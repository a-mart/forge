# Agents Snapshot Lazy Loading — Architectural Review

**Reviewer:** review-opus-4  
**Commit:** `bd4157b`  
**Date:** 2026-03-17  
**Verdict:** **APPROVE_WITH_FIXES**

---

## Summary

The implementation cleanly addresses the core problem: `agents_snapshot` events exceeding 1MB with 2000+ agents, causing silent WebSocket drops. The approach — bootstrap with managers only (plus `workerCount`/`activeWorkerCount` summaries), fetch workers on-demand via `get_session_workers` — is sound and well-scoped.

Protocol changes are backward-compatible (new optional fields, new event type, new command). State management is mostly correct with proper dedup guards and cache invalidation. Test coverage is good for the happy paths.

There are two areas needing attention: one HIGH issue with the `ws-handler.ts` type cast, and a MEDIUM design question around the bootstrap hot-workers / broadcast behavior.

---

## Findings

### HIGH-1: Unnecessary and fragile type cast in `ws-handler.ts`

**File:** `apps/backend/src/ws/ws-handler.ts:766-768`

The bootstrap code uses a `typeof` runtime guard with a double type cast to call `listBootstrapAgents`:

```ts
typeof (this.swarmManager as SwarmManager & { listBootstrapAgents?: () => ReturnType<SwarmManager["listAgents"]> }).listBootstrapAgents === "function"
  ? (this.swarmManager as SwarmManager & { listBootstrapAgents: () => ReturnType<SwarmManager["listAgents"]> }).listBootstrapAgents()
  : this.swarmManager.listAgents()
```

`this.swarmManager` is already typed as `SwarmManager` (line 41), and `listBootstrapAgents()` is a public method on `SwarmManager`. The entire guard is dead code — the `typeof` check always succeeds, and the fallback path is unreachable.

**Suggested fix:**
```ts
this.send(socket, {
  type: "agents_snapshot",
  agents: this.swarmManager.listBootstrapAgents()
});
```

This removes ~50 characters of noise and a maintenance trap (if the method is ever renamed, the cast silently falls back to `listAgents()` which returns ALL agents — silently defeating the lazy loading).

---

### MEDIUM-1: Bootstrap hot-workers are a no-op that add payload without value

**File:** `apps/backend/src/swarm/swarm-manager.ts:1183-1184` (bootstrap), `apps/ui/src/lib/ws-client.ts:1015-1024` (preservation logic)

`listBootstrapAgents()` includes streaming workers (`includeStreamingWorkers: true`). The design rationale was presumably to let the sidebar show streaming indicators on initial load. However:

1. **Sessions start collapsed by default** (`expandedSessionIds` initializes empty, `sessionCollapsed = !collapsedSessionIds.has(...)`). Collapsed sessions use `activeWorkerCount` from the manager descriptor, not worker entries.

2. **Hot workers are dropped on the first `agents_snapshot` broadcast.** The broadcast uses `listManagerAgents()` (managers only). `applyAgentsSnapshot` only preserves workers from `loadedSessionIds`, and bootstrap workers never get added to `loadedSessionIds`. So the first lifecycle event that triggers `emitAgentsSnapshot()` will silently evict them.

3. **The `activeWorkerCount` delta tracking via `agent_status` handles streaming counts correctly** regardless of whether workers are loaded. So the hot workers are redundant with the count-based approach.

Net effect: the hot workers survive in `state.agents` only until the next `agents_snapshot` broadcast (often seconds), then vanish. The extra payload in the bootstrap is wasted.

**Suggested fix (either):**
- **Option A (simple):** Change `listBootstrapAgents` to just return `listManagerAgents()`, making bootstrap and broadcast consistent. This is the simpler, lower-risk option.
- **Option B (if hot workers are desired):** Add bootstrap streaming workers to `loadedSessionIds` so they survive subsequent snapshots. But this adds complexity for a marginal benefit.

---

### MEDIUM-2: `session_workers_snapshot` broadcast goes to ALL clients, partially defeating lazy loading for active sessions

