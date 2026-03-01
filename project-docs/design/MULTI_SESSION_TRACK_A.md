# Multi-Session Per Manager — Revised Design (Track A)

> **Status:** Draft for review  
> **Date:** 2026-02-28  
> **Revision of:** `project-docs/design/MULTI_SESSION_DESIGN.md` (v1)

---

## Why a revision?

The v1 design assumed **one active session runtime per manager** with session switching. The user's actual workflow demands **true concurrency**: kick off a 60-minute task in Session A, immediately pivot to Session B, both running simultaneously under the same manager. The v1 design cannot support this without fundamental rework.

This revision throws away the single-active-session model and finds the simplest path to true concurrency.

---

## 1. Design Philosophy

### The core insight: sessions as lightweight virtual managers

The platform already runs multiple managers in parallel — each with its own runtime, workers, conversation history, and memory file. The machinery for concurrent agent runtimes **already exists**.

Rather than inventing a complex multiplexing layer inside `SwarmManager`, we reuse this existing parallelism. Each session becomes a **virtual manager**: a full `AgentDescriptor` with role `"manager"`, its own runtime, its own session file, its own workers. The only new concept is that these virtual managers are grouped under a **manager profile** — a thin identity layer that holds shared configuration and the base memory file.

**What this buys us:**

- Zero changes to `RuntimeFactory`, `AgentRuntime`, `CodexAgentRuntime`, or `ConversationProjector` internals. They already handle multiple parallel agents perfectly.
- Workers already bind to a `managerId` — they just bind to the session's virtual agent id instead.
- The event broadcast system (`WsHandler.broadcastToSubscribed`) already routes by `agentId` subscription — no multiplexing needed.
- Memory isolation falls out naturally (each session reads the profile memory, writes to its own).

**What changes:**

- A new `ManagerProfile` concept tracks identity, base config, and base memory.
- Manager agent descriptors get a `profileId` linking them to their profile.
- The UI groups sessions by profile instead of showing bare agents.
- `resetManagerSession` creates a new session agent instead of destroying history.

### Simplicity audit upfront

I explicitly avoid:
- **Session state machines** — sessions are just agents; agent lifecycle is the session lifecycle.
- **Runtime multiplexing** — no muxing conversation events across sessions; each session is an independent agent stream.
- **Cross-session message routing** — workers talk to their owning session agent, period.
- **New persistence files** — profile data lives in `agents.json` alongside everything else.

---

## 2. Architecture

### 2.1 Conceptual model

```
ManagerProfile "opus-manager"
├── memory: ~/.middleman/memory/opus-manager.md (shared base memory)
├── config: model defaults, cwd, integrations, archetypeId
│
├── Session Agent "opus-manager" (the original — also the "default" session)
│   ├── runtime: active SwarmAgentRuntime
│   ├── sessionFile: ~/.middleman/sessions/opus-manager.jsonl
│   ├── session memory: ~/.middleman/memory/opus-manager--s1.md
│   ├── worker: codex-worker-1
│   └── worker: codex-worker-2
│
└── Session Agent "opus-manager--s2" (second session)
    ├── runtime: active SwarmAgentRuntime  ← runs concurrently!
    ├── sessionFile: ~/.middleman/sessions/opus-manager--s2.jsonl
    ├── session memory: ~/.middleman/memory/opus-manager--s2.md
    └── worker: opus-reviewer
```

Both sessions run simultaneously. Each has its own runtime, conversation history, and workers. The UI groups them under the "opus-manager" profile.

### 2.2 Data model

#### Manager Profile (new, lightweight)

Stored as entries in a `profiles` array in `agents.json` (or a parallel `profiles.json` — see simplicity tradeoff below).

```ts
// packages/protocol/src/shared-types.ts — new

export interface ManagerProfile {
  profileId: string              // e.g. "opus-manager"
  displayName: string            // e.g. "Opus Manager"
  defaultSessionAgentId: string  // the "primary" session agent id
  createdAt: string
  updatedAt: string
}
```

**Decision: store in `agents.json` or new file?**

Simplest: extend `AgentsStoreFile` with an optional `profiles` array. This avoids cross-file atomicity problems entirely — one atomic write persists both profiles and agents.

