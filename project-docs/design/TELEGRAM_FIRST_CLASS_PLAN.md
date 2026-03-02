# Telegram First-Class Multi-Session — Implementation Plan

**Date:** 2026-03-02
**Status:** Implementation-ready
**Prerequisite:** [TELEGRAM_MULTI_SESSION_ANALYSIS.md](./TELEGRAM_MULTI_SESSION_ANALYSIS.md)

---

## Overview

Four work streams, in dependency order:

1. **Phase 1 — Outbound fix** (Gate 4 profile-aware filter)
2. **Phase 2 — Topic routing** (session ↔ topic mapping, inbound + outbound)
3. **Phase 3 — Lifecycle sync** (rename/delete/fork → topic operations)
4. **Phase 4 — Integration awareness** (system prompt injection)

Shared polling dedup is **deferred** — analysis shows it's not needed yet. Each `TelegramIntegrationService` is keyed by managerId (profile ID), and the shared config fallback just copies the token into each profile's own config object. Each profile already gets its own poller instance with its own offset tracking. Telegram allows one `getUpdates` consumer per token, but in practice users run one manager per bot token. If token sharing across profiles becomes real, we add a `TelegramPollingPool` then — not now.

---

## Phase 1: Outbound Delivery Fix

**Goal:** Messages from non-root sessions reach Telegram.

### File: `apps/backend/src/integrations/telegram/telegram-delivery.ts`

**Current (line ~68):**
```typescript
const descriptor = this.swarmManager.getAgent(event.agentId);
const agentProfileId = descriptor
  ? normalizeOptionalString(descriptor.profileId) ?? descriptor.agentId
  : undefined;
if (agentProfileId !== this.managerId) {
  return;
}
```

**Change:** Already correct — this resolves `profileId` and compares to `managerId`. The analysis doc's description of "Gate 4" was based on an older version. The current code uses `getAgent()` + `profileId` resolution, which handles session agents correctly because session descriptors have `profileId` set to the profile ID.

**Verification needed:** Confirm `descriptor.profileId` is always populated for session agents. Check `prepareSessionCreation`:

In `swarm-manager.ts` line ~1065:
```typescript
profileId: profile.profileId,
```
✅ Session descriptors always get `profileId` set. The outbound filter is **already correct**.

### File: `apps/backend/src/integrations/slack/slack-delivery.ts`

Same pattern — already uses `getAgent()` + `profileId` resolution. ✅ No change needed.

**Phase 1 verdict:** The Gate 4 bug described in the analysis was already fixed. Skip to Phase 2.

---

## Phase 2: Topic-Based Session Routing

### 2.1 Add Forum Topic API Methods to Client

**File: `apps/backend/src/integrations/telegram/telegram-client.ts`**

Add `messageThreadId` to `TelegramSendMessageInput`:

```typescript
export interface TelegramSendMessageInput {
  chatId: string;
  text: string;
  parseMode?: "HTML";
  disableWebPagePreview?: boolean;
  replyToMessageId?: number;
  messageThreadId?: number;  // NEW — forum topic thread
}
```

Wire it into `sendMessage()` body:

```typescript
body: {
  chat_id: chatId,
  text,
  parse_mode: input.parseMode ?? "HTML",
  disable_web_page_preview: input.disableWebPagePreview === true,
  reply_to_message_id: /* existing */,
  message_thread_id:
    typeof input.messageThreadId === "number" && Number.isFinite(input.messageThreadId)
      ? Math.trunc(input.messageThreadId)
      : undefined
}
```

Add new API methods:

