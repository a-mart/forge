# Telegram Notification Quick-Win Analysis

## 1) What exists today

### Telegram bridge architecture (current)
- **Inbound path**
  - `telegram-polling-pool.ts` / `telegram-polling.ts` polls Bot API `getUpdates`.
  - `telegram-router.ts` converts Telegram update → `swarmManager.handleUserMessage(...)` with `sourceContext.channel = "telegram"`, plus `channelId`, `userId`, `messageId`, `threadTs`, `integrationProfileId`.
- **Outbound path**
  - `telegram-delivery.ts` (`TelegramDeliveryBridge`) listens to `swarmManager` **`conversation_message`** events.
  - It forwards only messages where:
    - `event.sourceContext.channel === "telegram"`
    - `event.source !== "user_input"`
    - manager/profile checks pass
  - It sends via `TelegramBotApiClient.sendMessage(...)`, optionally threaded via `TelegramTopicManager.resolveTopicForSession(...)`.

### Important behavior already enforced
- `speak_to_user` defaults to `{ channel: "web" }` unless explicit target is set (`swarm-manager.ts`, `resolveReplyTargetContext`).
- So today, Telegram outbound is **reply-to-Telegram-channel only**, not generic notifications.

### WS/backend event hook points
- `apps/backend/src/ws/server.ts`
  - broadcasts `conversation_message`
  - emits `unread_notification` when `assistant + speak_to_user`
  - broadcasts `agent_status` but does not act on it
- Protocol already has what we need (`packages/protocol/src/server-events.ts`):
  - `conversation_message`
  - `agent_status`

---

## 2) Minimal path to notifications

## Smallest real change for v0
Use existing Telegram delivery bridge and add one new path:

- On `conversation_message` where:
  - `source === "speak_to_user"`
  - `role === "assistant"`
  - `sourceContext.channel === "web"` (so this is a web/UI completion, not a Telegram echo)
- Send a short Telegram message to DM target(s) with session deep-link.

Why this is the smallest:
- No new service, no new protocol event, no new queue, no scheduler.
- Reuses existing `TelegramBotApiClient`, config lifecycle, profile scoping, and bridge listener.
- No `ws/server.ts` plumbing required.

### Candidate code path
- `apps/backend/src/integrations/telegram/telegram-delivery.ts`
  - extend `forwardConversationMessage(...)` with an additional branch for web-origin `speak_to_user` notifications
  - format text + link
  - call `sendMessage(...)` for notification recipient(s)

### “Session finished” interpretation for v0
For this quick-win, treat **manager `speak_to_user`** as completion signal. In practice that is when user-visible work result is ready. It avoids noisy/ambiguous `agent_status` idle transitions.

---

## 3) What we should NOT do in v0

Avoid these now (from research doc “phase” ideas):
- Full notification preference model (channels/triggers matrix)
- Quiet hours
- Debounce/batching/summarization
- New `send_notification` tool
- Web Push/PWA/service worker/VAPID pipeline
- Multi-device subscription management UI
- iOS cold-start deep-link workaround work

These are valid later, but all are extra surface area. v0 should be one direct Telegram send on one clear trigger.

---

## 4) Deep-link format

## What works today in app routing
- Supported today:
  - `/?agent=<agentId>` → open that session
  - `/?view=settings`
  - `/agent/<agentId>` path also parses in `use-route-state.ts`

### What’s missing for external deep-links
- Backend does **not** currently have a canonical public UI base URL setting.
- A Telegram message needs an absolute URL to be tappable (`https://.../?agent=...`).

So we need one source of truth for base URL (env or config). Without that, we can only generate relative links, which are not useful in Telegram.

---

## 5) Rough implementation sketch (minimal PR)

### Files likely changed
1. `apps/backend/src/integrations/telegram/telegram-delivery.ts`
   - Add web `speak_to_user` notification branch
   - Build short message: session label/agent + snippet + deep-link
   - Send to recipient DM(s)
2. `apps/backend/src/integrations/telegram/telegram-types.ts` *(optional, if adding explicit notify settings)*
3. `apps/backend/src/integrations/telegram/telegram-config.ts` *(optional, if adding explicit notify settings/base URL there)*
4. `apps/backend/src/test/*` add targeted test(s) for notification branch (likely new telegram-delivery test file)

### Estimated LOC
- **Ultra-minimal (reuse existing fields + env base URL):** ~40–90 LOC
- **Still small but explicit config fields (`notify.enabled`, `notify.chatIds`, `notify.baseUrl`):** ~120–220 LOC (includes config parse/mask/update wiring)

---

## 6) Open questions before implementation

1. **Trigger definition:**
   - Is “finished” = `speak_to_user` (recommended v0), or strict `agent_status` transition to `idle`?
2. **Recipient selection:**
   - Use `allowedUserIds` as DM targets, or add explicit `notificationChatId(s)`?
3. **Base URL source:**
   - Where should absolute UI URL come from (env vs Telegram config vs global settings)?
4. **Notification text policy:**
   - Include response snippet, or only “Session complete + link”?
5. **Multi-recipient behavior:**
   - Send to all configured IDs or first one only?

---

## Recommended v0 decision
- Trigger on **manager `speak_to_user` targeted to web**.
- Send Telegram DM to configured user id(s).
- Message includes absolute deep-link to `/?agent=<sessionId>`.
- Keep everything else out of scope.
