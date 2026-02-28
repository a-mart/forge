# Test Coverage Audit

## Scope and Method
- Audited source + tests across:
  - `apps/backend/src/swarm/`
  - `apps/backend/src/ws/server.ts`
  - `apps/backend/src/integrations/`
  - `apps/backend/src/scheduler/`
  - `apps/ui/src/lib/`
  - `apps/ui/src/components/`
  - `apps/ui/src/routes/`
- Inventory based on all `*.test.*` files currently in repo.
- This audit does **not** attempt to fix existing failures (known backend suite has many pre-existing failures).
- Output focuses on **what is untested/undertested** and what should be prioritized by risk.

## Existing Test Inventory

| Test file | Area | Current coverage summary |
| --- | --- | --- |
| `apps/backend/src/test/agent-runtime.test.ts` | Backend swarm runtime | Queueing behavior (`steer` while busy), retry path, image handling, prompt failure recovery, status resets, termination. |
| `apps/backend/src/test/archetype-prompt-registry.test.ts` | Backend swarm archetypes | Built-in prompt loading and repo override precedence (`manager.md`). |
| `apps/backend/src/test/codex-agent-runtime.test.ts` | Backend codex runtime | Single startup failure case: missing Codex binary (`ENOENT`) => clear error. |
| `apps/backend/src/test/config.test.ts` | Backend config | `createConfig` env resolution: data dirs, allowlist roots, manager id. |
| `apps/backend/src/test/directory-picker.test.ts` | Backend directory picker | Platform command selection, fallback, cancellation, unsupported platform errors. |
| `apps/backend/src/test/schedule-storage.test.ts` | Backend scheduler storage | Manager-scoped schedule path + one-time legacy migration behavior. |
| `apps/backend/src/test/slack-mrkdwn.test.ts` | Slack markdown conversion | Markdown-to-mrkdwn formatting, comment stripping, code fence/newline normalization. |
| `apps/backend/src/test/swarm-manager.test.ts` | Middleman manager core | Broad lifecycle: boot, manager/worker creation/deletion, ownership, routing, attachments, history restore, model presets, memory/skills wiring. |
| `apps/backend/src/test/swarm-tools.test.ts` | Tool layer | `spawn_agent` model preset forwarding/validation + `speak_to_user` target forwarding. |
| `apps/backend/src/test/telegram-markdown.test.ts` | Telegram markdown conversion | Markdown-to-HTML conversion, escaping, code block rendering, newline normalization. |
| `apps/backend/src/test/ws-server.test.ts` | WS + HTTP server | Subscribe/message flow, reboot, compact endpoint, read-file, schedule endpoints, settings env/auth endpoints, attachment payloads, manager CRUD, ownership, directory WS commands. |
| `apps/ui/src/components/chat/AgentSidebar.test.ts` | UI chat sidebar | Expand/collapse state, selection behavior, runtime/model badges, delete controls, settings button. |
| `apps/ui/src/components/chat/MarkdownMessage.test.ts` | UI markdown renderer | Markdown formatting, HTML/js-link sanitization, artifact card rendering. |
| `apps/ui/src/lib/agent-hierarchy.test.ts` | UI agent hierarchy helpers | Manager/worker grouping + fallback manager/agent selection. |
| `apps/ui/src/lib/artifacts.test.ts` | UI artifact helpers | Shortcode normalization, link parsing, href helpers. |
| `apps/ui/src/lib/ws-client.test.ts` | UI websocket client | Connection/subscription behavior, attachment sends, manager create/delete flows, directory command requests, selection/fallback logic, status handling. |
| `apps/ui/src/routes/-index.test.ts` | UI route/page | Create-manager modal model preset selection and outgoing create payload model. |

## Coverage Map by Module

| Module | Coverage status | Notes |
| --- | --- | --- |
| `apps/backend/src/swarm/` | **Mixed** | Strong coverage for `swarm-manager` and `agent-runtime`; weak/near-zero for `codex-agent-runtime` behavior and zero direct tests for `codex-jsonrpc-client`, `codex-tool-bridge`, `cwd-policy`, `memory-paths`, `model-presets`. |
| `apps/backend/src/ws/server.ts` | **Partial** | Many websocket and core HTTP routes tested, but major endpoint families remain untested (transcribe, OAuth SSE auth login, Slack/Telegram integration REST routes). |
| `apps/backend/src/integrations/` | **Low** | Only markdown formatting helpers (`slack-mrkdwn`, `telegram-markdown`) are tested; integration lifecycle, routing, delivery, clients, config merging, and registry migration are largely untested. |
| `apps/backend/src/scheduler/` | **Low-Medium** | `schedule-storage` partially covered; `cron-scheduler-service` (core firing logic) has no dedicated tests. |
| `apps/ui/src/lib/` | **Medium** | Good coverage for `ws-client`; no tests for `file-attachments`, `collect-artifacts`, `theme`, `voice-transcription-client`, and no contract guard between backend/ui ws-types. |
| `apps/ui/src/components/` | **Low** | Only `AgentSidebar` + `MarkdownMessage` tested; message input/list, artifacts panes, chat header, and all settings screens are untested. |
| `apps/ui/src/routes/` | **Low** | `index.tsx` only tested for create-manager model selection; route-state sync and key page behaviors are untested. |

