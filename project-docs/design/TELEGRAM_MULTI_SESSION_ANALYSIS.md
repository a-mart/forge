# Telegram Integration × Multi-Session Architecture — Analysis

**Date:** 2026-03-02  
**Status:** Investigation complete — proposed solutions for review

---

## 1. Current State

### 1.1 Integration Architecture

One `TelegramIntegrationService` instance is created per **manager ID** (which, in the multi-session model, is the **profile ID** / root manager agent). The registry discovers managers and creates integration profiles keyed by this ID.

**Key files:**
- `apps/backend/src/integrations/telegram/telegram-integration.ts` — lifecycle, config, wiring
- `apps/backend/src/integrations/telegram/telegram-router.ts` — inbound message routing
- `apps/backend/src/integrations/telegram/telegram-delivery.ts` — outbound message delivery
- `apps/backend/src/integrations/telegram/telegram-polling.ts` — long-polling loop
- `apps/backend/src/integrations/telegram/telegram-client.ts` — raw Bot API HTTP client
- `apps/backend/src/integrations/registry.ts` — manages per-manager integration instances

### 1.2 Inbound Flow (Telegram → Swarm)

```
Telegram API
  → TelegramPollingBridge.pollLoop()        [telegram-polling.ts]
    → TelegramInboundRouter.handleUpdate()  [telegram-router.ts:42]
      → swarmManager.handleUserMessage()    [telegram-router.ts:82]
```

The router builds a `MessageSourceContext` with:
```typescript
const sourceContext: MessageSourceContext = {
  channel: "telegram",
  channelId: String(message.chat.id),
  userId: message.from ? String(message.from.id) : undefined,
  messageId: String(message.message_id),
  integrationProfileId: this.integrationProfileId,
  threadTs: message.message_thread_id ? String(message.message_thread_id) : undefined,
  channelType: resolveChannelType(message.chat.type)  // "dm" | "channel" | "group"
};
```

**Critical:** the router calls `handleUserMessage` with `targetAgentId: this.managerId`:
```typescript
await this.swarmManager.handleUserMessage(text, {
  targetAgentId: this.managerId,   // ← always the profile/root manager
  attachments,
  sourceContext
});
```

### 1.3 Outbound Flow (Swarm → Telegram)

```
SwarmManager.emit("conversation_message", event)
  → TelegramDeliveryBridge.onConversationMessage()    [telegram-delivery.ts:31]
    → TelegramDeliveryBridge.forwardConversationMessage()
      → telegramClient.sendMessage()                  [telegram-client.ts:107]
```

The delivery bridge filters events through these gates (`telegram-delivery.ts:52-78`):

```typescript
// Gate 1: only telegram-sourced messages
if (!event.sourceContext || event.sourceContext.channel !== "telegram") return;

// Gate 2: skip user_input echo
if (event.source === "user_input") return;

// Gate 3: config check
if (!config.enabled) return;

// Gate 4: agent ID must match this integration's manager ID
if (event.agentId !== this.managerId) return;    // ← THE CRITICAL FILTER

// Gate 5: profile ID match
if (eventProfileId && profileId && eventProfileId !== profileId) return;

// Gate 6: client available
if (!telegramClient) return;

// Gate 7: channelId present
if (!channelId) return;
```

### 1.4 How the Manager Generates Replies

When the manager's LLM calls `speak_to_user` (`swarm-tools.ts:197-230`), it invokes `SwarmManager.publishToUser()` (`swarm-manager.ts:1406`). This emits a `conversation_message` event with:
- `agentId` = the calling agent's ID (the session agent)
- `source` = `"speak_to_user"`
- `sourceContext` = resolved from the target context passed by the LLM tool call

The inbound `sourceContext` (with `channel: "telegram"`, `channelId`, etc.) is injected into the manager's prompt as `[sourceContext] {"channel":"telegram","channelId":"123",...}` (`swarm-manager.ts:3128-3133`). The manager LLM is expected to pass this back through the `speak_to_user` tool's `target` parameter.

### 1.5 Session Agent IDs

In multi-session, sessions have IDs formatted as:
- **Root session:** `{profileId}` (e.g., `my-manager`)
- **Additional sessions:** `{profileId}--s{N}` (e.g., `my-manager--s2`, `my-manager--s3`)

The integration's `this.managerId` is always the **profile ID** (`my-manager`).

---

## 2. What's Broken

### 2.1 Outbound: Gate 4 Silently Drops Non-Root Session Messages

**This is the primary bug causing unreliable delivery.**

When session `my-manager--s2` calls `speak_to_user`, the emitted event has `agentId: "my-manager--s2"`. The delivery bridge checks:

```typescript
if (event.agentId !== this.managerId) return;  // "my-manager--s2" !== "my-manager" → DROPPED
```

**Result:** All `speak_to_user` messages from non-root sessions are silently dropped. Only the root session's messages reach Telegram.

