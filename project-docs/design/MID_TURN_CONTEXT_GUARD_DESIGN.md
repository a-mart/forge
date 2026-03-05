# Mid-Turn Context Budget Guard with Intelligent Handoff

**Status:** Draft v2 (Revised)  
**Author:** Design Drafter  
**Date:** 2026-03-04  
**Revised:** 2026-03-04  
**Target:** `apps/backend/src/swarm/agent-runtime.ts` (primary), minor touch in `runtime-types.ts`

---

## Revision History

| Version | Date | Changes |
|---------|------|---------|
| v1 | 2026-03-04 | Initial design |
| v2 | 2026-03-04 | Major revision incorporating Codex review feedback. Key changes: (1) Replaced fragile event-driven state machine with single serialized orchestrator using `AbortSignal` cancellation. (2) Eliminated `agent_end` interception — `session.prompt()` already awaits full turn, so no event wiring needed. (3) Introduced unified recovery lock (`contextRecoveryInProgress`) replacing separate `midTurnHandoffInProgress` + `autoCompactionRecoveryInProgress` to prevent both systems from racing. (4) Replaced fixed 85% threshold with token-aware dual-threshold (soft/hard) computed from `contextWindow - reserveTokens`. (5) Dropped `message_update` as check site — `getContextUsage()` estimate doesn't materially change from partial stream deltas. (6) Tightened prompt templates with stricter tool constraints, lower word cap, and truncation guard. (7) Added workspace validation instruction in resume prompt. (8) Added explicit handling for "already compacted" and unknown-usage states. |

---

## 1. Problem Statement

### What Fails Today

The pi library's auto-compaction (`_checkCompaction()`) only runs **after a turn ends** — on `agent_end`, or before the next `session.prompt()` call. During a single agent turn, the agent makes many tool calls that accumulate tokens with no mid-turn budget check. By the time the turn ends, context can be at 95–100%. The library's compaction LLM call then needs ~16k tokens of headroom (`reserveTokens: 16384`) to generate a summary — and there isn't enough. Compaction fails.

We shipped a **three-tier reactive fallback** in `AgentRuntime.handleAutoCompactionEndEvent()`:

- **Tier 1:** Retry `compact()` manually
- **Tier 2:** Emergency context trim (surgical middle-message removal)
- **Tier 3:** Surface unrecoverable error to user

This works but is **reactive** — the agent is already disoriented. Even successful compaction produces a generic summary that loses sharp task-specific context (specific file paths, function names, line numbers, what was about to happen next). The agent post-compaction has "amnesia lite."

### Why Proactive Is Better

By intervening *before* context fills up, we can:

1. **Ask the agent to write its own handoff** — structured, task-specific continuity notes
2. **Run compaction with headroom** — compaction succeeds reliably with 20–30k tokens of margin
3. **Feed the handoff back post-compaction** — the agent gets BOTH the compaction summary (broad context) AND its own handoff document (sharp task-specific state)

---

## 2. Solution Overview

A **proactive mid-turn context guard** that:

1. Checks context usage after tool results land (`message_end` events)
2. When context hits a **soft threshold** (~85%, token-aware), aborts the turn and runs a structured handoff → compact → resume cycle
3. When context hits a **hard threshold** (closer to library compaction boundary), skips the handoff and compacts directly — there isn't enough headroom for a handoff turn
4. Is **complementary** to the existing three-tier fallback, coordinated via a shared recovery lock

### Key Design Principles (v2)

- **No event interception.** `session.prompt()` already awaits the full agent turn — no need to intercept `agent_end` or wire up completion promises.
- **Single serialized orchestrator.** One async method with `AbortSignal` cancellation, not a state machine.
- **Unified recovery lock.** One `contextRecoveryInProgress` flag covers both proactive guard and reactive fallback — they cannot race.
- **Token-aware thresholds.** Computed from `contextWindow - reserveTokens`, not a fixed percent.
- **Approximate input.** `getContextUsage()` is heuristic (`chars/4` for recent messages). The guard treats it as a noisy signal with conservative margins.

---

## 3. Detailed Flow

### Orchestrator: `runContextGuard()`

A single async method that runs the full cycle. No state machine — just sequential steps with cancellation checks between each step.

```
1. Set contextRecoveryInProgress = true
2. Abort current turn (session.abort())
3. Check: are we above softThreshold but below hardThreshold?
   ├─ YES → Send handoff prompt (session.prompt()), wait for turn to complete
   │        Read handoff file from disk
   └─ NO  → Skip handoff (too close to limit, or already compacted)
4. Check: does context still need compaction?
   ├─ YES → Run session.compact() (via this.compact() wrapper)
   └─ NO  → Skip (library already compacted during handoff turn)
5. Send resume prompt with handoff contents (if available)
6. Clean up handoff file
7. Set contextRecoveryInProgress = false
```

Each step checks `this.guardAbortController.signal.aborted` before proceeding. If the signal is aborted (from `stopInFlight()` or `terminate()`), the method returns immediately and cleans up.

### Why This Is Simpler Than v1

