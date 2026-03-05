# Startup Performance Optimization Plan

> **Revision 2** — incorporates review feedback (2 blockers + 7 concerns resolved)

## Overview

The middleman backend boot process has three scaling bottlenecks that degrade proportionally as sessions and profiles grow. All three stem from the sessions-as-agents architecture: every session has `role: "manager"`, so subsystems that enumerate managers without deduplicating by `profileId` create O(sessions) work instead of O(profiles).

With the current state (~36 sessions across 3 profiles), boot already triggers `MaxListenersExceededWarning` and performs hundreds of unnecessary file operations. At 100+ sessions this becomes a material startup latency and memory problem.

**Impact summary (current ~36 sessions / 3 profiles):**

| Bottleneck | Current cost | Cost with fix |
|---|---|---|
| Integration listeners | 72 `conversation_message` + 36 `session_lifecycle` listeners, 36 `testAuth()` HTTP calls, ~144 in-memory objects | 6 `conversation_message` + 3 `session_lifecycle` listeners, 3 `testAuth()` calls, ~12 objects |
| Conversation preload | 36 JSONL files parsed synchronously at boot (potentially 250MB+) | 0 files parsed at boot; lazy-load on demand; lightweight leaf-ID hydration (~1 line read per session) |
| Session manifest rebuild | ~180 serial file ops (`readSessionMeta` + `stat` × 2 + `writeSessionMeta` per session) | Same work, parallelized in batches of ~10, with per-session error isolation |

---

## Scope

### In scope
1. **Fix 1 — Integration profile deduplication**: `IntegrationRegistryService.discoverKnownManagerIds()` collects unique `profileId`s instead of every session `agentId`. Includes WS handler status broadcast fix and frontend normalization.
2. **Fix 2 — Remove boot-time conversation preload**: `ConversationProjector.loadConversationHistoriesFromStore()` no longer eagerly parses every session JSONL at boot. Leaf-ID hydration preserves `parentId` chain continuity.
3. **Fix 3 — Parallelize session manifest rebuild**: `rebuildSessionMeta()` processes sessions concurrently in bounded batches with per-session error isolation.

### Out of scope
- Integration routing logic changes (delivery bridges already filter by `profileId`)
- Config loading/saving paths (already profile-scoped)
- Scheduler deduplication (already correctly implemented in `collectManagerIds()`)
- Lazy-loading changes to `SessionManager.open()` / pi runtime internals
- Any protocol changes

---

## Fix 1 — Integration Profile Deduplication (CRITICAL)

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
- Calls `this.deliveryBridge.start()` → `swarmManager.on("conversation_message", ...)` (`telegram-delivery.ts:47`)
- Calls `telegramClient.testAuth()` → HTTP roundtrip to Telegram API (`telegram-integration.ts:228`)
- Calls `this.topicManager.initialize()` → `loadTopicStore()` → reads from `getProfileIntegrationsDir(dataDir, managerId)` where `managerId` is the session ID, not the profile ID → **ENOENT for 33/36** (`telegram-integration.ts:199`, `telegram-topic-store.ts:24`)
- Calls `swarmManager.on("session_lifecycle", ...)` on successful connect (`telegram-integration.ts:277`)

Each Slack instance:
- Calls `this.deliveryBridge.start()` → `swarmManager.on("conversation_message", ...)` (`slack-delivery.ts:43`)
- Performs similar config load / ENOENT pattern

The config fallback chain makes this worse: `loadTelegramConfig()` at `telegram-config.ts:93–112` falls through to the shared config when no per-manager override exists. Since session-IDs don't have override configs, they all inherit the shared config (including `enabled: true` + valid `botToken`), causing every session instance to attempt a real Telegram connection.

**Total listeners registered on `swarmManager`:**
- 36 Telegram `conversation_message` listeners
- 36 Slack `conversation_message` listeners
- Up to 36 Telegram `session_lifecycle` listeners (for those that successfully connect)
- → 108 total, well past `SWARM_MANAGER_MAX_EVENT_LISTENERS = 64`

**Topic store path is a correctness bug, not just perf:** When a session agentId like `middleman-project--s4` is used as the managerId, `getTopicStorePath()` builds path `profiles/middleman-project--s4/integrations/telegram-topics.json` instead of the correct `profiles/middleman-project/integrations/telegram-topics.json`. This means topic mappings written by non-root session instances go to wrong paths and are silently lost.