```typescript
export interface TelegramForumTopic {
  message_thread_id: number;
  name: string;
  icon_color: number;
  icon_custom_emoji_id?: string;
}

async createForumTopic(input: {
  chatId: string;
  name: string;
  iconColor?: number;
}): Promise<TelegramForumTopic> {
  return this.request<TelegramForumTopic>("createForumTopic", {
    method: "POST",
    body: {
      chat_id: input.chatId,
      name: input.name.slice(0, 128), // Telegram limit
      icon_color: input.iconColor
    }
  });
}

async editForumTopic(input: {
  chatId: string;
  messageThreadId: number;
  name?: string;
}): Promise<true> {
  return this.request<true>("editForumTopic", {
    method: "POST",
    body: {
      chat_id: input.chatId,
      message_thread_id: input.messageThreadId,
      name: input.name?.slice(0, 128)
    }
  });
}

async closeForumTopic(input: {
  chatId: string;
  messageThreadId: number;
}): Promise<true> {
  return this.request<true>("closeForumTopic", {
    method: "POST",
    body: {
      chat_id: input.chatId,
      message_thread_id: input.messageThreadId
    }
  });
}

async deleteForumTopic(input: {
  chatId: string;
  messageThreadId: number;
}): Promise<true> {
  return this.request<true>("deleteForumTopic", {
    method: "POST",
    body: {
      chat_id: input.chatId,
      message_thread_id: input.messageThreadId
    }
  });
}
```

### 2.2 Session-Topic Mapping Store

**New file: `apps/backend/src/integrations/telegram/telegram-topic-store.ts`**

Lightweight JSON persistence alongside the telegram config. One file per manager profile.

```typescript
export interface TelegramTopicMapping {
  sessionAgentId: string;
  chatId: string;
  messageThreadId: number;
  topicName: string;
  createdAt: string;
}

export interface TelegramTopicStore {
  mappings: TelegramTopicMapping[];
}

// Path: ~/.middleman/integrations/managers/{managerId}/telegram-topics.json

export async function loadTopicStore(dataDir: string, managerId: string): Promise<TelegramTopicStore>;
export async function saveTopicStore(dataDir: string, managerId: string, store: TelegramTopicStore): Promise<void>;
```

Helper functions:

```typescript
export function findTopicForSession(
  store: TelegramTopicStore,
  sessionAgentId: string,
  chatId: string
): TelegramTopicMapping | undefined {
  return store.mappings.find(
    (m) => m.sessionAgentId === sessionAgentId && m.chatId === chatId
  );
}

export function findSessionForTopic(
  store: TelegramTopicStore,
  chatId: string,
  messageThreadId: number
): TelegramTopicMapping | undefined {
  return store.mappings.find(
    (m) => m.chatId === chatId && m.messageThreadId === messageThreadId
  );
}

export function addTopicMapping(
  store: TelegramTopicStore,
  mapping: TelegramTopicMapping
): void {
  // Remove any existing mapping for this session+chat
  store.mappings = store.mappings.filter(
    (m) => !(m.sessionAgentId === mapping.sessionAgentId && m.chatId === mapping.chatId)
  );
  store.mappings.push(mapping);
}

export function removeTopicMapping(
  store: TelegramTopicStore,
  sessionAgentId: string
): TelegramTopicMapping | undefined {
  const index = store.mappings.findIndex((m) => m.sessionAgentId === sessionAgentId);
  if (index === -1) return undefined;
  return store.mappings.splice(index, 1)[0];
}
```

### 2.3 Topic Manager (Orchestration Layer)

**New file: `apps/backend/src/integrations/telegram/telegram-topic-manager.ts`**

Sits between the integration service and the topic store/client. Handles the create-on-first-use pattern.

