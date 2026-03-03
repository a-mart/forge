# Telegram Integration Plan (Slack-Aligned)

## Objective
Add Telegram as a third user channel in Middleman while reusing the same channel-aware messaging architecture already used for web + Slack.

This plan intentionally mirrors what worked in Slack:
- inbound messages are always forwarded to manager with `[sourceContext]` metadata,
- outbound delivery is driven by explicit `speak_to_user.target`,
- default delivery remains web when no target is provided,
- channel-specific formatting is handled in a dedicated markdown adapter layer.

---

## What We’re Carrying Forward from Slack

1. **Shared channel model**
   - Current: `target: { channel: "web" | "slack", channelId? }`
   - Planned: `target: { channel: "web" | "slack" | "telegram", channelId? }`

2. **Inbound manager context is explicit**
   - Telegram inbound messages are forwarded through `handleUserMessage(...)` with source metadata.
   - Manager receives user text prefixed with `[sourceContext] {...}` (same pattern as Slack).

3. **No implicit reply routing**
   - If manager omits `target`, message goes to web.
   - Telegram replies require explicit `target.channel = "telegram"` plus `target.channelId` (Telegram chat id).

4. **Prompt-based selective response**
   - Router forwards inbound Telegram messages without heuristic pre-filtering.
   - Manager prompt decides when to respond, based on message intent + source context.

5. **Dedicated delivery + formatting adapters**
   - Same pattern as Slack (`slack-delivery.ts`, `slack-mrkdwn.ts`):
     - `telegram-delivery.ts` for outbound API calls,
     - `telegram-markdown.ts` for Markdown → Telegram-safe format.

6. **Settings UX parity**
   - Add Telegram controls in `SettingsDialog.tsx` with:
     - enable/disable,
     - token input,
     - target manager,
     - connection status badge,
     - test/save/disable actions.

7. **Secrets handling**
   - Telegram bot token is stored in `shared/secrets.json` (same pattern used for integration secrets), not exposed in plaintext API responses.

---

## Telegram vs Slack Differences (Design Implications)

- Slack uses Socket Mode WebSocket; Telegram uses Bot API over HTTP.
- Telegram conversation key is `chat.id` (maps to `channelId`).
- Telegram formatting uses `parse_mode` (`HTML` or `MarkdownV2`), not Slack mrkdwn.
- No workspace/team model in Telegram.
- Telegram supports reply markup/inline keyboards (deferred beyond MVP).

---

## Proposed File Structure

> Mirror Slack’s modular structure and file naming.
>
> Recommended repo path (matches current Slack placement):
> `apps/backend/src/integrations/telegram/`
>
> Equivalent naming requested in earlier drafts is preserved (`src/swarm/telegram/*`):
> `telegram-client.ts`, `telegram-router.ts`, `telegram-delivery.ts`, `telegram-markdown.ts`, `index.ts`.

### Backend
`apps/backend/src/integrations/telegram/`

- `telegram-client.ts` — Bot API client (`getMe`, `getUpdates`, `sendMessage`, file download)
- `telegram-router.ts` — inbound update normalization and routing to manager
- `telegram-delivery.ts` — outbound `conversation_message` → Telegram delivery
- `telegram-markdown.ts` — markdown conversion for Telegram format
- `telegram-config.ts` — load/save/merge Telegram integration config
- `telegram-types.ts` — Telegram payload/config/status types
- `telegram-status.ts` — status tracker (`telegram_status` events)
- `telegram-integration.ts` — lifecycle service (start/stop/reload)
- `index.ts` — exports

### Existing app integration points
- `apps/backend/src/index.ts` — instantiate/start/stop `TelegramIntegrationService`
- `apps/backend/src/ws/server.ts` — add `/api/integrations/telegram*` endpoints + status fanout
- `apps/ui/src/components/chat/SettingsDialog.tsx` — Telegram settings section
- `apps/ui/src/lib/ws-types.ts` — add `TelegramStatusEvent`

---

## Contract Updates

### 1) Channel union
Update channel contracts to include Telegram:
- `apps/backend/src/swarm/types.ts`
- `apps/backend/src/protocol/ws-types.ts`
- `apps/ui/src/lib/ws-types.ts`
- `apps/backend/src/swarm/swarm-tools.ts` schema

From:
```ts
type MessageChannel = "web" | "slack"
```
To:
```ts
type MessageChannel = "web" | "slack" | "telegram"
```

### 2) Source metadata shape
Keep existing `sourceContext` shape and include Telegram identifiers:
- `channel: "telegram"`
- `channelId: String(chat.id)`
- `userId: String(from.id)`
- `messageId: String(message.message_id)` *(new optional field in source metadata)*
- `channelType`: map Telegram chat type to existing semantic bucket (`dm`/`group`/`channel`)

Example manager-visible line:
```text
[sourceContext] {"channel":"telegram","channelId":"123456789","userId":"5550001","messageId":"42","channelType":"dm"}
```

### 3) `speak_to_user` target behavior
- `target.channel = "telegram"` requires `target.channelId`.
- Missing `target` still defaults to web.
- No “reply to most recent Telegram chat” fallback.

