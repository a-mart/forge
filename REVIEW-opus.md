# Code Review: Context Recovery Bug Fixes (`feat/context-recovery-fixes`)

**Reviewer:** review-opus-2  
**Date:** 2026-03-06  
**Branch:** `feat/context-recovery-fixes`  
**Build:** ✅ Passes  
**Tests:** ✅ 296/296 passing  

---

## Summary

Five interacting bugs are addressed across 7 source files + 1 pnpm patch. The implementation closely follows the three remediation plans and the fixes are well-targeted. Overall quality is high. I found **zero critical blockers**, a few important items worth addressing before merge, and several minor observations.

---

## CRITICAL Issues

**None found.**

---

## IMPORTANT Issues (should fix before merge)

### I-1: `flushRecoveryBufferedMessages` can re-enter or race with new messages

**File:** `agent-runtime.ts`, lines ~378–398

After `cleanupGuard()` calls `endContextRecovery(CONTEXT_RECOVERY_GRACE_MS)`, `contextRecoveryInProgress` is `false` but `isContextRecoveryActive()` returns `true` (grace period). The flush then proceeds, calling `session.steer()` for each buffered message. If an incoming `sendMessage()` arrives during the flush's `await session.steer()` yield points:

1. `isContextRecoveryActive()` → `true` (grace still active)
2. `isContextRecoveryInProgress()` → `false`  
3. So the `else` branch runs: `await this.enqueueMessage(deliveryId, message)` → calls `session.steer()` immediately