```typescript
export class TelegramTopicManager {
  private readonly managerId: string;
  private readonly dataDir: string;
  private readonly getTelegramClient: () => TelegramBotApiClient | null;
  private readonly getSwarmManager: () => SwarmManager;
  private store: TelegramTopicStore = { mappings: [] };

  async initialize(): Promise<void> {
    this.store = await loadTopicStore(this.dataDir, this.managerId);
  }

  /**
   * Resolve the message_thread_id for a session+chat.
   * Creates a topic on first use if topics are supported.
   * Returns undefined if topics aren't available (graceful fallback).
   */
  async resolveTopicForSession(
    sessionAgentId: string,
    chatId: string
  ): Promise<number | undefined> {
    // Root session → General topic (id=1) or no topic
    if (sessionAgentId === this.managerId) {
      return undefined; // Root uses General/flat chat
    }

    // Check existing mapping
    const existing = findTopicForSession(this.store, sessionAgentId, chatId);
    if (existing) {
      return existing.messageThreadId;
    }

    // Try to create a topic
    const client = this.getTelegramClient();
    if (!client) return undefined;

    const descriptor = this.getSwarmManager().getAgent(sessionAgentId);
    const topicName = descriptor?.sessionLabel ?? sessionAgentId;

    try {
      const topic = await client.createForumTopic({
        chatId,
        name: topicName
      });

      const mapping: TelegramTopicMapping = {
        sessionAgentId,
        chatId,
        messageThreadId: topic.message_thread_id,
        topicName,
        createdAt: new Date().toISOString()
      };

      addTopicMapping(this.store, mapping);
      await saveTopicStore(this.dataDir, this.managerId, this.store);

      return topic.message_thread_id;
    } catch {
      // Topics not supported for this chat — graceful fallback
      return undefined;
    }
  }

  /**
   * Look up which session a topic belongs to.
   * Returns undefined if no mapping found (routes to root session).
   */
  resolveSessionForTopic(
    chatId: string,
    messageThreadId: number | undefined
  ): string | undefined {
    if (messageThreadId === undefined || messageThreadId === null) {
      return undefined; // General/flat → root session
    }

    const mapping = findSessionForTopic(this.store, chatId, messageThreadId);
    return mapping?.sessionAgentId;
  }

  // Phase 3 hooks
  async renameTopicForSession(sessionAgentId: string, newName: string): Promise<void>;
  async closeTopicForSession(sessionAgentId: string): Promise<void>;
  async createTopicForFork(sourceAgentId: string, forkAgentId: string, forkLabel: string): Promise<void>;
}
```

### 2.4 Update Inbound Router

**File: `apps/backend/src/integrations/telegram/telegram-router.ts`**

The router already captures `message_thread_id` as `sourceContext.threadTs`. Now use it for session routing.

**Constructor change — add topic manager dependency:**

```typescript
constructor(options: {
  // ... existing
  topicManager: TelegramTopicManager;  // NEW
}) {
  // ...
  this.topicManager = options.topicManager;
}
```

**Change in `handleUpdate()` — resolve target session:**

```typescript
// BEFORE:
await this.swarmManager.handleUserMessage(text, {
  targetAgentId: this.managerId,
  attachments,
  sourceContext
});

// AFTER:
const targetSession = this.topicManager.resolveSessionForTopic(
  String(message.chat.id),
  message.message_thread_id
);

await this.swarmManager.handleUserMessage(text, {
  targetAgentId: targetSession ?? this.managerId,
  attachments,
  sourceContext
});
```

The `targetSession` resolution is synchronous (in-memory lookup). If no mapping found, falls back to root session (existing behavior).

### 2.5 Update Outbound Delivery

**File: `apps/backend/src/integrations/telegram/telegram-delivery.ts`**

**Constructor change — add topic manager dependency:**

```typescript
constructor(options: {
  // ... existing
  topicManager: TelegramTopicManager;  // NEW
}) {
  // ...
  this.topicManager = options.topicManager;
}
```

**Change in `forwardConversationMessage()` — resolve topic before sending:**

After the existing gate checks, before the send loop:

```typescript
// Resolve topic for this session
const messageThreadId = await this.topicManager.resolveTopicForSession(
  event.agentId,
  channelId
);

// ... existing chunk loop, but pass messageThreadId:
await telegramClient.sendMessage({
  chatId: channelId,
  text: chunk,
  parseMode: config.delivery.parseMode,
  disableWebPagePreview: config.delivery.disableLinkPreview,
  replyToMessageId,
  messageThreadId  // NEW — routes to correct topic
});
```

### 2.6 Wire Into Integration Service

**File: `apps/backend/src/integrations/telegram/telegram-integration.ts`**

Add `TelegramTopicManager` as a member, initialized in `applyConfig()`:

```typescript
private topicManager: TelegramTopicManager;

// In constructor:
this.topicManager = new TelegramTopicManager({
  managerId: this.managerId,
  dataDir: options.dataDir,
  getTelegramClient: () => this.telegramClient,
  getSwarmManager: () => this.swarmManager
});

// In applyConfig(), after client creation and before router/delivery setup:
await this.topicManager.initialize();

// Pass to router:
this.inboundRouter = new TelegramInboundRouter({
  // ... existing options
  topicManager: this.topicManager  // NEW
});

// Pass to delivery bridge (constructor):
this.deliveryBridge = new TelegramDeliveryBridge({
  // ... existing options
  topicManager: this.topicManager  // NEW
});
```

