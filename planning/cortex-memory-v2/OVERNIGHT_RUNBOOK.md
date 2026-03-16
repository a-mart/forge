# Cortex Memory v2 — Overnight Runbook

## Read First After Compaction
1. `planning/cortex-memory-v2/E2E_EXEC_SUMMARY.md`
2. `planning/cortex-memory-v2/E2E_ACTIVE_TRACKER.md`
3. `planning/cortex-memory-v2/E2E_TEST_INDEX.md`
4. `planning/cortex-memory-v2/STATUS.md`
5. `planning/cortex-memory-v2/TASKS.md`

## Current Decision Frame
- **Strict rubric call:** conditional GO once the decision owner explicitly accepts the remaining fresh-env blocker as an environment/auth issue rather than a Memory v2 product regression.
- **Feature-evidence call:** GO/strong confidence; copied-prod evidence is strong and backend test gates are now clean.
- Copied-prod evidence is strong.
- Fresh isolated env still has live-dispatch auth/env blockage; do not misclassify it as a Memory v2 product regression.

## Must-Keep Truths
- Work only in `/Users/adam/repos/middleman-worktrees/cortex-memory-v2`.
- Use only isolated data dirs:
  - copied: `/Users/adam/.middleman-cortex-memory-v2-migrate`
  - fresh: `/Users/adam/.middleman-cortex-memory-v2-fresh`
- Never write to production `~/.middleman`.
- Prefer short, bounded commands; no endless retry loops.

## Overnight Priorities
1. **Fresh env:** continue narrowing the live-dispatch blocker; document exact auth/runtime behavior, but keep solution elegantly simple.
2. **Copied env:** run more real Cortex behavior against historical conversations and inspect resulting memory/knowledge outputs for usefulness, precision, and noise.
3. **Test gates:** keep the backend suite clean after the env-sensitive test hardening captured in `E2E_BACKEND_GATES.md`; if regressions reappear, diagnose them cleanly and keep fixes low-churn.
4. **Doc coherence:** keep `E2E_EXEC_SUMMARY.md`, `E2E_TEST_INDEX.md`, and `E2E_ACTIVE_TRACKER.md` aligned whenever new evidence lands.

## Scenario Expansion Backlog
- More copied-env historical conversation processing with isolated Cortex review behavior.
- Compare quality of resulting profile memory / reference outputs before vs after review activity.
- Additional fresh-env live-dispatch attempts only if they are bounded and evidence-rich.
- Any design tweak should stay low-churn and simple.

## Heartbeat Scheduling
- One-shot heartbeat schedules are installed every 30 minutes through 03:00 America/Chicago under manager `cortex`.
- Heartbeat message instructs the next session to resume from this runbook and continue overnight validation.

## Key Artifacts
- `planning/cortex-memory-v2/E2E_MIGRATE_RUNTIME.md`
- `planning/cortex-memory-v2/E2E_FRESH_RUNTIME.md`
- `planning/cortex-memory-v2/E2E_SCAN_AUDIT.md`
- `planning/cortex-memory-v2/E2E_SCAN_DELTAS.md`
- `planning/cortex-memory-v2/E2E_RECONNECT_PERSISTENCE.md`
- `planning/cortex-memory-v2/E2E_MEMORY_MERGE_RUNTIME.md`
- `planning/cortex-memory-v2/E2E_WORKER_CALLBACK_RUNTIME.md`
- `planning/cortex-memory-v2/E2E_CORTEX_LEARNING_EVAL.md`
- `.tmp/e2e-full-backend-vitest.log`

## Backend Gate Status
- Full backend Vitest is now clean at `425 passed / 0 failed`.
- Supporting artifact: `planning/cortex-memory-v2/E2E_BACKEND_GATES.md`.
- If failures reappear, treat them as new regressions rather than relying on the old diagnosis.