**File:** `apps/backend/src/ws/server.ts:99-102`, `apps/ui/src/lib/ws-client.ts:1118-1152`

Every worker lifecycle event (`spawnAgent`, `stopWorker`, `resumeWorker`, `deleteWorker`, `stopAllAgents`) triggers `emitSessionWorkersSnapshot()`, which broadcasts the FULL worker list for that session to ALL connected clients — not just the client that expanded the session.

This means:
- Client A has session S1 collapsed (never loaded workers).
- Worker W1 spawns under S1.
- Client A receives `session_workers_snapshot` for S1, which calls `applySessionWorkersSnapshot`, adding ALL workers for S1 to `state.agents` and adding S1 to `loadedSessionIds`.
- Client A now has workers it didn't ask for.

For the typical case (1-2 UI clients, most sessions quiet), this is fine. But with many active sessions with frequent worker churn, each client accumulates workers for all active sessions — exactly the scaling problem lazy loading was designed to solve.

**Severity:** MEDIUM because the typical deployment is 1-2 connected UIs and the per-session payload is bounded (unlike the old all-agents-in-one-event problem). But this is a design gap worth documenting.

**Possible future mitigation:** Filter `session_workers_snapshot` broadcasts in `broadcastToSubscribed` to only send to clients that have explicitly loaded that session (would require tracking loaded-session state server-side or adding a subscription model for worker snapshots).

---

### MEDIUM-3: `activeWorkerCount` delta tracking can drift from server truth

**File:** `apps/ui/src/lib/ws-client.ts:786-808`

The `agent_status` handler uses delta tracking (`+1` when a worker transitions to streaming, `-1` when transitioning away) to maintain `activeWorkerCount` on manager descriptors. This is elegant but fragile:

1. **Missed events:** If any `agent_status` event is dropped (WebSocket reconnect gap, browser tab suspend), the count drifts permanently until the next `agents_snapshot` resets it.

2. **Bootstrap race:** If a worker's `agent_status` arrives *before* the `agents_snapshot` bootstrap (possible during reconnect), `prevStatus` is `undefined`, and the delta fires as `+1`. If the bootstrap then arrives with the correct `activeWorkerCount` (already counting this worker as streaming), the count is correct (bootstrap overwrites the delta). But if the bootstrap arrives *first*, and then the status event arrives, the count could double-count.

3. **No reconciliation:** There's no periodic reconciliation between the client-side delta count and the server's authoritative count, except when `agents_snapshot` replaces the manager descriptors (which have the server-computed `activeWorkerCount`).

**Mitigation already present:** Every `agents_snapshot` broadcast carries the server-authoritative `activeWorkerCount`, which replaces the client's delta-tracked value. The drift window is bounded to the interval between snapshots.

**Impact:** LOW in practice — snapshot broadcasts happen frequently (every worker lifecycle event), so the drift window is short. But documenting this as a known limitation is worthwhile.

---

### LOW-1: `sendMessage` validation relaxation could allow stale targeting

**File:** `apps/ui/src/lib/ws-client.ts:269-273`

The added `!this.state.statuses[agentId]` check allows sending messages to agents that exist in `statuses` but not in `agents`. This is needed for workers that have status entries from broadcast events but aren't loaded.

However, `statuses` entries are never cleaned up except when `applyAgentsSnapshot`, `applySessionWorkersSnapshot`, `applyManagerDeleted`, or `applySessionDeleted` explicitly remove them. A terminated worker whose session is not loaded could linger in `statuses` indefinitely after receiving an `agent_status` broadcast. The check would then allow attempting to send a message to a terminated worker.

**Impact:** LOW — the server validates and rejects messages to terminated agents. The client-side check is a UX guard, not a security boundary.

---

### LOW-2: `contextRecoveryInProgress` addition to backend `AgentStatusEvent` is an unrelated type sync

**File:** `apps/backend/src/swarm/types.ts:279`

Adding `contextRecoveryInProgress?: boolean` to the backend `AgentStatusEvent` type brings it into sync with the protocol type. This is correct but unrelated to the lazy loading feature. Consider mentioning in the commit message or splitting into a separate commit for clean bisect history.