Expose topic manager for Phase 3 lifecycle hooks:

```typescript
getTopicManager(): TelegramTopicManager {
  return this.topicManager;
}
```

---

## Phase 3: Session Lifecycle Sync

### Approach: Event Listener on SwarmManager

The integration service already has a `swarmManager` reference. Listen for the `agents_snapshot` events that are emitted after every session lifecycle change, or more directly, add targeted session lifecycle events.

**Simpler approach:** Add session lifecycle hooks in the WS route handlers that call back into the integration registry. The routes already have access to `swarmManager`.

**Recommended approach:** Have `TelegramIntegrationService` subscribe to swarm manager events. The swarm manager emits `agents_snapshot` after creates/deletes/renames — but this is too coarse. Instead, add lightweight session lifecycle events.

### 3.1 Add Session Lifecycle Events to SwarmManager

**File: `apps/backend/src/swarm/swarm-manager.ts`**

After each session lifecycle operation, emit a typed event the integration can listen for:

```typescript
// In createSession(), after saveStore():
this.emit("session_lifecycle", {
  action: "created",
  sessionAgentId: sessionDescriptor.agentId,
  profileId: prepared.profile.profileId,
  label: sessionDescriptor.sessionLabel
});

// In deleteSession(), after saveStore():
this.emit("session_lifecycle", {
  action: "deleted",
  sessionAgentId: agentId,
  profileId: descriptor.profileId
});

// In renameSession(), after saveStore():
this.emit("session_lifecycle", {
  action: "renamed",
  sessionAgentId: agentId,
  profileId: descriptor.profileId,
  label: normalizedLabel
});

// In forkSession(), after saveStore():
this.emit("session_lifecycle", {
  action: "forked",
  sessionAgentId: forkedDescriptor.agentId,
  sourceAgentId: sourceDescriptor.agentId,
  profileId: profile.profileId,
  label: forkedDescriptor.sessionLabel
});
```

### 3.2 Listen in Integration Service

**File: `apps/backend/src/integrations/telegram/telegram-integration.ts`**

```typescript
private readonly onSessionLifecycle = (event: {
  action: "created" | "deleted" | "renamed" | "forked";
  sessionAgentId: string;
  profileId?: string;
  sourceAgentId?: string;
  label?: string;
}): void => {
  // Only handle events for our profile
  if (event.profileId !== this.managerId) return;
  if (!this.config.enabled || !this.telegramClient) return;

  void this.handleSessionLifecycle(event);
};

private async handleSessionLifecycle(event: SessionLifecycleEvent): Promise<void> {
  try {
    switch (event.action) {
      case "renamed":
        if (event.label) {
          await this.topicManager.renameTopicForSession(event.sessionAgentId, event.label);
        }
        break;

      case "deleted":
        await this.topicManager.closeTopicForSession(event.sessionAgentId);
        break;

      case "forked":
        if (event.sourceAgentId && event.label) {
          await this.topicManager.createTopicForFork(
            event.sourceAgentId,
            event.sessionAgentId,
            `🔀 ${event.label}`
          );
        }
        break;

      // "created" — topic created lazily on first outbound message (Phase 2)
    }
  } catch (error) {
    // Log but don't fail — topic sync is best-effort
    this.onError?.("Failed to sync Telegram topic", error);
  }
}

// In applyConfig():
this.swarmManager.on("session_lifecycle", this.onSessionLifecycle);

// In stopRuntime():
this.swarmManager.off("session_lifecycle", this.onSessionLifecycle);
```

### 3.3 Topic Manager Lifecycle Methods

**File: `apps/backend/src/integrations/telegram/telegram-topic-manager.ts`**

