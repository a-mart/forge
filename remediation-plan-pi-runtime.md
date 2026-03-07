# Remediation Plan: Pi Runtime `_runAutoCompaction` Reentrancy Race (`.signal` Crash)

**Package:** `@mariozechner/pi-coding-agent` v0.55.0  
**File:** `dist/core/agent-session.js`  
**Severity:** Critical — causes unrecoverable crash in long-running agent sessions  
**Date:** 2026-03-06

---

## 1. Root Cause Analysis (Verified)

### 1.1 The Crash

```
TypeError: Cannot read properties of undefined (reading 'signal')
```

Occurs at any of three `.signal` access points inside `_runAutoCompaction()`:
- **Line 1298:** `signal: this._autoCompactionAbortController.signal` (extension `session_before_compact` event)
- **Line 1322:** `this._autoCompactionAbortController.signal` (passed to `compact()`)
- **Line 1328:** `this._autoCompactionAbortController.signal.aborted` (post-compact abort check)

### 1.2 The Race Condition

`_autoCompactionAbortController` is a **shared mutable instance field** (line 74). The `_runAutoCompaction` method is `async` and yields control at multiple `await` points. There is **no reentrancy guard** — nothing prevents a second call from entering while the first is suspended.

**Timeline of the crash:**

```
T0:  Call A enters _runAutoCompaction("overflow", true)
T1:  Call A sets this._autoCompactionAbortController = new AbortController()  [AC-A]
T2:  Call A hits `await compact(...)` → yields to event loop
T3:  Call B enters _runAutoCompaction("threshold", false)
T4:  Call B sets this._autoCompactionAbortController = new AbortController()  [AC-B] — overwrites AC-A
T5:  Call A resumes from await, reaches `finally` block
T6:  Call A's `finally` sets this._autoCompactionAbortController = undefined  — clears AC-B!
T7:  Call B reads this._autoCompactionAbortController.signal → 💥 undefined
```

### 1.3 Two Concrete Trigger Paths That Race

**Path 1 — `agent_end` (fire-and-forget async):**
```
session.abort()
  → agent emits `agent_end` event
  → _handleAgentEvent (async arrow fn, line 142) — NOT awaited by abort()
  → _lastAssistantMessage is set? yes
  → _checkCompaction(msg) at line 207
  → _runAutoCompaction()
```

**Path 2 — `session.prompt(resumePrompt)` (pre-prompt check):**
```
session.prompt(text)
  → line 562: _checkCompaction(lastAssistant, false)
  → _runAutoCompaction()
```

