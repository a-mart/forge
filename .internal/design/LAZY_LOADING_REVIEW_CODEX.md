# Agents Snapshot Lazy Loading — Codex Review

**Commit reviewed:** `bd4157b` (diffed against `99cb7cd`)

## Verdict: **APPROVE_WITH_FIXES**

The core direction is correct and the three prior blockers are addressed:

1. ✅ `managerId` is now present on worker `agent_status` events (`swarm-manager.ts`, `server-events.ts`).
2. ✅ `get_session_workers` unknown-session path now returns explicit `UNKNOWN_SESSION` (`agent-routes.ts`).
3. ✅ Frontend dedup guard returns the same in-flight promise (`ws-client.ts` `pendingWorkerFetches`).

However, there are two correctness risks that should be fixed before merge.

---

## Findings

### HIGH — Full `session_workers_snapshot` is broadcast globally, which can reintroduce oversized WS payload drops

**Why this matters:** The feature goal is to avoid large bootstrap payloads. But current runtime wiring still emits full worker lists and broadcasts them to all subscribed clients. In large single-session cases (many workers under one manager), this can exceed practical WS frame budgets again.

**References:**
- `apps/backend/src/swarm/swarm-manager.ts:1978,2013,2044,2090,2163,2764,5284-5292`
- `apps/backend/src/ws/server.ts:99-101,276,294`
- `apps/backend/src/ws/ws-handler.ts:89-123` (broadcast is global except a few event types)

**Issue snippet:**
```ts
// swarm-manager.ts
private emitSessionWorkersSnapshot(sessionAgentId: string, requestId?: string): void {
  const payload: SessionWorkersSnapshotEvent = {
    type: "session_workers_snapshot",
    sessionAgentId,
    workers: this.listWorkersForSession(sessionAgentId),
    ...(requestId ? { requestId } : {})
  };
  this.emit("session_workers_snapshot", payload satisfies ServerEvent);
}

// server.ts
private readonly onSessionWorkersSnapshot = (event: ServerEvent): void => {
  if (event.type !== "session_workers_snapshot") return;
  this.wsHandler.broadcastToSubscribed(event);
};
```

**Suggested fix (minimum):**
- Keep `get_session_workers` request/response behavior.
- Stop globally broadcasting full `session_workers_snapshot` unless explicitly requested.
- If live sync for expanded sessions is required, switch to either:
  - targeted per-socket updates (requires tracking who expanded what), or
  - lightweight delta events (worker added/removed/status-changed) instead of full list snapshots.

---

### MEDIUM — `activeWorkerCount` can drift due to status baseline resets

**Why this matters:** `activeWorkerCount` is now adjusted by worker `agent_status` deltas, but `applyAgentsSnapshot()` rebuilds `statuses` only from `mergedAgents` (managers + loaded/preserved workers). Status baselines for unloaded workers are dropped; the next `streaming` status for those workers is treated as a fresh transition and increments count again.

**References:**
- `apps/ui/src/lib/ws-client.ts:775,793-806` (delta math from previous status)
- `apps/ui/src/lib/ws-client.ts:1042-1053` (status map reset on each agents snapshot)

**Issue snippet:**
```ts
// agent_status handler
const prevStatus = this.state.statuses[event.agentId]?.status
const delta =
  event.status === 'streaming' && prevStatus !== 'streaming' ? 1
  : event.status !== 'streaming' && prevStatus === 'streaming' ? -1
  : 0

// applyAgentsSnapshot
const statuses = Object.fromEntries(
  mergedAgents.map((agent) => {
    const previous = this.state.statuses[agent.agentId]
    return [agent.agentId, { ... }]
  }),
)
```

**Suggested fix:**
- Preserve existing worker status entries for workers not present in `mergedAgents` (at least for workers under known managers), or
- Apply delta updates only when a previous worker status baseline is known and keep manager `activeWorkerCount` authoritative from snapshots otherwise.

---

### LOW — Test coverage gaps for new lazy-loading failure modes

**Why this matters:** Current tests validate happy path and error code parsing, but they do not cover the two risks above.

**References:**
- `apps/backend/src/test/ws-server.test.ts:2618-2709,2740-2863`
- `apps/backend/src/test/ws-command-parser.test.ts:45-167`

**Missing cases to add:**
1. A regression test that ensures unsolicited `session_workers_snapshot` is not broadcast globally (or is filtered/ignored appropriately).
2. A client-state test proving `activeWorkerCount` remains stable across `agents_snapshot` + subsequent worker `agent_status` events.
3. Parser test for invalid `get_session_workers.requestId` type (currently only empty `sessionAgentId` is covered).

---

## Notes on requested focus areas

- **Backend list methods** (`listBootstrapAgents`, `listManagerAgents`, `listWorkersForSession`): implementation shape is correct for lazy bootstrap and on-demand fetch.
- **Protocol changes** are additive and backward-compatible (`workerCount`, `activeWorkerCount`, `managerId?`, new command/event).
- **WS parser/route wiring** is complete for the new command and error handling.
- **Prior blocker verification:** all three appear implemented.
