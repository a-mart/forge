# Worker Pills — Web UI Implementation Plan

## Current State Analysis

### Mobile App (Reference Implementation)

The mobile app already has worker pills implemented in two components:

- **`WorkerPillBar`** (`middleman-mobile/components/chat/WorkerPillBar.tsx`): A horizontal `FlatList` of pill-shaped indicators, one per **streaming** worker. Each pill shows a pulsing green dot + truncated worker name. The bar renders above the chat input and is only visible when viewing a manager session (not a worker's conversation). Renders nothing when no workers are streaming.

- **`WorkerListSheet`** (`middleman-mobile/components/chat/WorkerListSheet.tsx`): A bottom sheet opened by tapping a worker count badge in the header. Shows all workers grouped into Active/Inactive sections with status dots, model labels, and status text.

**Mobile data flow:**
1. `ChatScreen` resolves `activeManagerId` from the current agent (if viewing a worker, uses `managerId`).
2. Calls `client.getSessionWorkers(activeManagerId)` on mount/agent-change to lazy-load workers.
3. Derives `sessionWorkers` from `state.agents.filter(a => a.role === 'worker' && a.managerId === activeManagerId)`.
4. Passes `sessionWorkers` to `WorkerPillBar` which filters to only streaming workers.
5. Tapping a pill calls `client.subscribeToAgent(worker.agentId)` to navigate to that worker's conversation.

### Web UI (Current State)

Workers are **only** visible in the left sidebar (`AgentSidebar.tsx`):
- Workers appear nested under their parent session in the profile tree.
- Each worker row shows an activity spinner, name, and runtime badge.
- Workers can be expanded/collapsed per-session; default is collapsed.
- Clicking a worker navigates to that worker's conversation view.

**What's missing for the web UI:**
- No worker indicators near the chat input area.
- No quick-look preview of worker activity without navigating away.
- No at-a-glance awareness of active workers while chatting with a manager session.

### Data Already Available

All necessary data is already available in the web client — **no backend changes needed**:

| Data | Source | Available? |
|------|--------|-----------|
| Worker list for a session | `state.agents.filter(w => w.role === 'worker' && w.managerId === sessionId)` | ✅ Yes (after `getSessionWorkers` lazy-load) |
| Worker status (streaming/idle/terminated) | `state.statuses[workerId].status` | ✅ Yes (real-time via `agent_status` events) |
| Worker display name | `AgentDescriptor.displayName` | ✅ Yes |
| Worker model info | `AgentDescriptor.model` | ✅ Yes |
| Worker active count (pre-load) | `AgentDescriptor.activeWorkerCount` on the manager | ✅ Yes |
| Worker activity events (tool calls, messages) | `state.activityMessages` (when subscribed to manager) | ✅ Yes — `agent_tool_call` and `agent_message` events include `actorAgentId`/`fromAgentId` |
| Worker conversation history | Requires `subscribeToAgent(workerId)` | ✅ Yes (but switches subscription) |

**Key insight**: When viewing a manager session, the `activityMessages` array already contains `agent_tool_call` events with `actorAgentId` identifying which worker performed the action, and `agent_message` events showing worker ↔ manager communication. This is the data source for the quick-look preview — no new subscription needed.

---

## Proposed UX Behavior

### Pill Bar Placement

The pill bar sits **between the `MessageList` and `MessageInput`** components, inside the chat column. It appears only when:
1. The user is viewing a **manager session** (not a worker conversation).
2. There is at least one **streaming** worker.

When all workers stop streaming, the pill bar animates out (fade + height collapse).

### Pill Appearance

Each pill is a small rounded-full capsule:
- **Pulsing dot** (emerald/green, CSS animation) on the left
- **Worker name** (truncated to ~20 chars) as text
- **Live runtime timer** on the right — compact elapsed time since `worker.createdAt`
- Horizontal scroll if pills overflow the container width (like mobile)

### Runtime Timer

Each pill displays a live elapsed timer showing how long the worker has been running:

- **Format**: `m:ss` for under 10 minutes, `mm:ss` for under an hour, `h:mm:ss` for 1 hour+. Examples: `0:34`, `2:05`, `12:34`, `1:05:22`.
- **Source**: `Date.now() - new Date(worker.createdAt).getTime()`, updated every second.
- **Styling**: Slightly muted compared to the worker name (`text-emerald-400/60` or similar). Uses `font-variant-numeric: tabular-nums` so digit widths stay constant and the pill doesn't jiggle as numbers change.
- **Layout**: `● worker-name  2:34` — dot, name, then timer separated by a subtle gap.
- **Implementation**: A single shared `setInterval(1000)` drives a `tick` counter (via `useState`) at the `WorkerPillBar` level. All pills re-derive their elapsed time from this shared tick rather than each pill owning its own interval. This keeps timer overhead O(1) regardless of worker count.
- **Freeze on completion**: When a worker stops streaming (enters the fadeout grace period), its timer freezes at the last computed value rather than continuing to count up.

### Click/Hover Interaction

**Click** on a pill opens a **quick-look popover** anchored to the pill. The popover shows:
1. **Header**: Worker name (full), model badge, status dot
2. **Recent activity feed**: The last 5-10 tool calls and messages from this worker, filtered from `activityMessages` by `actorAgentId === workerId` or `fromAgentId === workerId`. Uses the same `ToolLogRow` rendering as the main chat (reuse existing components).
3. **Footer**: "View full conversation →" link that navigates to the worker's chat view (calls `subscribeToAgent`).

The popover uses the shadcn `Popover` component (already installed at `apps/ui/src/components/ui/popover.tsx`).

**Hover** shows a lightweight tooltip with: worker name, model, and current status text (e.g., "Running command: git status"). This uses the existing shadcn `Tooltip`.

### Preview Pane Content Detail

The activity feed in the popover is derived entirely from the manager's existing `activityMessages` array:
- Filter `agent_tool_call` events where `actorAgentId === workerId`
- Filter `agent_message` events where `fromAgentId === workerId` or `toAgentId === workerId`
- Take the most recent N entries (sorted by timestamp desc, display newest first or chronological — chronological matches the main chat)
- Render using the existing `ToolLogRow` and `AgentMessageRow` components from `message-list/`

This avoids any new backend queries or subscription changes.

### Animations

- **Pill bar enter/exit**: CSS `transition` on `max-height` + `opacity` (or `grid-rows` pattern already used in `ToolLogRow`).
- **Individual pill enter**: fade-in when a new worker starts streaming.
- **Individual pill exit**: fade-out when a worker stops streaming (with a brief delay to avoid flicker on transient status changes).
- **Pulsing dot**: CSS `@keyframes` animation matching the mobile's pulse effect.

---

## Component Architecture

### New Components

```
apps/ui/src/components/chat/
├── WorkerPillBar.tsx          # Container: horizontal scrolling pill list
├── WorkerPill.tsx             # Individual pill with tooltip + popover trigger
└── WorkerQuickLook.tsx        # Popover content: activity feed + header
```

### Component Tree Integration

```
IndexPage (routes/index.tsx)
└── <div className="flex min-w-0 flex-1 flex-col">
    ├── ChatHeader
    ├── MessageList
    ├── WorkerPillBar          ← NEW (between MessageList and MessageInput)
    │   ├── WorkerPill (×N)
    │   │   └── WorkerQuickLook (popover)
    └── MessageInput
```

### Props Flow

```typescript
// WorkerPillBar
interface WorkerPillBarProps {
  workers: AgentDescriptor[]              // All workers for the active session
  statuses: Record<string, { status: AgentStatus }>  // Live status map
  activityMessages: AgentActivityEntry[]  // For quick-look preview content
  onNavigateToWorker: (agentId: string) => void  // Subscribe to worker conv
}

// WorkerPill
interface WorkerPillProps {
  worker: AgentDescriptor
  status: AgentStatus
  tick: number                             // Shared tick counter for timer re-renders
  activityMessages: AgentActivityEntry[]  // Pre-filtered to this worker
  onNavigateToWorker: (agentId: string) => void
}

// WorkerQuickLook (popover content)
interface WorkerQuickLookProps {
  worker: AgentDescriptor
  status: AgentStatus
  recentActivity: AgentActivityEntry[]    // Last N filtered entries
  onViewFullConversation: () => void
}
```

### Data Derivation in IndexPage

The `IndexPage` component already has all necessary data. New derived state needed:

```typescript
// Derive session workers (same pattern as mobile)
const activeManagerId = useMemo(() => {
  if (activeAgent?.role === 'manager') return activeAgent.agentId
  if (activeAgent?.role === 'worker') return activeAgent.managerId
  return null
}, [activeAgent])

const sessionWorkers = useMemo(() => {
  if (!activeManagerId) return []
  return state.agents.filter(
    (a) => a.role === 'worker' && a.managerId === activeManagerId
  )
}, [activeManagerId, state.agents])

// Ensure workers are loaded (lazy-load on manager view)
useEffect(() => {
  if (!activeManagerId || !clientRef.current) return
  void clientRef.current.getSessionWorkers(activeManagerId).catch(() => {})
}, [activeManagerId, clientRef])
```

Note: `sessionWorkers` loading already happens via `handleRequestSessionWorkers` called from `AgentSidebar`, but we need it proactively when viewing a manager session even if the sidebar hasn't expanded that session's workers yet. The `getSessionWorkers` call is idempotent and cached via `loadedSessionIds`.

---

## Implementation Phases

### Phase 1: WorkerPillBar Component (Core)

**Files to create:**
- `apps/ui/src/components/chat/WorkerPillBar.tsx`

**Files to modify:**
- `apps/ui/src/routes/index.tsx` — Add worker derivation logic, render `WorkerPillBar` between `MessageList` and `MessageInput`

**Details:**
1. Create `WorkerPillBar` that receives the full worker list + statuses, internally filters to streaming workers, renders a horizontally-scrollable row of pills.
2. Each pill is a `<button>` with a pulsing dot + truncated name + live elapsed timer.
3. The pill bar owns a single `setInterval(1000)` that increments a `tick` state, passed to all pills. Each pill computes elapsed time from `worker.createdAt` on each tick. The interval is created/destroyed based on whether any streaming workers exist.
4. Clicking a pill navigates to the worker conversation (reuse `handleSelectAgent`).
4. Add the `activeManagerId` / `sessionWorkers` derivation to `IndexPage`.
5. Add a `useEffect` to proactively call `getSessionWorkers` when viewing a manager.
6. Render `WorkerPillBar` in the JSX between `MessageList` and `MessageInput`, only when `isActiveManager` is true.

**Styling:**
- Pill: `rounded-full bg-emerald-500/10 dark:bg-emerald-500/15 px-2.5 py-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-300` with timer in `tabular-nums text-emerald-600/60 dark:text-emerald-400/60`
- Container: `border-t border-border/40 bg-background px-2 py-1.5` with horizontal overflow scroll
- Pulsing dot: CSS animation `animate-pulse` or custom keyframes for a smoother effect

### Phase 2: Tooltip on Hover

**Files to modify:**
- `apps/ui/src/components/chat/WorkerPillBar.tsx` — Wrap each pill in a `TooltipProvider` / `Tooltip` / `TooltipTrigger`

**Details:**
- On hover, show tooltip with: full worker name, model (e.g., "claude-opus-4"), current status text, and the latest tool call summary (if available from `activityMessages`).
- Use the existing shadcn `Tooltip` component.

### Phase 3: Quick-Look Popover

**Files to create:**
- `apps/ui/src/components/chat/WorkerQuickLook.tsx`

**Files to modify:**
- `apps/ui/src/components/chat/WorkerPillBar.tsx` — Add `Popover` wrapper around each pill

**Details:**
1. Create `WorkerQuickLook` component that renders inside a `PopoverContent`.
2. Filter `activityMessages` to entries matching the worker's `agentId` (via `actorAgentId` for tool calls, `fromAgentId`/`toAgentId` for messages).
3. Take the last 8 entries and render them using `ToolLogRow` (for `agent_tool_call`) and `AgentMessageRow` (for `agent_message`) — these are imported from `message-list/`.
4. Show a scrollable area with max-height (~300px) for the activity feed.
5. Include a "View full conversation →" button at the bottom that calls `onNavigateToWorker`.
6. Popover anchored to the pill, opening upward (`side="top"`) since pills are near the bottom of the viewport.

**Data filtering for the popover:**
```typescript
const workerActivity = useMemo(() => {
  return activityMessages
    .filter(entry => {
      if (entry.type === 'agent_tool_call') {
        return entry.actorAgentId === workerId
      }
      if (entry.type === 'agent_message') {
        return entry.fromAgentId === workerId || entry.toAgentId === workerId
      }
      return false
    })
    .slice(-8)  // Last 8 entries
}, [activityMessages, workerId])
```

### Phase 4: Enter/Exit Animations

**Files to modify:**
- `apps/ui/src/components/chat/WorkerPillBar.tsx`

**Details:**
- Container: Use CSS `grid-rows` transition (pattern already used in `ToolLogRow`) for smooth height animation.
- Individual pills: `transition-all duration-200` for opacity/transform on mount/unmount. May require a delayed removal strategy (keep pill rendered for 300ms after worker stops streaming, then remove).
- Pulsing dot: Define a custom CSS animation or use Tailwind's `animate-pulse` with customization in `tailwind.config`.

---

## Edge Cases

### No Workers
- `WorkerPillBar` returns `null` when no workers are streaming. No visual element at all.

### Many Workers (10+)
- Horizontal scroll with `overflow-x-auto` and hidden scrollbar. On desktop, scroll with mouse wheel (horizontal) or trackpad. Consider showing a subtle gradient fade on the right edge when scrollable content overflows.
- The mobile app handles this with `FlatList horizontal`; the web equivalent is a simple flex container with `overflow-x-auto`.

### Worker Completes While Popover Is Open
- The popover should remain open showing the last known activity (the data is still in `activityMessages`).
- The pill itself fades out, which will close the popover via unmount. Use `onOpenChange` to detect this gracefully.
- Alternative: Keep the pill visible but change the dot from pulsing green to static gray for ~2 seconds before removing.

### Worker Starts Mid-Conversation
- New pill appears with a fade-in animation. The `agents_snapshot` and `agent_status` events will trigger re-renders.
- If the worker list hasn't been loaded yet, the `activeWorkerCount` on the manager descriptor serves as a pre-load indicator (could show a generic "N workers active" badge instead of individual pills until loaded).

### Viewing a Worker Conversation
- When `activeAgent.role === 'worker'`, pills should NOT render (matches mobile behavior). The user is already in a worker context.
- Could optionally show a "← Back to {session}" pill (like mobile does), but that's a follow-up.

### Rapid Status Changes
- A worker that quickly toggles between streaming/idle should not cause pill flicker. Debounce pill removal with a 500ms delay after status leaves `streaming`.

### Activity Messages Stale or Empty
- If `activityMessages` has no entries for a worker (e.g., it just started), the quick-look popover shows a "No recent activity" placeholder.
- Activity messages are scoped to the current subscription — when viewing a manager, all worker activity flows through `activityMessages` via the backend's conversation history broadcast.

### WebSocket Disconnection
- Pills depend on `state.agents` and `state.statuses`, which reset on disconnect/reconnect. Pills will disappear and reappear naturally with the reconnection flow.

### Multiple Workers with Same Display Name
- Pills are keyed by `agentId` (unique). Display names may collide but each pill links to a distinct worker.

---

## File Change Summary

| File | Action | Purpose |
|------|--------|---------|
| `apps/ui/src/components/chat/WorkerPillBar.tsx` | **Create** | Pill bar container + individual pill components |
| `apps/ui/src/components/chat/WorkerQuickLook.tsx` | **Create** | Popover content for worker activity preview |
| `apps/ui/src/routes/index.tsx` | **Modify** | Add `activeManagerId`, `sessionWorkers` derivation, proactive worker loading, render `WorkerPillBar` |

No backend changes needed. No protocol changes needed. No new WebSocket events needed.

---

## Dependencies & Sequencing

```
Phase 1 (Core Pill Bar)
   ↓
Phase 2 (Tooltip)      ← Independent of Phase 3, can be done in parallel
Phase 3 (Quick-Look)   ← Independent of Phase 2, can be done in parallel
   ↓
Phase 4 (Animations)   ← Depends on Phase 1 being complete
```

All phases can share a single branch. Phase 1 is the only prerequisite; Phases 2-4 are incremental enhancements.

## Risk Assessment

- **Low risk**: All data is already available client-side. No backend/protocol changes. Pure UI addition.
- **Minor complexity**: The popover interaction with dynamically appearing/disappearing pills needs care around React lifecycle (popover should close gracefully when its anchor unmounts).
- **Reuse opportunity**: `ToolLogRow` and `AgentMessageRow` are designed for the message list but should render fine in a popover context — they're self-contained components. Only concern is styling context (they assume dark/light mode classes from the parent, which should inherit correctly).
- **Performance**: Filtering `activityMessages` per-worker on each render is O(n) but the array is capped at 2000 entries client-side (`MAX_CLIENT_CONVERSATION_HISTORY`). Memoization with `useMemo` keeps this efficient.