### Existing Pattern to Follow

The scheduler in `index.ts:131–156` already does this correctly:

```typescript
function collectManagerIds(agents: unknown[], fallbackManagerId?: string): Set<string> {
  const profileIds = new Set<string>();
  for (const agent of agents) {
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

**Change 1: Add `resolveProfileId()` helper**

Add a private helper that maps any managerId (which may be a session agentId) to its canonical profileId:

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

**Change 2: `discoverKnownManagerIds()` — collect unique profileIds**

Replace the loop body (lines 652–660):

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
  const profileId =
    typeof descriptor.profileId === "string" && descriptor.profileId.trim().length > 0
      ? descriptor.profileId.trim()
      : descriptor.agentId;
  managerIds.add(profileId);
}
```

**Change 3: Resolve `defaultManagerId` to profileId**

At the top of `discoverKnownManagerIds()`, `this.defaultManagerId` is added directly. If the configured managerId happens to be a session agentId, it would be added raw alongside the profileId from the descriptor loop, creating a duplicate instance.

```typescript
// BEFORE
if (this.defaultManagerId) {
  managerIds.add(this.defaultManagerId);
}

// AFTER
if (this.defaultManagerId) {
  managerIds.add(this.resolveProfileId(this.defaultManagerId));
}
```

**Change 4: Apply `resolveProfileId()` to ALL public registry methods**

Every public method that accepts a `managerId` parameter must resolve it to a profileId before looking up or creating profile instances. The exhaustive list:

| Method | Line(s) | Change |
|---|---|---|
| `startProfile()` | ~125 | `normalizedManagerId = this.resolveProfileId(managerId)` |
| `stopProfile()` | ~137 | same |
| `getStatus()` (both overloads) | ~155 | same |
| `getIntegrationContext()` | ~185 | same |
| `getSlackSnapshot()` | ~218 | same |
| `updateSlackConfig()` | ~230 | same |
| `disableSlack()` | ~242 | same |
| `testSlackConnection()` | ~252 | same |
| `listSlackChannels()` | ~262 | same |
| `getTelegramSnapshot()` | ~275 | same |
| `updateTelegramConfig()` | ~287 | same |
| `disableTelegram()` | ~299 | same |
| `testTelegramConnection()` | ~309 | same |
| `ensureSlackProfileStarted()` | ~578 | already calls `startProfile` which is covered, but normalize `managerId` parameter too |
| `ensureTelegramProfileStarted()` | ~588 | same |

The pattern in each method changes from:
```typescript
const normalizedManagerId = normalizeManagerId(managerId);
```
to:
```typescript
const normalizedManagerId = this.resolveProfileId(managerId);
```

This is a one-token change per method. `resolveProfileId` internally calls `normalizeManagerId`, so the normalization behavior is preserved.

#### File: `apps/backend/src/ws/ws-handler.ts`

**Change 5: Fix status event broadcast filter**

The status broadcast filter at lines 82–86 currently does:

```typescript
if (event.type === "slack_status" || event.type === "telegram_status") {
  if (event.managerId) {
    const subscribedManagerId = this.resolveManagerContextAgentId(subscribedAgent);
    if (subscribedManagerId !== event.managerId) {
      continue;
    }
  }
}
```

`resolveManagerContextAgentId()` at line 256–265 returns `descriptor.agentId` for managers — the session agentId, not the profileId. After Fix 1, status events carry `managerId = profileId`. So `subscribedManagerId` (session agentId) ≠ `event.managerId` (profileId) for non-root sessions → status events get silently filtered out.

**Fix:** Resolve the subscribed agent's profileId for comparison:

```typescript
// Add a helper that resolves to profileId
private resolveProfileIdForAgent(agentId: string): string | undefined {
  const descriptor = this.swarmManager.getAgent(agentId);
  if (!descriptor) {
    // Fallback for pre-boot state
    return this.resolveConfiguredManagerId() ?? agentId;
  }
  if (descriptor.role === "manager") {
    return (typeof descriptor.profileId === "string" && descriptor.profileId.trim().length > 0)
      ? descriptor.profileId.trim()
      : descriptor.agentId;
  }
  // Worker: look up the manager's profileId
  const managerDescriptor = this.swarmManager.getAgent(descriptor.managerId);
  if (managerDescriptor) {
    return (typeof managerDescriptor.profileId === "string" && managerDescriptor.profileId.trim().length > 0)
      ? managerDescriptor.profileId.trim()
      : managerDescriptor.agentId;
  }
  return descriptor.managerId;
}
```