### 4) Manager prompt update
Update `apps/backend/src/swarm/archetypes/builtins/manager.md` so non-web channel guidance applies to Telegram as well as Slack:
- use source metadata,
- be selective in shared chats,
- always set explicit non-web target.

---

## Configuration & Secrets

### Telegram config file
`~/.middleman/profiles/<profileId>/integrations/telegram.json`

Recommended non-secret shape:
```json
{
  "enabled": false,
  "mode": "polling",
  "targetManagerId": "manager",
  "polling": {
    "timeoutSeconds": 25,
    "limit": 100,
    "dropPendingUpdatesOnStart": true
  },
  "delivery": {
    "parseMode": "HTML",
    "disableLinkPreview": true,
    "replyToInboundMessageByDefault": false
  },
  "attachments": {
    "maxFileBytes": 10485760,
    "allowImages": true,
    "allowText": true,
    "allowBinary": false
  }
}
```

### Secret storage
- `TELEGRAM_BOT_TOKEN` stored in `~/.middleman/shared/secrets.json`.
- API responses expose `hasBotToken` + masked value only.

---

## Inbound Routing (Telegram → Manager)

1. Poll `getUpdates` (MVP), maintain `offset`.
2. Normalize supported updates (`message`, `edited_message` optional later).
3. Build `sourceContext` with channel/chat/user/message metadata.
4. Convert attachments (photo/document) using same attachment model as Slack path.
5. Call:
```ts
swarmManager.handleUserMessage(text, {
  targetAgentId: config.targetManagerId,
  attachments,
  sourceContext: {
    channel: "telegram",
    channelId,
    userId,
    messageId,
    channelType
  }
})
```
6. No heuristic suppression in router; manager decides whether to answer.

---

## Outbound Delivery (Manager → Telegram)

Delivery bridge behavior mirrors Slack delivery bridge:

- listen to `conversation_message` events,
- only deliver when `sourceContext.channel === "telegram"`,
- ignore `source === "user_input"`,
- require explicit `channelId` (chat id),
- convert markdown via `telegram-markdown.ts`,
- chunk to Telegram limit (4096 chars),
- handle 429 with retry/backoff.

If manager omits target, event is `channel: "web"` and Telegram delivery does nothing.

---

## Markdown Conversion Strategy

Implement `telegram-markdown.ts` analogous to Slack’s formatter layer.

Recommendation for MVP: **Telegram HTML parse mode**
- easier escaping rules than MarkdownV2,
- good support for code/pre/links/emphasis,
- deterministic conversion path.

Function shape:
```ts
export function markdownToTelegramHtml(text: string): string
```

Include tests similar to `slack-mrkdwn.test.ts`:
- emphasis/link conversion,
- code fence handling,
- HTML escaping safety,
- newline normalization.

---

## Settings UI (Slack-Pattern Parity)

Update `apps/ui/src/components/chat/SettingsDialog.tsx`:
- add **Telegram** section/tab beside Slack settings,
- controls:
  - enable Telegram integration,
  - bot token (masked, rotatable),
  - target manager select,
  - polling options,
  - attachment toggles,
  - test connection button,
  - disable button,
  - save button,
  - connection/status badge.

Add `telegram_status` event handling in UI ws types and settings state.

---

## API Endpoints

Add Telegram endpoints parallel to Slack:
- `GET /api/integrations/telegram`
- `PUT /api/integrations/telegram`
- `DELETE /api/integrations/telegram`
- `POST /api/integrations/telegram/test`

Optional later:
- `POST /api/integrations/telegram/webhook` (if webhook mode is added)

---

## Implementation Phases

### Phase 0 — Channel contract alignment
- Add `telegram` to channel unions + tool schemas.
- Add optional `messageId` to source metadata contract.
- Update manager prompt rules for Telegram routing.

### Phase 1 — Backend Telegram service skeleton
- Add config/types/status/integration service files.
- Add polling client and lifecycle wiring in backend startup/shutdown.
- Add Telegram REST endpoints and status event fanout.

### Phase 2 — Inbound routing MVP
- Parse Telegram updates and map to `handleUserMessage` with `sourceContext`.
- Text-only first; preserve metadata.
- No inbound pre-filtering.

### Phase 3 — Outbound delivery + formatting
- Implement `telegram-delivery.ts` event bridge.
- Implement markdown conversion and chunking.
- Add retry/backoff and delivery error reporting.

### Phase 4 — Settings dialog integration
- Add Telegram section with Slack-like UX.
- Mask token + show connection state + test/save/disable flows.

### Phase 5 — Attachments + advanced Telegram features
- Photo/document ingestion parity with Slack attachment handling.
- Optional reply-to-message behavior and inline keyboard primitives.

---

## Validation Checklist

- Clean markdown doc and actionable file map.
- Routing model matches Slack architecture (sourceContext + explicit target).
- No implicit channel routing introduced.
- Telegram token stored in secrets store and masked in APIs.
- Settings UX mirrors existing Slack settings patterns.
