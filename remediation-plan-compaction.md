# Compaction & Recovery Remediation Plan (Bugs 1, 3, 5)

## Scope

**Codebase:** `/Users/adam/repos/middleman`

**Primary file to change:**
- `apps/backend/src/swarm/agent-runtime.ts`

**Test file to update:**
- `apps/backend/src/swarm/__tests__/mid-turn-context-guard.test.ts`

**External dependency reference (read-only):**
- `node_modules/.pnpm/@mariozechner+pi-coding-agent@0.55.0_.../dist/core/agent-session.js`
  - `_runAutoCompaction(...)` currently schedules `agent.continue()` on overflow success
  - `abortCompaction()` exists and aborts both manual + auto compaction controllers

---

## Bug 1 — `withTimeout` does not cancel underlying compaction

### Root issue
`withTimeout(this.compact(), 60s, ...)` only rejects the wrapper promise; the underlying `session.compact()` keeps running and can reconnect event processing later from its `finally` path.

### Planned code changes

### 1.1 Extend `withTimeout` to support timeout hooks
Add optional `onTimeout` so callers can cancel orphaned work.

**Before** (`agent-runtime.ts`, bottom helper):
```ts
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | undefined;

  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });

    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}
```

**After (planned):**
```ts
type TimeoutOptions = {
  onTimeout?: () => void | Promise<void>;
};

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  options?: TimeoutOptions
): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | undefined;
  let didTimeout = false;

  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        didTimeout = true;
        reject(new Error(`${label} timed out after ${ms}ms`));
      }, ms);
    });

    return await Promise.race([promise, timeoutPromise]);
  } catch (error) {
    if (didTimeout && options?.onTimeout) {
      await options.onTimeout();
    }
    throw error;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}
```

### 1.2 Add a safe compaction-abort helper
Use pi’s `abortCompaction()` when timeout fires.

**Planned new method in `AgentRuntime`:**
```ts
private abortCompactionSafely(stage: string): void {
  try {
    this.session.abortCompaction?.();
  } catch (error) {
    this.logRuntimeError("compaction", error, { stage });
  }
}
```

### 1.3 Call timeout hook at both compaction timeout sites
- `runContextGuard()` manual compaction timeout
- `retryCompactionOnceAfterAutoFailure()` reactive retry timeout

**Before:**
```ts
await withTimeout(this.compact(), CONTEXT_GUARD_COMPACT_TIMEOUT_MS, "context_guard_compact");
```

```ts
await withTimeout(this.compact(), CONTEXT_GUARD_COMPACT_TIMEOUT_MS, "reactive_compaction_retry");
```

**After (planned):**
```ts
await withTimeout(this.compact(), CONTEXT_GUARD_COMPACT_TIMEOUT_MS, "context_guard_compact", {
  onTimeout: () => this.abortCompactionSafely("context_guard_compact_timeout_abort")
});
```

```ts
await withTimeout(this.compact(), CONTEXT_GUARD_COMPACT_TIMEOUT_MS, "reactive_compaction_retry", {
  onTimeout: () => this.abortCompactionSafely("reactive_compaction_retry_timeout_abort")
});
```

---

## Bug 3 — `cleanupGuard()` unlocks recovery before late auto-compaction events

### Root issue
`cleanupGuard()` sets `contextRecoveryInProgress = false` immediately. Late `auto_compaction_end` events then enter full fallback recovery against unstable state.

### Planned code changes

### 3.1 Add post-guard grace window state
Use a short grace period after guard cleanup to treat recovery as still active for event handling.

**Planned additions:**
```ts
const CONTEXT_RECOVERY_GRACE_MS = 2_000;

private contextRecoveryGraceUntilMs = 0;

private isContextRecoveryActive(): boolean {
  return this.contextRecoveryInProgress || Date.now() < this.contextRecoveryGraceUntilMs;
}

private beginContextRecovery(): void {
  this.contextRecoveryInProgress = true;
  this.contextRecoveryGraceUntilMs = 0;
}

private endContextRecovery(graceMs = 0): void {
  this.contextRecoveryInProgress = false;
  this.contextRecoveryGraceUntilMs = graceMs > 0 ? Date.now() + graceMs : 0;
}
```

