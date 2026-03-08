# Smart Compaction — Manual Menu Action: Implementation Plan

> **Status:** Investigation complete, ready for implementation.
> **Date:** 2026-03-07

---

## 1. Current Behavior Summary

### 1.1 Existing "Compact context" Menu Action (Legacy/Manual Path)

**UI:** Three-dot dropdown menu in `ChatHeader.tsx` (line 254). Label is **"Compact context"**. Visible only when the active agent is a manager (`showCompact={isActiveManager}`). Has a `compactInProgress` disabled/spinner state.

**Frontend flow:**
1. `ChatHeader` → `onCompact()` → `handleCompactManager()` in `use-manager-actions.ts`
2. `handleCompactManager()` calls `requestManagerCompaction()` — a direct `POST /api/agents/:agentId/compact` REST call.
3. Supports an optional `customInstructions` string (used by the `/compact <instructions>` slash command variant).

**Backend flow:**
1. `agent-routes.ts` handles `POST /api/agents/:agentId/compact`.
2. Calls `swarmManager.compactAgentContext(agentId, { customInstructions, trigger: "api" })`.
3. `compactAgentContext()` in `swarm-manager.ts` (line 2031):
   - Validates agent is a running manager.
   - Gets (or creates) the `AgentRuntime`.
   - Emits a system `"Compacting manager context..."` conversation message.
   - Calls `runtime.compact(customInstructions)`.
   - Emits a system `"Compaction complete."` or `"Compaction failed: ..."` conversation message.
4. `AgentRuntime.compact()` (line 224) delegates to `this.session.compact(customInstructions)` — pi runtime's built-in compaction.

**Conclusion: Yes, the current menu action is the legacy/manual compaction path.** It calls pi's built-in `session.compact()` directly, which performs a standard context window summarization. It does **not** run the intelligent handoff-then-compact flow.

### 1.2 Automatic Smart Compaction (Context Guard)

The automatic "smart compaction" is implemented as the **mid-turn context guard** in `AgentRuntime` (`agent-runtime.ts`). It is a proactive recovery flow that fires automatically when context usage crosses a threshold during streaming.

**Trigger detection:**
- `checkContextBudget()` (line 456) runs on every `message_end` session event while the agent is streaming.
- Throttled to once per 3 seconds (`CONTEXT_BUDGET_CHECK_THROTTLE_MS`).
- Skipped if recovery is already active, agent is terminated, or not streaming.
- Uses `computeGuardThresholds(contextWindow)` to calculate:
  - **Soft threshold** ≈ `contextWindow − compactionReserve(16K) − handoffBudget(2K) − estimationMargin(max(4K, 5%))` → ~80-90% of context.
  - **Hard threshold** ≈ `contextWindow − compactionReserve(16K)` → ~95%+ of context.
- Fires `runContextGuard()` when `tokens >= softThresholdTokens`.

**Full `runContextGuard()` flow (line 495):**

1. **Lock**: Sets `contextRecoveryInProgress = true`. All incoming user messages are buffered (not steered into the session).
2. **Abort current turn**: Calls `session.abort()` (15s timeout) to halt the in-flight agent response.
3. **Handoff turn** (if below hard threshold):
   - Builds a temporary file path: `.middleman-handoff-<agentId>.md` in the agent's CWD.
   - Sends a `session.prompt()` with `buildHandoffPrompt(filePath)` — an urgent instruction telling the agent to write a structured handoff document (Current Task, Progress, Active Files, Next Steps, Open Issues) using the `write` tool. Max ~300 words.
   - 45-second timeout on the handoff turn (`HANDOFF_TURN_TIMEOUT_MS`).
   - Reads the handoff file content back, truncated to 3000 chars.
4. **Compact**: Calls `this.compact()` (pi `session.compact()`) with a 60s timeout if still above soft threshold.
5. **Resume prompt**: Sends `session.prompt(buildResumePrompt(handoffContent))`:
   - **Without handoff**: Generic "your context was compacted, review summary, check `git status`, continue."
   - **With handoff**: Injects the handoff document content inline, telling the agent to use it for specific working state and follow the Next Steps.