This means steers from the flush and from new incoming messages can interleave during the grace window. This is likely benign in practice (steer ordering isn't guaranteed anyway), but it's worth noting.

**Suggestion:** Consider setting a `flushInProgress` flag or documenting this as an accepted interleaving behavior.

### I-2: `handleAutoCompactionEndEvent` finally block has no grace period

**File:** `agent-runtime.ts`, line ~825

```ts
} finally {
  this.endContextRecovery();  // graceMs = 0
  await this.flushRecoveryBufferedMessages();
}
```

The `cleanupGuard()` path correctly uses `endContextRecovery(CONTEXT_RECOVERY_GRACE_MS)` to suppress late auto-compaction events. But `handleAutoCompactionEndEvent`'s `finally` uses `endContextRecovery()` with no grace period.

**Why this matters:** If pi emits a *second* `auto_compaction_end` event almost immediately after the first one completes (e.g., from a queued compaction check), it would enter the full recovery path rather than being suppressed.

**Counter-argument:** With the pi patch's reentrancy guard, a second concurrent compaction can't start, so a second `auto_compaction_end` event from the same cycle is unlikely. However, a *new* auto-compaction triggered by the resume prompt's `_checkCompaction` could still race.

**Suggestion:** Consider adding a short grace period here too:
```ts
this.endContextRecovery(CONTEXT_RECOVERY_GRACE_MS);
```

### I-3: `list_agents` `page.returned` count includes the always-included manager

**File:** `swarm-tools.ts`, lines ~224–228

```ts
const selectedAgents = managerDescriptor ? [managerDescriptor, ...pagedWorkers] : pagedWorkers;
// ...
page: {
  offset,
  limit,
  returned: selectedAgents.length,  // includes manager
  hasMore,
  mode: verbose ? "verbose" : "default"
}
```

The `returned` count includes the manager descriptor which is always prepended outside the page window. With `limit=20` and 30 workers, `returned` will be 21 (1 manager + 20 paged workers). The tests confirm this (`returned: 21`), but from an API consumer perspective this is confusing — the caller asked for `limit=20` and got 21 results.

**Suggestion:** Either:
- Document that the manager is always included as an extra entry, or
- Report `returned: pagedWorkers.length` and note the manager separately in the response, or
- Include the manager within the limit count

### I-4: Several old watchdog tests were deleted rather than adapted

**File:** `idle-worker-watchdog.test.ts`

The following important behavioral tests were removed:
- Worker reports to manager → no watchdog fires
- Worker messages non-parent target → watchdog still fires  
- Worker in error/streaming state → no watchdog
- Parent manager terminated → no watchdog
- Stale timer token invalidation
- `killAgent` / `stopAllAgents` cleanup

These behaviors still exist in the code and should be tested. The new batched code path changes the mechanism but the behavioral invariants remain. Removing these tests reduces coverage of non-regression guarantees.

**Suggestion:** Adapt the deleted tests to work with the new batched watchdog model. At minimum, keep tests for:
- Worker report resets watchdog (existing, but simplified version may not cover the `reportedThisTurn` flow end-to-end through `handleRuntimeAgentEnd` → timer → batch)
- State cleanup on kill/stop
- Non-parent report doesn't satisfy watchdog

---

## MINOR Issues (nice to have)

### M-1: `Date.now()` mock brittleness in throttling tests

**File:** `mid-turn-context-guard.test.ts`, lines ~241–251

The test now pre-stacks 6 `Date.now()` return values. This is fragile — if the implementation adds any `Date.now()` call (e.g., for grace period checks in `isContextRecoveryActive()`), the mock sequence will break silently. Consider using `vi.useFakeTimers()` for these tests instead, or at least adding a comment about the expected call count.

### M-2: `compactPath` in `list_agents` loses all directory context

**File:** `swarm-tools.ts`, `compactPath()` helper

```ts
const compactPath = (value: string): string => {
  const segments = normalized.split("/").filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : normalized;
};
```

This reduces `/Users/adam/repos/middleman` to just `middleman` and `/Users/adam/repos/other-project` to just `other-project`. If two workers share the same directory basename but different parents, the compact path is ambiguous. This is unlikely in practice but worth noting.

**Suggestion:** Consider keeping the last 2 segments (e.g., `repos/middleman`) for better disambiguation.

### M-3: Watchdog batch sends from manager-to-self instead of worker-to-manager

**File:** `swarm-manager.ts`, line ~4030

```ts
await this.sendMessage(managerId, managerId, watchdogMessage, "auto", { origin: "internal" });
```

The old code sent from the worker to the manager. The new code sends a self-message (manager → manager). This is actually a good change — it avoids the old `postSendState.reportedThisTurn = false` hack that was needed to undo the side-effect of `sendMessage` treating the synthetic watchdog as a worker report. However, this changes the conversation model: the watchdog message no longer appears "from" the worker in the manager's conversation.

**Observation:** This is likely intentional and better from a semantic perspective (the watchdog is a system notification, not a worker report). Just flagging for awareness.

### M-4: `list_agents` `statusCounts` is computed from `summaryAgents` which may exclude terminated

**File:** `swarm-tools.ts`

When `includeTerminated=false` (default), the `workers` list excludes terminated and stopped workers. The `summaryAgents` and `statusCounts` are derived from this filtered list. So `statusCounts.terminated` will always be `0` by default, and `totalVisible` won't include them. This is consistent but potentially confusing — a caller may wonder why terminated counts are always zero.

**Suggestion:** Consider computing `statusCounts` from the unfiltered list and noting `totalVisible` vs `totalAll` counts, so the caller knows terminated workers exist even if they're not in the page.

### M-5: Recovery buffer pending deliveries aren't cleaned up on successful steer during flush

**File:** `agent-runtime.ts`, `flushRecoveryBufferedMessages()`

When a steer succeeds, the corresponding `pendingDelivery` with `mode: "recovery_buffer"` remains in `pendingDeliveries`. It should eventually be consumed by `consumePendingMessage` when the `message_start` event arrives for that message, but there's a gap. If the steer succeeds but the message never starts (e.g., session aborted right after), the phantom delivery stays in `pendingDeliveries`.

This matches the existing behavior for normal steer deliveries, so it's not a regression — just an inherited edge case.

---

## APPROVED Items

### ✅ Bug 1: `withTimeout` cancellation via `abortCompactionSafely`

The `withTimeout` extension is clean and correct:
- `didTimeout` flag ensures `onTimeout` only fires for actual timeouts, not other errors
- `onTimeout` is awaited before re-throwing, ensuring cleanup completes
- `abortCompactionSafely` uses optional chaining (`this.session.abortCompaction?.()`) and try/catch for defensive safety
- Both compaction timeout sites (guard + reactive retry) correctly wire the hook

### ✅ Bug 2: Pi reentrancy patch

The pnpm patch is the correct A+D hybrid approach from the remediation plan:
- Reentrancy guard at method entry (`if (this._autoCompactionAbortController) return`)
- Local `AbortController` variable eliminates the `.signal` crash entirely
- Conditional `finally` cleanup (`=== localAbortController`) prevents cross-call clearing
- All three `.signal` access sites use the local variable
- The patch is properly registered in `package.json` `patchedDependencies`

### ✅ Bug 3: Grace-period recovery gating

The grace period implementation is well-designed:
- `isContextRecoveryActive()` provides a single check point combining boolean + timestamp
- `beginContextRecovery()` / `endContextRecovery(graceMs?)` normalize state transitions
- `cleanupGuard()` correctly applies grace; `terminate()` / `stopInFlight()` clear it completely
- The grace-period distinction in logging (`recovery_already_in_progress` vs `recovery_grace_period`) aids debugging
- Late `auto_compaction_end` errors during grace are suppressed as designed
- Good test coverage for grace period behavior (active, expired, cleared on stop/terminate)

### ✅ Bug 5: No duplicate `agent.continue()` scheduling

Clean removal of the middleman-side `agent.continue()` call:
- `continueAfterCompactionRecoveryIfNeeded` → `dropTrailingOverflowErrorIfPresent` (rename reflects narrowed responsibility)
- The `setTimeout(() => this.session.agent.continue()...)` is removed
- Error message cleanup (`replaceMessages(messages.slice(0, -1))`) is preserved
- Test explicitly verifies `continueSpy` is never called
- Pi remains the single owner of post-compaction `continue()` scheduling

### ✅ Recovery message buffering

Solid implementation:
- Messages during `contextRecoveryInProgress` are buffered (not steered), preventing context pressure
- Messages during grace period (recovery done, but late events still possible) correctly fall through to normal steer
- Buffer has a hard cap (25) with FIFO drop policy and logging
- Flush occurs at both recovery exit points (`cleanupGuard` and `handleAutoCompactionEndEvent` finally)
- Buffer is cleared on `terminate()` and `stopInFlight()`

### ✅ Watchdog batching and circuit breaker

Well-implemented with good defensive checks:
- Multiple workers in the same batch window produce a single compact message
- Batch flush re-validates eligibility (status, recovery, circuit, backoff) at send time
- Circuit breaker opens after 3 consecutive notifications (`MAX_CONSECUTIVE_NOTIFICATIONS`)
- Exponential backoff: 15s → 30s → circuit open
- State properly resets on genuine worker report to parent
- Cleanup in `clearWatchdogState` removes workers from batch queues and cleans empty timers
- Recovery suppression checks both worker AND manager runtime

### ✅ Bounded `list_agents` output

Good pagination implementation:
- Default compact view with summary counts + page metadata
- Workers sorted by priority (streaming > error > idle > stopped > terminated) then recency
- Limit clamped to [1, 100] range
- `offset` beyond workers.length returns empty page with `hasMore: false` (correct edge case)
- Verbose mode returns full descriptors for the page slice only
- Hint text guides LLM toward pagination for remaining pages

### ✅ Interface contract: `SwarmAgentRuntime`

The optional method `isContextRecoveryInProgress?(): boolean` is non-breaking:
- Uses optional method syntax (`?()`) in the interface
- SwarmManager accesses it with `runtime?.isContextRecoveryInProgress?.()`
- `AgentRuntime` implements it; other runtime implementations (e.g., `CodexAgentRuntime`) don't need to

### ✅ Test coverage

New tests cover the key scenarios:
- Compaction timeout triggers `abortCompaction` (both guard and reactive paths)
- Grace period suppresses late auto-compaction errors
- Grace expiry allows normal error processing
- No duplicate `agent.continue()` on overflow recovery
- Recovery buffer: buffering, flushing, cap enforcement
- Watchdog batching, recovery suppression, backoff, circuit breaker, reset

---

## Final Assessment

**APPROVE with minor items.** The implementation is thorough, well-tested, and faithfully follows the remediation plans. The five bugs are correctly addressed with defense-in-depth. No critical issues found.

Priority items before merge:
1. **I-2** (grace period on `handleAutoCompactionEndEvent` finally) — low risk but easy to add for consistency
2. **I-4** (deleted watchdog tests) — consider adding back adapted versions for coverage
3. **I-3** (page.returned count) — documentation or API adjustment

The build passes, all 296 tests pass, and the pi patch applies correctly.
