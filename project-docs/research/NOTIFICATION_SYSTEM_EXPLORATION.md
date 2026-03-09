# Notification & Sound System — Exploration Research

> **Date:** 2026-03-08  
> **Status:** Research complete — ready for design decisions  
> **Scope:** Adding configurable browser sound/notification support to Middleman

---

## Table of Contents

1. [WebSocket Event System](#1-websocket-event-system)
2. [Manager Lifecycle & "Run Complete" Signals](#2-manager-lifecycle--run-complete-signals)
3. [Tool System](#3-tool-system)
4. [Frontend Audio & Notification Capabilities](#4-frontend-audio--notification-capabilities)
5. [Configuration System](#5-configuration-system)
6. [Existing Patterns to Follow](#6-existing-patterns-to-follow)
7. [Gotchas & Constraints](#7-gotchas--constraints)
8. [Recommended Approach](#8-recommended-approach)
9. [Deep Dive: "Only When No Workers Running" Mode](#9-deep-dive-only-when-no-workers-running-mode)

---

## 1. WebSocket Event System

### How Events Flow

The event pipeline is clean and well-structured:

```
Backend (SwarmManager EventEmitter)
  → SwarmWebSocketServer (event listeners)
    → WsHandler.broadcastToSubscribed()
      → WebSocket clients (filtered by subscription)
        → ManagerWsClient.handleServerEvent()
          → React state update via updateState()
```

### Key Files

| File | Role |
|------|------|
| `packages/protocol/src/server-events.ts` | Canonical wire types for all server→client events |
| `packages/protocol/src/client-commands.ts` | Client→server command types |
| `apps/backend/src/ws/server.ts` | SwarmWebSocketServer — bridges SwarmManager EventEmitter to WS |
| `apps/backend/src/ws/ws-handler.ts` | WsHandler — manages subscriptions + per-client broadcast filtering |
| `apps/ui/src/lib/ws-client.ts` | ManagerWsClient — frontend WS client, dispatches events to state |
| `apps/ui/src/lib/ws-state.ts` | ManagerWsState — the canonical client-side state shape |

### Event Registration Pattern

In `SwarmWebSocketServer`, each event type has a dedicated listener method:

```typescript
// server.ts — one listener per event type
private readonly onAgentStatus = (event: ServerEvent): void => {
  if (event.type !== "agent_status") return;
  this.wsHandler.broadcastToSubscribed(event);
};

// Registered in start():
this.swarmManager.on("agent_status", this.onAgentStatus);
```

### Broadcast Filtering (WsHandler)

`broadcastToSubscribed()` applies per-event-type filtering:
- **Conversation events** (`conversation_message`, `conversation_log`, `agent_message`, `agent_tool_call`, `conversation_reset`): Only sent to clients subscribed to the matching `agentId`.
- **Integration status** (`slack_status`, `telegram_status`): Filtered by profile ownership.
- **All other events** (`agent_status`, `agents_snapshot`, `profiles_snapshot`, `unread_notification`, session lifecycle events, etc.): Broadcast to **all** subscribed clients.

This means a new notification event could be:
- **Agent-scoped** (like conversation events) — only sent to the subscribed agent's client
- **Globally broadcast** (like `unread_notification`) — sent to all connected clients

### Existing `unread_notification` Pattern — Strong Precedent

There's already a notification-like event in the system. In `server.ts`:

```typescript
private readonly onConversationMessage = (event: ServerEvent): void => {
  if (event.type !== "conversation_message") return;
  this.wsHandler.broadcastToSubscribed(event);

  if (event.role === "assistant" && event.source === "speak_to_user") {
    this.wsHandler.broadcastToSubscribed({
      type: "unread_notification",
      agentId: event.agentId,
    });
  }
};
```

The client handles it in `handleServerEvent()`:

```typescript
case 'unread_notification': {
  if (event.agentId !== this.state.targetAgentId) {
    const prev = this.state.unreadCounts[event.agentId] ?? 0
    this.updateState({
      unreadCounts: { ...this.state.unreadCounts, [event.agentId]: prev + 1 },
    })
  }
  break
}
```

**Key insight:** `unread_notification` is already broadcast to all clients and could directly trigger sounds — it fires on every `speak_to_user` assistant message for agents the user isn't currently viewing. This is an excellent hook point.

### Existing ServerEvent Union Type

The `ServerEvent` type in `packages/protocol/src/server-events.ts` is a discriminated union. All 30+ event types are listed. Adding new event types requires:
1. Define the interface in `server-events.ts`
2. Add to the `ServerEvent` union
3. Handle in `ws-client.ts` `handleServerEvent()`
4. Emit from backend (either `SwarmManager` or `SwarmWebSocketServer`)

### Complexity: **Easy**
Adding a new event type is a well-worn path. The `unread_notification` event is basically the template.

---

## 2. Manager Lifecycle & "Run Complete" Signals

### Agent State Machine

Defined in `apps/backend/src/swarm/agent-state-machine.ts`:

```typescript
export type AgentStatus = "idle" | "streaming" | "terminated" | "stopped" | "error";

export const AGENT_STATUS_TRANSITIONS: Record<AgentStatusInput, readonly AgentStatusInput[]> = {
  idle: ["streaming", "terminated", "stopped"],
  streaming: ["idle", "terminated", "error"],
  terminated: ["idle"],
  stopped: ["idle", "terminated"],
  stopped_on_restart: ["idle", "terminated"],
  error: []
};
```

The key transition for "run complete" is: **`streaming → idle`**.

### Where Transitions Happen

In `AgentRuntime` (`agent-runtime.ts`):

```typescript
// agent_start event → streaming
if (event.type === "agent_start") {
  await this.updateStatus("streaming");
}

// agent_end event → idle
if (event.type === "agent_end") {
  if (this.status !== "terminated") {
    await this.updateStatus("idle");
  }
  if (this.callbacks.onAgentEnd) {
    await this.callbacks.onAgentEnd(this.descriptor.agentId);
  }
}
```

The `updateStatus()` → `emitStatus()` chain:

```typescript
private async emitStatus(): Promise<void> {
  await this.callbacks.onStatusChange(
    this.descriptor.agentId,
    this.status,
    this.pendingDeliveries.length,
    this.getContextUsage()
  );
}
```

### SwarmManager Handling

In `swarm-manager.ts`, the callbacks are wired:

```typescript
callbacks: {
  onStatusChange: async (agentId, status, pendingCount, contextUsage) => {
    await this.handleRuntimeStatus(agentId, status, pendingCount, contextUsage);
  },
  onAgentEnd: async (agentId) => {
    await this.handleRuntimeAgentEnd(agentId);
  },
}
```

`handleRuntimeStatus()` (line 3662):
- Updates the descriptor status
- Persists the store
- Calls `this.emitStatus()` which emits an `agent_status` ServerEvent

`handleRuntimeAgentEnd()` (line 4157):
- Only handles **worker** agents (returns early for non-workers)
- Manages the idle-worker watchdog for callback reporting
- Does NOT emit a specific "manager run complete" signal

### The Gap: No "Manager Run Complete" Event

Currently, when a manager finishes processing (goes `streaming → idle`), the system:
1. Emits `agent_status` with `status: "idle"` (✅ exists)
2. Does NOT emit any dedicated "run complete" or "attention needed" event

The client receives `agent_status` and updates its status display, but there's no explicit notification trigger.

### How to Detect "Manager Run Complete"

**Option A: Frontend-side detection** — Watch `agent_status` events where a manager goes from `streaming` → `idle`. The client already tracks statuses in `state.statuses[agentId]`.

**Option B: Backend-side emission** — Add logic in `handleRuntimeStatus()` to emit a new event when a manager transitions `streaming → idle`.

**Option C: Piggyback on `agent_end` callback** — Currently `handleRuntimeAgentEnd` only processes workers. Extend it for managers.

**Recommended: Option A** (frontend detection). It's the simplest — the client already has all the state needed, and avoids backend changes for what is fundamentally a UI concern.

### Important Nuance: Pending Deliveries

A manager going `streaming → idle` doesn't always mean "done." It could have pending steered messages that will cause another streaming cycle. The `agent_status` event includes `pendingCount`. A truly "finished" run would be: `status === 'idle' && pendingCount === 0`.

### Complexity: **Easy** (frontend detection) / **Medium** (new backend event)

---

## 3. Tool System

### How Tools Are Built and Registered

Tools are defined in `apps/backend/src/swarm/swarm-tools.ts` using the `ToolDefinition` type from `@mariozechner/pi-coding-agent`:

```typescript
export function buildSwarmTools(host: SwarmToolHost, descriptor: AgentDescriptor): ToolDefinition[] {
  const shared: ToolDefinition[] = [
    // list_agents, send_message_to_agent
  ];

  if (descriptor.role !== "manager") {
    return shared;
  }

  const managerOnly: ToolDefinition[] = [
    // spawn_agent, kill_agent, speak_to_user
  ];

  return [...shared, ...managerOnly];
}
```

Each tool has:
- `name` — tool identifier
- `label` — display name
- `description` — what the LLM sees
- `parameters` — TypeBox schema
- `execute(toolCallId, params)` — async handler returning `{ content: [...], details?: ... }`

The tool host interface (`SwarmToolHost`) provides capabilities the tools call:

```typescript
export interface SwarmToolHost {
  listAgents(): AgentDescriptor[];
  spawnAgent(callerAgentId: string, input: SpawnAgentInput): Promise<AgentDescriptor>;
  killAgent(callerAgentId: string, targetAgentId: string): Promise<void>;
  sendMessage(...): Promise<SendMessageReceipt>;
  publishToUser(agentId: string, text: string, source?: ..., targetContext?: ...): Promise<...>;
}
```

### Tool Registration Flow

```
RuntimeFactory.createRuntimeForDescriptor()
  → buildSwarmTools(host, descriptor)  // returns ToolDefinition[]
  → createAgentSession({ tools: [...builtinTools, ...swarmTools] })
```

The tools are built per-agent at runtime creation time. The `host` is the `SwarmManager` itself (it implements `SwarmToolHost`).

### Skills vs Tools

**Skills** (from `apps/backend/src/swarm/skills/builtins/`) are NOT traditional tools — they're **markdown instruction files** injected into agent context. They guide the agent on HOW to use existing tools.

```
skills/
  memory/SKILL.md       → Instructions for using read/write/edit tools for memory
  brave-search/SKILL.md → Instructions for using bash to call search.js
  cron-scheduling/      → Instructions for bash-based cron management
  agent-browser/        → Instructions for browser tool usage
  image-generation/     → Instructions for image gen
```

The skills are loaded by `SkillMetadataService` and their paths are passed as `additionalSkillPaths` during agent session creation. They end up as context files, not as tool definitions.

### What a `notify_user` Tool Would Look Like

A `notify_user` tool would be a **swarm tool** (in `swarm-tools.ts`), not a skill. It would:

1. Be available to both managers and workers (or manager-only, depending on design)
2. Call a new method on `SwarmToolHost` (e.g., `notifyUser()`)
3. The backend would emit a new ServerEvent (e.g., `user_notification`)
4. The frontend would handle it and play a sound

Example sketch:

```typescript
// In swarm-tools.ts
{
  name: "notify_user",
  label: "Notify User",
  description: "Play an attention-grabbing notification sound in the user's browser. Use when you need the user's attention (task complete, question, blocker).",
  parameters: Type.Object({
    message: Type.Optional(Type.String({ description: "Optional short message to show with the notification." })),
    urgency: Type.Optional(Type.Union([
      Type.Literal("info"),
      Type.Literal("attention"),
      Type.Literal("urgent")
    ], { description: "Notification priority level." }))
  }),
  async execute(_toolCallId, params) {
    const parsed = params as { message?: string; urgency?: string };
    await host.notifyUser(descriptor.agentId, {
      message: parsed.message,
      urgency: parsed.urgency ?? "info"
    });
    return {
      content: [{ type: "text", text: "Notification sent to user." }],
      details: { notified: true }
    };
  }
}
```

### Complexity: **Easy-Medium**
The tool definition pattern is straightforward. The new piece is wiring it to a new event type.

---

## 4. Frontend Audio & Notification Capabilities

### Current Audio Usage

The codebase already uses audio in `apps/ui/src/hooks/use-voice-recorder.ts`:
- Uses `AudioContext` (Web Audio API) for voice recording level analysis
- Uses `MediaRecorder` for capturing audio
- Uses `getUserMedia` for microphone access

This confirms the Web Audio API is already available and used in the project.

### Approach Options for Playing Sounds

#### Option A: HTML5 `<audio>` Element / `new Audio()`

```typescript
const audio = new Audio('/sounds/notification.mp3');
audio.volume = 0.7;
audio.play();
```

**Pros:** Simplest approach. No setup needed. Works everywhere.  
**Cons:** No fine-grained control. Each play creates a new element. Volume/mixing limited.

#### Option B: Web Audio API (`AudioContext`)

```typescript
const ctx = new AudioContext();
const response = await fetch('/sounds/notification.mp3');
const buffer = await ctx.decodeAudioData(await response.arrayBuffer());
const source = ctx.createBufferSource();
source.buffer = buffer;
const gain = ctx.createGain();
gain.gain.value = 0.7;
source.connect(gain).connect(ctx.destination);
source.start();
```

**Pros:** Fine-grained control. Can pre-decode buffers. Better for multiple rapid sounds. Volume control per sound.  
**Cons:** More code. Needs user interaction to unlock AudioContext (browser policy).

#### Option C: Hybrid — `new Audio()` with pre-loaded sources

```typescript
// Pre-load at module level
const sounds = {
  complete: new Audio('/sounds/complete.mp3'),
  attention: new Audio('/sounds/attention.mp3'),
  urgent: new Audio('/sounds/urgent.mp3'),
};

function playNotificationSound(type: string, volume: number) {
  const audio = sounds[type];
  if (!audio) return;
  audio.volume = volume;
  audio.currentTime = 0; // Allow replay
  audio.play().catch(() => {}); // Swallow autoplay errors
}
```

**Pros:** Simple but pre-loadable. Easy volume control. Graceful failure.  
**Cons:** Less flexible than full Web Audio API.

#### Recommended: **Option C** (Hybrid)
Simplest approach that still supports pre-loading and volume control. Can upgrade to Web Audio API later if needed.

### Browser Notification API (Complement)

```typescript
if ('Notification' in window && Notification.permission === 'granted') {
  new Notification('Middleman', { body: 'Task complete', icon: '/logo192.png' });
}
```

**Pros:** Shows native OS notifications. Works when tab is backgrounded.  
**Cons:** Requires explicit permission grant. Might be too intrusive for some users. Separate preference needed.

**Recommendation:** Add as an optional complement alongside sound. Perfect for "urgent" notifications.

### Sound Assets Location

Currently `apps/ui/public/` contains:
```
agents/
logo192.png
logo512.png
manifest.json
pi-logo.svg
robots.txt
```

Sound files would go in `apps/ui/public/sounds/`:
```
public/sounds/
  complete.mp3    — Gentle chime for "run complete"
  attention.mp3   — Moderate tone for "notify_user" info/attention
  urgent.mp3      — Distinct alert for "notify_user" urgent
```

**Format choice:** MP3 is universally supported. Keep files small (< 50KB each). Alternatively use WAV for zero-latency decoding, or OGG for smaller size.

### Autoplay Policy Gotcha

Modern browsers block `audio.play()` until the user has interacted with the page. Since Middleman is an interactive app where users type messages and click buttons, this is unlikely to be an issue in practice — the user will have interacted before any notifications fire. But the code should gracefully handle rejected `play()` promises.

### Complexity: **Easy**
Browser audio is well-supported. The hybrid approach is ~30 lines of code.

---

## 5. Configuration System

### Current Settings Architecture

**Frontend settings UI:**
```
apps/ui/src/components/settings/
  SettingsLayout.tsx    — Tab navigation (general / auth / integrations / skills)
  SettingsGeneral.tsx   — Theme preference (localStorage-based)
  SettingsAuth.tsx      — API key management
  SettingsIntegrations.tsx — Slack/Telegram config
  SettingsSkills.tsx    — Skill env vars
  settings-api.ts      — HTTP API calls to backend
  settings-types.ts    — Shared types
  settings-row.tsx     — Reusable SettingsSection + SettingsWithCTA layout components
```

**Backend settings routes:**
```
apps/backend/src/ws/routes/settings-routes.ts — HTTP endpoints for env vars, auth, integrations
```

### Settings Patterns

The settings UI uses reusable layout components:

```tsx
<SettingsSection label="Appearance" description="Customize how the app looks">
  <SettingsWithCTA label="Theme" description="Choose between light, dark, or system theme">
    <Select value={...} onValueChange={...}>
      ...
    </Select>
  </SettingsWithCTA>
</SettingsSection>
```

Theme preference is stored client-side in `localStorage` under the key `'swarm-theme'`. This is a good pattern for notification preferences — they're per-browser, not per-profile.

### Where Notification Preferences Should Live

**Client-side (localStorage)** — Recommended for v1:
- Sound on/off toggle
- Volume level
- Per-event-type toggles (run complete, agent notification, etc.)
- Browser Notification permission state
- Which sound to use (if offering choices)

**Rationale:** Notification preferences are inherently per-device/browser. A user might want sounds on their desktop but off on their phone. No backend changes needed.

**Backend-side (profile config)** — Future consideration:
- Only needed if you want preferences to sync across devices
- Would require new API endpoints and storage
- Overkill for v1

### Proposed Settings UI Location

Add a "Notifications" section to `SettingsGeneral.tsx` (or a new `SettingsNotifications.tsx` tab):

```tsx
<SettingsSection label="Notifications" description="Configure sounds and alerts">
  <SettingsWithCTA label="Sound notifications" description="Play sounds when agents need attention">
    <Switch checked={soundEnabled} onCheckedChange={setSoundEnabled} />
  </SettingsWithCTA>
  
  <SettingsWithCTA label="Run complete sound" description="Play a sound when a manager finishes processing">
    <Switch checked={runCompleteSound} onCheckedChange={...} />
  </SettingsWithCTA>

  <SettingsWithCTA label="Agent notification sound" description="Play a sound when an agent explicitly requests attention">
    <Switch checked={agentNotifySound} onCheckedChange={...} />
  </SettingsWithCTA>

  <SettingsWithCTA label="Volume" description="Notification sound volume">
    {/* Range slider */}
  </SettingsWithCTA>

  <SettingsWithCTA label="Browser notifications" description="Show native OS notifications (requires permission)">
    <Switch checked={browserNotificationsEnabled} onCheckedChange={...} />
  </SettingsWithCTA>
</SettingsSection>
```

### localStorage Key Design

Following the existing `'swarm-theme'` pattern:

```typescript
const NOTIFICATION_STORAGE_KEY = 'swarm-notifications';

interface NotificationPreferences {
  soundEnabled: boolean;
  volume: number; // 0-1
  runCompleteSound: boolean;
  agentNotifySound: boolean;
  browserNotifications: boolean;
}

const DEFAULT_PREFERENCES: NotificationPreferences = {
  soundEnabled: true,
  volume: 0.7,
  runCompleteSound: true,
  agentNotifySound: true,
  browserNotifications: false,
};
```

### Complexity: **Easy-Medium**
Reuses existing settings patterns. localStorage approach means no backend changes. Adding a settings tab or section is straightforward.

---

## 6. Existing Patterns to Follow

### Pattern: `unread_notification` — The Closest Analog

This is the most relevant pattern. It:
1. Is emitted from `server.ts` piggy-backing on `conversation_message` events
2. Broadcasts to all subscribed clients
3. Is handled in `ws-client.ts` to update client state
4. Drives UI behavior (unread badges in the sidebar)

A sound notification system would follow the exact same flow, just triggering an audio play instead of (or in addition to) incrementing a counter.

### Pattern: Agent Status Display

The `agent_status` event → `state.statuses` → UI rendering chain demonstrates how events flow through to visual UI. The notification system would add a parallel path: event → notification preference check → sound play.

### Pattern: Theme Preference (Client-Side Config)

`apps/ui/src/lib/theme.ts` shows how to:
- Store preference in localStorage
- Read it back with fallback defaults
- Apply it to the UI
- Expose it in settings

The notification preferences module would mirror this pattern exactly.

### Pattern: Settings UI Layout

`settings-row.tsx` provides `SettingsSection` and `SettingsWithCTA` — reusable components with consistent spacing and layout. Already-installed shadcn components (`Switch`, `Select`, `Label`) cover all the controls needed.

### No Existing Toast/Snackbar System

The codebase does NOT have a toast/snackbar system (no sonner, react-hot-toast, etc.). System messages are shown inline in the chat as `role: 'system'` conversation messages. If we want visual notification toasts alongside sound, we'd need to add one. However, for v1, the chat-inline system messages + sound might be sufficient.

---

## 7. Gotchas & Constraints

### Browser Autoplay Policy

Browsers require user interaction before `audio.play()` works. In Middleman, users interact (send messages, click UI) before notifications would fire, so this is low risk. But the code must handle `play()` promise rejections gracefully.

### Tab Visibility

When the browser tab is backgrounded:
- `audio.play()` still works (sound plays even in background tabs)
- `Notification` API works (shows native OS notification)
- WebSocket events still arrive

This is good — users often switch tabs while waiting for agents.

### Multiple Browser Tabs

If the user has multiple tabs open to Middleman, all tabs receive the same WebSocket events. Without coordination, each tab would play the sound, resulting in echo/doubling. Mitigation options:
- **SharedWorker or BroadcastChannel** to coordinate (complex)
- **Visibility API** — only play sound in the currently visible/focused tab (simple, good enough)
- **Accept the limitation** for v1 — most users have one tab open

**Recommendation:** Use `document.visibilityState` or `document.hasFocus()` to only play in the active tab, with a fallback to play in any tab if none are focused.

### Sound File Licensing

Any bundled sound effects need appropriate licensing (CC0, MIT, or custom-created). Public domain chime/notification sounds are readily available.

### Mobile Considerations

On mobile browsers:
- Audio autoplay is more restricted (usually needs recent user gesture)
- `Notification` API has limited support on iOS Safari
- Volume might interact with system volume/ringer settings

Since Middleman is primarily a desktop tool, this is lower priority but worth noting.

### WebSocket Reconnection

On reconnect, the client gets a full bootstrap (agents_snapshot, conversation_history, etc.) but NOT replayed notification events. Missed notifications during disconnection are lost. This is acceptable — notifications are ephemeral.

### Rate Limiting

If an agent calls `notify_user` in a tight loop, or if many agents finish simultaneously, we could get sound spam. Consider:
- A minimum interval between notification sounds (e.g., debounce to 2 seconds)
- Coalescing rapid-fire notifications into a single sound

---

## 8. Recommended Approach

### Architecture Summary

```
┌─────────────────────────────────────────────────────┐
│ Backend                                             │
│                                                     │
│  SwarmManager                                       │
│    ├─ handleRuntimeStatus()                         │
│    │   └─ [streaming→idle for manager] ──emit──→    │
│    │     "agent_status" (already exists)             │
│    │                                                │
│    ├─ notify_user tool                              │
│    │   └─ host.notifyUser() ──emit──→               │
│    │     "user_notification" (new event)             │
│    │                                                │
│  SwarmWebSocketServer                               │
│    └─ broadcastToSubscribed() ──ws──→ client        │
└─────────────────────────────────────────────────────┘
                        │
                   WebSocket
                        │
┌─────────────────────────────────────────────────────┐
│ Frontend                                            │
│                                                     │
│  ManagerWsClient.handleServerEvent()                │
│    ├─ agent_status → check streaming→idle           │
│    │   for managers → triggerNotification("complete")│
│    │                                                │
│    ├─ user_notification (new) →                     │
│    │   triggerNotification("attention"|"urgent")    │
│    │                                                │
│  NotificationService (new module)                   │
│    ├─ reads preferences from localStorage           │
│    ├─ pre-loads audio buffers                       │
│    ├─ plays sounds (with debounce)                  │
│    ├─ optionally shows browser Notification         │
│    └─ respects tab focus (multi-tab safety)         │
│                                                     │
│  Settings UI                                        │
│    └─ Notifications section in General settings     │
│       ├─ Master sound toggle                        │
│       ├─ Per-event toggles                          │
│       ├─ Volume slider                              │
│       └─ Browser notification toggle + permission   │
└─────────────────────────────────────────────────────┘
```

### Implementation Phases

#### Phase 1: Core Sound Playback (Easy — ~2-4 hours)

1. **Add sound files** to `apps/ui/public/sounds/` (3 short MP3s)
2. **Create `apps/ui/src/lib/notification-service.ts`:**
   - localStorage-based preferences (mirroring `theme.ts` pattern)
   - Sound pre-loading and playback
   - Debounce logic (min 2s between plays)
   - Tab-focus check for multi-tab safety
3. **Wire into `ManagerWsClient.handleServerEvent()`:**
   - Detect manager `streaming → idle` (with `pendingCount === 0`) from `agent_status` events
   - Call `notificationService.play('complete')`

#### Phase 2: `notify_user` Tool (Easy-Medium — ~2-4 hours)

1. **Add `user_notification` event type** to `packages/protocol/src/server-events.ts`
2. **Add `notifyUser()` to `SwarmToolHost`** interface in `swarm-tools.ts`
3. **Add `notify_user` tool definition** in `buildSwarmTools()` — available to managers only (workers can ask their manager to notify)
4. **Implement `notifyUser()` in `SwarmManager`:**
   - Emit the event via `this.emit("user_notification", payload)`
5. **Add event listener** in `SwarmWebSocketServer`
6. **Handle in frontend** `handleServerEvent()` → play appropriate sound

#### Phase 3: Settings UI (Easy — ~2-3 hours)

1. **Add notification settings section** to `SettingsGeneral.tsx`
2. **Use existing shadcn components:** `Switch` (toggles), `Select` (sound choice), custom range input (volume)
3. **Wire to `notification-service.ts`** preferences

#### Phase 4: Browser Notifications (Easy — ~1-2 hours)

1. **Add permission request** flow in settings
2. **Show native `Notification`** alongside sound for urgent/attention events
3. **Only when tab is backgrounded** (to avoid doubling with in-app UI)

### Complexity Estimates Summary

| Component | Complexity | Effort |
|-----------|-----------|--------|
| Sound playback module | Easy | 2h |
| Manager run-complete detection (frontend) | Easy | 1h |
| `user_notification` protocol event | Easy | 1h |
| `notify_user` tool definition | Easy | 1h |
| Backend `notifyUser()` + event emission | Easy | 1h |
| Settings UI | Easy-Medium | 2-3h |
| Browser Notification integration | Easy | 1-2h |
| Sound asset sourcing/creation | Easy | 1h |
| Multi-tab coordination | Easy | 30min |
| Debounce/rate-limiting | Easy | 30min |
| **Total** | **Easy-Medium** | **~10-14h** |

### Key Design Decisions Needed

1. **Should `notify_user` be manager-only or available to workers too?**
   - Manager-only is simpler and prevents worker spam
   - Workers can report to manager who decides whether to notify

2. **Should the "run complete" sound be for all agents or only the currently-viewed session?**
   - All managers = more useful (you hear when any background task finishes)
   - Current session only = less noisy

3. **Should we add a toast/snackbar system alongside sound?**
   - Not strictly needed for v1 (system chat messages exist)
   - Would improve UX for backgrounded tabs where sound alone might be missed

4. **Sound asset approach: bundled files vs. system beep vs. user-uploadable?**
   - Bundled MP3s are simplest and most reliable for v1
   - Could add custom upload later

5. **Should the `notify_user` tool support a visible message or just be a sound ping?**
   - A message adds value — "Build complete, merge ready" with a chime is better than just a chime
   - Could combine with a `speak_to_user` call or embed the message in the notification event

---

## 9. Deep Dive: "Only When No Workers Running" Mode

> **Added 2026-03-08** — Focused investigation on the two notification trigger modes:
> - **Mode 1:** "On any unread message" — play sound on every `unread_notification`
> - **Mode 2:** "Only when no workers are running" — play sound only when the manager that sent the `speak_to_user` has no active/streaming workers

### 9.1 What the Frontend Knows About Worker Status

**`state.agents: AgentDescriptor[]`** — The client has a full list of ALL agents (managers + workers). This is populated from `agents_snapshot` events which broadcast the entire agent registry to all connected clients.

Each `AgentDescriptor` has:
```typescript
{
  agentId: string
  managerId: string       // ← parent relationship
  role: 'manager' | 'worker'  // ← role discrimination
  status: AgentStatus     // 'idle' | 'streaming' | 'terminated' | 'stopped' | 'error'
  // ... other fields
}
```

**`state.statuses: Record<string, { status, pendingCount, contextUsage }>`** — Updated from `agent_status` events which are broadcast to ALL clients (not filtered by subscription). This gives real-time status updates for every agent, including workers.

**Key finding:** The frontend has ALL the data needed to determine parent-child relationships and worker status. No blind spots here.

### 9.2 Parent-Child Relationship Resolution

Workers have `managerId` pointing to their owning session/manager. The frontend already resolves this in `apps/ui/src/lib/agent-hierarchy.ts`:

```typescript
// From buildProfileTreeRows():
const workersByManager = new Map<string, AgentDescriptor[]>()
for (const worker of workers) {
  const list = workersByManager.get(worker.managerId)
  if (list) list.push(worker)
  else workersByManager.set(worker.managerId, [worker])
}
```

To check "does manager X have any active workers?", the frontend can do:

```typescript
function hasActiveWorkers(managerAgentId: string, state: ManagerWsState): boolean {
  return state.agents.some(agent =>
    agent.role === 'worker' &&
    agent.managerId === managerAgentId &&
    (agent.status === 'streaming' || agent.status === 'idle')
  );
}
```

This uses `state.agents` for role/managerId linkage and `agent.status` from the descriptor (which is kept fresh by `agents_snapshot` updates). For even more real-time accuracy, we could cross-reference `state.statuses[agentId]?.status` since `agent_status` events arrive more frequently than snapshots:

```typescript
function hasActiveWorkers(managerAgentId: string, state: ManagerWsState): boolean {
  return state.agents.some(agent => {
    if (agent.role !== 'worker' || agent.managerId !== managerAgentId) return false;
    // Prefer real-time status over descriptor snapshot
    const liveStatus = state.statuses[agent.agentId]?.status ?? agent.status;
    return liveStatus === 'streaming' || liveStatus === 'idle';
  });
}
```

**Verdict: Fully doable from the frontend. No backend changes needed for the relationship data.**

### 9.3 Timing Analysis: The Critical Race

The scenario: Manager has 5 workers. Worker 5 (the last one) sends its report via `send_message_to_agent`, then goes idle. The manager processes the report and calls `speak_to_user`. The client receives an `unread_notification`. At that point, is Worker 5 already showing as idle/terminated in the client state?

**Traced event sequence (from source code):**

```
Worker 5's turn:
  1. Worker calls send_message_to_agent tool
  2. SwarmManager.sendMessage() → managerRuntime.sendMessage()
     → message queued/dispatched to manager (async)
  3. Tool returns success to worker
  4. Worker finishes turn → agent_end event
  5. AgentRuntime.handleEvent(agent_end) → updateStatus("idle")
  6. → emitStatus() → SwarmManager.handleRuntimeStatus()
  7. → emits agent_status {agentId: worker5, status: "idle"}  ← WS event A

Manager's turn (async, after receiving the message):
  8. Manager runtime starts → agent_start → status "streaming"
  9. → agent_status {agentId: manager, status: "streaming"}   ← WS event B
  10. Manager processes, calls speak_to_user tool
  11. SwarmManager.publishToUser() → emitConversationMessage()
  12. → conversation_message event
  13. SwarmWebSocketServer.onConversationMessage() →
      broadcasts conversation_message AND unread_notification  ← WS event C

  14. Manager finishes turn → idle → agent_status              ← WS event D
```

**Event arrival order at client: A → B → C → D**

Events A (worker idle) and C (unread_notification) are well separated in time. Between them:
- Worker 5 finishes its tool call and exits its agentic loop (step 4-7)
- Manager needs to: receive the message, make an API call to the LLM, get a response back, execute `speak_to_user` (step 8-13)

That's at minimum several hundred milliseconds, typically seconds. The worker `agent_status` event (A) will arrive at the client well before the `unread_notification` (C).

**But there's a subtlety:** WebSocket messages from the same server are ordered (TCP guarantees). Since both events flow through the same `SwarmWebSocketServer` → same WebSocket connection, the ordering is deterministic. Event A will ALWAYS arrive before Event C at the client, as long as both are emitted by the same Node.js process (which they are — single server).

**Verdict: No race condition. Worker status is reliably updated before the notification arrives.**

### 9.4 Edge Cases

#### Edge Case 1: Worker goes idle but is still alive

When a worker finishes a turn and goes `streaming → idle`, it's still a live agent. It might receive another message and start streaming again. The check should treat `idle` workers as **not active** for notification purposes — an idle worker has finished its current work. Only `streaming` workers should count as "active."

Wait — this depends on semantics. An `idle` worker that hasn't been terminated is still part of the manager's workforce and might be re-engaged. But for the notification use case, the user wants to know: "is the manager doing orchestration work right now?" An idle worker is not currently doing work.

**Recommended:** Count only `streaming` workers as active for the "no workers running" check:

```typescript
function hasStreamingWorkers(managerAgentId: string, state: ManagerWsState): boolean {
  return state.agents.some(agent => {
    if (agent.role !== 'worker' || agent.managerId !== managerAgentId) return false;
    const liveStatus = state.statuses[agent.agentId]?.status ?? agent.status;
    return liveStatus === 'streaming';
  });
}
```

#### Edge Case 2: Manager sends multiple speak_to_user in one turn

A manager might call `speak_to_user` multiple times in a single turn (e.g., status update + final summary). Each fires a separate `unread_notification`. With Mode 2, all of these would trigger sounds (since no workers are running at that point). The debounce mechanism (2-second minimum between sounds) would coalesce these into a single audible notification.

#### Edge Case 3: Worker spawned during the same turn

A manager could spawn a new worker and then call `speak_to_user` in the same turn. The `agents_snapshot` for the new worker would be emitted when the worker is spawned (synchronously in `SwarmManager.spawnAgent()`), BEFORE the later `speak_to_user` in the same turn. So the client would see the new streaming worker when the notification arrives. Mode 2 would correctly suppress the sound.

#### Edge Case 4: Worker terminated vs. idle

Terminated/stopped workers should NOT count as active. The check `liveStatus === 'streaming'` handles this correctly.

#### Edge Case 5: Manager has pending deliveries

The manager's `agent_status` event includes `pendingCount`. If the manager has pending steered messages (`pendingCount > 0`), it will start another turn after the current one finishes. This means the manager isn't truly "done" yet. However, for Mode 2 the trigger is `unread_notification` (which fires during `speak_to_user`), not "manager went idle." The pending count is irrelevant for the trigger — the question is only "are any workers streaming?"

### 9.5 Backend Enhancement Option

Instead of doing the check client-side, we could enrich the `unread_notification` event on the backend:

```typescript
// In server.ts onConversationMessage:
if (event.role === "assistant" && event.source === "speak_to_user") {
  const agents = this.swarmManager.listAgents();
  const hasStreamingWorkers = agents.some(
    a => a.role === 'worker' &&
         a.managerId === event.agentId &&
         a.status === 'streaming'
  );

  this.wsHandler.broadcastToSubscribed({
    type: "unread_notification",
    agentId: event.agentId,
    hasStreamingWorkers,  // ← new field
  });
}
```

**Protocol change required:**

```typescript
export interface UnreadNotificationEvent {
  type: 'unread_notification'
  agentId: string
  hasStreamingWorkers?: boolean  // ← additive, backward-compatible
}
```

**Pros of backend approach:**
- Single source of truth — no risk of client state being stale
- Simpler client logic — just read the flag
- The backend is in the same process/event loop, so the data is perfectly consistent at emission time

**Cons of backend approach:**
- Couples notification behavior to the protocol wire format
- Requires backend code change for what's fundamentally a UI preference

### 9.6 Comparison and Recommendation

| Approach | Reliability | Complexity | Backend Changes |
|----------|-------------|------------|-----------------|
| **Frontend-only** (check `state.agents` + `state.statuses`) | Very high — events are TCP-ordered, worker idle always arrives before manager's speak_to_user | Easy | None |
| **Backend-enriched** (add `hasStreamingWorkers` to event) | Perfect — atomically consistent | Easy | Small protocol + server.ts change |

**Recommendation: Frontend-only for v1.**

The timing analysis shows it's reliable. The event ordering is guaranteed by TCP + single-server WebSocket. The client already has all the data. The code is ~5 lines.

If we ever encounter a practical race (unlikely), we can add the backend flag as a follow-up with zero breaking changes (additive optional field on `UnreadNotificationEvent`).

### 9.7 Implementation Sketch

```typescript
// apps/ui/src/lib/notification-service.ts

interface NotificationPreferences {
  enabled: boolean;
  volume: number;
  mode: 'any_unread' | 'no_workers_streaming';
}

function shouldPlaySound(
  event: UnreadNotificationEvent,
  state: ManagerWsState,
  prefs: NotificationPreferences,
): boolean {
  if (!prefs.enabled) return false;

  // Don't play for the currently viewed session
  if (event.agentId === state.targetAgentId) return false;

  if (prefs.mode === 'any_unread') return true;

  if (prefs.mode === 'no_workers_streaming') {
    const hasStreaming = state.agents.some(agent => {
      if (agent.role !== 'worker') return false;
      if (agent.managerId !== event.agentId) return false;
      const status = state.statuses[agent.agentId]?.status ?? agent.status;
      return status === 'streaming';
    });
    return !hasStreaming;
  }

  return false;
}
```

This integrates cleanly into the existing `handleServerEvent()` in `ws-client.ts` — the `unread_notification` case already exists and just needs the sound trigger added.
