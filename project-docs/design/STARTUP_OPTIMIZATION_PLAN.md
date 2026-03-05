# Startup Performance Optimization Plan

## Overview

The middleman backend boot process has three scaling bottlenecks that degrade proportionally as sessions and profiles grow. All three stem from the sessions-as-agents architecture: every session has `role: "manager"`, so subsystems that enumerate managers without deduplicating by `profileId` create O(sessions) work instead of O(profiles).

With the current state (~36 sessions across 3 profiles), boot already triggers `MaxListenersExceededWarning` and performs hundreds of unnecessary file operations. At 100+ sessions this becomes a material startup latency and memory problem.

**Impact summary (current ~36 sessions / 3 profiles):**

| Bottleneck | Current cost | Cost with fix |
|---|---|---|
| Integration listeners | 72 `conversation_message` + 36 `session_lifecycle` listeners, 36 `testAuth()` HTTP calls, ~144 in-memory objects | 6 `conversation_message` + 3 `session_lifecycle` listeners, 3 `testAuth()` calls, ~12 objects |
| Conversation preload | 36 JSONL files parsed synchronously at boot (potentially 250MB+) | 0 files parsed at boot; lazy-load on demand |
| Session manifest rebuild | ~180 serial file ops (`readSessionMeta` + `stat` × 2 + `writeSessionMeta` per session) | Same work, parallelized in batches of ~10 |

---

## Scope

### In scope
1. **Fix 1 — Integration listener deduplication**: `IntegrationRegistryService.discoverKnownManagerIds()` collects unique `profileId`s instead of every session `agentId`.
2. **Fix 2 — Remove boot-time conversation preload**: `ConversationProjector.loadConversationHistoriesFromStore()` no longer eagerly parses every session JSONL at boot.
3. **Fix 3 — Parallelize session manifest rebuild**: `rebuildSessionMeta()` processes sessions concurrently in bounded batches.

### Out of scope
- Integration routing logic changes (delivery bridges already filter by `profileId`)
- Config loading/saving paths (already profile-scoped)
- Scheduler deduplication (already correctly implemented in `collectManagerIds()`)
- Lazy-loading changes to `SessionManager.open()` / pi runtime internals
- Any protocol or UI changes

---

## Fix 1 — Integration Listener Deduplication (CRITICAL)

### Problem

`discoverKnownManagerIds()` at `registry.ts:652–660` iterates all agents and adds every descriptor with `role === "manager"` to the discovery set:

```typescript
for (const descriptor of this.swarmManager.listAgents()) {
  if (descriptor.role !== "manager") {
    continue;
  }
  managerIds.add(descriptor.agentId);
}
```

With sessions-as-agents, every session descriptor has `role: "manager"`. This produces ~36 IDs for 3 actual profiles. `start()` then calls `startProfileInternal()` for each ID × 2 providers = 72 integration service instances.

Each Telegram instance:
- Calls `this.deliveryBridge.start()` → `swarmManager.on("conversation_message", ...)` (line `telegram-delivery.ts:47`)
- Calls `telegramClient.testAuth()` → HTTP roundtrip to Telegram API (line `telegram-integration.ts:228`)
- Calls `this.topicManager.initialize()` → `loadTopicStore()` → reads from `getProfileIntegrationsDir(dataDir, managerId)` where `managerId` is the session ID, not the profile ID → ENOENT for 33/36 (line `telegram-integration.ts:199`, `telegram-topic-store.ts:24`)
- Calls `swarmManager.on("session_lifecycle", ...)` on successful connect (line `telegram-integration.ts:277`)

Each Slack instance:
- Calls `this.deliveryBridge.start()` → `swarmManager.on("conversation_message", ...)` (line `slack-delivery.ts:43`)
- Performs similar config load / ENOENT pattern

The config fallback chain makes this worse: `loadTelegramConfig()` at `telegram-config.ts:93–112` falls through to the shared config when no per-manager override exists. Since session-IDs don't have override configs, they all inherit the shared config (including `enabled: true` + valid `botToken`), causing every session instance to attempt a real Telegram connection.

**Total listeners registered on `swarmManager`:**
- 36 Telegram `conversation_message` listeners
- 36 Slack `conversation_message` listeners  
- Up to 36 Telegram `session_lifecycle` listeners (for those that successfully connect)
- → 108 total, well past the default `MaxListenersExceededWarning` threshold