```ts
// apps/backend/src/swarm/types.ts — extend

export interface AgentsStoreFile {
  agents: AgentDescriptor[]
  profiles?: ManagerProfile[]   // NEW — optional for backward compat
}
```

#### Agent Descriptor changes (minimal)

```ts
// packages/protocol/src/shared-types.ts — extend AgentDescriptor

export interface AgentDescriptor {
  // ... all existing fields ...

  profileId?: string             // NEW — links session agents to their profile
  sessionLabel?: string          // NEW — human-readable session title, e.g. "Refactor auth"
}
```

That's it. A session agent is a manager-role descriptor with a `profileId`. Workers point their `managerId` at the session agent, not the profile.

#### Session identity convention

- **Profile id:** Same as the original manager agent id (e.g. `"opus-manager"`).
- **First/default session agent id:** Same as the profile id (e.g. `"opus-manager"`). This means the existing agent id is preserved through migration — zero disruption.
- **Additional session agent ids:** `"<profileId>--<slug>"` where slug is `s<N>` or a short timestamp+entropy (e.g. `"opus-manager--s2"`, `"opus-manager--20260228-a3f1"`).
- **Session files:** `~/.middleman/sessions/<sessionAgentId>.jsonl` (existing convention, no change).

### 2.3 Runtime model

Each session agent gets its own entry in `SwarmManager.runtimes: Map<string, SwarmAgentRuntime>`. This is **already how it works** — the runtimes map is keyed by `agentId`, and there's no restriction on multiple manager-role agents having runtimes simultaneously.

Key code path verification from `apps/backend/src/swarm/swarm-manager.ts`:

- `getOrCreateRuntimeForDescriptor(descriptor)` (line ~1460): Creates and stores a runtime keyed by `descriptor.agentId`. Works for any number of manager agents.
- `handleRuntimeStatus(agentId, ...)` (line ~1646): Updates the specific descriptor by `agentId`. No manager-singleton assumptions.
- `handleRuntimeSessionEvent(agentId, event)` (line ~1683): Routes to `ConversationProjector.captureConversationEventFromRuntime(agentId, event)`, which resolves manager context by looking up `descriptor.managerId`. For session agents, `managerId` equals `agentId` (self), so events route correctly.

**No changes needed** to `RuntimeFactory`, `AgentRuntime`, `CodexAgentRuntime`, or the runtime callback wiring.

### 2.4 Memory model — session-scoped with deferred merge

This is the elegant solution to concurrent memory writes.

#### Memory file layout

```
~/.middleman/memory/
├── opus-manager.md              ← profile base memory (shared identity)
├── opus-manager--s2.md          ← session s2's scratch memory
└── opus-manager--s3.md          ← session s3's scratch memory
```

The first/default session agent (`opus-manager`) uses the profile memory file directly — its `resolveMemoryOwnerAgentId()` returns itself, which maps to `opus-manager.md`. This preserves backward compatibility.

Additional session agents get their own session memory files. Their runtimes load **two** context files:
1. The profile base memory (read-only reference)
2. Their session memory (read-write)

#### How it works in the runtime

The key method is `getMemoryRuntimeResources(descriptor)` in `SwarmManager` (line ~1725). Currently it resolves one memory file. We extend it to return the profile base memory as a read-only context file, plus the session memory as the writable `SWARM_MEMORY_FILE`.

```ts
// In SwarmManager.getMemoryRuntimeResources — conceptual change

protected async getMemoryRuntimeResources(descriptor: AgentDescriptor): Promise<{
  memoryContextFile: { path: string; content: string }    // session memory (writable)
  baseMemoryContextFile?: { path: string; content: string } // profile memory (read-only reference)
  additionalSkillPaths: string[]
}> {
  const sessionMemoryPath = this.getAgentMemoryPath(descriptor.agentId)
  await this.ensureAgentMemoryFile(descriptor.agentId)
  
  // For session agents with a profile, also load the base memory
  let baseMemoryContextFile: { path: string; content: string } | undefined
  if (descriptor.profileId && descriptor.agentId !== descriptor.profileId) {
    const baseMemoryPath = this.getAgentMemoryPath(descriptor.profileId)
    baseMemoryContextFile = {
      path: baseMemoryPath,
      content: await readFile(baseMemoryPath, 'utf8')
    }
  }
  
  return {
    memoryContextFile: { path: sessionMemoryPath, content: await readFile(sessionMemoryPath, 'utf8') },
    baseMemoryContextFile,
    additionalSkillPaths: this.skillMetadataService.getAdditionalSkillPaths()
  }
}
```

