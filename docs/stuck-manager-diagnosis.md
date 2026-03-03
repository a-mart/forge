# Stuck Manager Diagnosis (Accepted Messages, No Reply Until Manual Compact)

> **Note (2026-03-03):** Session file paths referenced below (e.g. `~/.middleman/sessions/opus-manager.jsonl`) reflect the pre-restructure flat layout. The data directory has since been restructured to a hierarchical profile-scoped layout. Session files now live at `~/.middleman/profiles/<profileId>/sessions/<sessionAgentId>/session.jsonl`.

## Executive Summary
The highest-likelihood failure mode is **context overflow in the Pi runtime that does not throw at `session.prompt()`**, combined with **manager-specific response visibility rules**.

When this happens, user messages are accepted and persisted, but the manager produces only internal assistant error turns (e.g., `prompt is too long...`) and no `speak_to_user` tool call. Since manager runtime message mirroring is intentionally disabled, the UI appears silent until manual compaction shrinks context.

This exact pattern is present in `~/.middleman/sessions/opus-manager.jsonl`.

## Scope / Files Traced
- `apps/backend/src/swarm/agent-runtime.ts`
- `apps/backend/src/swarm/swarm-manager.ts`
- `apps/backend/src/ws/server.ts`
- `apps/backend/src/swarm/codex-agent-runtime.ts`
- `node_modules/@mariozechner/pi-coding-agent/dist/core/agent-session.js`
- `node_modules/@mariozechner/pi-coding-agent/dist/core/compaction/compaction.js`
- `node_modules/@mariozechner/pi-coding-agent/dist/core/settings-manager.js`
- `node_modules/@mariozechner/pi-agent-core/dist/agent.js`
- `node_modules/@mariozechner/pi-agent-core/dist/agent-loop.js`
- `node_modules/@mariozechner/pi-ai/dist/utils/overflow.js`
- `~/.middleman/sessions/opus-manager.jsonl`

## End-to-End Message Acceptance Path
1. WS receives `user_message` and calls `swarmManager.handleUserMessage(...)` (`apps/backend/src/ws/server.ts:1671-1712`).
2. `handleUserMessage()` emits a `conversation_message` for the user **before** manager runtime delivery (`apps/backend/src/swarm/swarm-manager.ts:940-951`).
3. For manager targets, it always calls `managerRuntime.sendMessage(..., "steer")` (`apps/backend/src/swarm/swarm-manager.ts:965-977`).
4. Pi `AgentRuntime.sendMessage()` returns accepted quickly; if idle it starts async dispatch and returns immediately (`apps/backend/src/swarm/agent-runtime.ts:67-93`, `146-162`).

Consequence: a message can be “accepted” in UI/logs even if later prompt execution yields no user-visible reply.

## Critical Visibility Rule for Managers
Manager runtime events are intentionally not mirrored to conversation messages:
- `captureConversationEventFromRuntime()` returns early for manager role (`apps/backend/src/swarm/swarm-manager.ts:2427-2431`).

So manager assistant/tool/error turns are not shown unless manager explicitly calls `speak_to_user` (via tool side effect to `publishToUser`, `apps/backend/src/swarm/swarm-manager.ts:765-801`).

This is central to the “silent” symptom.

## Session Log Evidence (Recent, Direct)
### Incident A (overflow loop, then manual compact, then recovery)
From `~/.middleman/sessions/opus-manager.jsonl`:
- `4794`: assistant error turn: `prompt is too long: 180186 tokens > 180000 maximum`
- `4795`: user message accepted (`did this all get merged`)
- `4797`: assistant error again (`180202 > 180000`)
- `4798`: user message accepted (`hello`)
- `4800`: assistant error again (`180214 > 180000`)
- `4801`: user message accepted (`hello`)
- `4802`: system message: `Compacting manager context...`
- `4803`: compaction entry (`tokensBefore: 180116`)
- `4806`: system message: `Compaction complete.`
- `4808`: manager resumes user-visible replies via `speak_to_user`

### Incident B (accepted user messages, no reply, then compaction unblocks)
- `4441`, `4442`, `4443`: repeated accepted user messages (`can you have a worker fix ci`)
- `4444`: `Compacting manager context...`
- `4445`: compaction entry
- `4446+`: assistant resumes with user-visible response

### Supporting debug text captured by user in session
- `4463` includes backend status snapshot: `status: 'idle', pendingCount: 1`, matching accepted-but-not-responded queue behavior.

## Ranked Failure Modes (All ways messages can be accepted but no reply)