---

### LOW-3: Naming inconsistency: `expandedSessionIds` vs `collapsedSessionIds`

**File:** `apps/ui/src/components/chat/AgentSidebar.tsx:1768, 2003, 2065`

The state variable is named `expandedSessionIds` but is passed to child components as the `collapsedSessionIds` prop. The child component then inverts the meaning:
```ts
const sessionCollapsed = !collapsedSessionIds.has(session.sessionAgent.agentId)
```

This double negation works correctly but is confusing. Existed before this PR — not introduced by this change. Just a pre-existing readability note.

---

## Test Coverage Assessment

### Well-covered:
- ✅ `get_session_workers` happy path (WS round-trip with worker returned)
- ✅ `get_session_workers` error path (unknown session → `UNKNOWN_SESSION` error)
- ✅ Bootstrap snapshot excludes workers, includes `workerCount`/`activeWorkerCount` on managers
- ✅ Kill agent emits `session_workers_snapshot` with updated worker status
- ✅ Kill agent's `agent_status` includes `managerId`
- ✅ Stop-all emits `session_workers_snapshot` with stopped workers
- ✅ Command parser validation for `get_session_workers`

### Missing coverage:
- ❌ **Client-side cache invalidation:** No test for when `workerCount` changes and `loadedSessionIds` gets invalidated.
- ❌ **Dedup guard:** No test for `pendingWorkerFetches` deduplication (multiple concurrent requests for same session).
- ❌ **`activeWorkerCount` delta tracking:** No test for the `agent_status` handler incrementing/decrementing `activeWorkerCount`.
- ❌ **Reconnect behavior:** No test for `loadedSessionIds` being cleared on reconnect.
- ❌ **`applyAgentsSnapshot` worker preservation:** No test for workers from loaded sessions being preserved across snapshot broadcasts.
- ❌ **Worker subscription stability:** No test for `currentTargetIsIntentionalWorkerSubscription` preventing unwanted re-subscription.
- ❌ **Notification service with `activeWorkerCount`:** The `hasStreamingWorkers` fallback to `activeWorkerCount` is not directly tested.

The missing coverage is primarily on the client-side state management, which is the most complex and error-prone part of this change. Backend coverage is adequate.

---

## Architecture Assessment

### Strengths:
1. **Clean protocol extension.** New types (`SessionWorkersSnapshotEvent`, `get_session_workers` command) follow existing patterns. Backward-compatible via optional fields.
2. **Proper separation.** Backend methods (`listBootstrapAgents`, `listManagerAgents`, `listWorkersForSession`) cleanly separate the three access patterns.
3. **Dedup guard.** `pendingWorkerFetches` map prevents duplicate concurrent requests for the same session.
4. **`requestId` correlation.** The `session_workers_snapshot` response carries `requestId` for request-response correlation, while also supporting push-based broadcast (no `requestId`).
5. **Cache invalidation.** `loadedSessionIds` invalidation on count mismatch is a simple, effective staleness guard.

### Weaknesses:
1. **Broadcast granularity.** `session_workers_snapshot` goes to all clients, partially defeating lazy loading for active sessions.
2. **Two state models.** `activeWorkerCount` (count-based) and `state.agents` (entity-based) coexist as parallel truth sources. The `agent_status` delta tracking bridges them but introduces drift risk.
3. **Ugly type cast.** The `ws-handler.ts` bootstrap code is unnecessarily defensive and should be a direct call.

---

## Verdict: APPROVE_WITH_FIXES

**Required before merge:**
- **HIGH-1:** Remove the unnecessary type cast in `ws-handler.ts` — it's a maintenance trap.

**Recommended but not blocking:**
- **MEDIUM-1:** Consider removing hot workers from bootstrap (make bootstrap consistent with broadcast).
- **MEDIUM-3:** Document the delta-tracking drift window as a known limitation.

Everything else is solid. The core architecture is sound, the protocol is clean, and the feature solves the original problem effectively.