**How they race in practice (middleman's `runContextGuard`):**

1. Mid-turn context guard detects high usage → calls `session.abort()` (line 446)
2. `session.abort()` returns after `waitForIdle()`, but `_handleAgentEvent` for `agent_end` is still running asynchronously
3. `_handleAgentEvent` calls `_checkCompaction` → starts **auto-compaction Call A**
4. Guard continues → calls `session.prompt(resumePrompt)` at line 494
5. `prompt()` calls `_checkCompaction` at line 562 → starts **auto-compaction Call B**
6. Both calls are now racing on the shared `_autoCompactionAbortController`

### 1.4 Existing Guards (Insufficient)

The code has **zero** guards against concurrent `_runAutoCompaction` entry:

- `_checkCompaction()` (line 1227) only checks: `settings.enabled`, `stopReason === "aborted"`, context window thresholds. No check for `_autoCompactionAbortController !== undefined`.
- `isCompacting` getter (line 430) exists but is **never consulted** before entering `_runAutoCompaction`.
- Middleman's `contextRecoveryInProgress` flag (agent-runtime.ts:70) guards the *middleman layer* but **cannot prevent pi-internal races** because pi's `_handleAgentEvent` runs fire-and-forget inside the pi session, invisible to middleman's guard.

---

## 2. Fix Options

### Option A: Simple Reentrancy Guard (Early Return)

**Implementation:**
```javascript
// In _runAutoCompaction, at the top:
async _runAutoCompaction(reason, willRetry) {
    // Guard: if a compaction is already running, skip
    if (this._autoCompactionAbortController) {
        return;
    }
    const settings = this.settingsManager.getCompactionSettings();
    this._emit({ type: "auto_compaction_start", reason });
    this._autoCompactionAbortController = new AbortController();
    // ... rest unchanged
}
```

**Pros:**
- Simplest possible fix (1 line added)
- Zero risk of introducing new failure modes
- Matches the existing behavior intent: auto-compaction is a best-effort background task

**Cons:**
- Silently drops the second compaction request. If Call A fails, the compaction need from Call B is lost.
- No event emission for the dropped call — callers with `willRetry=true` (overflow case) would silently lose their retry.

**Edge Cases:**
- If Call A is an "overflow" compaction that fails, and Call B is a "threshold" compaction that gets dropped, the session continues without compaction. This is safe because the next `agent_end` will re-trigger `_checkCompaction`.
- If Call A is dropped while Call B (the one that holds the controller) succeeds, correct behavior.

**Risk: LOW.** The dropped compaction will be retried on the next turn boundary. This is the correct minimal fix.

**Refinement — emit a diagnostic event for the skip:**
```javascript
if (this._autoCompactionAbortController) {
    this._emit({ type: "auto_compaction_end", result: undefined, aborted: true, willRetry: false });
    return;
}
```

### Option B: Abort Previous, Start Fresh

**Implementation:**
```javascript
async _runAutoCompaction(reason, willRetry) {
    // If a compaction is already running, abort it and take over
    if (this._autoCompactionAbortController) {
        this._autoCompactionAbortController.abort();
        // Wait briefly for the previous call's finally block to clean up
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    const settings = this.settingsManager.getCompactionSettings();
    this._emit({ type: "auto_compaction_start", reason });
    this._autoCompactionAbortController = new AbortController();
    // ... rest unchanged
}
```

**Pros:**
- More recent compaction request always wins (fresher context state)
- No silent data loss if the second call has a more critical reason

**Cons:**
- Still has a subtle race: the `setTimeout(0)` yield lets the first call's `finally` block run, but there's no guarantee of ordering. The first call's `finally` could still clear the *new* controller if timing is unlucky.
- More complex, harder to reason about correctness
- The `abort()` signal propagates into the `compact()` API call, which may leave the compaction model API in an undefined state

**Edge Cases:**
- If Call A's `compact()` is mid-flight with the LLM and gets aborted, the LLM request is cancelled but session state is consistent (no `appendCompaction` happens because the abort check at line 1328 catches it).
- The `finally` block race is the critical flaw: Call A's `finally` runs *after* Call B has set a new controller, clearing it. This option **does not fully fix the bug** without also changing the `finally` block.

**Risk: MEDIUM-HIGH.** Introduces new timing-dependent behavior. The `finally` block would need to be changed to only clear if it still owns the controller:

```javascript
finally {
    if (this._autoCompactionAbortController === myLocalController) {
        this._autoCompactionAbortController = undefined;
    }
}
```

This makes it essentially a combination of Options B and D.

### Option C: Serialized Compaction Queue

**Implementation:**
```javascript
// New field:
_autoCompactionQueue = Promise.resolve();

async _runAutoCompaction(reason, willRetry) {
    this._autoCompactionQueue = this._autoCompactionQueue.then(
        () => this._runAutoCompactionImpl(reason, willRetry)
    ).catch(() => {}); // Ensure chain doesn't break on errors
    return this._autoCompactionQueue;
}

async _runAutoCompactionImpl(reason, willRetry) {
    // Original _runAutoCompaction body (unchanged)
    const settings = this.settingsManager.getCompactionSettings();
    this._emit({ type: "auto_compaction_start", reason });
    this._autoCompactionAbortController = new AbortController();
    // ...
}
```

**Pros:**
- Guarantees serial execution — no two compactions overlap
- Preserves all compaction requests (none silently dropped)
- Clean separation of concerns

**Cons:**
- Overkill for this use case: if the first compaction succeeds, the second is often unnecessary (context already compacted)
- Increases latency: Call B waits for Call A to complete, then discovers nothing needs compacting
- More invasive change (new field, new method, wrapper pattern)
- Queue can grow unbounded if compaction failures trigger retries that trigger more compaction

**Edge Cases:**
- If the queue has N pending compactions and the first succeeds, all subsequent ones will run `prepareCompaction()` which returns `null` (nothing to compact), emit an empty `auto_compaction_end`, and return. This is benign but wasteful.
- If `abortCompaction()` is called externally, only the in-flight compaction is aborted; queued ones will still start when the current one finishes.

**Risk: LOW (correctness) / MEDIUM (complexity).** Over-engineered for the actual problem.

### Option D: Local AbortController Per Call (Instance Field Only for External Abort)

**Implementation:**
```javascript
async _runAutoCompaction(reason, willRetry) {
    const settings = this.settingsManager.getCompactionSettings();
    this._emit({ type: "auto_compaction_start", reason });

    // Create a LOCAL controller for this call's lifetime
    const localAC = new AbortController();
    // Store reference for external abort (abortCompaction())
    this._autoCompactionAbortController = localAC;

    try {
        // ... all internal references use `localAC.signal` instead of
        //     `this._autoCompactionAbortController.signal`

        if (this._extensionRunner?.hasHandlers("session_before_compact")) {
            const extensionResult = (await this._extensionRunner.emit({
                type: "session_before_compact",
                preparation,
                branchEntries: pathEntries,
                customInstructions: undefined,
                signal: localAC.signal,  // <-- local, not this._auto...
            }));
            // ...
        }

        const compactResult = await compact(
            preparation, this.model, apiKey, undefined,
            localAC.signal  // <-- local
        );

        if (localAC.signal.aborted) {  // <-- local
            this._emit({ type: "auto_compaction_end", result: undefined, aborted: true, willRetry: false });
            return;
        }

        // ... rest unchanged
    } catch (error) {
        // ... unchanged
    } finally {
        // Only clear the shared field if WE still own it
        if (this._autoCompactionAbortController === localAC) {
            this._autoCompactionAbortController = undefined;
        }
    }
}
```

**Pros:**
- Eliminates the crash entirely: each call uses its own local controller, never reads `undefined`
- `abortCompaction()` still works: it aborts whatever controller is currently stored in the field
- The `finally` guard (`=== localAC`) prevents one call from clearing another's controller
- Preserves `isCompacting` semantics (field is still set while any compaction runs)
- Minimal conceptual change to existing code structure

**Cons:**
- Two concurrent compactions can still run in parallel (both call the LLM). This wastes resources but doesn't crash.
- `isCompacting` might briefly return `false` between Call A's `finally` clearing the field and Call B being mid-flight (if Call B didn't re-set the field yet). In practice this window is negligible.
- Slightly more invasive than Option A (changes multiple lines)