```typescript
async renameTopicForSession(sessionAgentId: string, newName: string): Promise<void> {
  // Find all mappings for this session (could be in multiple chats)
  const mappings = this.store.mappings.filter(
    (m) => m.sessionAgentId === sessionAgentId
  );

  const client = this.getTelegramClient();
  if (!client) return;

  for (const mapping of mappings) {
    try {
      await client.editForumTopic({
        chatId: mapping.chatId,
        messageThreadId: mapping.messageThreadId,
        name: newName.slice(0, 128)
      });
      mapping.topicName = newName;
    } catch {
      // Topic may have been deleted externally — ignore
    }
  }

  await saveTopicStore(this.dataDir, this.managerId, this.store);
}

async closeTopicForSession(sessionAgentId: string): Promise<void> {
  const removed = removeTopicMapping(this.store, sessionAgentId);
  if (!removed) return;

  const client = this.getTelegramClient();
  if (!client) return;

  try {
    await client.closeForumTopic({
      chatId: removed.chatId,
      messageThreadId: removed.messageThreadId
    });
  } catch {
    // Best-effort
  }

  await saveTopicStore(this.dataDir, this.managerId, this.store);
}

async createTopicForFork(
  _sourceAgentId: string,
  forkAgentId: string,
  forkLabel: string
): Promise<void> {
  // Source's chat ID is needed — find from source's mapping
  const sourceMappings = this.store.mappings.filter(
    (m) => m.sessionAgentId === _sourceAgentId
  );

  const client = this.getTelegramClient();
  if (!client || sourceMappings.length === 0) return;

  for (const sourceMapping of sourceMappings) {
    try {
      const topic = await client.createForumTopic({
        chatId: sourceMapping.chatId,
        name: forkLabel.slice(0, 128)
      });

      addTopicMapping(this.store, {
        sessionAgentId: forkAgentId,
        chatId: sourceMapping.chatId,
        messageThreadId: topic.message_thread_id,
        topicName: forkLabel,
        createdAt: new Date().toISOString()
      });
    } catch {
      // Topics may not be supported — ignore
    }
  }

  await saveTopicStore(this.dataDir, this.managerId, this.store);
}
```

---

## Phase 4: Integration Awareness in System Prompt

### Goal

Agents should know about configured integrations even when a conversation starts from the web UI. This lets the manager proactively reach out via Telegram when relevant.

### Approach

Inject an integration context block into the manager's system prompt at runtime, similar to how `[sourceContext]` is injected per-message.

### 4.1 Integration Context Provider

**New file: `apps/backend/src/integrations/integration-context.ts`**

```typescript
export interface IntegrationContextInfo {
  telegram?: {
    enabled: boolean;
    botUsername?: string;
    knownChatIds: string[];
  };
  slack?: {
    enabled: boolean;
    knownChannelIds: string[];
  };
}

export function formatIntegrationContext(info: IntegrationContextInfo): string {
  const lines: string[] = [];

  if (info.telegram?.enabled) {
    lines.push(`## Telegram Integration`);
    lines.push(`- Status: connected`);
    if (info.telegram.botUsername) {
      lines.push(`- Bot: @${info.telegram.botUsername}`);
    }
    if (info.telegram.knownChatIds.length > 0) {
      lines.push(`- Known chat IDs: ${info.telegram.knownChatIds.join(", ")}`);
      lines.push(`- You can proactively send messages via speak_to_user with target: { channel: "telegram", channelId: "<chat_id>" }`);
    }
  }

  if (info.slack?.enabled) {
    lines.push(`## Slack Integration`);
    lines.push(`- Status: connected`);
    if (info.slack.knownChannelIds.length > 0) {
      lines.push(`- Known channel IDs: ${info.slack.knownChannelIds.join(", ")}`);
      lines.push(`- You can proactively send messages via speak_to_user with target: { channel: "slack", channelId: "<channel_id>" }`);
    }
  }

  if (lines.length === 0) return "";

  return `\n# Active Integrations\n${lines.join("\n")}\n`;
}
```

### 4.2 Expose Known Chat IDs from Integration Service

**File: `apps/backend/src/integrations/telegram/telegram-integration.ts`**

```typescript
getKnownChatIds(): string[] {
  return [...new Set(
    this.topicManager.getStore().mappings.map((m) => m.chatId)
  )];
}

getBotUsername(): string | undefined {
  return this.botUsername;
}