The `RuntimeFactory` then injects the base memory as a read-only context file in the system prompt, and the session memory as the `SWARM_MEMORY_FILE` env var.

Workers of a session read their session agent's memory (via `resolveMemoryOwnerAgentId` → `descriptor.managerId` → session agent id).

#### Deferred merge

When a session finishes (user closes it, or the session goes idle), a merge step is triggered:

1. Read the session memory file.
2. Read the profile base memory file.
3. Spawn a short-lived worker with the "merger" archetype (or a purpose-built memory-merge prompt) that takes both files and produces an updated base memory.
4. Write the updated base memory.
5. Optionally clear/archive the session memory file.

This can be:
- **Automatic** on session close.
- **On-demand** via a `/merge-memory` command.
- **Deferred** — just let session memories accumulate; user merges when ready.

For v1, I recommend **on-demand only** — keep it simple, no auto-merge until we're confident in the merge quality.

---

## 3. Protocol Changes

### 3.1 Shared types additions

```ts
// packages/protocol/src/shared-types.ts

export interface ManagerProfile {
  profileId: string
  displayName: string
  defaultSessionAgentId: string
  createdAt: string
  updatedAt: string
}

// Extend AgentDescriptor:
export interface AgentDescriptor {
  // ... existing fields ...
  profileId?: string
  sessionLabel?: string
}
```

### 3.2 Client commands additions

```ts
// packages/protocol/src/client-commands.ts — extend union

| { type: 'create_session'; profileId: string; label?: string; requestId?: string }
| { type: 'close_session'; agentId: string; requestId?: string }
| { type: 'rename_session'; agentId: string; label: string; requestId?: string }
| { type: 'merge_session_memory'; agentId: string; requestId?: string }
```

That's it. **No `switch_session` command** — because sessions are just agents. The existing `subscribe` command with `agentId` already handles switching the UI view. The existing `user_message` with `agentId` already targets a specific session.

### 3.3 Server events additions

```ts
// packages/protocol/src/server-events.ts

export interface SessionCreatedEvent {
  type: 'session_created'
  profile: ManagerProfile
  sessionAgent: AgentDescriptor
  requestId?: string
}

export interface SessionClosedEvent {
  type: 'session_closed'
  profileId: string
  agentId: string
  terminatedWorkerIds: string[]
  requestId?: string
}

export interface SessionRenamedEvent {
  type: 'session_renamed'
  agentId: string
  label: string
  requestId?: string
}

export interface ProfilesSnapshotEvent {
  type: 'profiles_snapshot'
  profiles: ManagerProfile[]
}

// Add to ServerEvent union:
| SessionCreatedEvent
| SessionClosedEvent
| SessionRenamedEvent
| ProfilesSnapshotEvent
```

### 3.4 Backward compatibility

- Old clients see session agents as normal manager agents in `agents_snapshot`. The new `profileId` field is optional and ignored by old clients.
- New `profiles_snapshot` is ignored by old clients (unknown event type).
- `subscribe`, `user_message`, `kill_agent` all work with session agent ids unchanged.
- `/new` still works — it creates a new session and switches the UI.

---

## 4. Backend Changes

### 4.1 SwarmManager additions

**File:** `apps/backend/src/swarm/swarm-manager.ts`

New state:

```ts
private readonly profiles = new Map<string, ManagerProfile>()
```

New public methods:

```ts
// Create a new session under an existing manager profile
async createSession(
  profileId: string,
  options?: { label?: string }
): Promise<{ profile: ManagerProfile; sessionAgent: AgentDescriptor }>

// Close a session (terminate its runtime + workers, mark terminated)
async closeSession(agentId: string): Promise<{ terminatedWorkerIds: string[] }>

// Rename a session
renameSession(agentId: string, label: string): Promise<void>

// Merge a session's memory back into profile base memory
async mergeSessionMemory(agentId: string): Promise<void>

// List profiles
listProfiles(): ManagerProfile[]
```

#### `createSession` implementation sketch