### 3.2 Replace direct boolean checks with `isContextRecoveryActive()`
Update these guard points:
- `sendMessage(...)`
- `checkContextBudget()`
- `runContextGuard()` early-exit check
- `handleAutoCompactionEndEvent()` skip gate

**Before (example):**
```ts
if (this.session.isStreaming || this.promptDispatchPending || this.contextRecoveryInProgress) {
```

**After (planned):**
```ts
if (this.session.isStreaming || this.promptDispatchPending || this.isContextRecoveryActive()) {
```

### 3.3 Change guard cleanup to grace-based unlock
**Before:**
```ts
private async cleanupGuard(handoffFilePath?: string): Promise<void> {
  this.contextRecoveryInProgress = false;
  this.guardAbortController = undefined;
  // ...
}
```

**After (planned):**
```ts
private async cleanupGuard(handoffFilePath?: string): Promise<void> {
  this.endContextRecovery(CONTEXT_RECOVERY_GRACE_MS);
  this.guardAbortController = undefined;
  // ...
}
```

### 3.4 Distinguish skip reason in `handleAutoCompactionEndEvent`
When skipping due active recovery/grace, log precise reason:
- `recovery_already_in_progress`
- `recovery_grace_period`

**Before:**
```ts
if (this.contextRecoveryInProgress) {
  this.logRuntimeError("compaction", new Error(autoCompactionError), {
    recoveryStage: "auto_compaction_skipped",
    reason: "recovery_already_in_progress"
  });
  this.latestAutoCompactionReason = undefined;
  return;
}
```

**After (planned):**
```ts
if (this.isContextRecoveryActive()) {
  this.logRuntimeError("compaction", new Error(autoCompactionError), {
    recoveryStage: "auto_compaction_skipped",
    reason: this.contextRecoveryInProgress ? "recovery_already_in_progress" : "recovery_grace_period"
  });
  this.latestAutoCompactionReason = undefined;
  return;
}
```

### 3.5 Normalize state resets through helper methods
Replace direct assignments in:
- `terminate()`
- `stopInFlight()`
- `checkContextBudget` top-level catch
- `runContextGuard()` start
- `handleAutoCompactionEndEvent()` start/finally

with `beginContextRecovery()` / `endContextRecovery()` to avoid partial state resets.

---

## Bug 5 — duplicate `agent.continue()` scheduling

### Root issue
Middleman fallback recovery path can schedule `agent.continue()` while pi also schedules one from `_runAutoCompaction` (overflow), causing duplicate turns.

### Planned code changes

### 5.1 Remove middleman-owned continue scheduling
Stop scheduling `this.session.agent.continue()` from `AgentRuntime` recovery helper.

**Before (current helper):**
```ts
private continueAfterCompactionRecoveryIfNeeded(
  compactionReason: "threshold" | "overflow" | undefined
): void {
  if (compactionReason !== "overflow") {
    return;
  }

  const messages = this.session.state.messages;
  const lastMessage = messages[messages.length - 1];
  if (lastMessage?.role === "assistant" && lastMessage.stopReason === "error") {
    this.session.agent.replaceMessages(messages.slice(0, -1));
  }

  setTimeout(() => {
    this.session.agent.continue().catch((error) => {
      this.logRuntimeError("compaction", error, {
        recoveryStage: "recovery_continue_failed",
        compactionReason
      });
    });
  }, 100);
}
```

**After (planned):**
- Delete this method, or reduce it to **error-message cleanup only** with no `agent.continue()`.
- Update `handleAutoCompactionEndEvent()` recovery-success branches to stop invoking continuation.

Example replacement:
```ts
private dropTrailingOverflowErrorIfPresent(
  compactionReason: "threshold" | "overflow" | undefined
): void {
  if (compactionReason !== "overflow") {
    return;
  }

  const messages = this.session.state.messages;
  const lastMessage = messages[messages.length - 1];
  if (lastMessage?.role === "assistant" && lastMessage.stopReason === "error") {
    this.session.agent.replaceMessages(messages.slice(0, -1));
  }
}
```

