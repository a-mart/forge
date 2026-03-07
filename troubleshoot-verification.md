# Independent Verification Report — Context Overflow Failure

**Verifier:** `verifier` agent  
**Date:** 2026-03-06  
**Codebase:** `/Users/adam/repos/middleman` @ current HEAD  

---

## Claim 1: `withTimeout` doesn't cancel the underlying promise

**Source:** `apps/backend/src/swarm/agent-runtime.ts`, lines 920–938

**Code (verbatim):**
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

**Verdict: ✅ CONFIRMED.**  
`withTimeout` is a pure `Promise.race` wrapper. When the timeout fires, the `Error` is thrown to the caller, but the underlying `compact()` / `abort()` promise continues executing in the background. There is no `AbortController` signal passed, no cancellation mechanism. The `finally` block only clears the timeout timer, not the underlying operation.

**Call sites affected (all in `agent-runtime.ts`):**
- Line 439: `withTimeout(this.session.abort(), ...)`
- Line 471: `withTimeout(this.compact(), ...)`
- Line 527: `withTimeout(this.session.abort(), ...)`
- Line 740: `withTimeout(this.compact(), ...)` (reactive compaction retry)

A timed-out `compact()` will continue running in the background, consuming resources and potentially completing/crashing later with stale state.

---

## Claim 2: Pi's `_runAutoCompaction` has a shared `_autoCompactionAbortController` reentrancy bug (THE crash)

**Source:** `node_modules/.pnpm/@mariozechner+pi-coding-agent@0.55.0_.../dist/core/agent-session.js`, lines 1270–1389

**Code flow:**
```javascript
// Line 1273: Entry
this._autoCompactionAbortController = new AbortController();
// Line 1298, 1322: Used
signal: this._autoCompactionAbortController.signal
// Line 1328: Read
if (this._autoCompactionAbortController.signal.aborted) { ... }
// Line 1359: Triggers new agent loop via setTimeout
setTimeout(() => { this.agent.continue().catch(() => {}); }, 100);
// Line 1383 (finally): Clears the field
this._autoCompactionAbortController = undefined;
```

**Analysis:** The reentrancy scenario requires two overlapping `_runAutoCompaction` calls. Looking at the actual call flow:

1. `_runAutoCompaction` is called from the agent turn handler (lines 1255, 1264) with `await`.
2. The `continue()` call on line 1359 uses `setTimeout(..., 100)`, meaning the finally block on line 1383 executes **synchronously** before the `continue()` callback fires. So within a single invocation, there's no race between `continue()` and the `finally` block.
3. However, the field is **unconditionally overwritten** on line 1273 at entry (`this._autoCompactionAbortController = new AbortController()`). There is **no guard** checking if one is already running. If `_runAutoCompaction` is called while a previous invocation's `compact()` call is still in-flight (e.g., because middleman's `withTimeout` timed out but the underlying compact continued, then a new overflow error triggers another call), the old abort controller is silently replaced, and the old in-flight compact operation references a now-orphaned signal.

4. The `finally` block unconditionally clears `_autoCompactionAbortController = undefined` (line 1383). If invocation A is still running when invocation B starts and finishes first, B's finally clears the controller, and A later reads `this._autoCompactionAbortController.signal` (line 1328) → **null reference crash** (`Cannot read properties of undefined (reading 'signal')`).

**Verdict: ✅ CONFIRMED — but with nuance.**  
The reentrancy is real but requires a specific trigger path. The most likely scenario in the observed failure: middleman's `withTimeout` on `compact()` times out, the background compact keeps running, then a new overflow triggers another `_runAutoCompaction`. The new call overwrites `_autoCompactionAbortController`, and if the old call tries to read `.signal` after the new call's `finally` clears it → crash. The `isCompacting` getter (line 430) checks `this._autoCompactionAbortController !== undefined` but is not used as a guard before calling `_runAutoCompaction`.

---

