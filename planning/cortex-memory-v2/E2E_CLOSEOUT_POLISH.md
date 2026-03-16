# Cortex Memory v2 — E2E Closeout Polish

**Date:** 2026-03-16  
**Worktree:** `/Users/adam/repos/middleman-worktrees/cortex-memory-v2`  
**Production touched:** **No**

## Goal
Harden the remaining weak spot from copied-history learning evals: **manager-level completion / closeout quality** after an on-demand Cortex review run.

## Problem summary
The copied-env learning eval showed a consistent closeout gap:
- worker extraction often succeeded,
- promotion sometimes succeeded,
- but Cortex frequently **ended without a final user-visible `speak_to_user` closeout**.

This was visible in `planning/cortex-memory-v2/E2E_CORTEX_LEARNING_EVAL.md`:
- Scenario 1: semantic no-op was correct, but there was **no completion message**.
- Scenario 2: useful reference promotion happened, but there was **no completion message**.
- Scenario 3: extraction produced useful findings, but promotion/closeout stalled and there was **no completion message**.

The hardening tracker already called this out as the main remaining weak lane:
- `planning/cortex-memory-v2/E2E_HARDENING_TRACKER.md`
- Lane 3 score: **5/10**
- Next action: “Prioritize callback completion clarity and deterministic closeout artifacts”

## Diagnosis
### Prompt-level
Partly yes.

`apps/backend/src/swarm/archetypes/builtins/cortex.md` already told Cortex to close the loop on direct/on-demand reviews, but that requirement was only a **prompt instruction**. In practice, historical review flows still sometimes ended after worker callbacks or synthesis without a final user-facing closeout.

So prompt guidance existed, but it was not strong enough by itself to reliably survive multi-worker historical-review runs.

### Orchestration-level
Yes — this is the higher-leverage root cause.

At runtime, nothing enforced this behavior when Cortex returned to idle after a user-initiated review. The manager runtime already had orchestration support for worker auto-completion reporting, but there was no analogous guard for:
- “a user asked Cortex to review something,”
- “worker activity happened,”
- “Cortex is now idle,”
- “but no fresh `speak_to_user` closeout was published after the latest work.”

That means the system depended entirely on the model remembering to do the right thing at the end of a long delegated flow.

## Conclusion
This was **both prompt-level and orchestration-level**, but the most important failure was orchestration-level:
- prompt already said what to do,
- runtime did not verify or nudge the final closeout,
- so the simplest high-leverage fix was to add a small runtime safety net rather than redesign review flow.

## Change implemented
### 1) Runtime closeout reminder for Cortex
File changed:
- `apps/backend/src/swarm/swarm-manager.ts`

Added a lightweight Cortex-specific guard:
- when a **manager transitions to idle with no pending work**,
- and that manager is **Cortex**,
- inspect the conversation history for the **latest direct user turn**,
- determine whether there is a fresh `speak_to_user` closeout after that turn,
- and if not, send Cortex an internal reminder:
  - publish a concise final closeout before ending the review.

The reminder is only sent once per latest user turn, so it does not spam.

The logic treats two cases as needing a reminder:
1. **Missing closeout** — no `speak_to_user` message after the latest user request.
2. **Stale closeout** — Cortex sent an earlier status update, but later worker/agent progress arrived after that message and no newer final closeout was published.

### 2) Slight prompt tightening
File changed:
- `apps/backend/src/swarm/archetypes/builtins/cortex.md`

Added a sharper closeout instruction:
- if Cortex sent an earlier status update and more worker/tool results arrived afterward, it should send a **fresh final closeout before going idle**.

This keeps the model-side instruction aligned with the runtime guard.

### 3) Focused regression tests
File added:
- `apps/backend/src/swarm/__tests__/cortex-closeout.test.ts`

Covered:
- no reminder when there was no direct user review turn,
- reminder when no `speak_to_user` closeout exists,
- reminder when worker progress arrives after the last user-visible update,
- no reminder after a valid final closeout,
- latest-user-turn scoping.