6. **Cleanup**: Deletes the handoff file, ends recovery lock (with 2s grace period), flushes any buffered user messages.

**Key properties:**
- Handoff file is ephemeral (created, read, deleted within the guard flow).
- The handoff content is injected as text in the resume prompt, not as a file reference.
- The entire flow is self-contained within `AgentRuntime` — no swarm-manager involvement beyond the normal `compact()` call.
- Only works with pi runtime (`AgentRuntime`); codex runtime throws "does not support manual compaction."

---

## 2. Reusability Analysis

The smart compaction flow in `runContextGuard()` is **partially reusable** but tightly coupled to the automatic trigger context:

| Aspect | Reusable? | Notes |
|--------|-----------|-------|
| `buildHandoffPrompt()` | ✅ Yes | Pure function, no state dependency |
| `buildResumePrompt()` | ✅ Yes | Pure function |
| `buildHandoffFilePath()` | ✅ Yes | Pure function |
| `runHandoffTurn()` | ✅ Yes | Self-contained, takes filepath + signal |
| `compact()` | ✅ Yes | Already a public method |
| `beginContextRecovery()` / `endContextRecovery()` | ✅ Yes | Needed for message buffering |
| `cleanupGuard()` | ✅ Yes | Handles file cleanup + grace period + buffer flush |
| Threshold check logic | ❌ N/A | Not needed for manual trigger |
| In-flight abort logic | ⚠️ Conditional | Only needed if agent is mid-stream; manual trigger may work when idle too |
| `session.prompt()` for handoff | ⚠️ | Must check session isn't already streaming |

**Recommendation:** Extract the guard's core logic into a new method `runSmartCompaction()` that:
1. Can be called both from the automatic threshold path and from a new manual trigger.
2. Handles the idle case (skip abort, go straight to handoff prompt).
3. Handles the streaming case (abort first, then handoff).
4. Shares the same recovery lock, cleanup, and resume machinery.

---

## 3. Proposed UX Design

### 3.1 Menu Item

| Property | Value |
|----------|-------|
| **Label** | `Smart compact` (idle) / `Smart compacting…` (in progress) |
| **Icon** | `Sparkles` from lucide-react (to differentiate from the `Minimize2` icon on basic compact) |
| **Position** | Below existing "Compact context" in the 3-dot dropdown |
| **Confirmation** | None required — consistent with existing "Compact context" behavior |

### 3.2 Disabled States

| Condition | Disabled? | Rationale |
|-----------|-----------|-----------|
| Agent is not a pi-runtime manager | Hidden | Codex doesn't support compaction at all |
| Smart compaction already in progress | Yes + spinner | Same pattern as basic compact |
| Basic compaction in progress | Yes | Both share the same recovery lock |
| Context recovery active (auto guard running) | Yes | Avoid conflicting concurrent recovery |
| Agent is terminated/stopped | Hidden | Same as existing compact visibility |

### 3.3 Behavior by Agent State

| Agent State | Behavior |
|-------------|----------|
| **Idle** | Skip abort step → run handoff prompt → compact → resume prompt |
| **Streaming** | Abort in-flight → run handoff prompt → compact → resume prompt |
| **Recovery in progress** | Reject with error (disabled in UI, 409 from API) |

### 3.4 Loading UX

- Spinner icon replaces `Sparkles` while in progress.
- Label changes to `Smart compacting…`.
- Both "Compact context" and "Smart compact" are disabled during either operation (they share the recovery lock).

---

## 4. Implementation Plan

### Phase 1: Backend — New `smartCompact()` Method on `AgentRuntime`

**File:** `apps/backend/src/swarm/agent-runtime.ts`

1. Extract the core guard logic from `runContextGuard()` into a new **public** `async smartCompact(): Promise<void>` method on `AgentRuntime`:
   ```
   async smartCompact(): Promise<void>
   ```