Then update the broadcast filter:

```typescript
if (event.type === "slack_status" || event.type === "telegram_status") {
  if (event.managerId) {
    const subscribedProfileId = this.resolveProfileIdForAgent(subscribedAgent);
    if (subscribedProfileId !== event.managerId) {
      continue;
    }
  }
}
```

Also update the bootstrap path at lines 305–308 where `getStatus()` is called with `managerContextId`:

```typescript
// BEFORE
const managerContextId = this.resolveManagerContextAgentId(targetAgentId);
if (this.integrationRegistry && managerContextId) {
  this.send(socket, this.integrationRegistry.getStatus(managerContextId, "slack"));
  this.send(socket, this.integrationRegistry.getStatus(managerContextId, "telegram"));
}

// AFTER — no change needed here because getStatus() now resolves to profileId internally
// (via Fix 1 Change 4). Just verify managerContextId is still passed correctly.
```

The bootstrap `getStatus()` call passes `managerContextId` (which is the session agentId from `resolveManagerContextAgentId`). After Fix 1, `getStatus()` calls `this.resolveProfileId(managerId)` internally, so it will correctly map to the profile instance. No change needed here.

#### File: `apps/ui/src/components/settings/SettingsIntegrations.tsx`

**Change 6: Normalize status managerId comparison to profileId**

Lines 287–293 compare live WS status events against `selectedIntegrationManagerId`:

```typescript
const effectiveSlackStatus =
  slackStatus && (!slackStatus.managerId || slackStatus.managerId === selectedIntegrationManagerId)
    ? slackStatus
    : slackStatusFromApi
const effectiveTelegramStatus =
  telegramStatus && (!telegramStatus.managerId || telegramStatus.managerId === selectedIntegrationManagerId)
    ? telegramStatus
    : telegramStatusFromApi
```

After Fix 1, status events carry `managerId = profileId`. The `selectedIntegrationManagerId` comes from the dropdown which currently lists session agentIds. Two changes needed:

**6a: Manager dropdown should list profiles, not sessions.**

The `managerOptions` memo (line 242) currently returns all `role === "manager"` descriptors. It should deduplicate by `profileId` and use `profileId` as the option value:

```typescript
// BEFORE
const managerOptions = useMemo(
  () =>
    managers.filter(
      (agent) => agent.role === 'manager' && (agent.status === 'idle' || agent.status === 'streaming'),
    ),
  [managers],
)

// AFTER
const managerOptions = useMemo(() => {
  const seen = new Set<string>()
  const result: AgentDescriptor[] = []
  for (const agent of managers) {
    if (agent.role !== 'manager') continue
    if (agent.status !== 'idle' && agent.status !== 'streaming') continue
    const profileId = agent.profileId?.trim() || agent.agentId
    if (seen.has(profileId)) continue
    seen.add(profileId)
    result.push(agent)
  }
  return result
}, [managers])
```

**6b: Use profileId as the SelectItem value:**

```typescript
// BEFORE (line 456)
<SelectItem key={m.agentId} value={m.agentId}>{m.agentId}</SelectItem>

// AFTER
<SelectItem key={m.profileId || m.agentId} value={m.profileId || m.agentId}>
  {m.profileId || m.agentId}
</SelectItem>
```

With these changes, `selectedIntegrationManagerId` is a profileId, matching the status event's `managerId`. The status comparison at lines 287–293 works without changes.

**6c: The API fetch calls** (e.g., `fetchSlackSettings(wsUrl, selectedIntegrationManagerId)`) now pass a profileId. The registry's `resolveProfileId()` handles this correctly (a profileId resolves to itself). No additional change needed.

#### File: `apps/backend/src/swarm/swarm-manager.ts`

**Change 7: Add comment near `SWARM_MANAGER_MAX_EVENT_LISTENERS`**

At line 317:

```typescript
// BEFORE
const SWARM_MANAGER_MAX_EVENT_LISTENERS = 64;

// AFTER
// Integration services add ~3 event listeners per profile (1 Telegram conversation_message,
// 1 Slack conversation_message, 1 Telegram session_lifecycle). Keep this limit above
// the expected listener count: base listeners + (3 × max_profiles).
const SWARM_MANAGER_MAX_EVENT_LISTENERS = 64;
```

### Correctness: Topic Store Path Fix

With `managerId` set to profileId, `getTopicStorePath(dataDir, managerId)` at `telegram-topic-store.ts:24` now resolves to `profiles/<profileId>/integrations/telegram-topics.json` instead of `profiles/<sessionAgentId>/integrations/telegram-topics.json`. This fixes a **data correctness bug** where topic mappings from non-root sessions were silently written to nonexistent session-scoped paths and lost on reload.

No migration is needed: the incorrect session-scoped paths only received writes from redundant integration instances that shouldn't have existed. Any topic data at those paths is a subset of the profile-level data (both instances received the same events).

### Risk Assessment

**Low-medium risk.** The core discovery change narrows the set from session-agentIds to profileIds. All downstream routing already filters by profileId. The WS handler and frontend changes are straightforward filter/normalization updates.

**Edge case: legacy agents without `profileId` field.** The fallback to `descriptor.agentId` matches existing behavior for pre-migration agents. No regression.

**Edge case: API calls with session agentId as managerId.** The `resolveProfileId` helper handles this across all public registry methods. Without it, `getIntegrationContext(sessionAgentId)` would miss the profile and return empty context.

**Edge case: WS clients subscribed during status event delivery.** The `resolveProfileIdForAgent` helper resolves at event-delivery time, so it always reflects the current descriptor state. No stale-cache risk.

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

### BLOCKER: parentId Chain Continuity

The preload loop has a critical side effect: it populates `lastSessionEntryIdBySessionFile` with the ID of the last entry in each session's JSONL. This map is used by `appendConversationEntryToSessionFile()` at line 293 to set `parentId` on new entries:

```typescript
const parentId = this.lastSessionEntryIdBySessionFile.get(descriptor.sessionFile) ?? null;
```

Without the preload, the first append after boot writes `parentId: null`, breaking the tree chain. This is a **realistic scenario**: user messages are emitted via `emitConversationMessage()` at `swarm-manager.ts:1991` before runtime creation (line ~2000+). At that point no runtime exists, so the fallback `appendConversationEntryToSessionFile` path is taken, and it needs the leaf ID.

The existing regression test at `conversation-projector.test.ts:96–124` validates this exact behavior: it calls `loadConversationHistoriesFromStore()`, then `emitConversationMessage()`, and asserts `parentId` chains to the last pre-restart entry.

### Implementation

#### File: `apps/backend/src/swarm/conversation-projector.ts`

**Change 1: Add `loadedFromDisk` sentinel set**

```typescript
// New private field alongside lastSessionEntryIdBySessionFile
private readonly loadedFromDisk = new Set<string>();
```

**Change 2: Replace bulk preload with lightweight leaf-ID hydration**