The Slack integration (`slack-delivery.ts:67`) has the **exact same bug** — identical filter logic.

### 2.2 Inbound: Always Targets Root Session

The inbound router hardcodes:

```typescript
await this.swarmManager.handleUserMessage(text, {
  targetAgentId: this.managerId,  // always routes to root session
  ...
});
```

There is no mechanism to route an inbound Telegram message to a specific non-root session. Every message goes to the root session.

**Combined effect:** If a user creates a second session, messages from that session never reach Telegram. If the user tries to reply in Telegram to something the second session said (which they can't, since they never see it), the reply would go to the root session anyway.

### 2.3 No Session Awareness Whatsoever

The integration was written before multi-session existed. It has:
- No concept of "which session" a message belongs to
- No mapping between Telegram threads/chats and sessions
- No way for the user to select or switch sessions from Telegram
- No session label or identifier in outbound messages

### 2.4 Race Condition: Concurrent speak_to_user Calls

Even if Gate 4 were fixed, multiple sessions could be simultaneously trying to `speak_to_user` with `channel: "telegram"`. Since they all target the same Telegram chat with no threading:
- Messages from different sessions would interleave in unpredictable order
- No visual indicator which session produced which message
- Replies from the user would be ambiguous

---

## 3. Telegram Bot API Capabilities

### 3.1 Forum Topics in Groups (Bot API 6.3+, June 2022)

Supergroups can be converted to **forums** with multiple **topics**. Each topic is an independent message thread with its own name and icon.

- **`createForumTopic`** — Create a new topic in a forum supergroup. Returns a `ForumTopic` with a `message_thread_id`.
- **`editForumTopic`** — Rename, change icon, close/reopen a topic.
- **`deleteForumTopic`** — Delete a topic and all its messages.
- **`sendMessage` with `message_thread_id`** — Send to a specific topic.
- **Inbound messages** include `message_thread_id` and `is_topic_message: true` when sent in a topic.
- Every forum has a non-deletable **"General" topic** with `id=1`.
- Bot needs `can_manage_topics` admin right to create/manage topics.

### 3.2 Forum Topics in Private Chats (Bot API 9.3, Dec 2025)

**New and highly relevant.** Bots can now have forum-style topics in 1:1 private DM chats:

- `has_topics_enabled` field on `User` — indicates if forum mode is active for this bot's DM.
- `message_thread_id` and `is_topic_message` fields work in private chat messages.
- `sendMessage` with `message_thread_id` works in private chats with topics enabled.
- **Bot API 9.4 (Feb 2026):** `createForumTopic` now works in private chats — bots can programmatically create topics in DMs.
- Bot can prevent users from creating/deleting topics (BotFather setting).

**This is the ideal primitive for session separation in DMs.** One Telegram DM → one topic per session.

### 3.3 message_thread_id Parameter

The universal threading mechanism. Available on `sendMessage`, `sendPhoto`, `sendDocument`, etc. When included:
- In a forum group: delivers to the specified topic
- In a private chat with topics: delivers to the specified topic
- Inbound updates include `message_thread_id` so the bot knows which topic the user is writing in

### 3.4 reply_to_message_id (Basic Reply Threading)

Standard reply mechanism in any chat. Not true topic isolation — replies are visible in the main chat timeline. Less suitable for session separation but usable as a lightweight fallback.

### 3.5 sendMessageDraft (Bot API 9.3)

New method allowing streaming/draft messages. Could be useful for showing the manager "is thinking" state, but orthogonal to the routing problem.

---

## 4. Proposed Approaches

### 4.1 Option A: Fix the Agent ID Filter (Minimal Fix)

**Change:** In `telegram-delivery.ts` (and `slack-delivery.ts`), replace the exact agent ID match with a profile-aware check.

```typescript
// Before:
if (event.agentId !== this.managerId) return;

// After: accept any session that belongs to this profile
const descriptor = this.swarmManager.getAgentDescriptor(event.agentId);
if (!descriptor || descriptor.profileId !== this.managerId) return;
```

Or simpler — check if `agentId === managerId` or `agentId.startsWith(managerId + "--s")`.

**Pros:**
- Minimal code change (< 10 lines per integration)
- Fixes the silent drop immediately
- No Telegram API changes needed

**Cons:**
- All sessions still dump into one flat Telegram chat
- No visual separation — messages from different sessions interleave
- Inbound still goes to root session only
- Doesn't solve the "which session am I talking to?" problem

**Verdict:** Necessary as an immediate bugfix, but insufficient as the full solution.

### 4.2 Option B: Telegram Topics = Sessions (Recommended)

Map each middleman session to a Telegram forum topic. Use the Bot API 9.3/9.4 private-chat topics for DMs, or group forum topics for group-based setups.

**How it works:**

1. **Session creation** → call `createForumTopic` with the session label as the topic name. Store the returned `message_thread_id` in the session's metadata (or in a lightweight mapping in the integration config).

2. **Outbound delivery** → when forwarding a `conversation_message`, look up the session's `message_thread_id` and include it in `sendMessage`.

3. **Inbound routing** → incoming messages include `message_thread_id`. Look up which session maps to that topic, and call `handleUserMessage` with that session's `targetAgentId` instead of always the root.

4. **Root/default session** → maps to the "General" topic (`message_thread_id=1`) or an explicitly created "Main" topic.

5. **Session deletion** → optionally close the topic via `editForumTopic(closed: true)` or leave it for history.

**Schema addition** — session-to-topic mapping (in integration config or separate file):
```typescript
interface TelegramSessionTopicMapping {
  sessionAgentId: string;
  chatId: string;
  messageThreadId: number;
  topicName: string;
}
```

**Pros:**
- Clean visual separation — each session is its own Telegram topic
- Users can naturally reply within the right session
- Inbound routing is unambiguous (topic → session)
- Leverages brand-new Telegram features designed exactly for this
- Works in both DMs (9.3+) and groups (6.3+)
- Session labels become topic names — easy to navigate

**Cons:**
- Requires the user to have topics enabled in their DM with the bot (9.3 feature, relatively new)
- Group forum setup requires the group to be a supergroup with forums enabled
- Adds complexity: topic lifecycle management, mapping persistence, edge cases (topic deleted externally, etc.)
- Need to handle the case where topics aren't available (fallback to flat chat)

**Verdict:** The elegant, correct solution. Aligns perfectly with middleman's session model. Requires Option A as a prerequisite (for the case where topics aren't available).