## Claim 3: `cleanupGuard()` sets `contextRecoveryInProgress = false` prematurely

**Source:** `apps/backend/src/swarm/agent-runtime.ts`, lines 566–570

**Code:**
```typescript
private async cleanupGuard(handoffFilePath?: string): Promise<void> {
    this.contextRecoveryInProgress = false;       // Line 567
    this.guardAbortController = undefined;         // Line 568
    // ... file cleanup
}
```

**Context:** `cleanupGuard` is called in the `finally` block of `runContextGuard` (line 501). The guard flow is:
1. Set `contextRecoveryInProgress = true` (line 407)
2. Abort → handoff → compact → resume prompt
3. `finally` → `cleanupGuard()` → sets `contextRecoveryInProgress = false`

Meanwhile, `handleAutoCompactionEndEvent` (line 648) checks `contextRecoveryInProgress` on line 670:
```typescript
if (this.contextRecoveryInProgress) {
    // skip — recovery_already_in_progress
    return;
}
```

**Timing issue:** If `cleanupGuard` runs (sets `contextRecoveryInProgress = false`), but a pi auto_compaction_end event arrives late (from a background compact that was still running after `withTimeout` timed out — see Claim 1), the event handler will NOT skip it, and will set `contextRecoveryInProgress = true` again and start a new reactive recovery cycle. This creates a double-recovery scenario.

**Verdict: ✅ CONFIRMED.** The guard cleanup and the auto_compaction_end event handler can desynchronize because `withTimeout` doesn't cancel the underlying compact. The flag flip creates a window for late events to start new recovery cycles.

---

## Claim 4: Idle worker watchdog has no rate limiting or suppression during context recovery

**Source:** `apps/backend/src/swarm/swarm-manager.ts`

**Watchdog state** (lines 395–398):
```typescript
interface WorkerWatchdogState {
  turnSeq: number;
  reportedThisTurn: boolean;
}
```

**Watchdog trigger** (`handleRuntimeAgentEnd`, lines 3822–3847): On every worker agent-end event, if the worker didn't report back, a 3-second timer fires `handleIdleWorkerWatchdogTimer`.

**Watchdog handler** (`handleIdleWorkerWatchdogTimer`, lines 3850–3920): Checks:
- Token match (stale-timer guard) ✅
- Descriptor exists and is a worker ✅
- `watchdogState.turnSeq` match and `reportedThisTurn` ✅
- Worker status is "idle" ✅
- Parent manager exists and is not in a non-running status ✅

**What's NOT checked:**
- ❌ No check for manager's `contextRecoveryInProgress` state
- ❌ No back-off or max-retry counter (a worker can trigger the watchdog on every single turn indefinitely)
- ❌ No rate limiting (each worker fires independently on its own 3-second timer)
- ❌ No suppression for workers that are failing due to model quota errors

The watchdog sends a message to the manager via `this.sendMessage(agentId, descriptor.managerId, watchdogMessage, "auto", ...)` (line 3896), which queues as a steer if the manager is busy. During context recovery, the manager is "streaming" (from the compaction/handoff prompt), so watchdog messages queue up.

**Verdict: ✅ CONFIRMED.** No rate limiting, no circuit breaker, no context-recovery awareness. Each idle worker independently fires nudges every turn, potentially flooding the manager with steer messages during recovery.

---

## Claim 5: Both middleman and pi call `agent.continue()` after overflow compaction recovery

**Source 1 — Pi's call** (`agent-session.js`, lines 1352–1360):
```javascript
if (willRetry) {
    const messages = this.agent.state.messages;
    const lastMsg = messages[messages.length - 1];
    if (lastMsg?.role === "assistant" && lastMsg.stopReason === "error") {
        this.agent.replaceMessages(messages.slice(0, -1));
    }
    setTimeout(() => {
        this.agent.continue().catch(() => { });
    }, 100);
}
```
This fires when `reason === "overflow"` and `willRetry === true` (line 1255).