### Existing Pattern to Follow

The scheduler in `index.ts:131–156` already does this correctly:

```typescript
function collectManagerIds(agents: unknown[], fallbackManagerId?: string): Set<string> {
  const profileIds = new Set<string>();
  for (const agent of agents) {
    // ...
    const id = (typeof descriptor.profileId === "string" && descriptor.profileId.trim().length > 0)
      ? descriptor.profileId.trim()
      : descriptor.agentId.trim();
    profileIds.add(id);
  }
  return profileIds;
}
```

### Implementation

#### File: `apps/backend/src/integrations/registry.ts`

**Change 1: `discoverKnownManagerIds()` → collect unique profileIds**

Replace the loop body in `discoverKnownManagerIds()` (lines 652–660):

```typescript
// BEFORE
for (const descriptor of this.swarmManager.listAgents()) {
  if (descriptor.role !== "manager") {
    continue;
  }
  managerIds.add(descriptor.agentId);
}

// AFTER
for (const descriptor of this.swarmManager.listAgents()) {
  if (descriptor.role !== "manager") {
    continue;
  }
  // Use profileId when available; fall back to agentId for legacy agents.
  const profileId =
    typeof descriptor.profileId === "string" && descriptor.profileId.trim().length > 0
      ? descriptor.profileId.trim()
      : descriptor.agentId;
  managerIds.add(profileId);
}
```

This is the only change required. The rest of the integration stack already works correctly:

- `loadTelegramConfig` / `loadSlackConfig` resolve config by managerId → profile path. With a profileId, this hits the correct profile-level override or shared fallback.
- `TelegramDeliveryBridge.forwardConversationMessage()` already filters by `agentProfileId !== this.managerId` (line `telegram-delivery.ts:77`) — it resolves `descriptor.profileId ?? descriptor.agentId` for the event's agent and compares to `this.managerId`. With `managerId` set to the profileId, this correctly matches all sessions under that profile.
- `SlackDeliveryBridge.forwardConversationMessage()` has the same filter at `slack-delivery.ts:69`.
- `TelegramTopicManager` / `getTopicStorePath()` uses `managerId` to build the path. With profileId, this reads from the correct profile integrations dir instead of a nonexistent session-level dir.
- `onSessionLifecycle` handler filters by `event.profileId !== this.managerId` (line `telegram-integration.ts:55`). With managerId = profileId, this correctly matches.

**Change 2: `ensureSlackProfileStarted` / `ensureTelegramProfileStarted` (defensive)**

These methods are called by API handlers (e.g., `getSlackSnapshot(managerId)`) where `managerId` could come from a session agentId via the WS API. Add a profileId resolution step:

Currently at lines 578–593:

```typescript
private async ensureSlackProfileStarted(managerId: string): Promise<SlackIntegrationService> {
  const normalizedManagerId = normalizeManagerId(managerId);
  // ...
  await this.startProfile(normalizedManagerId, "slack");
  return this.getOrCreateSlackProfile(normalizedManagerId);
}
```

Add a helper that resolves a raw managerId to its profileId using the swarm manager's descriptor:

```typescript
private resolveProfileId(managerId: string): string {
  const normalized = normalizeManagerId(managerId);
  const descriptor = this.swarmManager.getAgent(normalized);
  if (descriptor?.role === "manager") {
    const profileId =
      typeof descriptor.profileId === "string" && descriptor.profileId.trim().length > 0
        ? descriptor.profileId.trim()
        : descriptor.agentId;
    return normalizeManagerId(profileId);
  }
  return normalized;
}
```

Use this in `ensureSlackProfileStarted`, `ensureTelegramProfileStarted`, `getStatus`, `getIntegrationContext`, and any other public method that accepts a `managerId` parameter and looks up a profile by it. This ensures that if the WS server passes a session agentId, the integration registry maps it to the correct (already-running) profile instance.

### Risk Assessment

**Low risk.** The change narrows the discovery set from session-agentIds to profileIds. All downstream code already filters by profileId for routing. The only behavioral change is fewer instances — which is the fix.

**Edge case: legacy agents without `profileId` field.** The fallback to `descriptor.agentId` matches existing behavior for pre-migration agents. No regression.

**Edge case: API calls with session agentId as managerId.** The `resolveProfileId` helper handles this. Without it, `getIntegrationContext(sessionAgentId)` would miss the profile and return empty context. With it, it correctly maps to the profile instance.