**Edge Cases:**
- If `abortCompaction()` is called between Call A setting the field and Call B overwriting it, only Call A's controller is aborted. Call B's controller is safe because it hasn't been created yet.
- Two concurrent successful compactions: the second `appendCompaction()` call operates on already-compacted content. `prepareCompaction()` may return `null`, causing the second call to emit an empty result and return early. This is benign.

**Risk: LOW.** This is the most robust option from a correctness standpoint.

---

## 3. Recommended Fix: Option A+D Hybrid

**Combine the reentrancy guard (Option A) with local controller safety (Option D).**

Rationale:
- Option A prevents wasteful concurrent compaction (the common case)
- Option D's local-variable pattern protects against any remaining edge cases
- Together they provide defense-in-depth

```javascript
async _runAutoCompaction(reason, willRetry) {
    // Reentrancy guard: skip if compaction already in progress
    if (this._autoCompactionAbortController) {
        return;
    }

    const settings = this.settingsManager.getCompactionSettings();
    this._emit({ type: "auto_compaction_start", reason });

    const localAC = new AbortController();
    this._autoCompactionAbortController = localAC;

    try {
        // All signal reads use localAC.signal instead of this._autoCompactionAbortController.signal
        // ... (body uses localAC everywhere)

        if (this._extensionRunner?.hasHandlers("session_before_compact")) {
            const extensionResult = (await this._extensionRunner.emit({
                type: "session_before_compact",
                preparation,
                branchEntries: pathEntries,
                customInstructions: undefined,
                signal: localAC.signal,
            }));
            // ...
        }

        // ...
        const compactResult = await compact(preparation, this.model, apiKey, undefined, localAC.signal);
        // ...

        if (localAC.signal.aborted) {
            this._emit({ type: "auto_compaction_end", result: undefined, aborted: true, willRetry: false });
            return;
        }

        // ... rest unchanged
    } catch (error) {
        // ... unchanged
    } finally {
        if (this._autoCompactionAbortController === localAC) {
            this._autoCompactionAbortController = undefined;
        }
    }
}
```

