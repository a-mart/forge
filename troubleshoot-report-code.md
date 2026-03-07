# Root Cause Analysis: Context Overflow & Compaction Failure Cascade

## Executive Summary

A manager session with 60MB JSONL and 105 workers hit a catastrophic failure cascade involving **5 interacting bugs** across the middleman context guard, pi runtime library, and idle worker watchdog system. The root cause is a **missing cancellation mechanism** in the `withTimeout` utility combined with a **reentrancy race condition** in pi's `_runAutoCompaction` method.

---

## Failure Timeline Reconstruction

| # | Log Message | Source | What Actually Happened |
|---|---|---|---|
| 1 | "Context limit approaching — running intelligent handoff before compaction" | `runContextGuard()` | Soft threshold breached. Context guard fired. |
| 2 | "Manager reply failed: Request was aborted" | `session.abort()` | Guard aborted the in-flight streaming turn. |
| 3 | "Context guard error: context_guard_compact timed out after 60000ms" | `withTimeout()` | Manual compaction timed out, **but `session.compact()` kept running in background**. |
| 4 | "Context automatically compacted" | pi `_runAutoCompaction` | Pi's auto-compaction from the resume prompt's `_checkCompaction` reported success. |
| 5 | "Auto-compaction failed: Cannot read properties of undefined (reading 'signal')" | pi `_runAutoCompaction` | **RACE CONDITION**: A second `_runAutoCompaction` call's `_autoCompactionAbortController` was cleared by the first call's `finally` block. |
| 6 | "Context recovery failed after auto-compaction retry and emergency trim" | `handleAutoCompactionEndEvent` | All fallback paths failed because session state was corrupted by concurrent operations. |

---

## Bug 1: `withTimeout` Does Not Cancel Underlying Operations (Critical)

**File:** `apps/backend/src/swarm/agent-runtime.ts`  
**Lines:** 920–935

```typescript
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

**Problem:** `withTimeout` races a promise against a timer, but when the timeout fires, the original `promise` **is not cancelled**. There is no `AbortController` or cancellation mechanism. The underlying `session.compact()` continues running in the background.

**Impact in this incident:** At line 466 of `runContextGuard()`:
```typescript
await withTimeout(this.compact(), CONTEXT_GUARD_COMPACT_TIMEOUT_MS, "context_guard_compact");
```
When the 60-second timeout fires, `session.compact()` keeps running. Its `finally` block will eventually call `_reconnectToAgent()`, re-enabling pi's agent event processing at an unpredictable time — while the context guard has already moved on to the resume prompt.

**Fix needed:** `withTimeout` should accept/use an `AbortSignal` to cancel the underlying operation, or `session.compact()` should be wrapped with `session.abortCompaction()` in the catch/finally path:
```typescript
// In the catch block after compact timeout:
try { this.session.abortCompaction?.(); } catch {}
```

---

## Bug 2: Pi Runtime `_runAutoCompaction` Is Not Reentrant-Safe (Critical — THE `.signal` Crash)

**File:** `node_modules/@mariozechner/pi-coding-agent/dist/core/agent-session.js`  
**Lines:** 1270–1383

```javascript
async _runAutoCompaction(reason, willRetry) {
    this._autoCompactionAbortController = new AbortController();  // line 1273
    try {
        // ... various awaits that yield control ...
        const compactResult = await compact(
            preparation, this.model, apiKey, undefined,
            this._autoCompactionAbortController.signal  // line 1322 — CRASH SITE
        );
        if (this._autoCompactionAbortController.signal.aborted) {  // line 1328 — CRASH SITE
            // ...
        }
    } catch (error) {
        // Emits: "Auto-compaction failed: <error.message>"
    } finally {
        this._autoCompactionAbortController = undefined;  // line 1383 — CLEARS THE FIELD
    }
}
```

**Problem:** `_autoCompactionAbortController` is a shared mutable instance field with no concurrency guard. If two `_runAutoCompaction` calls overlap:

1. **Call A** starts → sets `_autoCompactionAbortController = new AbortController()` (AC-A)
2. **Call A** hits `await compact(...)` → **yields control**
3. **Call B** starts (from a different trigger path) → sets `_autoCompactionAbortController = new AbortController()` (AC-B) — **overwrites AC-A**
4. **Call A** resumes, its `finally` block runs → `_autoCompactionAbortController = undefined` — **clears AC-B!**
5. **Call B** tries `this._autoCompactionAbortController.signal` → **💥 `Cannot read properties of undefined (reading 'signal')`**

**How the overlap happens in this incident:**

The overlap is caused by two distinct trigger paths for `_runAutoCompaction`:

- **Path 1 (agent_end → _checkCompaction):** When the context guard calls `session.abort()`, the agent stops. The `agent_end` event fires asynchronously through `_handleAgentEvent`, which calls `_checkCompaction` → `_runAutoCompaction`. This runs as a **fire-and-forget async** because `_handleAgentEvent` is an async callback on the agent's event bus — the agent doesn't `await` it.

- **Path 2 (prompt → _checkCompaction):** When the context guard later calls `session.prompt(resumePrompt)`, the pi session's `prompt()` method calls `_checkCompaction(lastAssistant, false)` at line 562 **before** submitting the prompt. If the last assistant message was an overflow error, this triggers another `_runAutoCompaction`.

These two calls race on the shared `_autoCompactionAbortController` field.

**Fix needed (in pi-coding-agent):** Add a reentrancy guard:
```javascript
async _runAutoCompaction(reason, willRetry) {
    if (this._autoCompactionAbortController) {
        // Already running — skip or abort the previous one
        return;
    }
    // ... rest of method
}
```

---

## Bug 3: `cleanupGuard()` Runs Before Recovery Events Are Processed

**File:** `apps/backend/src/swarm/agent-runtime.ts`  
**Lines:** 497–510 (`runContextGuard` finally block) and 566–573 (`cleanupGuard`)

```typescript
// In runContextGuard():
} finally {
    await this.cleanupGuard(handoffFilePath);  // line 501
    // ...
}

