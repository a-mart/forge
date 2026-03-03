# Telegram Polling Pool & Topic-Per-Session Design

## Problem

Currently each manager profile creates its own `TelegramIntegrationService` with its own `TelegramPollingBridge`. When multiple profiles share the same bot token, only one poller receives updates (Telegram's `getUpdates` is single-consumer per token). This means inbound messages only reach one profile.

Additionally, root sessions send to flat chat (no topic), making it ambiguous which profile a flat-chat reply is intended for.

## Goals

1. **One poller per unique bot token** — shared across all profiles using that token
2. **Topic for every session** — including root sessions, eliminating flat-chat ambiguity
3. **Cross-profile inbound routing** — updates dispatched to the correct profile+session based on topic mapping

## Design

### 1. TelegramPollingPool

New file: `apps/backend/src/integrations/telegram/telegram-polling-pool.ts`

```typescript
class TelegramPollingPool {
  // Map: botToken → { poller, consumers: Map<managerId, ConsumerEntry> }
  // ConsumerEntry: { managerId, topicManager, router, config getter }
  
  register(botToken: string, consumer: PoolConsumer): void
  unregister(botToken: string, managerId: string): void
  
  // Internal: starts/stops pollers as consumers come and go
  private ensurePoller(botToken: string): void
  private removePollerIfEmpty(botToken: string): void
  
  // Dispatch logic per update:
  private dispatch(botToken: string, update: TelegramUpdate): void
}
```

**Dispatch logic:**
1. Extract `chat.id` and `message_thread_id` from update
2. If `message_thread_id` present: query each consumer's `topicManager.resolveSessionForTopic(chatId, threadId)` — first match wins, dispatch to that consumer's router
3. If no `message_thread_id` (flat chat): dispatch to a **default consumer** for that chat (see below)
4. If no consumer matches: drop the update (or log)

**Default consumer for flat chat:**
- Each chat can have a "default profile" — the first profile that sent an outbound message to that chat
- Tracked in a simple `Map<chatId, managerId>` within the pool, populated when consumers register
- Alternatively: just pick the first registered consumer (deterministic enough for now)

### 2. Root Sessions Get Topics

In `TelegramTopicManager.resolveTopicForSession()`, remove the early return for root sessions:

```typescript
// REMOVE this check:
if (normalizedSessionAgentId === this.managerId) {
  return undefined;
}
```

Topic name for root session: use the profile's display name or session label. Format: `"📋 {profileName}"` or just `"{sessionLabel}"`.

When the first outbound message from a root session triggers topic creation, subsequent outbound messages and inbound replies all use that topic.

### 3. Integration Service Changes

`TelegramIntegrationService.applyConfig()` changes:
- **Remove**: Direct `TelegramPollingBridge` creation
- **Add**: Register with the shared `TelegramPollingPool` 
- Pool is passed in via constructor (from registry)
- On `stop()`: unregister from pool

The service still owns:
- `TelegramBotApiClient` (for outbound delivery + topic API calls)
- `TelegramInboundRouter` (receives dispatched updates from pool)
- `TelegramTopicManager` (per-profile topic store — unchanged)
- `TelegramDeliveryBridge` (outbound — unchanged)

### 4. Registry Changes

`IntegrationRegistryService`:
- Creates and owns a single `TelegramPollingPool` instance
- Passes it to each `TelegramIntegrationService` via constructor
- Pool lifecycle tied to registry start/stop

### 5. Inbound Router Changes

`TelegramInboundRouter`:
- Remove internal dedup (`seenUpdateIds`) — dedup moves to pool level
- `handleUpdate()` stays the same otherwise (allowlist check, text extraction, `handleUserMessage`)

### 6. Topic Store

No structural changes needed. Each profile keeps its own per-profile topic store. The pool queries across all consumers' topic managers for routing.

**Future optimization**: If profile count grows large, consolidate into a single global store. Not needed now.

## Flow: Outbound Message

1. Agent calls `speak_to_user` with `target: { channel: "telegram", channelId: "..." }`
2. `TelegramDeliveryBridge.forwardConversationMessage()` fires
3. Calls `topicManager.resolveTopicForSession(agentId, chatId)`
4. **Root session**: No longer returns `undefined` — creates topic lazily (same as non-root)
5. Sends message with `messageThreadId` to the topic

## Flow: Inbound Message

1. Pool's single poller receives update via `getUpdates`
2. Pool extracts `chatId` + `messageThreadId`
3. Pool iterates registered consumers, checks `consumer.topicManager.resolveSessionForTopic(chatId, threadId)`
4. First match → dispatch to that consumer's `router.handleUpdate(update)`
5. No match + no threadId → dispatch to default consumer
6. Consumer's router does allowlist check, extracts text, calls `swarmManager.handleUserMessage()`

## File Changes Summary

| File | Change |
|------|--------|
| `telegram-polling-pool.ts` | **NEW** — pool with register/unregister/dispatch |
| `telegram-integration.ts` | Remove direct PollingBridge creation, register with pool |
| `telegram-topic-manager.ts` | Remove root session early-return in `resolveTopicForSession` |
| `telegram-router.ts` | Remove internal dedup (pool handles it) |
| `registry.ts` | Create/own pool, pass to integration services |
| `telegram-polling.ts` | Unchanged (pool uses it internally) |
| `telegram-delivery.ts` | Unchanged (already works with topics) |
| `telegram-topic-store.ts` | Unchanged |

## Edge Cases

- **First message before any topic exists**: If a user sends to flat chat before any outbound, pool routes to default consumer. That consumer's root session handles it. The next outbound reply creates the root topic, and future messages land there.
- **Same chatId, multiple profiles**: Each profile's root session gets a distinct topic in the same chat. Topics are visually labeled with profile/session name.
- **Consumer removed (profile disabled)**: Pool unregisters consumer. If that consumer had the only topic match for a thread, messages to that thread are dropped (or logged). This is correct — disabled profiles shouldn't receive messages.
- **Bot token change**: Consumer unregisters from old token's poller, registers with new one. Pool cleans up empty pollers.
