# Review: `MID_TURN_CONTEXT_GUARD_DESIGN.md`

## TL;DR
The design direction is good (proactive guard + continuity handoff is the right problem to solve), but the current implementation plan is **not yet safe against actual runtime behavior** in `agent-runtime.ts` and pi `AgentSession` internals. The biggest issues are event-flow/race handling, interaction with existing auto-compaction recovery, and assumptions about context usage accuracy during streaming.

I’d rate this design as **promising but not implementation-ready** without a tighter orchestration model.

---

## What’s Strong

1. **Correct problem framing**
   - Current compaction is post-turn and can fail when context is already too full.
   - Preserving task-specific continuity beyond generic compaction summaries is a valid gap.

2. **Good strategic idea**
   - “handoff note before compaction, then resume with handoff injected” is a strong continuity pattern.

3. **Reasonable fallback philosophy**
   - Keeping existing reactive three-tier recovery as safety net is correct.

---

## 1) Feasibility vs Actual Code (`agent-runtime.ts` + session APIs)

## API reality check
The proposed APIs do exist and are callable:
- `session.abort()` ✅
- `session.compact()` ✅
- `session.prompt()` ✅
- `session.sendUserMessage()` ✅
- `session.agent.continue()` ✅

But there are important behavior details the design currently misses:

### A. `session.prompt()` already waits for the turn
In pi `AgentSession.prompt()`, the call awaits `agent.prompt(...)`, which runs the full loop until completion. So the design’s extra `midTurnHandoffResolve` + waiting for `agent_end` is mostly redundant and introduces fragility.

### B. Intercepting `agent_end` during handoff is risky
The design proposes short-circuiting normal `agent_end` handling during handoff. In current runtime, `agent_end` is where status returns to `idle`. Skipping that can leave status stale (`streaming`) while the session is actually idle, causing inconsistent state and confusing telemetry/UI behavior.

### C. Hook placement is partly right, partly low-value
Checking on `message_end` is useful. Checking on `message_update` is much less useful than assumed because context usage is estimated from stored messages (completed messages), not partial stream deltas, so updates may not materially move the estimate.

---

## 2) Interaction with existing compaction recovery (critical)

Current runtime already has:
- `handleAutoCompactionEndEvent`
- `retryCompactionOnceAfterAutoFailure`
- `runEmergencyContextTrim`

### Conflict risk 1: double-compaction race
If handoff turn ends and pi auto-compaction triggers immediately after that `agent_end`, your orchestrator may then call `session.compact()` again. If already compacted, manual compact can throw (“Already compacted” path in pi session logic).

### Conflict risk 2: concurrent recovery flows
If auto-compaction fails during/after handoff turn, existing recovery may already be running (`autoCompactionRecoveryInProgress=true`) while guard flow also attempts compaction/resume. That is a real race over shared session state.

### Conflict risk 3: recovery ownership ambiguity
Design says “no conflict” conceptually, but current runtime has no unified lock/owner for “who currently controls context recovery.” Without that, proactive and reactive flows can fight.

**Actionable fix:** introduce a single serialized recovery owner (mutex/guard token) that covers both proactive handoff flow and reactive fallback.

---

## 3) Handoff-turn token risk

The document’s 200k-context arithmetic is directionally fine, but incomplete:

- At 85% on 200k, yes, ~30k headroom sounds okay.
- But this assumes 200k windows and ignores model variance.
- Compaction reserve is token-based (`reserveTokens` default 16384), while your trigger is percent-based. On smaller windows, fixed 85% can be wrong.
- If trigger happens late (e.g. jump to 95%+), handoff prompt + tool call + tool result can consume the remaining margin quickly.

**Actionable fix:**
- Use **token-aware thresholds** tied to `contextWindow - reserveTokens - handoffBudget`, not just 85%.
- Add a hard ceiling: if already too close to reserve, skip handoff turn and go straight to compact/recovery.

---

## 4) Context usage accuracy concerns

The design overstates precision of `getContextUsage()`.

Key runtime facts:
- It is hybrid: last assistant `usage` + estimated trailing messages.
- Estimate is heuristic (`chars/4`) and can drift with code-heavy/tool-heavy payloads.
- During streaming, partial assistant output isn’t reliably represented in stored message history yet.
- After compaction, usage may be intentionally unknown until a post-compaction assistant response (runtime sees undefined).

Implication: hard threshold logic can fire too late or too early, and post-compaction checks like “if percent < 50 skip compact” are not reliable.

**Actionable fix:**
- Treat usage as approximate.
- Add hysteresis and conservative margins.
- Don’t rely on immediate post-compaction percent checks for control flow.

---

## 5) Simplicity / overengineering

The 6-state model is conceptually clear, but implementation details are heavier than needed and introduce race surfaces.

You can simplify:
1. No `midTurnHandoffResolve` promise.
2. No `agent_end` short-circuiting.
3. One serialized `runContextGuard()` task with cancellation token.
4. `await session.abort()` → optional handoff prompt turn → compact (or detect already compacted) → resume prompt.

This preserves behavior while reducing fragile event coupling.

---

## 6) Edge cases missed or under-specified

1. **Partial repo mutation on abort**
   - If aborted mid-task, some file edits may already be applied.
   - Resume prompt should explicitly instruct agent to re-validate workspace/diff before continuing.

2. **Pending queued messages during guard**
   - Steering/follow-up/user messages can queue while handoff is running.
   - Need explicit policy: pause delivery, or allow and merge deterministically.

3. **Handoff prompt can cause extra tool churn**
   - Current prompt says “ONLY write file,” but models can still do reads/edits.
   - Add stricter guardrails + timeout + post-turn validation of handoff file.

4. **Large one-shot jump (70→95+)**
   - Guard may trigger with too little room for safe handoff turn.
   - Need “late-trigger bypass” mode: skip handoff, compact immediately.

5. **stop/terminate mid-guard**
   - Clearing flags alone is insufficient if async guard flow continues and later sends resume prompt.
   - Need cancellation token checked before each step.

---

## 7) Prompt quality (handoff + resume)

The structure is good and likely better than freeform. Improvements:

- Enforce tighter size cap (e.g. 250–350 words) to reduce token overhead.
- Explicitly forbid any tool except `write` in the handoff turn.
- Use a deterministic file schema (e.g. exact headings, short bullets).
- Resume prompt should cap injected handoff length (truncate/summarize if huge).

Current prompts are decent, but not strict enough for reliable bounded behavior under pressure.

---

## Additional implementation notes

1. If `RuntimeErrorEvent.phase` gains `"context_guard"`, update `SwarmManager.handleRuntimeError()` behavior so informational guard stages don’t appear as generic “⚠️ Agent error”.
2. Treat `"Already compacted"` from manual compact as non-fatal success path.
3. Prefer runtime wrapper methods (`this.compact()`) when you need consistent status emission/log behavior.

---

## Recommended path to make this shippable

1. Keep proactive guard concept.
2. Replace event-driven mini state machine with a single serialized orchestrator + cancellation token.
3. Use token-aware soft/hard thresholds (not fixed 85% only).
4. Coordinate with existing reactive recovery via one shared recovery lock.
5. Handle already-compacted and unknown-usage states explicitly.
6. Tighten prompts for bounded output and predictable tool behavior.

With these changes, this feature can be robust and materially improve session continuity.
