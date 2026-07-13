# Manager Empty-Turn Fix — Deterministic Terminal-Obligation Backstop

**Date:** 2026-07-06 · **Branch:** `v2/wp-manager-turn` · builds on `docs/MANAGER_SILENCE_INVESTIGATION.md` (2026-06-10).

> **Current behavior (2026-07-13):** This document preserves historical design evidence. Worker callbacks
> remain internal manager decision turns, but a substantive manager final now renders normally in an
> eligible Builder web session. Exact `NO_REPLY` expresses intentional silence (including after explicit
> delivery); it does not satisfy an unanswered direct user turn. Protected/non-web routes remain explicit.

## Problem
`gpt-5.5` (the most-used manager model, `openai-codex`) can end a manager turn with a literally empty
response — empty/whitespace content, no tool call, `stopReason: "stop"`, ~12 output tokens — instead of
delivering a user-facing update. The historical investigation found this most often after a worker's
**terminal report** was injected as `WORKER REPORT: status: …` (~18% of worker callbacks for gpt-5.5).
The raw terminal report is persisted for the manager's All view, but it is intentionally hidden from the
focused Web view; without a manager summary or backstop, the visible conversation has no outcome.

The prior countermeasure (`manager-noop-guard`, June 3–8) **re-prompted the silent model** and failed ~44%
of the time it fired, then was parked. **Re-prompting the same model is not a reliable fix.**

## Fix — a deterministic delivery backstop (no model dependence)
The runtime-agnostic event projector already covers any manager run that ends without visible output: at
run end it can emit a plain system notice, and for an unsummarized worker report that notice tells the user
to inspect All. This is guidance, not a clickable deep link.

The Pi-specific deterministic backstop is layered *after* the runtime's existing resample-retry ladder.
When every resample is exhausted on a silent turn whose trigger was a terminal worker report, the server
surfaces a bounded worker outcome itself rather than asking the model again.

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
   - Emits one system `conversation_message` with `systemNoticeKind: worker_outcome_backstop`. The UI renders
     it as the sky informational **Worker outcome · auto-surfaced** card, not as manager-authored prose.
     `summarizeTerminalWorkerReportForUser` (`swarm-manager-utils.ts`) mechanically extracts the structured
     `status:` and a metadata-stripped one-line `summary:` (capped), then tells the user that full details are
     in All. It **never echoes the raw report** (which still carries internal routing metadata), and the card
     is not a clickable worker link even when `sourceWorkerId` is present.
   - Logs `manager:terminal_obligation_backstop_delivered` — the observability the investigation flagged as
     missing, so the fire rate is now measurable.

The projector's last-user-facing-output watermark is the authority for whether output actually rendered;
the Pi retry path consults it rather than relying only on runtime text markers. After the deterministic card
is emitted, the controller advances that watermark, cancels any armed runtime-agnostic notice, and removes
the passive runtime-error message. These gates enforce one user-facing artifact for that handled obligation
instead of stacking the card and warning.

## Why it succeeds where the noop-guard failed
The guard asked the *same silent model* to try again (failed ~44%). This backstop does not involve the model:
once retries are exhausted, the server composes a bounded outcome from the worker report it already holds.
That removes model cooperation from the final step for eligible web-visible terminal obligations. It does
not promise delivery for protected, non-web, malformed, stale, or otherwise ineligible routes.

## False-positive safety
- Only on an **exhausted** silent turn (after the resample ladder), only for a **terminal_report** trigger,
  only for a **web-visible** route, and **deduped**. Protected and non-web deliveries are declined rather
  than relayed into Web; the existing passive warning and follow-up guidance remain available for those
  cases. This avoids leaking a peer/Telegram obligation to the web user.

## Verification
- Reproduction + behavior tests: `swarm-manager.test.ts` (system backstop delivery, notice kind, dedup, no
  metadata leak), `swarm-runtime-controller.test.ts` (tagged-error → backstop path, visibility-watermark
  advance, passive-notice suppression), `agent-runtime.test.ts` (terminal_report exhaustion tags
  `deliverOutcome`), `swarm-manager-utils.test.ts` (bounded summary formatting, metadata stripping, status
  map).
- Full backend suite green (3568 tests) + typecheck clean.

## Live verification (follow-up)
A real gpt-5.5 empty turn is probabilistic (~18% after callbacks), so it can't be forced on demand cheaply.
Deploy to the running instance and watch for `manager:terminal_obligation_backstop_delivered` over real
worker-report traffic; that log line shows the eligible deterministic backstop fired.