isConnected(): boolean {
  return this.config.enabled && this.telegramClient !== null;
}
```

### 4.3 Registry Exposes Integration Context

**File: `apps/backend/src/integrations/registry.ts`**

```typescript
getIntegrationContext(managerId: string): IntegrationContextInfo {
  const normalizedManagerId = normalizeManagerId(managerId);

  const telegramProfile = this.telegramProfiles.get(normalizedManagerId);
  const slackProfile = this.slackProfiles.get(normalizedManagerId);

  return {
    telegram: telegramProfile?.isConnected() ? {
      enabled: true,
      botUsername: telegramProfile.getBotUsername(),
      knownChatIds: telegramProfile.getKnownChatIds()
    } : undefined,
    slack: slackProfile?.isConnected() ? {
      enabled: true,
      knownChannelIds: slackProfile.getKnownChannelIds()
    } : undefined
  };
}
```

### 4.4 Inject Into System Prompt

**File: `apps/backend/src/swarm/swarm-manager.ts`**

In `resolveSystemPromptForDescriptor()`, for managers:

```typescript
private resolveSystemPromptForDescriptor(descriptor: AgentDescriptor): string {
  if (descriptor.role === "manager") {
    const managerArchetypeId = descriptor.archetypeId
      ? normalizeArchetypeId(descriptor.archetypeId) ?? MANAGER_ARCHETYPE_ID
      : MANAGER_ARCHETYPE_ID;
    let prompt = this.resolveRequiredArchetypePrompt(managerArchetypeId);

    // Inject integration context if available
    const profileId = descriptor.profileId ?? descriptor.agentId;
    const integrationContext = this.getIntegrationContext(profileId);
    if (integrationContext) {
      prompt += `\n\n${integrationContext}`;
    }

    return prompt;
  }
  // ... rest unchanged
}
```

The `getIntegrationContext` method needs access to the integration registry. Currently the swarm manager doesn't hold a reference to the registry. Two options:

**Option A (preferred): Callback injection.** Add an optional callback during swarm manager initialization:

```typescript
// In SwarmManager constructor or config:
private integrationContextProvider?: (profileId: string) => string;

setIntegrationContextProvider(provider: (profileId: string) => string): void {
  this.integrationContextProvider = provider;
}

// In resolveSystemPromptForDescriptor:
const integrationContext = this.integrationContextProvider?.(profileId) ?? "";
```

Wire it in the application bootstrap (where the registry and swarm manager are both created):

```typescript
// In app startup:
swarmManager.setIntegrationContextProvider((profileId) => {
  const info = integrationRegistry.getIntegrationContext(profileId);
  return formatIntegrationContext(info);
});
```

**Option B: Pass registry reference.** Slightly more coupling but simpler. Given the project's existing patterns of dependency injection via constructor options, Option A is cleaner.

---

## Implementation Order

```
Phase 1: SKIP (already fixed)
    │
Phase 2: Topic Routing
    ├── 2.1 Client API methods (telegram-client.ts)
    ├── 2.2 Topic store (NEW: telegram-topic-store.ts)
    ├── 2.3 Topic manager (NEW: telegram-topic-manager.ts)
    ├── 2.4 Inbound router update (telegram-router.ts)
    ├── 2.5 Outbound delivery update (telegram-delivery.ts)
    └── 2.6 Integration service wiring (telegram-integration.ts)
    │
Phase 3: Lifecycle Sync (depends on Phase 2)
    ├── 3.1 Session lifecycle events (swarm-manager.ts)
    ├── 3.2 Integration listener (telegram-integration.ts)
    └── 3.3 Topic manager lifecycle methods (telegram-topic-manager.ts)
    │
Phase 4: Integration Awareness (independent, can parallel with 2/3)
    ├── 4.1 Integration context formatter (NEW: integration-context.ts)
    ├── 4.2 Expose state from integration services
    ├── 4.3 Registry context method (registry.ts)
    └── 4.4 System prompt injection (swarm-manager.ts)