```ts
async createSession(profileId: string, options?: { label?: string }) {
  const profile = this.profiles.get(profileId)
  if (!profile) throw new Error(`Unknown profile: ${profileId}`)
  
  // Generate unique session agent id
  const slug = generateSessionSlug()  // e.g. "s2", "s3", ...
  const sessionAgentId = `${profileId}--${slug}`
  
  // Clone config from the default session agent (or profile defaults)
  const templateAgent = this.descriptors.get(profile.defaultSessionAgentId)
  if (!templateAgent) throw new Error(`Profile default agent missing: ${profile.defaultSessionAgentId}`)
  
  const now = this.now()
  const descriptor: AgentDescriptor = {
    agentId: sessionAgentId,
    displayName: sessionAgentId,
    role: 'manager',
    managerId: sessionAgentId,  // self-referencing, same as existing managers
    archetypeId: templateAgent.archetypeId,
    profileId,
    sessionLabel: options?.label ?? `Session ${slug}`,
    status: 'idle',
    createdAt: now,
    updatedAt: now,
    cwd: templateAgent.cwd,
    model: { ...templateAgent.model },
    sessionFile: join(this.config.paths.sessionsDir, `${sessionAgentId}.jsonl`)
  }
  
  this.descriptors.set(sessionAgentId, descriptor)
  
  // Create runtime (same as createManager does)
  const runtime = await this.createRuntimeForDescriptor(
    descriptor,
    this.resolveSystemPromptForDescriptor(descriptor)
  )
  this.runtimes.set(sessionAgentId, runtime)
  
  await this.saveStore()
  
  this.emitAgentsSnapshot()
  this.emitProfilesSnapshot()
  
  return { profile, sessionAgent: cloneDescriptor(descriptor) }
}
```

#### `resetManagerSession` change

The existing `/new` command calls `resetManagerSession`. Change it to:

```ts
async resetManagerSession(managerId: string, reason: string): Promise<void> {
  const descriptor = this.descriptors.get(managerId)
  if (!descriptor || descriptor.role !== 'manager') {
    throw new Error(`Unknown manager: ${managerId}`)
  }
  
  const profileId = descriptor.profileId ?? descriptor.agentId
  
  // Create a new session instead of destroying the current one
  const { sessionAgent } = await this.createSession(profileId, { label: 'New chat' })
  
  // Emit conversation_reset so the UI clears and switches
  this.emitConversationReset(managerId, reason)
  
  // Note: the old session keeps running with its workers.
  // The UI will switch to the new session via agents_snapshot.
}
```

**But wait — should `/new` create a session and leave the old one running, or also stop it?**

Simplest: `/new` creates a new session. The old session's workers keep running. The user can close the old session explicitly if they want. This matches the "concurrent sessions" requirement perfectly.

#### `createManager` change

When a new manager is created, also create a profile:

```ts
async createManager(callerAgentId: string, input: { ... }): Promise<AgentDescriptor> {
  // ... existing logic to create the manager descriptor ...
  
  // Create a profile for this manager
  const profile: ManagerProfile = {
    profileId: descriptor.agentId,
    displayName: descriptor.displayName,
    defaultSessionAgentId: descriptor.agentId,
    createdAt: descriptor.createdAt,
    updatedAt: descriptor.createdAt
  }
  this.profiles.set(profile.profileId, profile)
  
  // ... rest of existing logic (runtime creation, bootstrap, save) ...
  
  this.emitProfilesSnapshot()
  return cloneDescriptor(descriptor)
}
```

#### `deleteManager` change

Deleting a manager profile should delete all its session agents and their workers:

```ts
async deleteManager(callerAgentId: string, targetManagerId: string) {
  // targetManagerId is the profile id
  const profile = this.profiles.get(targetManagerId)
  
  // Find all session agents for this profile
  const sessionAgents = Array.from(this.descriptors.values())
    .filter(d => d.profileId === targetManagerId || d.agentId === targetManagerId)
    .filter(d => d.role === 'manager')
  
  const terminatedWorkerIds: string[] = []
  
  for (const sessionAgent of sessionAgents) {
    // Terminate workers and session agent (existing terminateDescriptor logic)
    for (const worker of this.getWorkersForManager(sessionAgent.agentId)) {
      terminatedWorkerIds.push(worker.agentId)
      await this.terminateDescriptor(worker, { abort: true, emitStatus: true })
      this.descriptors.delete(worker.agentId)
    }
    
    await this.terminateDescriptor(sessionAgent, { abort: true, emitStatus: true })
    this.descriptors.delete(sessionAgent.agentId)
    this.conversationProjector.deleteConversationHistory(sessionAgent.agentId)
  }
  
  this.profiles.delete(targetManagerId)
  await this.saveStore()
  this.emitAgentsSnapshot()
  this.emitProfilesSnapshot()
  
  return { managerId: targetManagerId, terminatedWorkerIds }
}
```

