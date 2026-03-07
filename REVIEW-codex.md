# Context-Recovery Fixes Test Review (codex)

## MISSING TESTS (critical gaps)

No remaining **critical** gaps after this review pass.

I added missing critical coverage for the highest-risk edge cases:

- `apps/backend/src/swarm/__tests__/mid-turn-context-guard.test.ts`
  - `runContextGuard does not abort compaction when compact resolves just before timeout`
  - `flushRecoveryBufferedMessages preserves new deliveries that arrive during flush`
  - `allows a new guard cycle after late auto-compaction events are suppressed`
- `apps/backend/src/test/idle-worker-watchdog.test.ts`
  - `batch flush skips stale workers and still notifies for valid queued workers`
- `apps/backend/src/test/swarm-tools.test.ts`
  - `list_agents handles zero workers and offset beyond total without throwing`
  - `list_agents returns one worker correctly when only one exists`
  - `list_agents treats exactly-at-limit worker counts as a full final page`

## WEAK TESTS (pass but don’t fully prove the fix)

1. `handleAutoCompactionEndEvent processes errors normally after grace expires`  
   - Good for retry invocation, but it does not assert intermediate lock behavior (`contextRecoveryInProgress` toggling during execution) or buffer flush side effects.

2. `overflow recovery cleanup does not schedule duplicate agent.continue`  
   - Correctly asserts `agent.continue()` is not called in this runtime path, but it does not protect against duplicate resume behavior if it reappears in a different layer (e.g., manager-side orchestration).

## SUGGESTIONS (additional coverage)

- Add a watchdog test where the worker is queued, then the **manager enters context recovery before batch flush**; verify flush-time suppression still prevents notification.
- Add a focused backoff timing assertion on exact suppression windows (`15s`, then `30s`) to guard against accidental constant-delay regressions.
- Add a list_agents case for `includeTerminated: true` + pagination to ensure bounded paging remains correct when stopped/terminated workers are included.

## VERDICT

Overall test quality is **strong** and now covers the core interaction bugs and edge paths the fix set targeted:

- Bug 1 timeout behavior is covered (timeout abort and pre-timeout success race).
- Bug 3 grace suppression and post-grace normal handling are covered.
- Bug 5 duplicate `agent.continue()` avoidance is covered.
- Recovery buffering behavior is covered (buffering, cap/drop oldest, flush, concurrent arrival during flush).
- Watchdog behavior is covered (batching, suppression during recovery, backoff, circuit breaker, reset on worker report, stale+valid mixed batch).
- `list_agents` behavior is covered (bounded default, verbose paging, active-first sort, offset beyond total, zero/one/boundary counts).

### Test run

Executed:

```bash
cd /Users/adam/repos/middleman-context-fixes && pnpm --filter @middleman/backend test
```

Result: **pass** (`31` files, `303` tests).