---

## Fix 2 — Remove Boot-time Conversation History Preload (HIGH)

### Problem

`ConversationProjector.loadConversationHistoriesFromStore()` at `conversation-projector.ts:115–124` iterates all descriptors and loads/parses the full JSONL file for each idle or streaming session:

```typescript
loadConversationHistoriesFromStore(): void {
  this.deps.conversationEntriesByAgentId.clear();
  this.lastSessionEntryIdBySessionFile.clear();

  for (const descriptor of this.deps.descriptors.values()) {
    if (!this.shouldPreloadHistoryForDescriptor(descriptor)) {
      continue;
    }
    this.loadConversationHistoryForDescriptor(descriptor);
  }
}
```

`shouldPreloadHistoryForDescriptor` (line 335) returns `true` for `idle` or `streaming` status — which covers nearly all sessions at boot. Each call opens the JSONL file via `SessionManager.open()`, parses all entries, filters for conversation entries, and stores them in memory. For large sessions (1–50MB), this is expensive both in CPU (JSON parsing) and memory.

The lazy-load path **already exists** in `getConversationHistory()` (line 52):

```typescript
getConversationHistory(agentId: string): ConversationEntryEvent[] {
  let history = this.deps.conversationEntriesByAgentId.get(agentId);
  if (!history) {
    const descriptor = this.deps.descriptors.get(agentId);
    if (descriptor) {
      history = this.loadConversationHistoryForDescriptor(descriptor);
    }
  }
  return (history ?? []).map((entry) => ({ ...entry }));
}
```

When a client subscribes to a session or requests its history, `getConversationHistory()` is called and the load happens on demand. The boot-time bulk preload is redundant.

### Implementation

#### File: `apps/backend/src/swarm/conversation-projector.ts`

**Change: Make `loadConversationHistoriesFromStore()` a no-op for preloading, only clear stale state.**

```typescript
// BEFORE
loadConversationHistoriesFromStore(): void {
  this.deps.conversationEntriesByAgentId.clear();
  this.lastSessionEntryIdBySessionFile.clear();

  for (const descriptor of this.deps.descriptors.values()) {
    if (!this.shouldPreloadHistoryForDescriptor(descriptor)) {
      continue;
    }
    this.loadConversationHistoryForDescriptor(descriptor);
  }
}

// AFTER
loadConversationHistoriesFromStore(): void {
  // Clear stale in-memory state from any previous boot cycle.
  // Conversation histories are loaded on demand via getConversationHistory().
  this.deps.conversationEntriesByAgentId.clear();
  this.lastSessionEntryIdBySessionFile.clear();
}
```

That's it. The method name is a bit misleading now, but renaming it would require changing the call site in `SwarmManager.loadConversationHistoriesFromStore()` (line 3686) and potentially the `SwarmManager.boot()` call at line 582. A comment is sufficient; renaming is optional polish.

**Optional cleanup: Remove `shouldPreloadHistoryForDescriptor`**

This private method (line 335) is only used by the preload loop. If the preload is removed, this method is dead code. Can be removed or left with a comment for documentation.

#### File: `apps/backend/src/swarm/swarm-manager.ts`

No changes required. The call at line 582 still runs (now just clears maps). The `restoreRuntimesForBoot()` call at line 583 follows and does not depend on preloaded conversation histories.

### Interaction with Runtime Restore

`restoreRuntimesForBoot()` (line 2513) creates runtimes for streaming sessions. These runtimes may emit events that the `ConversationProjector` captures via `captureConversationEventFromRuntime()`. This path appends to the in-memory entries for that agent — it does **not** require prior history to be loaded. The on-demand `getConversationHistory()` path handles the full load when a client subscribes.

**One subtlety:** If a streaming runtime emits events before any client subscribes, those events get appended to an empty (or nonexistent) entry list. When the client later calls `getConversationHistory()`, the lazy load reads from the JSONL file. But `emitConversationEntry()` (the internal method that appends events) also persists entries to the session file. So the lazy load will pick them up.

Wait — let me verify this. Let me trace `emitConversationEntry`:

```
emitConversationEntry → getOrCreateEntriesForAgent → appends to in-memory list
                      → persistConversationEntryToSessionFile → appends to JSONL
```

And `getConversationHistory` → on cache miss → `loadConversationHistoryForDescriptor` → reads full JSONL from disk.