---

## 4. Patching Strategy

### 4.1 Local Patch (Immediate Fix for Middleman)

Since `@mariozechner/pi-coding-agent` is a dependency installed via pnpm, we have two viable approaches:

#### Approach 1: pnpm `patchedDependencies` (Recommended)

```bash
# Generate a patch directory
pnpm patch @mariozechner/pi-coding-agent@0.55.0

# This creates a temp directory — edit agent-session.js there
# Apply the fix (Option A+D hybrid)
# Then finalize:
pnpm patch-commit <temp-directory>
```

This creates a `.patch` file in the repo and adds `patchedDependencies` to `package.json`. The patch survives `pnpm install` and is version-controlled.

**Pros:** Clean, reproducible, survives dependency reinstalls, git-tracked.  
**Cons:** Tied to exact version (0.55.0). Must be re-evaluated on upgrades.

#### Approach 2: Post-install script

Add a `postinstall` script that applies a `sed`/`node` transform to the built file. Fragile and not recommended.

#### Approach 3: Runtime monkey-patch in middleman

In `agent-runtime.ts`, before creating a session, patch the prototype:

```typescript
import { AgentSession } from "@mariozechner/pi-coding-agent";

const origRun = AgentSession.prototype._runAutoCompaction;
AgentSession.prototype._runAutoCompaction = async function(reason, willRetry) {
    if (this._autoCompactionAbortController) return;
    return origRun.call(this, reason, willRetry);
};
```

**Pros:** No dependency patching, easy to remove when upstream fixes.  
**Cons:** Relies on internal API; `_runAutoCompaction` is private and not exported. Would need to access via `(session as any)` or prototype hacking. Brittle across versions.

### 4.2 Recommended Local Fix: pnpm patch

Use `pnpm patch` for the immediate fix. It's the cleanest approach for a dependency bug.

### 4.3 Upstream PR/Issue

**Issue title:** `_runAutoCompaction reentrancy race causes "Cannot read properties of undefined (reading 'signal')" crash`

**Issue body should include:**
1. The race condition timeline (Section 1.2 above)
2. The two trigger paths (Section 1.3)
3. Minimal reproduction scenario: any situation where `_handleAgentEvent` processes `agent_end` asynchronously while `prompt()` is called shortly after `abort()` returns
4. Suggested fix: the A+D hybrid (Section 3)

**PR changes:**
- `src/core/agent-session.ts` — same changes as the JS patch, applied to TypeScript source
- Add a test: mock `compact()` to `await` a delayed promise, call `_runAutoCompaction` twice concurrently, assert no crash and second call returns early

---

## 5. Can Middleman Work Around This Without Patching Pi?

**Partially, but not reliably.**

### What middleman already does:
- `contextRecoveryInProgress` flag prevents middleman's *own* code from calling `prompt()` while recovery is active
- `guardAbortController` + abort signals prevent middleman from stacking guard operations