### 4.2 PersistenceService changes

**File:** `apps/backend/src/swarm/persistence-service.ts`

Minimal: extend `loadStore` / `saveStore` to handle the `profiles` array in `agents.json`.

```ts
async loadStore(): Promise<AgentsStoreFile> {
  // ... existing agent loading ...
  return {
    agents: validAgents,
    profiles: parsed.profiles ?? []   // NEW
  }
}

async saveStore(): Promise<void> {
  const payload: AgentsStoreFile = {
    agents: this.deps.sortedDescriptors(),
    profiles: this.deps.sortedProfiles()   // NEW
  }
  // ... existing atomic write ...
}
```

### 4.3 ConversationProjector — NO changes

The conversation projector keys everything by `agentId`. Each session agent is a separate `agentId`, so all conversation history, event emission, and trimming work correctly without modification.

This is the biggest win of the "sessions as agents" approach.

### 4.4 RuntimeFactory — NO changes

`RuntimeFactory.createRuntimeForDescriptor` takes an `AgentDescriptor` and creates a runtime. It doesn't care about profiles or sessions. Each session agent is just another descriptor.

### 4.5 Memory path changes

**File:** `apps/backend/src/swarm/memory-paths.ts`

No change needed. Memory files are already at `~/.middleman/memory/<agentId>.md`. Session agent `opus-manager--s2` gets `opus-manager--s2.md` automatically.

**File:** `apps/backend/src/swarm/swarm-manager.ts` — `getMemoryRuntimeResources`

Extend to also inject the profile base memory as a read-only context file for non-default sessions:

```ts
protected async getMemoryRuntimeResources(descriptor: AgentDescriptor) {
  // Existing: get the agent's own memory file
  const memoryOwnerAgentId = this.resolveMemoryOwnerAgentId(descriptor)
  const memoryFilePath = this.getAgentMemoryPath(memoryOwnerAgentId)
  await this.ensureAgentMemoryFile(memoryOwnerAgentId)
  
  const memoryContent = await readFile(memoryFilePath, 'utf8')
  
  // NEW: for session agents that aren't the default, also load profile base memory
  let baseMemoryContent: string | undefined
  if (descriptor.role === 'manager' && descriptor.profileId 
      && descriptor.agentId !== descriptor.profileId) {
    const baseMemoryPath = this.getAgentMemoryPath(descriptor.profileId)
    try {
      baseMemoryContent = await readFile(baseMemoryPath, 'utf8')
    } catch { /* base memory may not exist yet */ }
  }
  
  // Combine: base memory (read-only reference) + session memory (writable)
  const combinedContent = baseMemoryContent
    ? `# Profile Memory (read-only reference — shared across sessions)\n\n${baseMemoryContent}\n\n---\n\n# Session Memory (your writable memory for this session)\n\n${memoryContent}`
    : memoryContent
  
  return {
    memoryContextFile: { path: memoryFilePath, content: combinedContent },
    additionalSkillPaths: this.skillMetadataService.getAdditionalSkillPaths()
  }
}
```

For the Codex runtime path, the `SWARM_MEMORY_FILE` env var points to the session memory file, and the base memory gets injected into the system prompt.

**Worker memory resolution:** `resolveMemoryOwnerAgentId(workerDescriptor)` returns `workerDescriptor.managerId`, which is the session agent id. So workers read their session's memory — correct behavior.

### 4.6 WS handler changes

**File:** `apps/backend/src/ws/ws-handler.ts`

Minor:
1. Add `profiles_snapshot` to the subscription bootstrap:

```ts
private sendSubscriptionBootstrap(socket: WebSocket, targetAgentId: string): void {
  // ... existing ready, agents_snapshot, conversation_history ...
  
  this.send(socket, {
    type: 'profiles_snapshot',
    profiles: this.swarmManager.listProfiles()    // NEW
  })
}
```

2. Listen for and broadcast the new event types from SwarmManager.

**File:** `apps/backend/src/ws/routes/session-routes.ts` (new)

Handle `create_session`, `close_session`, `rename_session`, `merge_session_memory` commands. Follows the same pattern as `manager-routes.ts`.

**File:** `apps/backend/src/ws/routes/conversation-routes.ts`

The `/new` handler already calls `resetManagerSession`. The revised `resetManagerSession` creates a new session, so this works without changes.

### 4.7 Integrations routing

**Files:** `apps/backend/src/integrations/slack/slack-router.ts`, `apps/backend/src/integrations/telegram/telegram-router.ts`

Currently, both routers call `swarmManager.handleUserMessage(text, { targetAgentId: this.managerId })`.

For v1, **no changes needed**. Inbound messages from Slack/Telegram target the profile's default session agent (which is the original manager id). This is correct because:
- `this.managerId` is set during integration setup to the profile id, which IS the default session agent id.
- The message arrives at the session that was created first / is the primary session.

For v2 (future): thread-to-session binding. A Slack thread could be bound to a specific session agent id. This is additive and doesn't affect the v1 design.

### 4.8 Scheduler

**File:** `apps/backend/src/scheduler/cron-scheduler-service.ts`

The scheduler targets `this.managerId` which is the profile id = default session agent id. No changes needed for v1.

---

## 5. Frontend/UI Changes

### 5.1 WS state

**File:** `apps/ui/src/lib/ws-state.ts`

```ts
import type { ManagerProfile } from '@middleman/protocol'