## Ranked Missing Test Cases (By Risk)

### P0 (Highest Risk)

#### 1) `apps/backend/src/swarm/codex-agent-runtime.ts`
Current: 1 startup error test only.

Missing high-risk cases:
- `create()` auth flow:
  - uses `CODEX_API_KEY`/`OPENAI_API_KEY` for `account/login/start`
  - throws clear auth-required error when still unauthenticated.
- thread bootstrap behavior:
  - resumes persisted thread successfully
  - resume failure falls back to `thread/start`.
- delivery behavior:
  - `sendMessage()` queues `steer` during active turn/start-pending
  - queued steers flush in-order once turn starts.
- notification/event translation:
  - `turn/started`, `turn/completed`, `item/*` map to runtime session events/status updates.
- failure handling:
  - `turn/start`/`turn/steer` failures call `recoverFromTurnFailure`
  - runtime exit (`onExit`) marks runtime terminated and emits error log session event.
- termination behavior:
  - interrupts active turn (best-effort) and clears pending queues.

#### 2) `apps/backend/src/swarm/codex-jsonrpc-client.ts`
Current: no direct tests.

Missing high-risk cases:
- request/response happy path and typed result resolution.
- timeout behavior (`request()` rejects and clears pending).
- JSON-RPC error payload mapping to `Error` with `code`/`data`.
- server request handling:
  - with no `onRequest` => `-32601` unsupported method response
  - with `onRequest` success/error response wiring.
- process lifecycle:
  - child `exit`/`error` rejects all pending
  - `dispose()` is idempotent and rejects pending with disposal reason.

#### 3) `apps/backend/src/ws/server.ts`
Current: good baseline tests, but major untested endpoint paths.

Missing high-risk cases:
- `/api/transcribe`:
  - content-type validation
  - max-size rejection
  - missing API key path
  - upstream 401/403, 5xx, timeout mapping.
- `/api/settings/auth/login/:provider` SSE OAuth flow:
  - stream start + event emission
  - `/respond` prompt handling
  - invalid provider/path
  - duplicate in-progress flow rejection
  - cleanup on socket close.
- integration HTTP routes:
  - manager-scoped Slack/Telegram route parsing and method matrix
  - expected 400/404/405 behavior and payload validation errors.
- websocket command validation negative cases:
  - invalid payloads for `create_manager`, `user_message.attachments`, `list/validate/pick_directory`, etc.

#### 4) `apps/backend/src/integrations/` runtime paths (Slack/Telegram/Registry)
Current: markdown helpers only.

Missing high-risk cases:
- `registry.ts` profile lifecycle and migration:
  - manager discovery, legacy config migration marker behavior, per-manager start/stop orchestration.
- Slack inbound router:
  - dedupe key behavior
  - ignore bot/self/subtype messages
  - channel allowlist/private channel gates
  - attachment ingestion and limits.
- Telegram polling + router:
  - drop-pending-on-start drain logic
  - retry/backoff and abort handling
  - allowlist enforcement and duplicate update rejection.
- delivery bridges (`slack-delivery.ts`, `telegram-delivery.ts`):
  - source-context filtering
  - chunking/threading/reply semantics
  - integration profile mismatch suppression.

#### 5) `apps/backend/src/scheduler/cron-scheduler-service.ts`
Current: no tests.

Missing high-risk cases:
- startup initializes file and processes due schedules.
- one-shot schedule firing removes schedule.
- recurring schedule advances `nextFireAt` and sets `lastFiredAt`.
- duplicate suppression via `lastFiredAt` + in-memory occurrence key set.
- dispatch failure path does not corrupt schedule state.
- watcher/poll concurrency (`pendingProcess`/`processing`) avoids overlapping writes.

### P1 (High/Medium Risk)

#### `apps/backend/src/swarm/swarm-manager.ts`
Current: broad coverage, but several pathways remain thin.