### Why it's insufficient:
The race happens **inside pi**, triggered by pi's own `_handleAgentEvent` async callback. Middleman has no way to:
1. Prevent `_handleAgentEvent` from firing (it's an internal subscription callback)
2. Control the timing of `agent_end` processing relative to `session.prompt()` calls
3. Synchronize with pi's internal event handler since `session.abort()` returns after `waitForIdle()` but **before** the async `_handleAgentEvent` for `agent_end` completes

### Partial workaround — add delay after abort:
```typescript
// In runContextGuard, after abort:
await this.session.abort();
// Yield to let pi's _handleAgentEvent finish
await new Promise(resolve => setTimeout(resolve, 100));
```

**This is a timing hack, not a fix.** The 100ms might not be enough if `_checkCompaction` takes longer (e.g., slow `shouldCompact` calculation). It reduces the race window but doesn't close it.

### Partial workaround — skip pre-prompt compaction check:
The crash specifically happens when `prompt()` triggers `_checkCompaction` while the event handler's compaction is still running. If middleman could tell pi to skip the pre-prompt check, the race would be avoided. But `_checkCompaction` at line 562 is unconditional — there's no option to disable it.

### Verdict: **Patch pi.** The workarounds are unreliable.

---

## 6. Implementation Checklist

1. **[ ] Generate pnpm patch**
   ```bash
   pnpm patch @mariozechner/pi-coding-agent@0.55.0
   ```

2. **[ ] Apply fix to `dist/core/agent-session.js`**
   - Add reentrancy guard at top of `_runAutoCompaction`
   - Replace all `this._autoCompactionAbortController.signal` with `localAC.signal`
   - Change `finally` block to conditional clear (`=== localAC`)

3. **[ ] Commit the patch**
   ```bash
   pnpm patch-commit <temp-directory>
   ```

4. **[ ] Verify fix**
   - `pnpm install` (patch applies)
   - Run middleman with a long session that triggers compaction
   - Verify no `.signal` crash in logs
   - Verify compaction still works correctly

5. **[ ] File upstream issue** on `@mariozechner/pi-coding-agent` repo

6. **[ ] Remove patch** once upstream releases a fixed version

---

## 7. Exact Patch Diff

Below is the precise change to `dist/core/agent-session.js`, showing the three modifications within `_runAutoCompaction`:

### Change 1: Reentrancy guard + local controller (top of method)

```diff
     async _runAutoCompaction(reason, willRetry) {
+        // Reentrancy guard: if compaction is already in progress, bail out.
+        // This prevents a race where two concurrent calls (from agent_end handler
+        // and prompt's pre-check) corrupt the shared _autoCompactionAbortController.
+        if (this._autoCompactionAbortController) {
+            return;
+        }
         const settings = this.settingsManager.getCompactionSettings();
         this._emit({ type: "auto_compaction_start", reason });
-        this._autoCompactionAbortController = new AbortController();
+        const localAbortController = new AbortController();
+        this._autoCompactionAbortController = localAbortController;
         try {
```

### Change 2: Replace all `this._autoCompactionAbortController.signal` with `localAbortController.signal`

Three occurrences:

```diff
-                    signal: this._autoCompactionAbortController.signal,
+                    signal: localAbortController.signal,
```

```diff
-                const compactResult = await compact(preparation, this.model, apiKey, undefined, this._autoCompactionAbortController.signal);
+                const compactResult = await compact(preparation, this.model, apiKey, undefined, localAbortController.signal);
```

```diff
-            if (this._autoCompactionAbortController.signal.aborted) {
+            if (localAbortController.signal.aborted) {
```

### Change 3: Conditional clear in `finally`

```diff
         finally {
-            this._autoCompactionAbortController = undefined;
+            // Only clear if we still own the field (another call may have taken over)
+            if (this._autoCompactionAbortController === localAbortController) {
+                this._autoCompactionAbortController = undefined;
+            }
         }
```

---

## 8. Verification That the Second Copy Is Identical

There are **two** pnpm store copies of the file (zod@4.3.6 and zod@3.25.76 variants). Both need to be checked, but only the one actually resolved by middleman's import graph needs patching. `pnpm patch` handles this correctly by patching the package itself, which affects all resolution variants.

```
node_modules/.pnpm/@mariozechner+pi-coding-agent@0.55.0_.../dist/core/agent-session.js  (zod@4.3.6)
node_modules/.pnpm/@mariozechner+pi-coding-agent@0.55.0_.../dist/core/agent-session.js  (zod@3.25.76)
```

Both copies have the same source — `pnpm patch` will cover both.