And in handler:
```ts
if (manualRetry.recovered) {
  this.dropTrailingOverflowErrorIfPresent(compactionReason);
  return;
}
```

---

## Edge cases to cover

1. **Timeout races near completion**
   - Compaction may finish close to timeout boundary.
   - Ensure `abortCompaction()` is only invoked when timeout actually won race.

2. **`abortCompaction()` throws unexpectedly**
   - Must not mask original timeout error.
   - Log and continue fallback path.

3. **Late auto-compaction errors during grace**
   - Must be skipped, not escalated into manual retry + emergency trim.

4. **Grace period should not “stick” forever**
   - `terminate()` / `stopInFlight()` / new recovery runs must clear grace state.

5. **Overflow fallback recovery after removing `continue()`**
   - Confirm we don’t accidentally trigger duplicate turns.
   - Confirm no unhandled exception path expects middleman to resume the loop.

---

## Test strategy

## Unit tests (`apps/backend/src/swarm/__tests__/mid-turn-context-guard.test.ts`)

### Add/adjust FakeSession support
- Add `abortCompaction()` tracking (`abortCompactionCalls`)
- Ensure `agent.continue` is spy-able for duplicate-continue assertions

### New tests
1. **Compaction timeout aborts orphaned work (guard path)**
   - `runContextGuard` + hanging `compactImpl`
   - advance fake timers to 60s
   - assert `abortCompactionCalls === 1`

2. **Reactive retry timeout aborts orphaned work**
   - `retryCompactionOnceAfterAutoFailure` + hanging `compactImpl`
   - advance fake timers
   - assert timeout result + `abortCompactionCalls === 1`

3. **Late `auto_compaction_end` error is skipped during grace**
   - simulate guard cleanup (or set grace timestamp directly)
   - emit `auto_compaction_end` with `errorMessage`
   - assert `retryCompactionOnceAfterAutoFailure` not called

4. **After grace expires, auto-compaction error is processed normally**
   - move clock beyond grace
   - emit `auto_compaction_end` error
   - assert retry path invoked

5. **Fallback recovery does not call middleman `agent.continue()`**
   - force `manualRetry.recovered = true` with `compactionReason = "overflow"`
   - assert `session.agent.continue` not called by `AgentRuntime`

## Validation commands
- Targeted backend test:
  - `pnpm --filter @middleman/backend test -- src/swarm/__tests__/mid-turn-context-guard.test.ts`
- Full backend tests:
  - `pnpm --filter @middleman/backend test`
- Project typecheck gate:
  - `pnpm exec tsc --noEmit`

---

## Risk assessment

### Low risk
- Adding timeout hooks and calling `abortCompaction()` on timeout.
- Grace-period gating of recovery-event handling.

### Medium risk
- Changing continuation ownership (Bug 5) can alter overflow-retry behavior in rare fallback paths.
  - Mitigation: rely on pi as single owner of `agent.continue()` after auto-compaction.
  - Add explicit tests that no duplicate continue is scheduled by middleman.

### Observability follow-up
- Add explicit log metadata when timeout-triggered abort fires and when grace-suppression occurs.
- This helps verify the fixes in production traces.

---

## Dependency on pi-coding-agent (Bug 2)

Bug 2 is external and must still be fixed in pi:
- `_runAutoCompaction` needs reentrancy protection for `_autoCompactionAbortController`.

**Why this matters for this plan:**
- The middleman fixes here reduce blast radius (cancel orphaned compaction, suppress late-event recovery races, avoid duplicate continue scheduling), but they do **not** eliminate the root `.signal` crash if pi remains reentrancy-unsafe.

### Recommended dependency action
- Upgrade/pin to pi version containing Bug 2 fix before declaring the compaction pipeline fully remediated.
- Keep optional chaining on `abortCompaction` calls (`?.`) for compatibility safety across mixed environments.
