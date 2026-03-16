# Cortex Memory v2 — E2E Backend Gates (Overnight)

Date: 2026-03-15 (CDT)
Worktree: `/Users/adam/repos/middleman-worktrees/cortex-memory-v2`

## Scope reviewed
Per runbook request, reviewed:
- `planning/cortex-memory-v2/OVERNIGHT_RUNBOOK.md`
- `planning/cortex-memory-v2/E2E_EXEC_SUMMARY.md`
- `planning/cortex-memory-v2/E2E_ACTIVE_TRACKER.md`
- `.tmp/e2e-full-backend-vitest.log`

Target failures from full-suite log (`423 passed / 2 failed`):
1. `src/test/index-shutdown-signals.test.ts` (`SIGUSR1` expectation on POSIX)
2. `src/test/ws-server.test.ts` (control pid file `ENOENT`)

---

## Diagnosis

### Failure 1: `index-shutdown-signals.test.ts`
- Logged failure: expected registered signals to include `SIGUSR1`, but observed only `['SIGINT', 'SIGTERM', 'message']`.
- Runtime code path in `apps/backend/src/index.ts` only registers `SIGUSR1` when `process.env[DAEMONIZED_ENV_VAR] !== "1"`.
- Test case inherited ambient environment for the POSIX assertion, so if `MIDDLEMAN_DAEMONIZED=1` is present in the process env, the expectation is invalid.

**Classification:** pre-existing env-sensitive test assumption (not product behavior regression, not flaky runtime logic).

### Failure 2: `ws-server.test.ts` control pid `ENOENT`
- Logged failure: `readFile(pidFile)` failed with `ENOENT` immediately after `server.start()`.
- In `apps/backend/src/ws/server.ts`, control pid creation is skipped when daemonized (`process.env[DAEMONIZED_ENV_VAR] === "1"`).
- Test similarly assumed non-daemonized env and did not sanitize `MIDDLEMAN_DAEMONIZED`.

**Classification:** pre-existing env-sensitive test assumption (not product behavior regression, not random flake).

---

## Implemented fix (low churn)

No production logic changes. Only test hardening to remove ambient-env coupling.

### 1) `apps/backend/src/test/index-shutdown-signals.test.ts`
- Updated POSIX test to explicitly clear daemonized env for that assertion:
  - from: `loadRegisteredSignals("linux")`
  - to: `loadRegisteredSignals("linux", { MIDDLEMAN_DAEMONIZED: undefined })`

### 2) `apps/backend/src/test/ws-server.test.ts`
- Imported `DAEMONIZED_ENV_VAR` constant from `../reboot/control-pid.js`.
- In `writes and removes its control pid file across start/stop` test:
  - save previous `process.env[DAEMONIZED_ENV_VAR]`
  - clear it before server construction/start
  - restore it in `finally`
  - ensure `server.stop()` runs in `finally`

These changes keep behavior expectations explicit and deterministic across parent process environments.

---

## Validation

### Focused tests (requested)
- Command:
  - `cd apps/backend && pnpm exec vitest run src/test/index-shutdown-signals.test.ts src/test/ws-server.test.ts`
- Result:
  - `2 passed` files, `45 passed` tests.

### Full backend suite sanity check
- Command:
  - `cd apps/backend && pnpm exec vitest run`
- Result:
  - `42 passed` files, `425 passed` tests, `0 failed`.

### Required typechecks
- Command:
  - `cd apps/backend && pnpm exec tsc -p tsconfig.build.json --noEmit`
  - `cd apps/ui && pnpm exec tsc --noEmit`
- Result:
  - both passed (no diagnostics).

---

## Gate recommendation

- These two failures were **not waiver candidates after investigation**; they had straightforward, robust, low-churn fixes in tests.
- Current backend test gate status after fix/validation: **clean**.
- No explicit waiver needed for these two failures.
