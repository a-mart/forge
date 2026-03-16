# Cortex Memory v2 — Hardening Postfix Rerun

**Date:** 2026-03-16  
**Worktree:** `/Users/adam/repos/middleman-worktrees/cortex-memory-v2`

## Goal
Validate the latest Cortex hardening changes against a fresh scratch copy of the copied isolated env, not against earlier runs that started before the newest commits.

Primary raw artifacts:
- `.tmp/e2e-cortex-postfix-rerun/result.json`
- `.tmp/e2e-cortex-postfix-rerun.stdout.json`
- `planning/cortex-memory-v2/raw/postfix-rerun-before-relative-closeout-fix.json`
- `planning/cortex-memory-v2/raw/postfix-rerun-after-relative-fix-before-timer-fix.json`
- `planning/cortex-memory-v2/raw/postfix-rerun-after-timer-fix-before-relative-guard-fix.json`
- latest validated rerun state remains in `.tmp/e2e-cortex-postfix-rerun/{result.json,stdout.json}`
- scratch data dir: `/Users/adam/.middleman-cortex-memory-v2-postfix-rerun-scratch`

## Setup
The postfix rerun harness:
- cloned the copied isolated env into a lane-specific scratch dir,
- restored historical scenarios to their pre-fix baseline state,
- reran them against the latest worktree behavior.

Scenario set:
1. `postfix-01-noop-review` — `middleman-project/middleman-enhancements`
2. `postfix-02-reference-promotion` — `middleman-project/playwright-dashboard`
3. `postfix-03-larger-history` — `feature-manager/playwright-test`

## Iteration history

### Pass 1 — after prompt/closeout hardening
Result: **strong**
- all 3 scenarios emitted final `speak_to_user` closeouts with the requested `EVAL_DONE ...` format
- no-op discipline was much better
- remaining issue: scenario 3 still leaked a migrate-dir absolute path in `FILES:` instead of a scratch-relative path

### Pass 2 — after adding relative-path wording only
Result: **regression**
- all 3 scenarios lost their final closeouts
- backend log showed `runtime:error` with:
  - `phase: 'steer_delivery'`
  - `message: 'no active turn to steer'`
- a queued self-message appeared to get stuck and poison later direct reviews in the same run

### Pass 3 — after timer-based closeout-reminder scheduling
Result: **recovered**
- all 3 scenarios again emitted final `speak_to_user` closeouts with the requested token/shape
- this strongly suggests the main regression came from the closeout reminder being sent too early on the idle transition, creating a self-steer race
- remaining issue: scenario 3 still leaked an absolute migrate-dir path in `FILES:`

### Pass 4 — after Cortex closeout path sanitization + Codex queued-steer recovery hardening
Result: **clean pass**
- all 3 scenarios completed successfully again
- scenario 3 now reported relative paths in `FILES:`:
  - `profiles/feature-manager/reference/gotchas.md`
  - `profiles/feature-manager/sessions/playwright-test/meta.json`
- focused backend tests added coverage for both:
  - Codex queued-steer recovery after `no active turn to steer`
  - Cortex user-visible path normalization

### Pass 5 — overnight heartbeat confirmation rerun
Result: **still clean**
- reran the postfix harness again on commit `b70ae75`
- all 3 scenarios still completed successfully
- no `steer_delivery` / `no active turn to steer` errors reappeared
- scenario 3 continued to report relative `profiles/...` paths instead of absolute host paths

## Latest results

### 1) `postfix-01-noop-review`
**Result: PASS**

Observed closeout:
- `EVAL_DONE postfix-01-noop-review FILES: NONE ...`
- source: `speak_to_user`
- final assistant message matched the requested completion token exactly

Judgment:
- Best possible no-op behavior.
- Cortex stayed quiet on knowledge files and ended decisively.

### 2) `postfix-02-reference-promotion`
**Result: PASS (disciplined no-op)**

Observed closeout:
- `EVAL_DONE postfix-02-reference-promotion FILES: NONE ...`
- source: `speak_to_user`
- final assistant message matched the requested completion token exactly

Judgment:
- Cortex recognized the narrow operational signal was already captured in `reference/playwright-dashboard.md`.
- It resisted redundant writes and still closed cleanly.

### 3) `postfix-03-larger-history`
**Result: PASS**

Observed closeout:
- `EVAL_DONE postfix-03-larger-history FILES: profiles/feature-manager/reference/gotchas.md, profiles/feature-manager/sessions/playwright-test/meta.json ...`
- source: `speak_to_user`
- final assistant message matched the requested completion token exactly

Substance of result:
- Cortex kept the durable signal narrow:
  - parallel monitor/debug Playwright runs need distinct `PLAYWRIGHT_CLI_SESSION` names to avoid worker interference
- it kept that signal in `reference/gotchas.md` rather than bloating injected memory
- changed-file reporting is now relative and scratch-safe instead of leaking migrate-dir absolute paths

## Net assessment

### What clearly improved
1. **Closeout reliability improved a lot**
   - after the timer-based reminder fix, all 3 scenarios emitted final `speak_to_user` closeouts
   - all 3 matched the requested completion token format

2. **No-op discipline improved**
   - both the explicit no-op scenario and the already-captured-reference scenario ended with `FILES: NONE`
   - Cortex did not force writes just because a review was requested

3. **Promotion discipline remained good**
   - the larger historical scenario kept a narrow gotcha in reference-only scope instead of inflating injected memory

### What still needs polish
1. **The closeout reminder needed orchestration hardening, not just prompt wording**
   - the failed middle pass showed that prompt tweaks alone were not enough
   - the runtime had to avoid self-steering too early during idle transition

2. **Queued-steer recovery now has a defensive fallback, but should still be watched in future stress runs**
   - Codex now restarts queued work as a new turn after a `steer_delivery` failure instead of leaving the same queued delivery stuck
   - this looks correct in focused tests and reruns, but future stress waves should still watch for repeated `queuedDeliveryId` poisoning patterns

## Scorecard
- **Usefulness:** 8/10
- **Precision:** 9/10
- **Closeout quality:** 9/10
- **Low noise:** 9/10
- **Magical-feeling output:** 9/10

## Bottom line
The postfix rerun is the strongest current evidence about the *latest* Cortex behavior.

The important story is not just “it passed once.” It is:
- we found a real closeout regression,
- we traced the worst failure to an orchestration race,
- we fixed it with a low-churn timer-based reminder schedule,
- we added a defensive Codex queued-steer recovery path,
- we normalized Cortex user-visible file paths,
- and the rerun stayed clean.

That is exactly the kind of iterative hardening the user asked for.

The next useful pressure is no longer this closeout/path layer. It is broader repeated stress to confirm the improved behavior keeps holding across more historical-review shapes.