```

## Files Changed / Created

| File | Action | Phase |
|------|--------|-------|
| `apps/backend/src/integrations/telegram/telegram-client.ts` | Modify — add `messageThreadId`, forum topic methods | 2 |
| `apps/backend/src/integrations/telegram/telegram-topic-store.ts` | **New** — mapping persistence | 2 |
| `apps/backend/src/integrations/telegram/telegram-topic-manager.ts` | **New** — topic orchestration | 2, 3 |
| `apps/backend/src/integrations/telegram/telegram-router.ts` | Modify — topic→session routing | 2 |
| `apps/backend/src/integrations/telegram/telegram-delivery.ts` | Modify — session→topic delivery | 2 |
| `apps/backend/src/integrations/telegram/telegram-integration.ts` | Modify — wire topic manager, lifecycle listener | 2, 3 |
| `apps/backend/src/integrations/telegram/telegram-types.ts` | Modify — add `ForumTopic` type | 2 |
| `apps/backend/src/swarm/swarm-manager.ts` | Modify — session lifecycle events, integration context injection | 3, 4 |
| `apps/backend/src/integrations/integration-context.ts` | **New** — context formatter | 4 |
| `apps/backend/src/integrations/registry.ts` | Modify — add `getIntegrationContext()` | 4 |

---

## Backward Compatibility

- **No topics enabled:** `createForumTopic` fails → caught → `resolveTopicForSession` returns `undefined` → `messageThreadId` omitted from `sendMessage` → flat chat, exactly like today.
- **Single session:** Root session maps to no topic (General/flat). No topic operations happen. Zero behavioral change.
- **Existing config:** No new required config fields. Topic store is created on first use.
- **No integration configured:** `integrationContextProvider` returns empty string. No system prompt change.

---

## Edge Cases

| Case | Handling |
|------|----------|
| Topic deleted externally | `sendMessage` with stale `messageThreadId` fails → catch, clear mapping, retry without thread |
| Chat doesn't support topics | `createForumTopic` throws → return undefined → flat delivery |
| User sends in General topic | `message_thread_id` absent or =1 → routes to root session |
| User sends in unknown topic | No mapping found → routes to root session |
| Bot lacks `can_manage_topics` right | `createForumTopic` throws → graceful fallback |
| Multiple chats with same bot | Each chat gets independent topic mappings (keyed by chatId) |

---

## Telegram User Setup (Handoff)

### For Private DM Topics (Bot API 9.3+)

1. **Enable topics in bot DM:** Open the bot DM in Telegram → tap bot name → "Topics" toggle → enable. (This is a client-side setting, available in Telegram 10.x+ clients.)
2. **BotFather setting (optional):** Send `/mybots` → select bot → "Bot Settings" → "Manage Topics in Private Chats" → enable "Only bot can manage topics" to prevent users from creating/deleting topics manually.

### For Group/Supergroup Topics

1. **Convert to forum:** Group settings → "Topics" → enable. (Group must be a supergroup.)
2. **Add bot as admin:** Bot needs `can_manage_topics` permission to create/rename/close topics.
3. **Bot must be admin** with at least: `can_manage_topics`, `can_delete_messages` (for topic deletion).

### What Middleman Does Automatically

- Creates a topic for each new session on first outbound message
- Names topics after session labels
- Renames topics when sessions are renamed
- Closes topics when sessions are deleted
- Creates fork-indicator topics for forked sessions

### Fallback Behavior

If topics aren't enabled or the bot lacks permissions, everything works exactly like before — single flat chat, all sessions share it. The user doesn't need to configure anything for the basic experience.

---

## Testing Checklist

- [ ] Root session messages deliver to flat chat (no topic) — existing behavior preserved
- [ ] Non-root session first outbound creates topic + delivers to it
- [ ] Subsequent outbound to same session reuses existing topic
- [ ] Inbound from topic routes to correct session
- [ ] Inbound from General/flat routes to root session
- [ ] Session rename → topic renamed in Telegram
- [ ] Session delete → topic closed in Telegram
- [ ] Session fork → new topic created with fork indicator
- [ ] Topics not supported → graceful fallback to flat chat
- [ ] `createForumTopic` failure → no crash, falls back silently
- [ ] Integration context appears in system prompt when Telegram is configured
- [ ] Integration context absent when Telegram is not configured
- [ ] Multiple chats with same bot work independently
- [ ] TypeScript typecheck passes: `pnpm exec tsc --noEmit`