The risk here is: if events are captured *before* the lazy load, they go into an in-memory list. Then when `getConversationHistory()` is called, it checks `this.deps.conversationEntriesByAgentId.get(agentId)` — if that key exists (because runtime events were already captured), it returns that partial list and skips the disk load. This would miss historical entries.

This is a real issue. The fix is to ensure the lazy-load path in `getConversationHistory` always loads from disk if the history hasn't been explicitly loaded yet.

**Revised approach: Use a separate "loaded" sentinel.**

```typescript
private readonly loadedFromDisk = new Set<string>();

getConversationHistory(agentId: string): ConversationEntryEvent[] {
  if (!this.loadedFromDisk.has(agentId)) {
    const descriptor = this.deps.descriptors.get(agentId);
    if (descriptor) {
      this.loadConversationHistoryForDescriptor(descriptor);
    }
  }

  const history = this.deps.conversationEntriesByAgentId.get(agentId) ?? [];
  return history.map((entry) => ({ ...entry }));
}
```

And in `loadConversationHistoryForDescriptor`, add the agent to `loadedFromDisk`:

```typescript
private loadConversationHistoryForDescriptor(descriptor: AgentDescriptor): ConversationEntryEvent[] {
  // ... existing load logic ...
  this.loadedFromDisk.add(descriptor.agentId);
  this.deps.conversationEntriesByAgentId.set(descriptor.agentId, entriesForAgent);
  return entriesForAgent;
}
```

Clear `loadedFromDisk` in the boot reset:

```typescript
loadConversationHistoriesFromStore(): void {
  this.deps.conversationEntriesByAgentId.clear();
  this.lastSessionEntryIdBySessionFile.clear();
  this.loadedFromDisk.clear();
}
```

And in `resetConversationHistory`:

```typescript
resetConversationHistory(agentId: string): void {
  this.deps.conversationEntriesByAgentId.set(agentId, []);
  this.loadedFromDisk.add(agentId); // Mark as loaded (intentionally empty)
}
```

And in `deleteConversationHistory`:

```typescript
deleteConversationHistory(agentId: string): void {
  this.deps.conversationEntriesByAgentId.delete(agentId);
  this.loadedFromDisk.delete(agentId);
  // ...existing sessionFile tracking cleanup...
}
```

### Risk Assessment

**Medium risk** due to the cache-miss subtlety described above. The sentinel approach handles it cleanly.

**Edge case: Concurrent runtime event capture + client subscribe.** Since `loadConversationHistoryForDescriptor` is synchronous (uses `openSync`/`readSync` internally via `SessionManager.open()`), there's no race condition — JS single-threaded event loop ensures the load completes atomically before any event processing resumes.

**Edge case: Large session files.** The lazy load still opens the full file. This is acceptable — it happens once per session on first access rather than all-at-once on boot. If a session is never accessed (common for old idle sessions), the load never happens.

---

## Fix 3 — Parallelize Session Manifest Rebuild (HIGH)

### Problem

`rebuildSessionMeta()` at `session-manifest.ts:80–148` processes every manager descriptor sequentially:

```typescript
for (const sessionDescriptor of managerDescriptors) {
  const existingMeta = await readSessionMeta(...);       // read meta.json
  const sessionFileSize = await readFileSize(...);        // stat session JSONL
  const memoryFileSize = await readFileSize(...);         // stat memory file
  await writeSessionMeta(options.dataDir, meta);          // write meta.json (write tmp + rename)
  metas.push(meta);
}
```

Each iteration does 4–5 async file operations sequentially. With 36 sessions, that's ~144–180 serial file ops. Node's `fs/promises` stat/read/write are async but each `await` yields back to the event loop, introducing per-op scheduling overhead.

### Implementation

#### File: `apps/backend/src/swarm/session-manifest.ts`

**Change: Process sessions in parallel batches.**

Replace the sequential `for` loop (lines 98–145) with a batched `Promise.all`:

