# WS Crash Deep Debug Report

## Summary
The recurring stack overflow during/after onboarding completion was **not** caused by the WebSocket send path itself. The new VM crash log showed the overflow surfacing in `WsHandler.send()`, but the real loop started **earlier** in manager runtime recycling.

## Fresh VM evidence
`backend.err.log` showed:

- `RangeError: Maximum call stack size exceeded`
- stack path:
  - `WsHandler.send()`
  - `WsHandler.broadcastToSubscribed()`
  - `SwarmWebSocketServer.onAgentStatus()`
  - `SwarmManager.emitStatus()`
  - `SwarmManager.handleRuntimeStatus()`
  - `runtime-factory.ts -> onStatusChange`
  - `AgentRuntime.emitStatus()`
  - `AgentRuntime.endContextRecovery()`

This proved the send guard commit (`4b76a67`) was only catching where the recursion finally exploded, not the source of the recursion.

## Full onboarding-completion path traced
1. Model/tool calls `set_onboarding_status(completed)`.
2. `SwarmManager.setOnboardingStatus()` persists onboarding state.
3. If requested, it calls `renderOnboardingCommonKnowledge()`.
4. On success it calls `syncManagerPromptMode(descriptor, { recycleIfChanged: true })`.
5. Completing onboarding changes the root Cortex manager prompt mode from onboarding -> default.
6. `syncManagerPromptMode()` marks the manager for recycle and calls `applyManagerRuntimeRecyclePolicy(..., "prompt_mode_change")`.
7. `applyManagerRuntimeRecyclePolicy()` calls `recycleManagerRuntime()`.
8. `recycleManagerRuntime()` previously left `pendingManagerRuntimeRecycleAgentIds` set **while awaiting** `runtime.recycle()`.
9. `AgentRuntime.recycle()` calls `endContextRecovery()`, which emits another runtime status update.
10. `SwarmManager.handleRuntimeStatus()` sees the manager idle with a pending recycle flag still set, so it re-enters `applyManagerRuntimeRecyclePolicy(..., "idle_transition")`.
11. That calls `recycleManagerRuntime()` again on the same runtime.
12. Loop repeats until the stack blows up; WS send is just where one recursive branch finally crashes.

## Root cause
**Re-entrant manager runtime recycle triggered by status emission during `runtime.recycle()`.**

The manager kept the recycle-pending flag active while the runtime was already mid-recycle. Because `AgentRuntime.recycle()` emits a status update via `endContextRecovery()`, the manager treated that update as another valid idle-transition recycle trigger and recursively recycled the same runtime.

## Fix
Updated `apps/backend/src/swarm/swarm-manager.ts`:

- In `recycleManagerRuntime()`:
  - clear `pendingManagerRuntimeRecycleAgentIds` **before** awaiting `runtime.recycle()`
  - if recycle throws, restore the pending flag and rethrow
  - detach the runtime only after successful recycle

This breaks the recursive status -> recycle -> status -> recycle loop while preserving retry/deferred behavior on failure.

## Regression coverage added
Added a new backend test in `apps/backend/src/test/swarm-manager.test.ts` that simulates the exact re-entrant case:

- a fake runtime emits an idle status update from inside `recycle()`
- completing onboarding flips prompt mode
- assertion verifies only one recycle occurs, the runtime detaches cleanly, and pending recycle state clears

## Validation run
Passed:

- `cd apps/backend && pnpm exec vitest run src/test/swarm-manager.test.ts`
- `cd apps/backend && pnpm exec vitest run src/test/ws-handler.test.ts`
- `cd apps/backend && pnpm exec tsc -p tsconfig.build.json --noEmit`
- `cd apps/ui && pnpm exec tsc --noEmit`
- `pnpm test`

## Files changed
- `apps/backend/src/swarm/swarm-manager.ts`
- `apps/backend/src/test/swarm-manager.test.ts`
- `WS-CRASH-DEEP-DEBUG-REPORT.md`

## Bottom line
The crash was a **manager recycle re-entrancy bug**, not a pure WebSocket transport issue. The send guard remains useful as a safety net, but the real fix was stopping onboarding-triggered prompt-mode recycle from re-triggering itself during `AgentRuntime.recycle()`.
