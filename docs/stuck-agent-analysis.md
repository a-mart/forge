# Stuck Agent Analysis (voice manager)

> **Note (2026-03-03):** Session file paths referenced below (e.g. `~/.middleman/sessions/voice.jsonl`) reflect the pre-restructure flat layout. The data directory has since been restructured to a hierarchical profile-scoped layout. Session files now live at `~/.middleman/profiles/<profileId>/sessions/<sessionAgentId>/session.jsonl`.

## Scope
Investigated the requested paths:

- `apps/backend/src/swarm/swarm-manager.ts`
- `apps/backend/src/swarm/agent-runtime.ts`
- `apps/backend/src/ws/server.ts`
- `apps/backend/src/swarm/codex-agent-runtime.ts`
- Session evidence from `~/.middleman/sessions/voice.jsonl`

## Quick timeline from session evidence

- `~/.middleman/sessions/voice.jsonl` line `3777`: `compaction` at `2026-02-24T18:40:31.071Z`
- line `3778`: user message (`Does Tari support Windows?`)
- line `3779`: user message (`hello`)
- line `3780`: `compaction` at `2026-02-24T19:55:11.071Z`
- lines `3783-3786`: assistant reply + completion (`2026-02-24T19:55:21.415Z`)
- no later entries after line `3786`

Important context:

- The `voice` session file is large (~31 MB).
- Compaction entries at lines `3777`/`3780` are **auto compactions** (not manual `/compact` path), because there is no paired `"Compacting manager context..."`/`"Compaction complete."` system message around those timestamps.

## Failure modes

## 1) Silent PI prompt failure (most likely)

- **Code path**
  - `apps/backend/src/swarm/swarm-manager.ts:902-913` emits user conversation entry before runtime delivery.
  - `apps/backend/src/swarm/swarm-manager.ts:922-940` sends to manager runtime.
  - `apps/backend/src/swarm/agent-runtime.ts:63-90` returns success immediately on idle path (`acceptedMode: "prompt"`).
  - `apps/backend/src/swarm/agent-runtime.ts:134-151` fire-and-forget `dispatchPrompt`.
  - `apps/backend/src/swarm/agent-runtime.ts:138-146` catches prompt errors and only `console.error(...)` (no rethrow, no user-visible event).
- **Why this can look “stuck”**
  - User message is accepted/logged.
  - If `session.prompt(...)` fails (context overflow, provider error, session state error), failure is swallowed.
  - Agent can remain `idle` and produce no reply.
- **Likelihood**
  - **High**.
- **Recommended fix**
  - Do not swallow prompt failures silently.
  - Surface runtime prompt failures through `onSessionEvent`/`onStatusChange` (or explicit error callback) and emit a `conversation_message` system error or WS `error`.
  - Add structured error telemetry (`agentId`, provider/model, error class, context size).

## 2) Status stuck on `streaming` with no watchdog

- **Code path**
  - PI runtime sets streaming on `agent_start`: `apps/backend/src/swarm/agent-runtime.ts:185-188`.
  - PI runtime returns to idle only on `agent_end`: `apps/backend/src/swarm/agent-runtime.ts:191-198`.
  - New incoming message while busy is steered: `apps/backend/src/swarm/agent-runtime.ts:72-76`, `169-177`.
  - Manager always routes manager-targeted user messages as steer-in-flight behavior: `apps/backend/src/swarm/swarm-manager.ts:929-939`.
- **Why this can look “stuck”**
  - If upstream never emits `agent_end` (hung request/tool/provider), runtime remains in busy semantics indefinitely.
  - New messages keep being steered into a turn that may never complete.
- **Likelihood**
  - **Medium**.
- **Recommended fix**
  - Add per-turn timeout watchdog.
  - If a turn exceeds threshold, interrupt/reset runtime and emit system notice.
  - Expose “last turn start / last progress” in status payload.

## 3) Compaction deadlock risk (manual compaction path)

- **Code path**
  - Manual compaction entrypoint: `apps/backend/src/swarm/swarm-manager.ts:768-853`.
  - Runtime compaction call: `apps/backend/src/swarm/agent-runtime.ts:112-115`.
  - Only termination is checked; no streaming-state guard and no timeout: `apps/backend/src/swarm/swarm-manager.ts:781-783`, `815`.
- **Why this can look “stuck”**
  - If `runtime.compact(...)` hangs, request path blocks.
  - No timeout/cancel path at manager layer.
- **Likelihood**
  - **Low to Medium** for this specific incident.
  - Observed problematic compactions were auto-compaction entries, not this manual API path.