Replace the body of `loadConversationHistoriesFromStore()`:

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
  this.loadedFromDisk.clear();

  // Hydrate leaf entry IDs so parentId chains remain correct for
  // conversation entries appended before the first full lazy-load.
  // This reads only the last line of each session file — O(1) per session
  // regardless of file size, vs the previous full parse.
  for (const descriptor of this.deps.descriptors.values()) {
    if (descriptor.role !== "manager") {
      continue;
    }
    this.hydrateLeafEntryId(descriptor);
  }
}
```

**Change 3: Add `hydrateLeafEntryId()` — tail-scan method**

```typescript
private hydrateLeafEntryId(descriptor: AgentDescriptor): void {
  const sessionFile = descriptor.sessionFile;
  if (!sessionFile) {
    return;
  }

  try {
    const fileStat = statSync(sessionFile);
    if (fileStat.size === 0) {
      return;
    }

    // Read the last chunk of the file to find the final JSONL line.
    // Session entries are typically <4KB each, so 8KB captures the last line
    // with margin. This is O(1) regardless of file size.
    const TAIL_BYTES = 8192;
    const readStart = Math.max(0, fileStat.size - TAIL_BYTES);
    const readLength = Math.min(TAIL_BYTES, fileStat.size);

    const fd = openSync(sessionFile, "r");
    try {
      const buffer = Buffer.alloc(readLength);
      const bytesRead = readSync(fd, buffer, 0, readLength, readStart);
      if (bytesRead <= 0) {
        return;
      }

      const tail = buffer.toString("utf8", 0, bytesRead);
      const lines = tail.split("\n").filter((line) => line.trim().length > 0);
      // Walk backwards to find the last line with a valid entry ID
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const parsed = JSON.parse(lines[i]) as { id?: string };
          if (typeof parsed.id === "string" && parsed.id.trim().length > 0) {
            this.trackLastSessionEntryId(sessionFile, parsed.id);
            return;
          }
        } catch {
          // Partial line at read boundary or invalid JSON — skip
          continue;
        }
      }
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (!isEnoentError(error)) {
      this.deps.logDebug("history:hydrate_leaf:error", {
        agentId: descriptor.agentId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
}
```

This uses `openSync`/`readSync`/`closeSync` which are already imported at the top of the file (line 2). `statSync` is also already imported.

**Change 4: Guard `getConversationHistory()` with `loadedFromDisk` sentinel**

```typescript
// BEFORE
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

// AFTER
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

The sentinel is needed because runtime events captured before any client subscribes will create an entry in `conversationEntriesByAgentId` — and the old code's `if (!history)` check would see that non-empty list and skip the disk load, returning only the post-boot events without the historical transcript.

**Change 5: Update `loadConversationHistoryForDescriptor` to set sentinel**

Add `this.loadedFromDisk.add(descriptor.agentId);` after loading:

```typescript
private loadConversationHistoryForDescriptor(descriptor: AgentDescriptor): ConversationEntryEvent[] {
  const entriesForAgent: ConversationEntryEvent[] = [];
  let lastSessionEntryId: string | undefined;

  try {
    // ... existing load logic unchanged ...
  } catch (error) {
    // ... existing error handling ...
  }

  this.trackLastSessionEntryId(descriptor.sessionFile, lastSessionEntryId);
  this.loadedFromDisk.add(descriptor.agentId);  // ← NEW
  this.deps.conversationEntriesByAgentId.set(descriptor.agentId, entriesForAgent);
  return entriesForAgent;
}
```

**Change 6: Update lifecycle methods to manage sentinel**

```typescript
resetConversationHistory(agentId: string): void {
  this.deps.conversationEntriesByAgentId.set(agentId, []);
  this.loadedFromDisk.add(agentId);  // Mark as loaded (intentionally empty)
}

deleteConversationHistory(agentId: string): void {
  this.deps.conversationEntriesByAgentId.delete(agentId);
  this.loadedFromDisk.delete(agentId);  // Allow re-load on next access

  const descriptor = this.deps.descriptors.get(agentId);
  if (descriptor) {
    this.lastSessionEntryIdBySessionFile.delete(descriptor.sessionFile);
  }
}
```

**Change 7: Remove dead code**

Remove `shouldPreloadHistoryForDescriptor()` (line 335–337) entirely — it is now unreferenced dead code.

### Risk Assessment

**Medium risk** — the parentId chain integrity is critical for session tree correctness. The leaf-ID hydration approach mitigates this by reading only the last line of each file, preserving the exact same `lastSessionEntryIdBySessionFile` state that the full preload would have produced.

**Edge case: Empty session files.** The `statSync` check returns early for size 0. Matches existing behavior (empty files have no entries to chain to).

**Edge case: Session file with entries but no valid ID on last line.** The backward scan loop handles this — it walks backwards until it finds a valid ID. If none found, the session has no leaf to chain to, same as current behavior for corrupt files.

**Edge case: Concurrent runtime event capture + client subscribe.** Since `loadConversationHistoryForDescriptor` is synchronous (uses sync file reads via `SessionManager.open()`), the JS event loop ensures no interleaving. The `loadedFromDisk` sentinel makes the check idempotent.

**Edge case: Very large last line (>8KB).** Extremely unlikely for JSONL session entries. But if it happens, the tail scan would read a partial last line, fail to parse it, and fall back to the second-to-last line. The only impact is that the leaf ID is one entry behind — the next append's `parentId` points to the penultimate entry instead of the ultimate one. This is a minor tree imprecision, not a correctness failure. If paranoia is warranted, increase `TAIL_BYTES` to 16384.

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

**Change 1: Add module-level batch size constant**

```typescript
// At module level, near other constants
const SESSION_META_REBUILD_BATCH_SIZE = 10;
```

**Change 2: Replace sequential loop with batched `Promise.all`**

Replace the sequential `for` loop (lines 98–145):

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
const metas: SessionMeta[] = [];

for (let i = 0; i < managerDescriptors.length; i += SESSION_META_REBUILD_BATCH_SIZE) {
  const batch = managerDescriptors.slice(i, i + SESSION_META_REBUILD_BATCH_SIZE);
  const batchResults = await Promise.all(
    batch.map(async (sessionDescriptor): Promise<SessionMeta | null> => {
      try {
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
      } catch (error) {
        console.warn(
          `[swarm] Failed to rebuild session meta for ${sessionDescriptor.agentId}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        return null;
      }
    })
  );

  for (const result of batchResults) {
    if (result !== null) {
      metas.push(result);
    }
  }
}

return metas;
```

**Key design points:**

- **Batch size 10:** Keeps ~40–50 concurrent file ops (10 sessions × 4–5 ops each), well within typical OS fd limits while providing ~10× throughput improvement.
- **Per-session error isolation:** Each `batch.map` entry is wrapped in try/catch. A failure for one session (e.g., corrupt meta file, permission error) returns `null` and logs a warning. The rest of the batch and subsequent batches proceed normally.
- **Inner parallelization:** The two `readFileSize` calls within each session are independent and wrapped in `Promise.all`. This saves one scheduling round-trip per session.

### Risk Assessment

**Low risk.** The parallelized code does identical work to the sequential version, just overlapping I/O. Each session's meta is independent (different file paths). The atomic write pattern (`writeFile(tmp) + rename(tmp, target)`) is safe for concurrent writes to different target files.

**Edge case: Shared `now()` timestamps.** Multiple concurrent sessions calling `now()` within the same batch get slightly different timestamps. This matches existing behavior — the sequential loop also produces different timestamps per iteration.

**Edge case: One session failure.** Previously a single failure would throw and abort the entire rebuild. The new per-session try/catch is strictly more resilient — remaining sessions still get their meta rebuilt.

---

## Testing Strategy

### Fix 1 — Integration Profile Deduplication

1. **Unit test: `discoverKnownManagerIds` output.** Mock `swarmManager.listAgents()` returning 10 sessions across 2 profiles. Assert the discovered set has exactly 2 entries (the profile IDs), not 10.

2. **Listener count validation.** After `integrationRegistry.start()`, count listeners on `swarmManager` for `conversation_message` and `session_lifecycle`. Assert counts match `2 × number_of_profiles` (1 Telegram + 1 Slack per profile) and `number_of_profiles` (Telegram only), not `2 × number_of_sessions`.

3. **Integration context lookup by session agentId.** Call `getIntegrationContext(sessionAgentId)` where `sessionAgentId` is a session under a profile. Assert it returns the profile's integration context (not empty).

4. **WS status broadcast for non-root sessions.** Subscribe a WS client to a non-root session agentId (e.g., `middleman-project--s3`). Trigger a Telegram status change. Assert the status event is delivered to the subscriber (verifies `resolveProfileIdForAgent` works).

5. **WS status bootstrap for non-root sessions.** Subscribe a WS client to a non-root session. Assert the bootstrap response includes `telegram_status` and `slack_status` events with the correct profile-level data.

6. **Frontend settings integration dropdown.** Verify `managerOptions` deduplicates by profileId and the dropdown shows profile IDs, not session agentIds. Verify that selecting a profile and loading settings fetches the correct config.

7. **Boot log inspection.** Start the backend and verify:
   - No `MaxListenersExceededWarning` in stderr
   - Number of `testAuth()` calls matches number of profiles with enabled Telegram
   - No ENOENT errors for topic store reads

### Fix 2 — Lazy Conversation Preload + Leaf Hydration

1. **Leaf-ID hydration correctness.** Create a session file with known entries. Call `loadConversationHistoriesFromStore()`. Assert `lastSessionEntryIdBySessionFile` contains the correct leaf ID for each session without loading full conversation history into `conversationEntriesByAgentId`.

2. **parentId chain continuity (regression test).** The existing test at `conversation-projector.test.ts:96–124` must still pass. It calls `loadConversationHistoriesFromStore()`, then `emitConversationMessage()`, and asserts the appended entry has `parentId` pointing to the last pre-restart entry.

3. **First-access correctness.** After boot, call `getConversationHistory(agentId)` for a session with known history. Assert the returned entries match the JSONL contents.

4. **Runtime-then-access correctness.** Resume a streaming session that emits events. Before any client subscribes, let events accumulate. Then call `getConversationHistory()`. Assert the result includes both historical entries from disk AND the newly captured events. (Validates the `loadedFromDisk` sentinel.)

5. **Reset/delete correctness.** Call `resetConversationHistory(agentId)`, then `getConversationHistory(agentId)`. Assert empty result (should NOT re-load from disk — sentinel is set). Call `deleteConversationHistory(agentId)`, then `getConversationHistory(agentId)`. Assert it re-loads from disk (sentinel is cleared).

6. **Boot timing.** Measure `swarmManager.boot()` wall time before and after with 10+ sessions having non-trivial JSONL files. Expect measurable improvement.

### Fix 3 — Parallel Session Manifest

1. **Output equivalence.** Run `rebuildSessionMeta` with the same inputs before and after. Assert the returned `SessionMeta[]` arrays contain the same sessionIds, same stats, same workers.

2. **File integrity.** After parallel rebuild, read each `meta.json` from disk. Assert valid JSON, correct `sessionId`/`profileId`, and non-null `stats.sessionFileSize` where the session file exists.

3. **Error isolation.** Introduce a corrupt meta file for one session. Assert the rebuild completes for all other sessions (returns `null` for the corrupt one, logs a warning, does not throw).

4. **Performance.** With 30+ sessions, measure wall time. Expect ~3–5× improvement over sequential.

### Integration / Smoke Tests

After all three fixes:

1. `pnpm build` — clean compile
2. `pnpm exec tsc --noEmit` — no type errors
3. `pnpm test` — existing tests pass (especially `conversation-projector.test.ts`)
4. Manual boot test with production data dir:
   - Backend starts without warnings
   - WS clients can subscribe to sessions and see conversation history
   - Telegram integration connects once per profile (check bot polling activity)
   - Session metadata in UI shows correct file sizes and worker counts
   - Settings → Integrations dropdown shows profiles (not sessions), status updates live for non-root sessions

---

## Implementation Ordering

```
Fix 1 (Integration dedup + WS + UI)  ←── CRITICAL, standalone
Fix 2 (Lazy preload + leaf hydration) ←── HIGH, standalone
Fix 3 (Parallel manifest)             ←── HIGH, standalone
```

All three fixes are independent — they touch different files and different subsystems. They can be implemented in parallel by separate workers or sequentially in any order.

**Recommended order if sequential:** Fix 1 → Fix 2 → Fix 3

- Fix 1 has the highest impact (eliminates listener warnings, reduces HTTP calls, fixes topic store path correctness bug) and lowest risk.
- Fix 2 has medium risk (needs leaf hydration + sentinel done correctly) but high payoff for large-session deployments.
- Fix 3 is the simplest change with lowest risk, and includes a resilience improvement (per-session error isolation).

### Files Modified Summary

| Fix | Files | Nature of change |
|---|---|---|
| 1 | `apps/backend/src/integrations/registry.ts` | `discoverKnownManagerIds()` loop + `resolveProfileId()` helper + all public methods |
| 1 | `apps/backend/src/ws/ws-handler.ts` | `resolveProfileIdForAgent()` helper + status broadcast filter |
| 1 | `apps/ui/src/components/settings/SettingsIntegrations.tsx` | `managerOptions` dedup by profileId + dropdown value |
| 1 | `apps/backend/src/swarm/swarm-manager.ts` | Comment on `SWARM_MANAGER_MAX_EVENT_LISTENERS` |
| 2 | `apps/backend/src/swarm/conversation-projector.ts` | `loadConversationHistoriesFromStore()` body + `hydrateLeafEntryId()` + `loadedFromDisk` set + `getConversationHistory()` guard + remove `shouldPreloadHistoryForDescriptor` |
| 3 | `apps/backend/src/swarm/session-manifest.ts` | `rebuildSessionMeta()` loop → batched `Promise.all` with error isolation + `SESSION_META_REBUILD_BATCH_SIZE` constant |