```typescript
// BEFORE
const metas: SessionMeta[] = [];
for (const sessionDescriptor of managerDescriptors) {
  // ... ~20 lines of sequential async work ...
  await writeSessionMeta(options.dataDir, meta);
  metas.push(meta);
}
return metas;

// AFTER
const BATCH_SIZE = 10;
const metas: SessionMeta[] = [];

for (let i = 0; i < managerDescriptors.length; i += BATCH_SIZE) {
  const batch = managerDescriptors.slice(i, i + BATCH_SIZE);
  const batchResults = await Promise.all(
    batch.map(async (sessionDescriptor) => {
      const profileId = normalizeProfileId(sessionDescriptor);
      const workers = (workerDescriptorsByManager.get(sessionDescriptor.agentId) ?? []).map(
        (worker) => buildWorkerMeta(worker)
      );

      const existingMeta = await readSessionMeta(options.dataDir, profileId, sessionDescriptor.agentId);

      const sessionFilePath =
        normalizeOptionalString(sessionDescriptor.sessionFile) ??
        getSessionFilePath(options.dataDir, profileId, sessionDescriptor.agentId);

      const memoryFilePath = resolveMemoryFilePath(options.dataDir, {
        agentId: sessionDescriptor.agentId,
        role: "manager",
        profileId,
        managerId: sessionDescriptor.managerId
      });

      const [sessionFileSize, memoryFileSize] = await Promise.all([
        readFileSize(sessionFilePath),
        readFileSize(memoryFilePath)
      ]);

      const meta: SessionMeta = {
        sessionId: sessionDescriptor.agentId,
        profileId,
        label: normalizeOptionalString(sessionDescriptor.sessionLabel) ?? null,
        model: {
          provider: normalizeOptionalString(sessionDescriptor.model.provider) ?? null,
          modelId: normalizeOptionalString(sessionDescriptor.model.modelId) ?? null
        },
        createdAt: sessionDescriptor.createdAt,
        updatedAt: sessionDescriptor.updatedAt ?? now(),
        cwd: normalizeOptionalString(sessionDescriptor.cwd) ?? null,
        promptFingerprint: existingMeta?.promptFingerprint ?? null,
        promptComponents: existingMeta?.promptComponents ?? null,
        cortexReviewedAt: existingMeta?.cortexReviewedAt,
        cortexReviewedBytes: existingMeta?.cortexReviewedBytes,
        feedbackFileSize: existingMeta?.feedbackFileSize,
        lastFeedbackAt: existingMeta?.lastFeedbackAt,
        cortexReviewedFeedbackBytes: existingMeta?.cortexReviewedFeedbackBytes,
        cortexReviewedFeedbackAt: existingMeta?.cortexReviewedFeedbackAt,
        workers,
        stats: buildWorkerStats(workers, {
          sessionFileSize,
          memoryFileSize
        })
      };

      await writeSessionMeta(options.dataDir, meta);
      return meta;
    })
  );
  metas.push(...batchResults);
}

return metas;
```

**Why batched instead of unbounded `Promise.all`:** Writing 100 meta files simultaneously could hit file descriptor limits or cause disk I/O contention. A batch size of 10 keeps ~40–50 concurrent file ops (10 sessions × 4–5 ops each), which is well within typical OS limits while still providing ~10× throughput improvement.

**Inner parallelization:** Within each session, the `readFileSize(sessionFilePath)` and `readFileSize(memoryFilePath)` calls are independent, so they're wrapped in `Promise.all` too. This is a small optimization (saves one scheduling round-trip per session) but free.

### Alternative Considered: Incremental Rebuild

Skip sessions where `meta.json` mtime is newer than `agents.json` mtime. This would avoid re-processing unchanged sessions entirely.

**Why not chosen for v1:** The `writeSessionMeta` call uses atomic write (tmp + rename), which always updates mtime. So after the first boot, all metas would have fresh mtimes, and the incremental check would skip everything — even if the JSONL file grew or memory file changed. A correct incremental check would need to compare `meta.json` mtime against `max(sessionFile.mtime, memoryFile.mtime, agentsStore.mtime)`, which still requires 3 `stat()` calls per session. The savings are marginal compared to parallelization.

**Future enhancement:** Track a content hash in meta (e.g., `sessionFileSize + memoryFileSize + descriptorUpdatedAt`) and skip write if unchanged. This eliminates the write and most of the computation, but adds complexity. Worth doing if session counts grow to 500+.

### Risk Assessment

**Low risk.** The parallelized code does identical work to the sequential version, just overlapping I/O. Each session's meta is independent (different file paths). The atomic write pattern (`writeFile(tmp) + rename(tmp, target)`) is safe for concurrent writes to different target files.

**Edge case: Shared `now()` timestamps.** Multiple concurrent sessions calling `now()` within the same batch get slightly different timestamps. This matches existing behavior — the sequential loop also produces different timestamps per iteration.