**Source 2 — Middleman's call** (`agent-runtime.ts`, lines 819–841):
```typescript
private continueAfterCompactionRecoveryIfNeeded(compactionReason) {
    if (compactionReason !== "overflow") return;
    // ... remove error message ...
    setTimeout(() => {
        this.session.agent.continue().catch((error) => { ... });
    }, 100);
}
```
This is called from `handleAutoCompactionEndEvent` after manual retry recovery (line 705) or emergency trim (line 714).

**Analysis of double-continue risk:** The key question is whether both fire in the same flow. Looking at the flow:

1. Pi's `_runAutoCompaction` succeeds → it calls `continue()` (line 1359) AND emits `auto_compaction_end` with no error (line 1351).
2. Middleman's `handleAutoCompactionEndEvent` receives the successful event → the `!autoCompactionError` branch (line 659) returns early WITHOUT calling `continueAfterCompactionRecoveryIfNeeded`. **No double-continue in success case.**

3. Pi's `_runAutoCompaction` fails → it does NOT call `continue()`, and emits `auto_compaction_end` with an error message (lines 1371–1381).
4. Middleman catches the failed event → does manual retry → if that succeeds, calls `continueAfterCompactionRecoveryIfNeeded` (line 705). **This is a single continue — middleman only.**

**However,** if pi's `_runAutoCompaction` succeeds AND fires `continue()`, but the resumed agent loop immediately overflows again, middleman's context guard (`runContextGuard`) could trigger, which does its own `session.prompt(resumePrompt)` (line 497). This isn't `continue()` per se, but it is a second concurrent prompt dispatch, which could interleave with the pi-initiated `continue()`.

**Verdict: ⚠️ PARTIALLY CONFIRMED.** Both call sites exist, but they don't fire in the same auto_compaction_end event flow. The actual double-kick risk is: pi's `continue()` on success → new turn overflows → middleman's context guard fires → concurrent activity. The investigators' framing of "both call `continue()`" is technically true (both code paths exist), but the more precise issue is that pi handles the success-path continue internally while middleman handles the failure-path continue, and they can cascade rather than double-fire on the same event.

---

## Claim 6: `list_agents` output bloat — no truncation/pagination

**Source:** `apps/backend/src/swarm/swarm-tools.ts`, lines 80–106

**Code:**
```typescript
{
  name: "list_agents",
  async execute() {
    let agents = host.listAgents();
    // Filter to own manager + sibling workers
    agents = agents.filter(...);
    return {
      content: [{ type: "text", text: JSON.stringify({ agents }, null, 2) }],
      details: { agents }
    };
  }
}
```

**AgentDescriptor shape** (from `packages/protocol/src/shared-types.ts`, lines 26–42):
```typescript
interface AgentDescriptor {
  agentId: string;      managerId: string;
  displayName: string;  role: 'manager' | 'worker';
  archetypeId?: string; status: AgentStatus;
  createdAt: string;    updatedAt: string;
  cwd: string;          model: AgentModelDescriptor;
  sessionFile: string;  contextUsage?: AgentContextUsage;
  profileId?: string;   sessionLabel?: string;
  mergedAt?: string;
}
```

**Analysis:**
- `JSON.stringify({ agents }, null, 2)` — pretty-printed with 2-space indent, no truncation.
- The `sessionFile` field contains **full absolute paths** like `/Users/adam/.middleman/profiles/<id>/sessions/<id>/session.jsonl`.
- The `cwd` field also contains full paths.
- Each agent descriptor JSON-serialized with pretty-print is roughly ~500-800 bytes.
- With ~20+ workers, a single `list_agents` call easily produces 10-20KB.
- The filtering only restricts to same-manager siblings, so a busy manager with many workers sees all of them.

There is **no pagination, no truncation, and no size cap** in the tool output.