Missing cases:
- directory policy integration negative paths:
  - invalid path, non-directory, outside roots behavior via manager APIs.
- `pickDirectory()` manager path + picker failure propagation.
- settings auth APIs (`list/update/deleteSettingsAuth`) behavior parity with settings env tests.
- explicit publish target edge cases:
  - telegram target constraints (`channelId` required)
  - integration profile routing edge behavior.

#### `apps/backend/src/swarm/cwd-policy.ts`
Current: no direct tests.

Missing cases:
- allowlist normalization + dedupe.
- relative vs absolute resolution.
- error code mapping for missing/non-directory/list failure.
- `isPathWithinRoot(s)` behavior with nested paths and root equality.

#### `apps/backend/src/swarm/codex-tool-bridge.ts`
Current: no direct tests.

Missing cases:
- unknown tool returns failure response.
- argument normalization for non-object payload.
- extraction precedence for `content[].text` vs JSON stringify fallback.
- tool execution exception handling + error formatting.

#### `apps/backend/src/integrations/*-config.ts` (Slack/Telegram)
Current: no direct tests.

Missing cases:
- merge normalization (booleans/arrays/token masking/file-size clamp).
- masked token handling preserving existing secret.
- JSON parse failure behavior for corrupt config files.

### P2 (Medium/Lower Risk)

#### `apps/ui/src/lib/`
- `file-attachments.ts`:
  - image/text/binary classification
  - extension/mime heuristics
  - empty/failed read behavior
  - conversion output shape.
- `collect-artifacts.ts`:
  - markdown link extraction and dedupe ordering.
- `theme.ts`:
  - stored preference loading
  - `auto` mode with system listener attach/cleanup.
- `voice-transcription-client.ts`:
  - status-code-to-message mapping and invalid response handling.

#### `apps/ui/src/components/`
Missing component tests for:
- `MessageInput.tsx` (send gating, attachments, paste, voice errors/states).
- `MessageList.tsx` (tool log aggregation, runtime error rows, source badges, auto-scroll behavior).
- `ArtifactPanel.tsx` + `ArtifactsSidebar.tsx` (artifact loading, schedule parsing/rendering, tab interactions).
- settings screens (`SettingsAuth`, `SettingsIntegrations`, `SettingsGeneral`, `SettingsSkills`) and API error state handling.

#### `apps/ui/src/routes/index.tsx`
Current: only manager model selection path tested.

Missing cases:
- route parsing/search sync (`view=settings`, `/agent/:id`, fallback behavior).
- active agent fallback when snapshots change.
- `/compact` slash command handling + API error surface.
- manager delete fallback navigation.
- file drag/drop integration with `MessageInputHandle.addFiles`.
- channel filter behavior (`web` vs `all`).

## Quick-Win Tests (Best Coverage per Effort)

1. `apps/backend/src/swarm/model-presets.ts` pure-function unit tests.
- Fast and deterministic; validates model preset parsing/inference used by manager + tools + UI.

2. `apps/backend/src/swarm/cwd-policy.ts` unit tests.
- Isolated and high-value for directory safety/path handling.

3. `apps/backend/src/swarm/codex-tool-bridge.ts` unit tests.
- Small module, currently zero coverage, easy to fully cover.

4. `apps/backend/src/integrations/slack/slack-config.ts` + `telegram-config.ts` merge/mask tests.
- Pure-ish functions with many branchy normalizers, high regression risk.

5. `apps/backend/src/scheduler/cron-scheduler-service.ts` smoke tests with fake manager + temp schedules file.
- Even a small suite covering fire/advance/remove would materially de-risk scheduler behavior.

6. `apps/ui/src/lib/file-attachments.ts` unit tests.
- Pure front-end conversion logic; no DOM rendering required; catches many attachment regressions quickly.

7. `apps/ui/src/routes/index.tsx` add tests for `/compact` and route-state sync.
- High user-facing path with limited current coverage.

8. `apps/backend/src/ws/server.ts` endpoint tests for transcribe + OAuth login SSE happy/negative path.
- Big risk reduction because these are externally exposed API surfaces currently untested.

## Suggested Next Test Sprint Order
1. P0 backend runtime + server surface:
   - `codex-jsonrpc-client`
   - `codex-agent-runtime`
   - `ws/server` transcribe + OAuth/integration routes
2. P0/P1 integrations + scheduler:
   - Slack/Telegram routers + delivery
   - cron scheduler service
3. P1/P2 UI interaction layers:
   - `MessageInput`, `MessageList`, settings API/components
   - `index.tsx` route/flow tests