| v1 | v2 |
|----|-----|
| 6-state machine (`HANDOFF_ABORTING` → `HANDOFF_PROMPTING` → ...) | Sequential async with early-return on cancellation |
| `midTurnHandoffResolve` promise wired to `agent_end` interception | `await session.prompt()` — already waits for full turn |
| `agent_end` short-circuited during handoff → stale `streaming` status | `agent_end` flows normally → status transitions happen correctly |
| Separate `midTurnHandoffInProgress` + `autoCompactionRecoveryInProgress` | Single `contextRecoveryInProgress` lock covers both |

---

## 4. Implementation Plan

### Files Modified

| File | Change |
|------|--------|
| `apps/backend/src/swarm/agent-runtime.ts` | Core implementation |
| `apps/backend/src/swarm/runtime-types.ts` | Add `"context_guard"` to `RuntimeErrorEvent.phase` union |

### New Constants

```typescript
/**
 * Token budget reserved for the handoff turn (prompt + agent response + tool call).
 * Handoff prompt is ~250 tokens, agent write response ~800 tokens, tool overhead ~200 tokens.
 * 2048 provides comfortable margin.
 */
const HANDOFF_TURN_TOKEN_BUDGET = 2048;

/**
 * Minimum milliseconds between context budget checks.
 * getContextUsage() iterates messages with chars/4 heuristic — throttle to avoid overhead.
 */
const CONTEXT_BUDGET_CHECK_THROTTLE_MS = 3_000;

/**
 * Maximum time (ms) to wait for the handoff turn to complete.
 * The handoff turn should be fast (~10-15s for a single file write).
 */
const HANDOFF_TURN_TIMEOUT_MS = 45_000;

/**
 * Maximum character length of handoff content to inject into the resume prompt.
 * Prevents a runaway handoff from bloating the post-compaction context.
 */
const MAX_HANDOFF_CONTENT_CHARS = 3000;
```

### Token-Aware Dual Thresholds

Instead of a fixed 85%, thresholds are computed from the agent's actual context window and the library's compaction constants:

```typescript
/**
 * Compute soft and hard context guard thresholds.
 *
 * - softThreshold: trigger handoff flow. Must leave enough room for the handoff
 *   turn itself (HANDOFF_TURN_TOKEN_BUDGET) plus compaction's reserveTokens (16384).
 * - hardThreshold: skip handoff, compact directly. At this point there's not enough
 *   room for a safe handoff turn, but compaction may still work.
 *
 * Both are expressed as token counts (not percentages).
 */
function computeGuardThresholds(contextWindow: number): {
  softThresholdTokens: number;
  hardThresholdTokens: number;
} {
  const COMPACTION_RESERVE_TOKENS = 16_384; // from pi library compaction settings

  // Hard threshold: library's own compaction trigger point.
  // contextWindow - reserveTokens is where shouldCompact() returns true.
  const hardThresholdTokens = contextWindow - COMPACTION_RESERVE_TOKENS;

  // Soft threshold: leave room for handoff turn + compaction reserve.
  // This is where we trigger the handoff flow.
  const softThresholdTokens = contextWindow - COMPACTION_RESERVE_TOKENS - HANDOFF_TURN_TOKEN_BUDGET;

  return { softThresholdTokens, hardThresholdTokens };
}
```

**Example for 200k context window:**
- `softThresholdTokens` = 200,000 - 16,384 - 2,048 = **181,568** (~90.8%)
- `hardThresholdTokens` = 200,000 - 16,384 = **183,616** (~91.8%)

**Example for 128k context window:**
- `softThresholdTokens` = 128,000 - 16,384 - 2,048 = **109,568** (~85.6%)
- `hardThresholdTokens` = 128,000 - 16,384 = **111,616** (~87.2%)

The soft threshold adapts to the model's context window automatically. On smaller windows the percentage is naturally lower, giving more relative margin.

**Estimation error margin:** `getContextUsage()` uses `chars/4` for recent messages — this can underestimate code-heavy content (shorter chars per token) or overestimate prose. To account for this, we subtract an additional estimation error margin from the soft threshold:

```typescript
// Additional margin for estimation inaccuracy.
// 5% of context window, but at least 4096 tokens.
const ESTIMATION_ERROR_MARGIN_PERCENT = 0.05;
const ESTIMATION_ERROR_MARGIN_MIN_TOKENS = 4096;

function computeGuardThresholds(contextWindow: number): {
  softThresholdTokens: number;
  hardThresholdTokens: number;
} {
  const COMPACTION_RESERVE_TOKENS = 16_384;

  const estimationMargin = Math.max(
    ESTIMATION_ERROR_MARGIN_MIN_TOKENS,
    Math.floor(contextWindow * ESTIMATION_ERROR_MARGIN_PERCENT)
  );

  const hardThresholdTokens = contextWindow - COMPACTION_RESERVE_TOKENS;
  const softThresholdTokens = contextWindow - COMPACTION_RESERVE_TOKENS - HANDOFF_TURN_TOKEN_BUDGET - estimationMargin;

  return { softThresholdTokens, hardThresholdTokens };
}
```

**Revised example for 200k context:**
- `estimationMargin` = max(4096, 10000) = 10,000
- `softThresholdTokens` = 200,000 - 16,384 - 2,048 - 10,000 = **171,568** (~85.8%)
- `hardThresholdTokens` = **183,616** (~91.8%)