2. The method should:
   - Check `isContextRecoveryActive()` → throw if already in recovery.
   - Set `beginContextRecovery()`.
   - If session is streaming: abort (with timeout).
   - Run `runHandoffTurn()` to get handoff content.
   - Run `compact()`.
   - Run `session.prompt(buildResumePrompt(handoffContent))`.
   - `cleanupGuard()` in `finally` block.
3. Refactor `runContextGuard()` to call `smartCompact()` internally (or share a private helper) to avoid duplication. The automatic path adds the threshold-specific logic (soft/hard threshold decisions, skip-handoff-at-hard-threshold).
4. Add `smartCompact()` to the `SwarmAgentRuntime` interface in `runtime-types.ts`.
5. In `codex-agent-runtime.ts`, add `smartCompact()` that throws `"does not support smart compaction"`.

### Phase 2: Backend — New API Endpoint / SwarmManager Method

**File:** `apps/backend/src/swarm/swarm-manager.ts`

1. Add `async smartCompactAgentContext(agentId: string, options?)` method, mirroring the existing `compactAgentContext()`:
   - Validate agent is a running manager.
   - Get runtime.
   - Emit system conversation message: `"Running smart compaction (handoff → compact → resume)…"`.
   - Call `runtime.smartCompact()`.
   - Emit system conversation message: `"Smart compaction complete."` (or error).

**File:** `apps/backend/src/ws/routes/agent-routes.ts`

2. Add a new endpoint: `POST /api/agents/:agentId/smart-compact`
   - Same shape as `/compact` (no body required, but could accept `customInstructions` in future).
   - Calls `swarmManager.smartCompactAgentContext(agentId, ...)`.
   - Same error handling pattern as the existing compact endpoint.

### Phase 3: Frontend — New Menu Action

**File:** `apps/ui/src/hooks/index-page/use-manager-actions.ts`

1. Add `isSmartCompactingManager` state (boolean).
2. Add `handleSmartCompactManager()` callback:
   - `POST /api/agents/:agentId/smart-compact` via a new `requestManagerSmartCompaction()` helper.
   - Same error handling pattern as `handleCompactManager()`.
3. Export both new values.

**File:** `apps/ui/src/components/chat/ChatHeader.tsx`

4. Add new props: `showSmartCompact`, `smartCompactInProgress`, `onSmartCompact`.
5. Add a new `DropdownMenuItem` below the existing "Compact context" item:
   - Icon: `Sparkles`
   - Label: `Smart compact` / `Smart compacting…`
   - Disabled when: `smartCompactInProgress || compactInProgress`
6. Disable existing "Compact context" when `smartCompactInProgress` is true.

**File:** `apps/ui/src/routes/index.tsx`

7. Wire the new props from `useManagerActions` into `ChatHeader`.

### Phase 4: Cross-disable and Recovery Lock Integration

1. In `AgentRuntime.compact()` — check `isContextRecoveryActive()` and throw if locked (prevents calling basic compact while smart compact is running). This may already be handled by the session level, but an explicit check is safer.
2. In `AgentRuntime.smartCompact()` — the `beginContextRecovery()` call naturally prevents basic compact and auto-guard from firing concurrently.
3. Frontend: disable both buttons when either operation is in progress.

---

## 5. Risks and Edge Cases

### 5.1 Concurrency

| Risk | Mitigation |
|------|------------|
| User clicks "Smart compact" while auto context guard is already running | `isContextRecoveryActive()` check → 409 from API, disabled in UI |
| User clicks both compact buttons rapidly | Both share `contextRecoveryInProgress` lock; second call rejected |
| User sends a message during smart compaction | Messages buffered via existing `bufferMessageDuringRecovery()`, flushed after completion |

### 5.2 Streaming vs Idle