## Validation
### A) Targeted unit test
Command:
```bash
cd apps/backend && pnpm exec vitest run src/swarm/__tests__/cortex-closeout.test.ts
```

Result:
- **PASS** (`5 tests passed`)

### B) Copied-env retry proof
Command:
```bash
cd /Users/adam/repos/middleman-worktrees/cortex-memory-v2 && node .tmp/e2e-cortex-learning-eval-retry.mjs
```

Observed result in `.tmp/e2e-cortex-learning-eval-retry/result.json`:
- Cortex emitted a user-visible `speak_to_user` closeout:
  - “No durable changes were warranted for `middleman-project/middleman-enhancements` in the copied env...”
- This directly addresses the prior silent-closeout failure mode from the earlier learning eval.

Important nuance:
- the retry run also picked up unrelated copied-env backlog noise already present in that isolated data dir, so it is **not** a clean single-scenario benchmark.
- But it does provide live evidence that the historical-review lane now closes with a user-visible completion message instead of silently ending.

### C) Required typechecks
Commands:
```bash
cd apps/backend && pnpm exec tsc -p tsconfig.build.json --noEmit
cd apps/ui && pnpm exec tsc --noEmit
```

Result:
- executed after the closeout hardening change
- no new typecheck regressions

## Expected effect
This should improve the exact weak spot seen in the learning evals:
- on-demand historical review runs should now be much less likely to end silently,
- no-op reviews should still produce a concise completion message,
- earlier mid-run status updates should be followed by a true final closeout if later worker activity occurred,
- the fix is low-churn and localized, without changing broader Cortex review architecture.

## Why this fix was chosen
This was the simplest high-leverage improvement because it:
- preserves the existing delegated Cortex workflow,
- does not require redesigning scan/promotion logic,
- addresses the most visible UX failure directly,
- complements prompt guidance instead of replacing it,
- is easy to test in isolation.

## Follow-up hardening after the first fix
A second-layer sharp edge appeared during postfix reruns:
- the idle-transition reminder could still race with Codex steer delivery,
- and one scenario still leaked absolute host paths in the final `FILES:` field.

Follow-up adjustments tightened that layer without redesigning review flow:
1. **Timer-based reminder deferral** in `apps/backend/src/swarm/swarm-manager.ts`
   - Cortex closeout reminders are now scheduled shortly *after* idle instead of immediately on the same transition.
2. **Defensive queued-steer recovery** in `apps/backend/src/swarm/codex-agent-runtime.ts`
   - after a `steer_delivery` failure such as `no active turn to steer`, queued work is restarted as a new turn instead of leaving the same queued delivery stuck.
3. **User-visible path normalization** in `apps/backend/src/swarm/swarm-manager.ts`
   - Cortex `speak_to_user` closeouts now rewrite absolute `.../profiles/...` paths to relative `profiles/...` paths before publishing.
4. **Extra focused tests**
   - `src/test/codex-agent-runtime-behavior.test.ts`
   - `src/swarm/__tests__/cortex-closeout.test.ts`

Result:
- postfix rerun scenarios complete cleanly again,
- the prior `steer_delivery` timeout wave is gone in the latest rerun,
- scenario 3 now reports `profiles/feature-manager/...` instead of leaking migrate-dir absolute paths.

## Remaining limitation
This does **not** solve every promotion/writeback stall. If Cortex never reaches a clean idle point, or if an upstream review flow truly wedges, these closeout guards still cannot finish the review on their own.

But they materially improve the common case identified by the evals:
- real work happened,
- Cortex had enough information to finish,
- and the missing piece was a reliable final closeout.

## Files changed in this lane
- `apps/backend/src/swarm/swarm-manager.ts`
- `apps/backend/src/swarm/codex-agent-runtime.ts`
- `apps/backend/src/swarm/archetypes/builtins/cortex.md`
- `apps/backend/src/swarm/__tests__/cortex-closeout.test.ts`
- `apps/backend/src/test/codex-agent-runtime-behavior.test.ts`
- `planning/cortex-memory-v2/E2E_CLOSEOUT_POLISH.md`