This naturally lands near the 85% range for 200k models, but scales correctly for smaller/larger windows.

### Unified Recovery Lock

Replace the separate `autoCompactionRecoveryInProgress` and (v1's) `midTurnHandoffInProgress` with a single flag:

```typescript
private contextRecoveryInProgress = false;
private guardAbortController: AbortController | undefined;
```

Both `runContextGuard()` and `handleAutoCompactionEndEvent()` check and set `contextRecoveryInProgress`. This serializes all recovery flows.

**Migration:** `autoCompactionRecoveryInProgress` is renamed to `contextRecoveryInProgress`. All existing references in `handleAutoCompactionEndEvent()`, `stopInFlight()`, and `terminate()` update to the new name. Behavior is identical for the reactive path — it just now also blocks the proactive guard, and vice versa.

### New State Variables (on `AgentRuntime`)

```typescript
// Replaces autoCompactionRecoveryInProgress
private contextRecoveryInProgress = false;

// Cancellation for the guard orchestrator
private guardAbortController: AbortController | undefined;

// Throttle for context budget checks
private lastContextBudgetCheckAtMs = 0;
```

**Removed from v1:** `midTurnHandoffInProgress`, `midTurnHandoffResolve`.

### New Methods

#### `checkContextBudget(): void`

Called from `handleEvent()` on `message_end` events only. (Dropped `message_update` — per review, `getContextUsage()` estimates from completed messages, so partial stream deltas don't materially move the estimate.)

```typescript
private checkContextBudget(): void {
  // Guards
  if (this.contextRecoveryInProgress) return;
  if (this.status === "terminated") return;
  if (!this.session.isStreaming) return;

  // Throttle
  const nowMs = Date.now();
  if (nowMs - this.lastContextBudgetCheckAtMs < CONTEXT_BUDGET_CHECK_THROTTLE_MS) return;
  this.lastContextBudgetCheckAtMs = nowMs;

  // Get usage (approximate)
  const usage = this.getContextUsage();
  if (!usage) return;

  // Compute thresholds
  const { softThresholdTokens } = computeGuardThresholds(usage.contextWindow);

  // Check against soft threshold (hard threshold is handled by library's own compaction)
  if (usage.tokens < softThresholdTokens) return;

  // Fire the guard (async, with catch)
  void this.runContextGuard(usage).catch((error) => {
    this.logRuntimeError("context_guard", error, {
      stage: "guard_top_level_catch",
      contextTokens: usage.tokens,
      contextWindow: usage.contextWindow
    });
    this.contextRecoveryInProgress = false;
    this.guardAbortController = undefined;
  });
}
```

#### `runContextGuard(triggeringUsage: AgentContextUsage): Promise<void>`

The single serialized orchestrator. No state machine, no event promises.

```typescript
private async runContextGuard(triggeringUsage: AgentContextUsage): Promise<void> {
  // Acquire recovery lock
  this.contextRecoveryInProgress = true;
  this.guardAbortController = new AbortController();
  const signal = this.guardAbortController.signal;

  const { softThresholdTokens, hardThresholdTokens } = computeGuardThresholds(
    triggeringUsage.contextWindow
  );
  const handoffFilePath = buildHandoffFilePath(this.descriptor);

  this.logContextGuard("triggered", {
    contextTokens: triggeringUsage.tokens,
    contextWindow: triggeringUsage.contextWindow,
    contextPercent: triggeringUsage.percent,
    softThresholdTokens,
    hardThresholdTokens,
    handoffFilePath
  });

  // ── Step 1: Abort current turn ────────────────────────────────────────────
  try {
    await this.session.abort();
  } catch (error) {
    this.logRuntimeError("context_guard", error, { stage: "abort_failed" });
    this.contextRecoveryInProgress = false;
    this.guardAbortController = undefined;
    return;
  }

  if (signal.aborted) return this.cleanupGuard();

  // ── Step 2: Handoff turn (if we have headroom) ────────────────────────────
  //
  // If context is between soft and hard thresholds, there's enough room for
  // a handoff turn. If context is at or above the hard threshold, skip
  // straight to compaction.
  let handoffContent: string | undefined;

  if (triggeringUsage.tokens < hardThresholdTokens) {
    handoffContent = await this.runHandoffTurn(handoffFilePath, signal);
  } else {
    this.logContextGuard("handoff_skipped_hard_threshold", {
      contextTokens: triggeringUsage.tokens,
      hardThresholdTokens
    });
  }

  if (signal.aborted) return this.cleanupGuard(handoffFilePath);

  // ── Step 3: Compact (if still needed) ─────────────────────────────────────
  //
  // Re-check context usage. The library's auto-compaction may have already
  // fired during the handoff turn's agent_end. If usage is now well below
  // the soft threshold, skip our compaction.
  //
  // getContextUsage() may return undefined/null tokens after compaction
  // (no post-compaction assistant response yet). In that case, assume
  // compaction already happened and skip.
  const postHandoffUsage = this.getContextUsage();
  const needsCompaction = postHandoffUsage
    && postHandoffUsage.tokens !== null
    && postHandoffUsage.tokens !== undefined
    && postHandoffUsage.tokens >= softThresholdTokens;

  if (needsCompaction) {
    try {
      await this.compact();
    } catch (error) {
      const normalized = normalizeRuntimeError(error);
      // "Already compacted" or similar is non-fatal
      if (!isAlreadyCompactedError(normalized.message)) {
        this.logRuntimeError("context_guard", error, {
          stage: "compaction_failed",
          handoffWritten: handoffContent !== undefined
        });
      }
      // Either way, continue to resume if we have handoff content
    }
  } else {
    this.logContextGuard("compaction_skipped", {
      reason: postHandoffUsage ? "below_threshold" : "usage_unknown_post_compaction",
      postHandoffTokens: postHandoffUsage?.tokens
    });
  }

  if (signal.aborted) return this.cleanupGuard(handoffFilePath);

  // ── Step 4: Resume prompt ─────────────────────────────────────────────────
  try {
    const resumePrompt = buildResumePrompt(handoffContent);
    await this.session.prompt(resumePrompt);
  } catch (error) {
    this.logRuntimeError("context_guard", error, { stage: "resume_prompt_failed" });
    // Agent is still functional post-compaction, just without explicit resume
  }

  // ── Step 5: Cleanup ───────────────────────────────────────────────────────
  this.cleanupGuard(handoffFilePath);

  this.logContextGuard("completed", {
    handoffWritten: handoffContent !== undefined,
    handoffContentLength: handoffContent?.length ?? 0
  });
}
```

#### `runHandoffTurn(handoffFilePath: string, signal: AbortSignal): Promise<string | undefined>`

Sends the handoff prompt and reads the resulting file. Returns handoff content or `undefined`.

```typescript
private async runHandoffTurn(
  handoffFilePath: string,
  signal: AbortSignal
): Promise<string | undefined> {
  // Send handoff prompt — session.prompt() awaits the full turn
  try {
    const handoffPrompt = buildHandoffPrompt(handoffFilePath);

    // Race against timeout
    const turnPromise = this.session.prompt(handoffPrompt);
    const timeoutPromise = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), HANDOFF_TURN_TIMEOUT_MS)
    );
    const result = await Promise.race([turnPromise, timeoutPromise]);

    if (result === "timeout") {
      this.logContextGuard("handoff_timeout", { timeoutMs: HANDOFF_TURN_TIMEOUT_MS });
      await this.session.abort();
      // Fall through to read whatever was written
    }
  } catch (error) {
    this.logRuntimeError("context_guard", error, { stage: "handoff_prompt_failed" });
    // Fall through — try to read file in case agent partially wrote it
  }

  if (signal.aborted) return undefined;

  // Read handoff file (best-effort)
  try {
    const content = await readFile(handoffFilePath, "utf8");
    const trimmed = content.trim();
    if (trimmed.length === 0) return undefined;

    // Truncate if agent wrote too much
    if (trimmed.length > MAX_HANDOFF_CONTENT_CHARS) {
      this.logContextGuard("handoff_truncated", {
        originalLength: trimmed.length,
        truncatedTo: MAX_HANDOFF_CONTENT_CHARS
      });
      return trimmed.slice(0, MAX_HANDOFF_CONTENT_CHARS) + "\n\n[... truncated for context budget ...]";
    }

    return trimmed;
  } catch {
    // File may not exist if handoff turn failed
    this.logContextGuard("handoff_file_not_found", { handoffFilePath });
    return undefined;
  }
}
```

#### `cleanupGuard(handoffFilePath?: string): void`

Releases the recovery lock and cleans up resources.

```typescript
private cleanupGuard(handoffFilePath?: string): void {
  this.contextRecoveryInProgress = false;
  this.guardAbortController = undefined;

  if (handoffFilePath) {
    // Best-effort async cleanup — don't await
    rm(handoffFilePath, { force: true }).catch(() => {});
  }
}
```

#### `logContextGuard(stage: string, details?: Record<string, unknown>): void`

Convenience wrapper that uses the informational log path (not `logRuntimeError`) for non-error guard events. This addresses the review note about informational stages appearing as generic "⚠️ Agent error" in the UI.

```typescript
private logContextGuard(stage: string, details?: Record<string, unknown>): void {
  console.log(`[swarm][${this.now()}] context_guard:${stage}`, {
    agentId: this.descriptor.agentId,
    ...details
  });
}
```

Actual errors during the guard flow still use `logRuntimeError("context_guard", ...)` and `reportRuntimeError(...)` to surface to the UI.

### Integration Points in `handleEvent()`

Minimal changes. No `agent_end` interception.

```typescript
// In handleEvent():

// On message_end — check context budget after tool results land
if (event.type === "message_end") {
  this.checkContextBudget();
  // existing message_start key extraction logic follows...
}

// message_update — NO CHANGE (v2 drops this as a check site)
```

**Why no `agent_end` changes?**

`session.prompt()` awaits the full turn, including `agent_end`. So:
- During the handoff turn: `session.prompt(handoffPrompt)` is awaited inside `runContextGuard()`. The `agent_end` fires, `handleEvent()` processes it normally (status → idle), and then `prompt()` returns. The guard orchestrator continues to the next step.
- During the resume turn: Same — `session.prompt(resumePrompt)` awaits the full turn, `agent_end` flows normally.
- The `onAgentEnd` callback fires for both handoff and resume turns, which is correct — the swarm manager should know about turn completions.

### Updates to `handleAutoCompactionEndEvent()`

Replace `autoCompactionRecoveryInProgress` with `contextRecoveryInProgress`:

```typescript
private async handleAutoCompactionEndEvent(
  event: Extract<AgentSessionEvent, { type: "auto_compaction_end" }>
): Promise<void> {
  // ...existing preamble...

  if (this.contextRecoveryInProgress) {           // ← renamed
    this.logRuntimeError("compaction", new Error(autoCompactionError), {
      recoveryStage: "auto_compaction_skipped",
      reason: "recovery_already_in_progress"       // covers both guard and reactive
    });
    return;
  }

  this.contextRecoveryInProgress = true;           // ← renamed

  try {
    // ...existing three-tier fallback logic (unchanged)...
  } finally {
    this.contextRecoveryInProgress = false;         // ← renamed
  }
}
```

The reactive fallback checks `contextRecoveryInProgress` before starting. If the proactive guard is already running (flag is true), the reactive path skips. This prevents the double-compaction race the reviewer identified.

Conversely, the proactive guard checks `contextRecoveryInProgress` before starting in `checkContextBudget()`. If the reactive path is already running, the guard skips.

### Cleanup in `stopInFlight()` and `terminate()`

```typescript
// In both methods, replace existing cleanup with:
this.contextRecoveryInProgress = false;            // ← renamed from autoCompactionRecoveryInProgress
this.guardAbortController?.abort();                // ← NEW: cancel in-flight guard
this.guardAbortController = undefined;             // ← NEW
this.lastContextBudgetCheckAtMs = 0;               // ← NEW
```

The `AbortSignal` propagates through the guard orchestrator. Each step in `runContextGuard()` checks `signal.aborted` before proceeding. If aborted, it calls `cleanupGuard()` and returns.

---

## 5. Handoff Prompt Template

```typescript
function buildHandoffPrompt(handoffFilePath: string): string {
  return `URGENT — CONTEXT LIMIT: Your context window is nearly full. A compaction will run after this message. You must write a handoff document NOW so you can resume seamlessly.

INSTRUCTIONS:
1. Use the write tool to create this file: \`${handoffFilePath}\`
2. Do NOT use any other tool. Do NOT read files. Do NOT run commands. ONLY write.
3. Do NOT continue your previous task. ONLY write this handoff file.

FILE CONTENTS — use these exact headings:

## Current Task
What is the specific task/objective you're working on? (1-2 sentences)

## Progress
What concrete actions have you completed? (bullet list, max 5 items)

## Active Files
Which files are you working in? Include paths and line numbers if relevant. (bullet list)

## Next Steps
What were you about to do next? Be precise — name the file, function, and action. (bullet list, max 3 items)

## Open Issues
Any blockers, uncertainties, or things to verify? (bullet list, or "None")

CONSTRAINTS:
- Maximum 300 words total
- Focus on specifics that would be lost in a summary: file paths, function names, line numbers, variable names
- Write the file immediately with a single write tool call`;
}
```

### Changes from v1

| Aspect | v1 | v2 (revised) |
|--------|-----|------|
| Tool constraint | "Do NOT continue your previous task" | **Explicit: "Do NOT use any other tool. Do NOT read files. Do NOT run commands. ONLY write."** |
| Word cap | ~500 words | **300 words** (tighter bound, less token overhead) |
| Tone | Instruction | **URGENT prefix** — models respond more reliably to urgency framing under pressure |
| Structure | 5 sections, free prose | 5 sections with **explicit format constraints** (bullet lists, max items) |
| Write instruction | "Write the file NOW" | **"Write the file immediately with a single write tool call"** — explicit single-call expectation |

---

## 6. Resume Prompt Template

```typescript
function buildResumePrompt(handoffContent: string | undefined): string {
  if (!handoffContent) {
    return `Your context was compacted to free up space. Some earlier conversation details have been summarized.

Before continuing:
1. Review the compaction summary above to orient yourself.
2. Check your working directory for recent file modifications (\`ls -lt\` or \`git status\`) to verify the current state of any work in progress.
3. If you're unsure what you were doing, look for recently modified files.

Then continue where you left off.`;
  }

  return `Your context was compacted to free up space. Before compaction, you wrote a handoff document with your working state:

---
${handoffContent}
---

Before continuing:
1. Review the compaction summary above for broad context.
2. Use the handoff document above for your specific working state.
3. Verify the workspace is consistent — run \`git status\` or check the files listed in "Active Files" to confirm your edits are intact.
4. Follow the "Next Steps" to continue where you left off.
5. Note any "Open Issues" that need attention.

Continue your work now.`;
}
```

### Changes from v1

- **Added workspace validation instruction** — the reviewer correctly noted that aborting mid-tool-chain may leave partial edits. The resume prompt now asks the agent to verify workspace state before continuing.
- **Handoff content is already truncated** by `runHandoffTurn()` to `MAX_HANDOFF_CONTENT_CHARS` (3000 chars), so runaway handoff content can't bloat the post-compaction context.

---

## 7. Edge Cases and Failure Modes

### 7.1 Handoff Turn Overflow

**Scenario:** Context is at 91% when guard triggers. The handoff prompt + agent response pushes past 100%.

**Handling:** This is why we have the **dual threshold**. At 91%, `triggeringUsage.tokens` is likely above `hardThresholdTokens` (~91.8%), so the guard skips the handoff turn entirely and goes straight to compaction. The soft threshold is set lower (~86%) to give the handoff turn room to breathe.

If the guard triggers at soft threshold but the handoff turn somehow tips over, the library's `_checkCompaction()` fires on the handoff turn's `agent_end`, auto-compaction runs, and the `auto_compaction_end` event hits our `handleAutoCompactionEndEvent()`. Since `contextRecoveryInProgress` is already `true` (set by the guard), the reactive path skips — no conflict. The guard's step 3 then detects that usage is low (or unknown) and skips its own compaction call.

### 7.2 Compaction Fails After Handoff

**Scenario:** Handoff succeeds, but `this.compact()` throws.

**Handling:** The guard logs the error and continues to the resume prompt. If the error is "already compacted" (library did it), we treat that as success. If it's a genuine failure, the agent is still functional — the handoff file is on disk, and the resume prompt's no-handoff variant gives general orientation. The reactive fallback will catch this on the next `agent_end` if context is still too high.

### 7.3 Agent in Mid-Tool-Chain

**Scenario:** Agent has called `read` (result pending) when we abort. Some file edits from earlier tool calls may already be applied.

**Handling:** `session.abort()` discards pending tool execution. Prior edits are already on disk. The handoff prompt asks the agent to document what it was doing. The resume prompt explicitly asks the agent to **verify workspace state** (git status, check files) before continuing. This addresses the reviewer's concern about partial repo mutations.

### 7.4 Interaction with Existing Three-Tier Fallback

**Coordinated via `contextRecoveryInProgress`:**

| Scenario | Guard state | Reactive state | Outcome |
|----------|-------------|----------------|---------|
| Guard triggers first | Sets `contextRecoveryInProgress = true` | Reactive checks flag → skips | Guard handles it |
| Reactive triggers first (e.g., on `agent_end` after guard misses) | Guard checks flag → skips | Sets flag → runs three-tier | Reactive handles it |
| Both try simultaneously | First to set flag wins | Second checks → skips | Serialized, no race |
| Guard running, library auto-compacts during handoff turn | Flag is true | `handleAutoCompactionEndEvent` checks → skips | Guard continues, no double-compact |

The existing `if (this.autoCompactionRecoveryInProgress)` check becomes `if (this.contextRecoveryInProgress)` — same logic, broader scope.

### 7.5 Rapid Context Growth (One-Shot Jump)

**Scenario:** A single `read` tool result jumps context from 70% to 95%+.

**Handling:** The budget check fires on the next `message_end` after the tool result lands. At 95%, `triggeringUsage.tokens` is likely above `hardThresholdTokens`. The guard skips the handoff turn and compacts directly. This is less ideal than the full handoff flow but strictly better than the current reactive-only approach — we compact proactively with slightly more headroom than waiting for `agent_end`.

If the jump goes straight to overflow (100%+), the library's own compaction fires, handled by the reactive path. The guard cannot help here — it's a speed-of-light limitation.

### 7.6 User Sends Message During Guard

**Scenario:** User sends a message via `sendMessage()` while `runContextGuard()` is running.

**Handling:** `sendMessage()` checks `this.session.isStreaming || this.promptDispatchPending`. During the handoff/resume turns, the session is streaming (the `prompt()` call is in flight), so the user message gets enqueued via `steer`. It will be delivered during the handoff or resume turn as a steering interrupt.

If the message arrives between steps (session is idle momentarily), `sendMessage()` calls `dispatchPrompt()`, which starts a new turn. The guard's next step (`await session.prompt()`) will throw because the session is already streaming. The guard catches the error, logs it, and cleans up.

**Acceptable behavior:** User messages during recovery are inherently disruptive. Queuing via steer is the least-bad option.

### 7.7 `stopInFlight()` or `terminate()` During Guard

**Scenario:** User clicks "Stop" while the guard is running.

**Handling:** Both methods call `this.guardAbortController?.abort()`. Every step in `runContextGuard()` checks `signal.aborted` before proceeding. The currently-awaited `session.prompt()` or `session.compact()` is also aborted (they internally support cancellation). The guard's `cleanupGuard()` runs, releasing the lock and cleaning up the handoff file.

This is more robust than v1's flag-clearing approach because the `AbortSignal` propagates into async operations rather than just preventing re-entry.

### 7.8 Multiple Agents on Same CWD

**Scenario:** Two agents share the same `cwd` and both trigger handoff.

**Handling:** Agent ID is included in the filename:

```typescript
function buildHandoffFilePath(descriptor: AgentDescriptor): string {
  const safeId = descriptor.agentId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(descriptor.cwd ?? ".", `.middleman-handoff-${safeId}.md`);
}
```

### 7.9 `getContextUsage()` Returns Unknown After Compaction

**Scenario:** The library compacted during the handoff turn. Post-compaction, `getContextUsage()` returns `{ tokens: null, contextWindow, percent: null }` because there's no post-compaction assistant response yet.

**Handling:** Step 3 explicitly checks for `null`/`undefined` tokens and skips compaction when usage is unknown:

```typescript
const needsCompaction = postHandoffUsage
  && postHandoffUsage.tokens !== null
  && postHandoffUsage.tokens !== undefined
  && postHandoffUsage.tokens >= softThresholdTokens;
```

Unknown usage after compaction is treated as "compaction already happened" — we proceed to the resume prompt.

### 7.10 Handoff Turn Does Extra Tool Calls

**Scenario:** Despite prompt instructions, the agent reads files or runs commands during the handoff turn instead of just writing the handoff file.

**Handling:** The prompt is explicit ("Do NOT use any other tool"), but models can still deviate. Mitigations:

1. **Timeout** — the handoff turn has a 45-second timeout. Extra tool calls will be cut short.
2. **Truncation** — handoff content is truncated to `MAX_HANDOFF_CONTENT_CHARS` (3000 chars) before injection into the resume prompt.
3. **Not catastrophic** — even if the agent does extra reads, it still likely writes the handoff file. The guard continues regardless of what the agent does during the turn.

A stronger mitigation (restricting tool access during the handoff turn) would require API changes to `AgentSession` and is deferred.

### 7.11 "Already Compacted" Error from Manual Compact

**Scenario:** Library auto-compacts during handoff turn. Guard then calls `this.compact()` and gets an error because the session is already compacted.

**Handling:** Add a helper to detect this:

```typescript
function isAlreadyCompactedError(message: string): boolean {
  return /already\s+compact/i.test(message) || /nothing\s+to\s+compact/i.test(message);
}
```

Treated as non-fatal success in `runContextGuard()`.

---

## 8. Configuration

### Compile-Time Constants

| Constant | Value | Rationale |
|----------|-------|-----------|
| `HANDOFF_TURN_TOKEN_BUDGET` | `2048` | Conservative budget for handoff prompt + response + tool overhead |
| `ESTIMATION_ERROR_MARGIN_PERCENT` | `0.05` | 5% of context window as heuristic accuracy margin |
| `ESTIMATION_ERROR_MARGIN_MIN_TOKENS` | `4096` | Floor for estimation margin on small context windows |
| `CONTEXT_BUDGET_CHECK_THROTTLE_MS` | `3000` | 3s throttle — checking every message_end is wasteful; longer than v1's 2s because we dropped message_update checks |
| `HANDOFF_TURN_TIMEOUT_MS` | `45000` | 45s — generous for a single write call, shorter than v1's 60s |
| `MAX_HANDOFF_CONTENT_CHARS` | `3000` | ~750 tokens — keeps resume prompt compact post-compaction |

### Future: Per-Agent Configuration

If needed, add to `AgentDescriptor`:

```typescript
contextGuard?: {
  enabled?: boolean;                    // default: true
  estimationMarginPercent?: number;     // default: 0.05
};
```

**Deferred** — start with hardcoded constants. Tune based on real-world data.

### Handoff File Location

`{agent.cwd}/.middleman-handoff-{agentId}.md`

Written to agent CWD because the agent's `write` tool operates relative to CWD. The agent ID suffix prevents collision when multiple agents share a CWD.

---

## 9. Testing Strategy

### Unit Tests

#### `checkContextBudget()` Guards
- Skips when `contextRecoveryInProgress` is true
- Skips when status is `terminated`
- Skips when not streaming
- Skips when below soft threshold
- Triggers at soft threshold
- Throttled — two calls within 3s, only first runs
- Throttle resets after interval

#### `computeGuardThresholds()`
- 200k window: soft ≈ 171k, hard ≈ 183k
- 128k window: soft ≈ 105k, hard ≈ 111k
- Small window (32k): margins scale correctly, soft < hard
- Minimum estimation margin (4096) applies for small windows

#### `runContextGuard()` — Happy Path
- Mock: abort succeeds, prompt succeeds, readFile returns content, compact succeeds, resume prompt succeeds
- Verify: all steps called in order, handoff content passed to resume prompt, cleanup runs, flag cleared

#### `runContextGuard()` — Abort Failure
- Mock: `session.abort()` throws
- Verify: flag cleared, no further steps

#### `runContextGuard()` — Hard Threshold Skip
- Set `triggeringUsage.tokens >= hardThresholdTokens`
- Verify: handoff turn skipped, compaction runs directly

#### `runContextGuard()` — Handoff Timeout
- Mock: `session.prompt()` never resolves within 45s
- Verify: timeout fires, abort called, compaction still runs

#### `runContextGuard()` — Handoff File Missing
- Mock: `readFile` throws ENOENT
- Verify: compaction runs, resume prompt uses no-handoff variant

#### `runContextGuard()` — Compaction Already Done
- Mock: post-handoff `getContextUsage()` returns `undefined` (or tokens below threshold)
- Verify: compaction skipped, resume prompt still sent

#### `runContextGuard()` — Compaction Failure
- Mock: `this.compact()` throws
- Verify: error logged, resume prompt still sent (graceful degradation)

#### `runContextGuard()` — "Already Compacted" Error
- Mock: `this.compact()` throws with "already compacted" message
- Verify: treated as non-fatal, flow continues normally

#### `runContextGuard()` — Cancellation
- Abort the `guardAbortController` at various steps
- Verify: method returns early, cleanup runs at each point

#### Recovery Lock Serialization
- Start guard (sets `contextRecoveryInProgress = true`)
- Simulate `auto_compaction_end` error event
- Verify: reactive path skips (flag is true)
- Reverse: start reactive path, then trigger guard check
- Verify: guard skips (flag is true)

#### State Cleanup
- Verify `stopInFlight()` aborts guard controller and clears all state
- Verify `terminate()` aborts guard controller and clears all state

### Integration Tests

#### Simulated Context Growth
- Create `AgentRuntime` with mock session reporting escalating usage
- Simulate `message_end` events at 60%, 80%, 87% (above soft threshold for 200k)
- Verify guard triggers at 87%
- Verify full handoff → compact → resume cycle

#### Guard + Reactive Coexistence
- Simulate guard failure (abort throws)
- Then simulate `auto_compaction_end` with error
- Verify reactive three-tier fallback engages normally

#### Hard Threshold Direct Compact
- Simulate `message_end` at 92% (above hard threshold)
- Verify guard triggers, skips handoff, runs compact directly

### Manual Smoke Tests

1. **Long coding session** — give agent a large refactoring task. Verify guard triggers, handoff file appears, agent writes it, compaction runs, agent resumes with orientation.
2. **Stop during guard** — trigger guard, click "Stop" during handoff turn. Verify clean state, no stuck flags.
3. **Multiple agents** — two workers on same CWD. Verify handoff files don't collide.
4. **Small context model** — test with a 128k model. Verify thresholds scale correctly.

---

## 10. Rollout Considerations

### Logging

Two log paths:

| Level | Method | Used For |
|-------|--------|----------|
| Info | `logContextGuard()` via `console.log` | `triggered`, `completed`, `handoff_skipped_*`, `compaction_skipped` — operational visibility, not surfaced as errors to UI |
| Error | `logRuntimeError("context_guard", ...)` | Actual failures: `abort_failed`, `compaction_failed`, `resume_prompt_failed` — surfaced to UI via `SwarmManager.handleRuntimeError()` |

The review correctly noted that v1 used `logRuntimeError()` for informational stages, which would cause "⚠️ Agent error" messages in the UI for non-error events. v2 separates these.

**Implication for `SwarmManager.handleRuntimeError()`:** Add `context_guard` to the phase handling so error messages are formatted appropriately (e.g., "Context guard: compaction failed" rather than generic "Agent error").

### User Visibility

The handoff and resume prompts appear as normal messages in the conversation. Users see:
1. The system asking the agent to write a handoff document
2. The agent writing the file
3. (Compaction — transparent, just a summary appearing)
4. The resume prompt with handoff contents

This is **intentionally visible** — transparency about what happened.

### Feature Flag

Always-on. The threshold is computed to fire just before the library's own compaction boundary, so the guard only triggers when compaction is imminent anyway. The only question is whether compaction happens with a handoff or without one.

Kill switch constant if needed:

```typescript
const MID_TURN_CONTEXT_GUARD_ENABLED = true;
```

### Rollout Order

1. Ship to dev — test with internal sessions
2. Monitor `context_guard:*` logs — watch for trigger rates, handoff success rates, threshold accuracy
3. Tune estimation margin if guards fire too early (lower margin) or too late (raise margin)
4. Ship to prod

---

## Appendix A: Import Additions

```typescript
// New imports needed in agent-runtime.ts
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
```

## Appendix B: `RuntimeErrorEvent.phase` Update

```typescript
// In runtime-types.ts, add "context_guard" to the phase union:
export interface RuntimeErrorEvent {
  phase:
    | "prompt_dispatch"
    | "prompt_start"
    | "steer_delivery"
    | "compaction"
    | "context_guard"    // ← NEW
    | "interrupt"
    | "thread_resume"
    | "startup"
    | "runtime_exit";
  // ...
}
```

## Appendix C: Handoff File Lifecycle

| Event | Handoff File State |
|-------|-------------------|
| Guard triggers | Does not exist |
| Handoff turn runs | Agent creates it via `write` tool |
| Guard reads it | Content captured in memory |
| Resume prompt sent | Content inlined in prompt |
| `cleanupGuard()` runs | Deleted (best-effort) |
| Process crash mid-guard | Orphaned on disk (harmless dotfile) |

Periodic cleanup of orphaned `.middleman-handoff-*.md` files could be added to `SwarmManager.boot()`. **Deferred** — orphaned files are rare and harmless.

## Appendix D: Full Method Dependency Map

```
handleEvent(message_end)
  └─ checkContextBudget()
       └─ runContextGuard(usage)
            ├─ session.abort()
            ├─ runHandoffTurn(path, signal)
            │    ├─ session.prompt(handoffPrompt)  // awaits full turn
            │    └─ readFile(path)
            ├─ this.compact()
            ├─ session.prompt(resumePrompt)        // awaits full turn
            └─ cleanupGuard(path)

stopInFlight() / terminate()
  └─ guardAbortController.abort()  // cancels in-flight guard
```

No event interception. No completion promises. No state machine. Just sequential async with cancellation.