---

## Testing Strategy

### Fix 1 — Integration Deduplication

1. **Unit test for `discoverKnownManagerIds` output.** Mock `swarmManager.listAgents()` returning 10 sessions across 2 profiles. Assert the discovered set has exactly 2 entries (the profile IDs), not 10.

2. **Listener count validation.** After `integrationRegistry.start()`, count listeners on `swarmManager` for `conversation_message` and `session_lifecycle`. Assert counts match `2 × number_of_profiles` (1 Telegram + 1 Slack per profile) and `number_of_profiles` (Telegram only), not `2 × number_of_sessions`.

3. **Integration context lookup by session agentId.** Call `getIntegrationContext(sessionAgentId)` where `sessionAgentId` is a session under a profile. Assert it returns the profile's integration context (not empty).

4. **Boot log inspection.** Start the backend and verify:
   - No `MaxListenersExceededWarning` in stderr
   - Number of `testAuth()` calls matches number of profiles with enabled Telegram
   - No ENOENT errors for topic store reads

### Fix 2 — Lazy Conversation Preload

1. **Boot timing.** Measure `swarmManager.boot()` wall time before and after. With 10+ sessions having non-trivial JSONL files, expect measurable improvement.

2. **First-access correctness.** After boot, call `getConversationHistory(agentId)` for a session with known history. Assert the returned entries match the JSONL contents.

3. **Runtime-then-access correctness.** Resume a streaming session that emits events. Before any client subscribes, let events accumulate. Then call `getConversationHistory()`. Assert the result includes both historical entries from disk AND the newly captured events. (This validates the `loadedFromDisk` sentinel logic.)

4. **Reset/delete correctness.** Call `resetConversationHistory(agentId)`, then `getConversationHistory(agentId)`. Assert empty result (should NOT re-load from disk). Call `deleteConversationHistory(agentId)`, then `getConversationHistory(agentId)`. Assert it re-loads from disk.

### Fix 3 — Parallel Session Manifest

1. **Output equivalence.** Run `rebuildSessionMeta` with the same inputs before and after. Assert the returned `SessionMeta[]` arrays are equivalent (same sessionIds, same stats, same workers). Timestamps will differ slightly but structure should match.

2. **File integrity.** After parallel rebuild, read each `meta.json` from disk. Assert valid JSON, correct `sessionId`/`profileId`, and non-null `stats.sessionFileSize` where the session file exists.

3. **Performance.** With 30+ sessions, measure wall time. Expect ~3–5× improvement over sequential (limited by disk I/O, not CPU).

### Integration / Smoke Tests

After all three fixes:

1. `pnpm build` — clean compile
2. `pnpm exec tsc --noEmit` — no type errors
3. `pnpm test` — existing tests pass
4. Manual boot test with production data dir:
   - Backend starts without warnings
   - WS clients can subscribe to sessions and see conversation history
   - Telegram integration connects once per profile (check bot polling activity)
   - Session metadata in UI shows correct file sizes and worker counts

---

## Implementation Ordering

```
Fix 1 (Integration dedup)  ←── CRITICAL, standalone, no dependencies
Fix 2 (Lazy preload)       ←── HIGH, standalone, no dependencies
Fix 3 (Parallel manifest)  ←── HIGH, standalone, no dependencies
```

All three fixes are independent — they touch different files and different subsystems. They can be implemented in parallel by separate workers or sequentially in any order.

**Recommended order if sequential:** Fix 1 → Fix 2 → Fix 3

- Fix 1 has the highest impact (eliminates listener warnings, reduces HTTP calls, fixes ENOENT noise) and lowest risk.
- Fix 2 has medium risk (needs the sentinel pattern done correctly) but high payoff for large-session deployments.
- Fix 3 is the simplest change and lowest risk, but also the lowest marginal impact.

### Files Modified Summary

| Fix | Files | Nature of change |
|---|---|---|
| 1 | `apps/backend/src/integrations/registry.ts` | `discoverKnownManagerIds()` loop + `resolveProfileId()` helper + usage in public methods |
| 2 | `apps/backend/src/swarm/conversation-projector.ts` | `loadConversationHistoriesFromStore()` body + `loadedFromDisk` set + `getConversationHistory()` guard |
| 3 | `apps/backend/src/swarm/session-manifest.ts` | `rebuildSessionMeta()` loop → batched `Promise.all` |