- **Recommended fix**
  - Guard manual compaction while active streaming turn (or queue it).
  - Add timeout and fallback (`resetManagerSession` option when compaction exceeds threshold).
  - Emit explicit compaction state/status.

## 4) Pending message silently dropped in Codex runtime

- **Code path**
  - Busy-path queues steer and returns accepted: `apps/backend/src/swarm/codex-agent-runtime.ts:149-167`, `388-398`.
  - Flush catches steer failure and drops queued message + pending entry silently: `apps/backend/src/swarm/codex-agent-runtime.ts:408-421`.
- **Why this can look “stuck”**
  - Message is accepted at API boundary, then removed without user-visible failure.
- **Likelihood**
  - **Medium** (for codex-backed agents; less relevant to current `voice` manager which is PI-backed).
- **Recommended fix**
  - On `turn/steer` failure, emit error event and keep/retry queue entry (with bounded retries).
  - Avoid silent drop; add dead-letter event to conversation log.

## 5) Pending accounting drift in PI runtime

- **Code path**
  - Pending only tracked for steers: `apps/backend/src/swarm/agent-runtime.ts:169-177`.
  - Pending removed by message-key matching on `message_start user`: `apps/backend/src/swarm/agent-runtime.ts:201-207`, `210-223`.
  - Key creation/parsing is content-derived: `apps/backend/src/swarm/agent-runtime.ts:323-375`.
- **Why this can look “stuck”**
  - If runtime-emitted user message content differs from keyed input shape, pending may never clear.
  - UI can show misleading pending state even when agent is idle.
- **Likelihood**
  - **Low to Medium**.
- **Recommended fix**
  - Track pending via explicit delivery IDs (not reconstructed content keys).
  - Expire stale pending entries on turn end / timeout.

## 6) WS routing/validation is explicit (not silent backend drop)

- **Code path**
  - Command parsing/validation: `apps/backend/src/ws/server.ts:1892-2100`.
  - `user_message` routing + explicit errors: `apps/backend/src/ws/server.ts:1654-1701`.
  - Subscription precondition check: `apps/backend/src/ws/server.ts:1485-1494`.
- **Assessment**
  - Backend generally sends explicit `error` events for invalid command, unknown agent, unsupported subscription, or runtime send failure.
  - This is less likely to be a server-side silent reject.
- **Likelihood**
  - **Low** as root cause.
- **Recommended fix**
  - Add explicit `user_message_accepted` ack event so UI can distinguish send failure vs. no-reply.
  - Ensure frontend prominently surfaces `error` events.

## 7) EventEmitter/MaxListeners leak causing dropped handlers

- **Code path**
  - Manager sets max listeners: `apps/backend/src/swarm/swarm-manager.ts:189`, `256`.
  - WS server attaches listeners once on start and removes on stop: `apps/backend/src/ws/server.ts:241-247`, `251-257`.
- **Assessment**
  - Node EventEmitter max-listener warnings do not drop listeners.
  - Listener lifecycle here appears balanced.
- **Likelihood**
  - **Very Low**.
- **Recommended fix**
  - Add periodic debug metric: listener counts per event.
  - Keep start/stop idempotency tests around listener registration.

## 8) Session-file corruption / context overflow path

- **Code path**
  - History preload tolerates parse/load errors: `apps/backend/src/swarm/swarm-manager.ts:2547-2586`.
  - Conversation entries are appended as custom entries on every message: `apps/backend/src/swarm/swarm-manager.ts:1142-1157`.
  - Prompt failures can be swallowed by PI runtime: `apps/backend/src/swarm/agent-runtime.ts:138-146`.
- **Assessment**
  - Hard JSONL corruption is not indicated by this file (all lines parsed in this investigation).
  - However, very large session/context pressure can still trigger provider/session prompt errors which are then silently swallowed (Failure mode #1).
- **Likelihood**
  - **Medium** contributor, mainly through silent error handling rather than parse corruption.
- **Recommended fix**
  - Add session health checks (size thresholds, entry counts, attachment token budget).
  - On context-related prompt failure, emit actionable system message and suggest `/new` or managed compaction.

## Most likely root cause for “idle but not responding”

1. **Silent prompt failure in PI runtime** (`agent-runtime.ts:138-146`) after message acceptance.
2. Potentially amplified by **large context/session pressure** and repeated compaction activity.

## Fix priority

1. **P0**: Stop swallowing PI prompt errors; surface them to UI/system conversation.
2. **P1**: Add stuck-turn watchdog + recovery path.
3. **P1**: Add message acceptance + delivery outcome telemetry/events.
4. **P2**: Harden compaction with timeout/state guard.
5. **P2**: Improve pending tracking (delivery IDs over content-key heuristics).
