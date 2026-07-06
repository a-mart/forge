# Manager Empty-Turn Fix — Deterministic Terminal-Obligation Backstop

**Date:** 2026-07-06 · **Branch:** `v2/wp-manager-turn` · builds on `docs/MANAGER_SILENCE_INVESTIGATION.md` (2026-06-10).

## Problem
`gpt-5.5` (the most-used manager model, `openai-codex`) ends a manager turn with a literally empty
response — empty/whitespace content, no tool call, `stopReason: "stop"`, ~12 output tokens — instead of
delivering a user-facing update. It happens most after a worker's **terminal report** is injected as a
`SYSTEM: … WORKER REPORT: status: …` message (~18% of worker callbacks for gpt-5.5). The terminal result is
then dropped on the floor: the user sees nothing.

The prior countermeasure (`manager-noop-guard`, June 3–8) **re-prompted the silent model** and failed ~44%
of the time it fired, then was parked. **Re-prompting the same model is not a reliable fix.**

## Fix — a deterministic delivery backstop (no model dependence)
Layered *after* the runtime's existing resample-retry ladder. When every resample is exhausted on a silent
turn whose trigger was a terminal worker report, the server surfaces the worker's outcome **itself** rather
than asking the model again.

1. **Runtime tags the exhaustion** — `pi-agent-runtime.ts`: on `silent_turn` after the resample ladder is
   exhausted, if `trigger.kind === "terminal_report"`, attach `deliverOutcome: true` +
   `terminalReportText: trigger.text` to the error. (A silent turn after *direct user input* is left alone —
   there is nothing server-known to surface, so the passive "type update?" notice stands.)
2. **Controller invokes the backstop** — `swarm-runtime-controller.ts` `maybeApplyTerminalObligationBackstop`:
   on that tagged error, call `SwarmManager.deliverTerminalObligationBackstop(agentId, reportText)`. If it
   delivers, strip the passive `userFacingMessage` so the error still records telemetry without producing a
   second, redundant user-facing artifact.
3. **Manager delivers deterministically** — `swarm-manager.ts` `deliverTerminalObligationBackstop`:
   - Fires **only** when the manager is running and its active route for this report resolves to a **visible
     web** transcript (`resolveManagerAssistantFinalOutputRoute → target.channel === "web"`). Worker reports
     are `routed_required`, which also covers peer/Telegram obligations; delivering those to the web user
     would be a cross-channel leak, so non-web routes fall back to the passive notice.
   - **Dedups** per `(manager, reportText)` so a re-entrant exhaustion cannot double-deliver.
   - Emits a single `conversation_message` (assistant, `assistant_output`) containing a
     **mechanically-parsed summary** — `summarizeTerminalWorkerReportForUser` (`swarm-manager-utils.ts`)
     extracts the structured `status:` and a metadata-stripped one-line `summary:` (capped), attributed to the
     worker with a pointer to the worker view. It **never echoes the raw report** (which still carries the
     internal `[assistantOutputTarget]` routing metadata), preserving the single-voice rule.
   - Logs `manager:terminal_obligation_backstop_delivered` — the observability the investigation flagged as
     missing, so the fire rate is now measurable.

## Why it succeeds where the noop-guard failed
The guard asked the *same silent model* to try again (failed ~44%). This backstop does not involve the model:
once retries are exhausted, the server composes and delivers the outcome from the worker report it already
holds. Delivery is therefore **guaranteed** for a web-visible terminal obligation, independent of model
behavior.

## False-positive safety
- Only on an **exhausted** silent turn (after the resample ladder), only for a **terminal_report** trigger,
  only for a **web-visible** route, and **deduped**. It cannot fire on a turn where the manager legitimately
  chose silence (no user-facing obligation), nor leak a peer/Telegram obligation to the web user.

## Verification
- Reproduction + behavior tests: `swarm-manager.test.ts` (backstop delivers on silence; dedup; no metadata
  leak), `swarm-runtime-controller.test.ts` (tagged-error → backstop path, passive-notice suppression),
  `agent-runtime.test.ts` (terminal_report exhaustion tags `deliverOutcome`), `swarm-manager-utils.test.ts`
  (summary formatting: attributed vs. graceful "A background task" fallback, metadata stripping, status map).
- Full backend suite green (3568 tests) + typecheck clean.

## Live verification (follow-up)
A real gpt-5.5 empty turn is probabilistic (~18% after callbacks), so it can't be forced on demand cheaply.
Deploy to the running instance and watch for `manager:terminal_obligation_backstop_delivered` receipts over
real worker-report traffic; that log line is the signal the backstop fired and the user was covered.