| Risk | Mitigation |
|------|------------|
| Agent is idle — `session.abort()` may throw or no-op | Conditionally skip abort if `!session.isStreaming` |
| Agent is idle — handoff prompt has nothing to hand off | The agent will still write what it knows from conversation context; the handoff document will be sparse but not harmful |
| Agent just finished streaming, context is already small | `compact()` may throw "already compacted" → catch and continue (existing `isAlreadyCompactedError()` check) |

### 5.3 Provider/Runtime Compatibility

| Risk | Mitigation |
|------|------------|
| Codex runtime doesn't support any compaction | `smartCompact()` throws; API returns 409; menu item hidden for codex agents |
| `session.prompt()` fails during handoff | Existing error handling in `runHandoffTurn()` catches and returns `undefined`; resume prompt uses generic fallback |
| Handoff file write fails (permissions, disk) | `readFile` catch returns `undefined`; cleanup deletes on best-effort |

### 5.4 UX Confusion

| Risk | Mitigation |
|------|------------|
| Two compact options may confuse users | Different icons (`Minimize2` vs `Sparkles`), clear naming. Could add tooltip in future. |
| User expects instant result but smart compact takes 30-60s | Spinner + "Smart compacting…" label. System messages in chat show progress. |
| Smart compact during idle creates a visible "assistant writing handoff" turn in conversation | Expected behavior — the handoff turn is a real assistant turn that will be visible in the chat. It gets compacted away in the subsequent compaction. |

### 5.5 Context Budget

| Risk | Mitigation |
|------|------------|
| Context is already very full; handoff prompt itself might overflow | Same risk as automatic guard. Handoff prompt is ~200 tokens. If context is at >99%, the `compact()` step handles it. Could add a pre-check and skip handoff if at hard threshold (as auto guard does). |
| Handoff turn output exceeds budget | 3000-char truncation limit already enforced by `runHandoffTurn()` |

---

## 6. Files to Modify (Summary)

| File | Changes |
|------|---------|
| `apps/backend/src/swarm/runtime-types.ts` | Add `smartCompact()` to `SwarmAgentRuntime` interface |
| `apps/backend/src/swarm/agent-runtime.ts` | Add public `smartCompact()` method; minor refactor of `runContextGuard()` to share logic |
| `apps/backend/src/swarm/codex-agent-runtime.ts` | Add throwing `smartCompact()` stub |
| `apps/backend/src/swarm/swarm-manager.ts` | Add `smartCompactAgentContext()` method |
| `apps/backend/src/ws/routes/agent-routes.ts` | Add `POST /api/agents/:agentId/smart-compact` route |
| `apps/ui/src/hooks/index-page/use-manager-actions.ts` | Add `isSmartCompactingManager` + `handleSmartCompactManager()` |
| `apps/ui/src/components/chat/ChatHeader.tsx` | Add new dropdown menu item with `Sparkles` icon |
| `apps/ui/src/routes/index.tsx` | Wire new props through |

---

## 7. Validation Checklist

- [ ] **Idle manager**: Click "Smart compact" → see handoff turn in chat → compaction runs → resume prompt appears → agent continues normally.
- [ ] **Streaming manager**: Click "Smart compact" while agent is working → agent stops, writes handoff, compacts, resumes.
- [ ] **Concurrent protection**: While smart compact is in progress, verify "Compact context" is disabled and vice versa.
- [ ] **Auto guard interaction**: Trigger auto context guard (fill context to threshold) → verify "Smart compact" is disabled during auto recovery.
- [ ] **Codex runtime**: Verify "Smart compact" is hidden/disabled for codex-runtime managers.
- [ ] **Message buffering**: Send a user message while smart compaction is running → message should be delivered after compaction completes.
- [ ] **Error recovery**: Kill the agent mid-smart-compact → verify lock is released, UI recovers.
- [ ] **API direct test**: `curl -X POST /api/agents/:id/smart-compact` → 200 for pi managers, 409 for codex/stopped agents.
- [ ] **TypeScript**: `pnpm exec tsc --noEmit` passes.
- [ ] **Visual**: Both menu items render correctly, icons are distinct, spinner states work.