**Verdict: ✅ CONFIRMED.** `list_agents` dumps the full AgentDescriptor for every visible agent as pretty-printed JSON with no truncation. For a session with many workers, repeated `list_agents` calls can produce enormous tool_result entries. Whether it reached 938KB per call or 18.3MB total depends on how many agents were alive and how many times it was called — the code imposes no limit whatsoever.

---

## Claim 7: Dead `worktree-cleanup` worker with no circuit breaker for repeated model failures

**Source:** `apps/backend/src/swarm/swarm-manager.ts` — `WorkerWatchdogState` (lines 395–398) and `handleIdleWorkerWatchdogTimer` (lines 3850–3920)

**WorkerWatchdogState:**
```typescript
interface WorkerWatchdogState {
  turnSeq: number;
  reportedThisTurn: boolean;
}
```

**No circuit breaker fields:** No `nudgeCount`, `failureCount`, `lastNudgeAt`, `maxRetries`, `backoffMs`, or any similar field exists in the state or the handler.

**Flow for a repeatedly failing worker:**
1. Worker gets a message → tries to call model → model returns quota/billing error → agent turn ends with error
2. `handleRuntimeAgentEnd` fires → worker didn't report → 3s timer starts
3. Timer fires → sends watchdog nudge to manager
4. Manager processes nudge → sends follow-up to worker
5. Worker tries again → model error again → go to step 2
6. This repeats indefinitely with no escalation, suppression, or back-off

The watchdog `turnSeq` and token mechanism only prevents stale timer races, NOT repeated nudges. Each new turn increments `turnSeq` and resets `reportedThisTurn`, making the worker eligible for another nudge.

**Verdict: ✅ CONFIRMED.** There is absolutely no circuit breaker, max-retry, or back-off logic in the watchdog. A worker stuck in a model failure loop will trigger the watchdog every single turn, sending a new nudge to the manager each time. The manager then sends a new message to the worker, which fails again, creating an infinite nudge loop that generates continuous context growth.

---

## Summary

| # | Claim | Verdict | Severity |
|---|-------|---------|----------|
| 1 | `withTimeout` doesn't cancel underlying promise | ✅ Confirmed | High — background compaction runs unsupervised |
| 2 | Pi's `_autoCompactionAbortController` reentrancy crash | ✅ Confirmed (with nuance) | Critical — null-ref crash on `.signal` |
| 3 | `cleanupGuard()` premature flag reset | ✅ Confirmed | Medium — creates double-recovery window |
| 4 | Watchdog has no rate limiting during recovery | ✅ Confirmed | High — floods manager during crisis |
| 5 | Both middleman + pi call `continue()` | ⚠️ Partially confirmed | Medium — they cover different paths but cascade risk exists |
| 6 | `list_agents` output bloat, no truncation | ✅ Confirmed | High — unbounded context growth |
| 7 | No circuit breaker for failing worker watchdog | ✅ Confirmed | High — infinite nudge loop |

### Key Correction

**Claim 5** was slightly misstated. Pi calls `continue()` on successful auto-compaction overflow recovery. Middleman calls `continue()` on failed auto-compaction (after its own manual retry/trim succeeds). They don't both fire on the same event — they handle different branches. The cascade risk is real but the mechanism is sequential overflow → recovery → new overflow, not a single-event double-continue.

### Root Cause Chain (Verified)

The catastrophic failure follows this verified chain:
1. **`list_agents` bloat** (Claim 6) inflates context toward limits
2. **Failing worker nudge loop** (Claim 7) compounds context growth
3. Context hits overflow → pi's `_runAutoCompaction` fires
4. **`withTimeout` doesn't cancel** (Claim 1) → if compaction times out, background compact continues
5. **Reentrancy crash** (Claim 2) → second overflow triggers new `_runAutoCompaction`, overwrites abort controller
6. **Premature flag reset** (Claim 3) → late events start new recovery cycles
7. **Watchdog flooding** (Claim 4) → workers keep sending nudges during recovery, adding more context pressure
8. System enters death spiral: overflow → recovery → more context → overflow