export interface ManagerWsState {
  // ... existing fields ...
  profiles: ManagerProfile[]     // NEW
}
```

### 5.2 WS client

**File:** `apps/ui/src/lib/ws-client.ts`

Add to event handler:

```ts
case 'profiles_snapshot':
  this.updateState({ profiles: event.profiles })
  break

case 'session_created':
  // agents_snapshot will follow with the new agent; optionally auto-navigate
  this.requestTracker.resolve('create_session', event.requestId, event)
  break

case 'session_closed':
  this.requestTracker.resolve('close_session', event.requestId, event)
  break
```

Add client methods:

```ts
async createSession(profileId: string, label?: string): Promise<SessionCreatedEvent> {
  return this.enqueueRequest('create_session', (requestId) => ({
    type: 'create_session', profileId, label, requestId
  }))
}

async closeSession(agentId: string): Promise<SessionClosedEvent> {
  return this.enqueueRequest('close_session', (requestId) => ({
    type: 'close_session', agentId, requestId
  }))
}
```

### 5.3 Agent hierarchy

**File:** `apps/ui/src/lib/agent-hierarchy.ts`

Currently builds a flat list of `{ manager, workers }` rows. Change to a profile-grouped hierarchy:

```ts
export interface SessionRow {
  sessionAgent: AgentDescriptor
  workers: AgentDescriptor[]
  isDefault: boolean
}

export interface ProfileTreeRow {
  profile: ManagerProfile
  sessions: SessionRow[]
}

export function buildProfileTreeRows(
  agents: AgentDescriptor[],
  profiles: ManagerProfile[]
): { profileRows: ProfileTreeRow[]; orphanManagers: ManagerTreeRow[]; orphanWorkers: AgentDescriptor[] } {
  // Group agents by profileId
  // For each profile, build session rows with their workers
  // Agents without a profileId are "orphan managers" (legacy, pre-migration)
  // ...
}
```

### 5.4 Sidebar

**File:** `apps/ui/src/components/chat/AgentSidebar.tsx`

Change the tree rendering to:

```
Profile: "Opus Manager"
  ├── Session: "Refactoring auth"  [active]  ← click to subscribe
  │   ├── worker: codex-auth-worker
  │   └── worker: codex-test-runner
  │
  ├── Session: "Bug triage"  [active]
  │   └── worker: opus-reviewer
  │
  └── [+ New session]   ← creates a new session under this profile