## 1) Context overflow becomes assistant error turn, not thrown JS error (Very High)
**Path**
- `AgentRuntime.sendToSession()` calls `session.prompt(...)` (`apps/backend/src/swarm/agent-runtime.ts:198-209`).
- Pi core loop turns overflow into assistant message with `stopReason: "error"`; it does not necessarily throw (`node_modules/@mariozechner/pi-agent-core/dist/agent-loop.js:88-93`, `186-199`).
- Overflow detection pattern includes Anthropic `prompt is too long` (`node_modules/@mariozechner/pi-ai/dist/utils/overflow.js:26`, `87-108`).

**Why accepted but silent**
- Message already accepted/recorded upstream.
- No `onRuntimeError` callback path is hit unless dispatch throws.
- Manager assistant error turns are not mirrored to conversation (`swarm-manager.ts:2427-2431`).
- No `speak_to_user` call => no visible assistant output.

**Why compaction unsticks**
- Manual compact aborts current run and rewrites context with compaction summary (`agent-session.js:1116-1118`, `1178-1182`, `1199-1201`).
- Token load drops (`tokensBefore: 180116` at line `4803`), subsequent prompts fit window and manager can call `speak_to_user` again.

## 2) Auto-compaction fails/no-ops silently from user perspective (High)
**Path**
- Auto-compaction logic exists and is enabled by default (`settings-manager.js:304-327`; `agent-session.js:1227-1265`, `1270-1384`).
- On failure, it emits `auto_compaction_end` with `errorMessage`, but does not throw (`agent-session.js:1370-1380`).

**Why accepted but silent**
- Middleman manager does not surface manager runtime auto-compaction events to chat (`swarm-manager.ts:2427-2431`) and debug path also no-ops these event types (`swarm-manager.ts:2377-2383`).
- If auto-compaction fails repeatedly, user only sees accepted inputs and no progress.

**Why compaction unsticks**
- Manual compaction uses a direct API path and emits explicit system messages (`swarm-manager.ts:803-889`), making failure/success visible and often forcing a successful context rewrite.

## 3) Streaming/run hangs -> messages accepted as steers, never drain (Medium)
**Path**
- If `session.isStreaming` is true, runtime enqueues with `steer` and returns accepted (`agent-runtime.ts:76-85`, `212-220`).
- Pi agent can remain in-flight if stream/tool call hangs; `isStreaming` stays true until `agent_end` (`pi-agent-core/agent.js:281`, `349-350`, `395-400`).

**Why accepted but silent**
- Every new message is accepted into queue while no user-facing completion occurs.

**Why compaction unsticks**
- Manual compact calls `abort()` first (`agent-session.js:1117`, `855-858`), forcing run termination and re-establishing idle + compacted context.

## 4) Auto-retry promise can wedge prompt completion (Medium-Low)
**Path**
- `prompt()` waits on `waitForRetry()` (`agent-session.js:607`, `1754-1757`).
- Retry state uses `_retryPromise` (`agent-session.js:80`, `1684-1688`).

**Why accepted but silent**
- If retry flow gets stuck (e.g., retry `continue()` never settles), prompt dispatch remains pending; runtime then accepts future messages via steer path.

**Why compaction unsticks**
- `compact()` calls `abort()` -> `abortRetry()` resolves retry promise (`agent-session.js:855-858`, `1745-1749`).

## 5) Prompt/compaction race (no `isCompacting` guard in `prompt`) (Low-Medium)
**Path**
- `isCompacting` exists (`agent-session.js:429-430`) but `prompt()` does not block on it (`agent-session.js:496-608`).
- Manual compact disconnects event handling (`agent-session.js:1116`, `340-354`) and later replaces agent messages (`1179-1182`).

**Why accepted but silent**
- Concurrent prompt during compaction can run in a state where event persistence/ordering is unstable, causing dropped visibility or overwritten context snapshots.

**Why compaction unsticks**
- A fresh manual compaction+abort cycle can re-sync session state and reconnect listeners (`1199-1201`).

## 6) Manager turn completes without `speak_to_user` (Low)
**Path**
- Manager may produce internal assistant text/tool activity but no `speak_to_user` call.

**Why accepted but silent**
- Manager runtime message mirroring is disabled (`swarm-manager.ts:2427-2431`); only `speak_to_user` publishes to chat (`swarm-manager.ts:765-801`).

**Why compaction may appear to fix**
- Compaction changes context and can alter subsequent behavior, making manager resume tool usage that publishes replies.