### 4.3 Option C: Prefix-Based Routing (No API Dependencies)

Keep a single flat chat. Add session metadata to messages.

**Outbound:** Prefix all messages with the session label:
```
[📋 Code Review] Here's what I found in the PR...
```

**Inbound:** Support a command to select the active session:
```
/session Code Review
/session 2
```

Or use a reply-based heuristic: if the user replies to a message from session X, route to session X.

**Pros:**
- Works with any Telegram chat type, no feature requirements
- Simple implementation
- No API dependencies beyond what we already use

**Cons:**
- Ugly — pollutes messages with metadata
- Reply-based heuristic is fragile (what if the user doesn't reply, just sends a new message?)
- `/session` command UX is clunky
- Interleaved messages from concurrent sessions are still confusing
- Feels like a workaround, not a solution

**Verdict:** Acceptable as a temporary measure or fallback mode. Not the right long-term answer.

### 4.4 Option D: One Bot Per Session (Rejected)

Create separate Telegram bots for each session.

**Verdict:** Rejected outright. Terrible UX (user manages multiple bots), operational overhead (multiple tokens), goes against the single-integration-profile model.

---

## 5. Recommendation

**Phased approach:**

### Phase 1: Immediate Bugfix (Option A)
Fix the `agentId` filter in both `telegram-delivery.ts` and `slack-delivery.ts`. This is a ~10-line change that unblocks outbound delivery for all sessions immediately. No new features, just fixing the regression.

### Phase 2: Topic-Based Session Routing (Option B)
Implement full session-to-topic mapping:
1. Add `message_thread_id` support to `TelegramBotApiClient.sendMessage()` and `createForumTopic()` to the client.
2. Add session-topic mapping persistence (lightweight JSON alongside existing config).
3. Wire topic creation into session lifecycle events (listen for `session_created` on the swarm manager).
4. Update `TelegramDeliveryBridge` to resolve the session's topic before sending.
5. Update `TelegramInboundRouter` to resolve topic → session before calling `handleUserMessage`.
6. Add graceful fallback: if topics aren't available, fall back to Phase 1 behavior (flat chat, all sessions).

### Phase 3: UX Polish
- Session label changes → `editForumTopic` to rename
- Session deletion → close the topic
- Session fork → create a new topic with "[Fork] " prefix
- Status indicators in topic names (emoji prefix for active/idle?)

### Implementation Notes
- The `message_thread_id` field is already captured in the inbound router's `sourceContext.threadTs` — this was prescient. The plumbing exists; we just need to use it for routing.
- The `TelegramSendMessageInput` type needs a `messageThreadId?: number` field.
- The Slack integration has the same Gate 4 bug and would benefit from the same Phase 1 fix. Slack's thread model (channel threads) could be used for a similar Phase 2, but that's a separate investigation.
- All changes are backward-compatible. Existing single-session setups with no topics enabled continue to work.

---

## 6. Impact Summary

| Issue | Severity | Fix Phase |
|-------|----------|-----------|
| Outbound messages from non-root sessions silently dropped | **Critical** | Phase 1 |
| Inbound messages always route to root session | **High** | Phase 2 |
| No visual separation between sessions in Telegram | Medium | Phase 2 |
| Interleaved messages from concurrent sessions | Medium | Phase 2 |
| Same bugs exist in Slack integration | High | Phase 1 |
| No session lifecycle events in Telegram (create/delete/rename) | Low | Phase 3 |