// cleanupGuard:
private async cleanupGuard(handoffFilePath?: string): Promise<void> {
    this.contextRecoveryInProgress = false;   // line 567 — UNLOCKS RECOVERY PATH
    this.guardAbortController = undefined;     // line 568
    // ...
}
```

**Problem:** The `finally` block of `runContextGuard()` sets `contextRecoveryInProgress = false` unconditionally. But the context guard's operations (abort, handoff, compact, resume prompt) may have triggered pi auto-compaction events that arrive **after** cleanup. When `handleAutoCompactionEndEvent` receives a failed auto-compaction event and finds `contextRecoveryInProgress === false`, it enters the full recovery path — attempting manual compaction and emergency trim on a session that's already been through multiple concurrent operations.

**Timeline:**
1. Context guard finishes, `cleanupGuard()` sets `contextRecoveryInProgress = false`
2. Pi's auto-compaction failure event arrives (from the `.signal` crash in Bug 2)
3. `handleAutoCompactionEndEvent` at line 670 checks: `if (this.contextRecoveryInProgress)` → **false**
4. Enters full recovery → tries compaction retry → tries emergency trim → **all fail** because session state is corrupted from the concurrent operations

```typescript
// Line 670-679:
if (this.contextRecoveryInProgress) {
    // Would skip here — but contextRecoveryInProgress is already false!
    this.logRuntimeError("compaction", ..., { recoveryStage: "auto_compaction_skipped" });
    return;
}
this.contextRecoveryInProgress = true;  // Enters recovery
```

**Fix needed:** The guard should track whether it triggered operations that may produce async events, and either:
- Keep `contextRecoveryInProgress = true` for a grace period after cleanup
- Or explicitly cancel/abort pi's compaction before cleaning up: `this.session.abortCompaction?.()`

---

## Bug 4: Idle Worker Watchdog Amplifies Context Pressure

**File:** `apps/backend/src/swarm/swarm-manager.ts`  
**Lines:** 3816–3920

```typescript
private async handleRuntimeAgentEnd(agentId: string): Promise<void> {
    const descriptor = this.descriptors.get(agentId);
    if (!descriptor || descriptor.role !== "worker") return;

    const watchdogState = this.getOrCreateWorkerWatchdogState(agentId);
    const reportedThisTurn = watchdogState.reportedThisTurn;
    // ... reset state ...

    if (reportedThisTurn) {
        // Worker reported back — no nudge needed
        return;
    }

    // After 3-second grace period, send watchdog notification to manager
    const timer = setTimeout(() => {
        this.handleIdleWorkerWatchdogTimer(agentId, turnSeq, nextToken).catch(...);
    }, IDLE_WORKER_WATCHDOG_GRACE_MS);  // 3000ms
}
```

And at line 3896, the watchdog sends a message to the manager:
```typescript
await this.sendMessage(agentId, descriptor.managerId, watchdogMessage, "auto", { origin: "internal" });
```

**Problem:** With 105 workers, many will complete turns without explicitly sending `send_message_to_agent` to their manager (this is normal for workers doing intermediate tool calls). Each triggers a 3-second watchdog timer, then sends a notification message to the manager. During the context overflow incident:

- The manager's `sendMessage` handler at `AgentRuntime` line 115-118 checks:
  ```typescript
  if (this.session.isStreaming || this.promptDispatchPending || this.contextRecoveryInProgress) {
      await this.enqueueMessage(deliveryId, message);  // Steers into context
  }
  ```
- Each watchdog notification is steered into the context via `session.steer()`, adding tokens to an already-overflowing context window.
- **No rate limiting or batching** for watchdog notifications — all 105 workers' timers fire independently.
- **No suppression during context recovery** — the `contextRecoveryInProgress` check only queues messages rather than dropping them.

**The watchdog message itself is verbose** (lines 3881-3892):
```typescript
const watchdogMessage = `⚠️ [IDLE WORKER WATCHDOG — AUTOMATED SYSTEM CHECK]

Worker \`${descriptor.agentId}\` completed its turn and went idle without sending a message back to you.
...
Worker session file: ${descriptor.sessionFile}
...`;
```

With 105 workers, this could inject **tens of kilobytes** of watchdog text into an already-overflowing context.

**Fix needed:**
- Drop (don't steer) messages during `contextRecoveryInProgress`
- Rate-limit watchdog notifications (batch multiple idle workers into one message)
- Suppress watchdog notifications entirely when the manager is in context recovery

---

## Bug 5: Concurrent `agent.continue()` Calls After Recovery

**File:** `apps/backend/src/swarm/agent-runtime.ts`  
**Lines:** 819–841 (`continueAfterCompactionRecoveryIfNeeded`)

```typescript
private continueAfterCompactionRecoveryIfNeeded(
    compactionReason: "threshold" | "overflow" | undefined
): void {
    if (compactionReason !== "overflow") return;

    const messages = this.session.state.messages;
    const lastMessage = messages[messages.length - 1];
    if (lastMessage?.role === "assistant" && lastMessage.stopReason === "error") {
        this.session.agent.replaceMessages(messages.slice(0, -1));
    }

    setTimeout(() => {
        this.session.agent.continue().catch(...);  // Starts a new agent turn
    }, 100);
}
```

**And in pi's `_runAutoCompaction` (line 1355-1363):**
```javascript
if (willRetry) {
    // ...
    setTimeout(() => {
        this.agent.continue().catch(() => { });  // ALSO starts a new agent turn
    }, 100);
}
```

**Problem:** If auto-compaction succeeds for an "overflow" reason, **both** the middleman's `handleAutoCompactionEndEvent` (via `continueAfterCompactionRecoveryIfNeeded`) AND pi's internal `_runAutoCompaction` call `agent.continue()` with a 100ms `setTimeout`. This causes **duplicate agent turns**, which can compound the context overflow.

**Fix needed:** The middleman should not call `agent.continue()` after overflow recovery — pi's `_runAutoCompaction` already handles this internally.

---

## The Full Cascade — How All Bugs Compound

```
   105 idle workers firing watchdog notifications (Bug 4)
              │
              ▼
   Manager context fills past soft threshold
              │
              ▼
   checkContextBudget() → runContextGuard()
              │
              ├─── session.abort() fires → agent_end
              │                              │
              │         ┌────────────────────┘
              │         ▼
              │    pi _handleAgentEvent (async, fire-and-forget)
              │         │
              │         ▼
              │    _checkCompaction() → _runAutoCompaction() [Call A starts]
              │         │
              │         ▼
              │    _autoCompactionAbortController = new AbortController()
              │    await compact(...) ─── yields control ───┐
              │                                             │
              ├─── handoff turn (may timeout)               │
              │                                             │
              ├─── withTimeout(compact(), 60s)              │
              │         │                                   │
              │         ▼                                   │
              │    session.compact() starts                 │
              │    (separate _compactionAbortController)    │
              │         │                                   │
              │    ┌── TIMEOUT (60s) ──┐                    │
              │    │ withTimeout       │                    │
              │    │ rejects           │                    │
              │    │ BUT compact()     │                    │
              │    │ keeps running!    │  (Bug 1)           │
              │    └───────────────────┘                    │
              │                                             │
              ├─── session.prompt(resumePrompt)             │
              │         │                                   │
              │         ▼                                   │
              │    prompt() calls _checkCompaction()        │
              │         │                                   │
              │         ▼                                   │
              │    _runAutoCompaction() [Call B starts]     │
              │    _autoCompactionAbortController = AC-B    │
              │    (overwrites Call A's controller)         │
              │         │                                   │
              │         │         ┌─────────────────────────┘
              │         │         ▼
              │         │    Call A finally block runs
              │         │    _autoCompactionAbortController = undefined  ← CLEARS AC-B!
              │         │
              │         ▼
              │    Call B: this._autoCompactionAbortController.signal
              │    💥 Cannot read properties of undefined (reading 'signal')
              │                                             (Bug 2)
              │
              ├─── cleanupGuard() → contextRecoveryInProgress = false
              │                                             (Bug 3)
              │
              ▼
   auto_compaction_end event arrives with ".signal" error
              │
              ▼
   handleAutoCompactionEndEvent
   contextRecoveryInProgress === false → enters full recovery
              │
              ├─── retryCompactionOnceAfterAutoFailure → FAILS
              │    (session state corrupted from concurrent operations)
              │
              ├─── runEmergencyContextTrim → FAILS
              │    (session in inconsistent state)
              │
              ▼
   "Context recovery failed after auto-compaction retry and emergency trim"
```

---

## Recommended Fixes (Priority Order)

### P0: Fix `withTimeout` to cancel underlying operations
**File:** `apps/backend/src/swarm/agent-runtime.ts` line 920  
Add abort controller support, and call `session.abortCompaction()` when compact times out:
```typescript
// In runContextGuard, after compact timeout catch:
try { this.session.abortCompaction?.(); } catch {}
```

### P0: Guard against `_runAutoCompaction` reentrancy (pi-coding-agent fix)
**File:** `pi-coding-agent/dist/core/agent-session.js` line 1270  
Add: `if (this._autoCompactionAbortController) return;` at the top of `_runAutoCompaction`.

### P1: Don't steer messages during context recovery
**File:** `apps/backend/src/swarm/agent-runtime.ts` line 115  
During `contextRecoveryInProgress`, drop inbound messages (or hold them in a separate buffer that doesn't touch the session context):
```typescript
if (this.contextRecoveryInProgress) {
    return { targetAgentId, deliveryId, acceptedMode: "dropped" };
}
```

### P1: Rate-limit / suppress watchdog notifications during recovery
**File:** `apps/backend/src/swarm/swarm-manager.ts` line 3849  
Check manager's context recovery state before sending watchdog messages. Batch multiple idle workers into a single notification.

### P2: Keep `contextRecoveryInProgress` active with grace period
**File:** `apps/backend/src/swarm/agent-runtime.ts` line 566  
In `cleanupGuard()`, use a short delay or event-count-based approach before clearing `contextRecoveryInProgress`, so late-arriving auto_compaction_end events are properly suppressed.

### P2: Remove duplicate `agent.continue()` in `continueAfterCompactionRecoveryIfNeeded`
**File:** `apps/backend/src/swarm/agent-runtime.ts` line 835  
Pi already handles the `agent.continue()` after overflow auto-compaction. The middleman should not also call it.