## 7) `status` field itself stuck is mostly a UI symptom, not dispatch gate (Low)
**Path / nuance**
- Dispatch gating in `sendMessage` uses `session.isStreaming` and `promptDispatchPending`, not descriptor `status` (`agent-runtime.ts:76`, `35`, `146-162`).
- `status` is updated by events (`agent-runtime.ts:228-249`), but stale `status` alone does not block prompt starts.

**Real blocker variant**
- If underlying `session.isStreaming` is stuck true (hung run), then queue-only behavior occurs (Failure Mode #3).

## Key Questions Answered
### 1) All ways accepted message can produce no response
Covered in ranked list #1-#7 above. Most likely in this incident: #1 + #2.

### 2) What compaction changes that unsticks
- Aborts in-flight execution (`agent-session.js:1117`, `855-858`)
- Rebuilds session context from compaction summary (`1178-1182`)
- Reconnects event wiring (`1199-1201`)
- Reduces context size below model max (log evidence: line `4803` `tokensBefore: 180116`)

### 3) Internal locks/semaphores that could wedge
No explicit mutex/semaphore primitives found. State is coordinated via:
- `runningPrompt` promise (`pi-agent-core/agent.js:36`, `277`, `400`)
- abort controllers (`agent-session.js:73-79`, `1118`, `1273`)
- retry promise (`agent-session.js:80`, `1684-1688`, `1754-1757`)
These can still wedge behavior if unresolved/hung.

### 4) Could auto-compaction itself cause stalls
Yes, primarily via silent failures and races (not lock non-release in normal code paths):
- Failures are event-only (`auto_compaction_end.errorMessage`) and not surfaced to manager chat.
- No global compaction/prompt serialization.
- Controllers clear in `finally` (`agent-session.js:1383`, `1199`), so hard lock leak is less likely than silent failure.

### 5) What if `prompt()` is called while `isCompacting` is true
No guard prevents it (`agent-session.js:429-430`, `496-608`). It can run concurrently with compaction.

### 6) What if `steer()` is called while streaming / compacting
- While streaming: it queues and is consumed by loop polling (`agent-session.js:705-716`; `agent-loop.js:62`, `99`, `114`).
- While compacting: no special guard; queue mutation still allowed. Runtime path usually won’t call steer during compaction because it keys off `session.isStreaming` (`agent-runtime.ts:76-85`).

### 7) Race conditions between auto-compaction and prompt dispatch
Yes:
- Event handler is async and not externally serialized (`agent-session.js:142-208` + agent emitter behavior).
- `_checkCompaction` runs both on `agent_end` and pre-prompt (`agent-session.js:198-208`, `559-563`).
- No cross-call compaction lock.

### 8) Could `status` stuck on `streaming` block dispatch
Not directly. `status` is not the dispatch gate. `session.isStreaming` is.
If `session.isStreaming` remains true due hung run, message acceptance continues as queued steer with no visible response until abort/compact.

## Codex Runtime Comparison (Why this is mostly Pi-specific)
Codex runtime is less prone to this exact silent accept-no-reply shape because:
- `sendMessage` awaits turn start and throws on start failure (`apps/backend/src/swarm/codex-agent-runtime.ts:153-182`), rather than fire-and-forget.
- It has explicit recovery/error reporting (`codex-agent-runtime.ts:762-815`, `688-729`).
- Manual compaction is unsupported (`codex-agent-runtime.ts:228-231`), so this specific “manual compact unsticks” signature points to Pi manager runtime path.

## Final Likelihood Ranking
1. Context overflow error turns hidden from manager chat (#1) - **Very High**
2. Auto-compaction failing/no-op and not surfaced (#2) - **High**
3. Streaming/tool/LLM hang causing perpetual steer queue (#3) - **Medium**
4. Retry promise wedge (`waitForRetry`) (#4) - **Medium-Low**
5. Prompt-vs-compaction race (#5) - **Low-Medium**
6. No `speak_to_user` tool call in successful turn (#6) - **Low**
7. Stale descriptor `status` alone (#7) - **Low**

## Bottom Line
The observed `opus-manager.jsonl` pattern (lines `4794/4797/4800` overflow errors + accepted user messages + immediate recovery after `4802/4803/4806` manual compact) most strongly supports:
- **primary mechanism**: overflow error turns that are not surfaced to user in manager mode,
- **secondary mechanism**: auto-compaction not effectively recovering in that window (or recovering without visibility),
- manual compact as the operational reset (abort + context rewrite + reconnection).