```

Each session row is clickable and subscribes to that session's agent id. Workers nest under sessions.

Context menu on sessions: Rename, Close, Merge Memory.
Context menu on profiles: Delete (deletes all sessions + workers).

The "New Manager" button becomes "New Manager" (creates a profile + default session, as today).
Each profile gets a "New Session" action.

### 5.5 Route state

**File:** `apps/ui/src/hooks/index-page/use-route-state.ts`

No fundamental changes needed. Session agents are agents, so the existing `{ view: 'chat', agentId: string }` route state works — `agentId` is the session agent id.

The URL might look like `/agent/opus-manager--s2` for a non-default session — perfectly readable.

---

## 6. Migration

### 6.1 Boot reconciliation (idempotent)

On boot, during `SwarmManager.boot()`, after loading `agents.json`:

1. For each manager agent that has **no `profileId`** (pre-migration):
   - Create a `ManagerProfile` with `profileId = agent.agentId`, `defaultSessionAgentId = agent.agentId`.
   - Set `agent.profileId = agent.agentId`.

2. Persist to `agents.json`.

This is idempotent — running it twice produces the same result.

### 6.2 Existing data preservation

- The original manager agent id doesn't change. Its `agentId` stays the same.
- Its session file stays the same.
- Its memory file stays the same.
- Its workers stay assigned to it.
- All conversation history is preserved.

**Zero-disruption migration.** The user sees their existing manager with a new ability to create additional sessions.

### 6.3 Rollback safety

If the user rolls back to a pre-multi-session build:
- `profiles` array in `agents.json` is silently ignored (unknown field).
- `profileId` and `sessionLabel` on descriptors are silently ignored (unknown fields).
- Session agents created as `opus-manager--s2` would appear as separate managers in the old UI — functional but visually ungrouped.
- The original manager works exactly as before.

---

## 7. Implementation Phases

### Phase 1: Data model + profiles (backend only)

**Files changed:**
- `packages/protocol/src/shared-types.ts` — Add `ManagerProfile`, extend `AgentDescriptor`
- `apps/backend/src/swarm/types.ts` — Mirror protocol additions, extend `AgentsStoreFile`
- `apps/backend/src/swarm/persistence-service.ts` — Load/save profiles in `agents.json`
- `apps/backend/src/swarm/swarm-manager.ts` — `profiles` map, boot reconciliation, `listProfiles()`

**Test:** Boot with existing data → profile auto-created → data round-trips correctly.

**Risk:** None. Additive-only changes.

### Phase 2: Session lifecycle (backend)

**Files changed:**
- `apps/backend/src/swarm/swarm-manager.ts` — `createSession`, `closeSession`, `renameSession`, revised `resetManagerSession`

**Test:** Create session → runs concurrently with original → workers bind correctly → close session terminates its workers → `/new` creates a new session.

**Depends on:** Phase 1.

### Phase 3: Memory isolation

**Files changed:**
- `apps/backend/src/swarm/swarm-manager.ts` — `getMemoryRuntimeResources` extension for profile base memory injection
- `apps/backend/src/swarm/swarm-manager.ts` — `mergeSessionMemory` (on-demand merge)

**Test:** Session agent's runtime sees profile base memory read-only + its own writable memory. Workers see session memory. Merge produces combined base memory.

**Depends on:** Phase 2.

### Phase 4: Protocol + WS wiring

**Files changed:**
- `packages/protocol/src/client-commands.ts` — New command types
- `packages/protocol/src/server-events.ts` — New event types
- `apps/backend/src/ws/ws-command-parser.ts` — Parse new commands
- `apps/backend/src/ws/routes/session-routes.ts` — New route handler
- `apps/backend/src/ws/ws-handler.ts` — Wire new routes, broadcast new events
- `apps/backend/src/ws/server.ts` — Listen for new SwarmManager events

**Test:** WS client sends `create_session` → receives `session_created` + `agents_snapshot` + `profiles_snapshot`.

**Depends on:** Phase 2.

### Phase 5: UI

**Files changed:**
- `apps/ui/src/lib/ws-state.ts` — Add `profiles`
- `apps/ui/src/lib/ws-client.ts` — Handle new events, add request methods
- `apps/ui/src/lib/agent-hierarchy.ts` — Profile-grouped tree
- `apps/ui/src/components/chat/AgentSidebar.tsx` — Profile/session/worker hierarchy
- `apps/ui/src/components/chat/ChatHeader.tsx` — Show session label

**Test:** Sidebar shows profile → sessions → workers. Click session to switch. "New session" creates concurrent session. Close session removes it.

**Depends on:** Phase 4.

### Phase 6 (future): Integration thread binding

**Files changed:**
- `apps/backend/src/integrations/slack/slack-router.ts`
- `apps/backend/src/integrations/telegram/telegram-router.ts`

Not needed for v1. Integrations route to the default session agent, which works fine.

### Parallelization

- Phases 1-3 are backend-only and sequential.
- Phase 4 can start once Phase 2 API contracts are stable.
- Phase 5 can start UI scaffolding (hierarchy, sidebar layout) during Phase 3-4.

---

## 8. Simplicity Audit

### What's intentionally NOT in this design

| Tempting complexity | Why we skip it |
|---|---|
| Session state machine (active/paused/closed/archived) | Sessions are agents. Agent lifecycle IS the session lifecycle. `idle` = available. `streaming` = working. `terminated` = closed. |
| Session switching protocol | Sessions are agents. `subscribe` to a session agent id = view that session. Already works. |
| Runtime multiplexing / event muxing | Each session has its own runtime. Events route by `agentId`. Already works. |
| `sessions.json` separate store file | Store profiles alongside agents in `agents.json`. One atomic write. |
| Auto-merge memory on session close | Start with on-demand merge only. Auto-merge adds complexity (what if merge fails? what if two sessions close simultaneously?) |
| Integration thread-to-session binding | Default session routing is good enough for v1. Thread binding is v2. |
| New conversation projector logic | Projector already keys by `agentId`. Session agents are agents. Zero changes. |
| Cross-session worker communication | Workers talk to their session agent. Period. No cross-session messaging. |

### What might feel over-engineered (and why it's not)

| Element | Justification |
|---|---|
| `ManagerProfile` type | Without profiles, the UI can't group sessions. It's 5 fields. It's the minimum viable grouping mechanism. |
| `profileId` on `AgentDescriptor` | One optional field. It's the join key between agents and profiles. Alternatives (naming convention parsing) are fragile. |

### Key simplicity wins

1. **Zero changes to RuntimeFactory, AgentRuntime, ConversationProjector.** The three most complex modules in the backend are untouched.
2. **Zero changes to the wire protocol's existing commands.** `subscribe`, `user_message`, `kill_agent` all work unchanged.
3. **Migration is a no-op for users.** Existing data is preserved bit-for-bit. Profiles are auto-created on boot.
4. **Rollback is safe.** Old builds ignore new fields.
5. **The concurrency model is proven.** Multiple managers already run in parallel today. Sessions reuse that exact machinery.

---

## 9. Comparison with v1 Design

| Aspect | v1 (session switching) | This revision (sessions as agents) |
|---|---|---|
| Concurrent sessions | ❌ Non-goal | ✅ First-class |
| Runtime changes | Significant (mux/switch) | None |
| ConversationProjector changes | Significant (session-keyed) | None |
| New persistence store | `sessions.json` (cross-file atomicity risk) | `profiles` in `agents.json` (single atomic write) |
| Protocol complexity | 5 new commands + session tagging on all conversation events | 3 new commands, zero changes to existing events |
| Memory model | Not addressed | Session-scoped with deferred merge |
| Migration risk | Medium (session file rebinding) | Minimal (additive fields + auto-generated profiles) |
| Lines of code estimate | ~800-1200 backend | ~400-600 backend |
| UI complexity | Session tree within agent tree | Profile tree (slightly more nesting, but cleaner model) |

---

## 10. Open Questions

1. **Session naming UX:** Should new sessions auto-title based on the first user message (like ChatGPT), or always start as "Session N"? Recommendation: start simple with "Session N", add auto-titling later.

2. **Max concurrent sessions:** Should we cap concurrent sessions per profile? Recommendation: no cap in v1. Each session is lightweight (one runtime process). Users will self-regulate.

3. **Session list growth:** Closed sessions accumulate as terminated agents. Should we add a "clear closed sessions" action? Recommendation: yes, add a simple bulk-delete in v2.

4. **`/new` semantics with long-running session:** When the user types `/new` in a session that has active workers, should it: (a) leave the session running and create a new one, or (b) close the current session first? Recommendation: (a) — leave it running. The user can close it explicitly.

5. **Profile memory vs. session memory for new sessions:** When creating a new session, should it start with a copy of the current profile memory, or an empty session memory file? Recommendation: empty session memory, with profile memory injected as read-only context. The session can write important findings to its own memory, and merge later.
