# Multi-Session Per Manager — Final Design Document

> **Status:** **APPROVED — Ready for implementation**
> **Date:** 2026-02-28
> **Supersedes:** `MULTI_SESSION_DESIGN.md` (v1), `MULTI_SESSION_TRACK_A.md`, `MULTI_SESSION_TRACK_B.md`
> **Architecture:** Sessions-as-agents (Track A), with cherry-picked enhancements from Track B
>
> **⚠️ Data paths note (2026-03-03):** The data directory restructure has been merged. Memory/session path formulas in §4.4, §5.1, and the conceptual model (§3.1) reference the **pre-restructure flat layout** (e.g. `~/.middleman/sessions/<agentId>.jsonl`, `~/.middleman/memory/<agentId>.md`). The actual layout is now hierarchical and profile-scoped — see `apps/backend/src/swarm/data-paths.ts` for canonical paths. The architectural concepts and session-as-agent design remain valid; only the filesystem paths have changed.

---

## 1. Status & Summary

This is the definitive, implementation-ready design for multi-session per manager in Middleman. All previously open design questions are now resolved. It merges the best ideas from two independent design tracks:

- **Track A** (foundation): Sessions are full `AgentDescriptor` objects with role `"manager"`, linked to a `ManagerProfile` via `profileId`. Each session is an independent agent with its own runtime, session file, workers, and conversation history. Zero changes to `RuntimeFactory`, `AgentRuntime`, `CodexAgentRuntime`, or `ConversationProjector` internals.

- **Track B** (cherry-picked enhancements):
  1. Per-profile mutex for merge serialization
  2. `mergedAt` field for merge lifecycle tracking
  3. Explicit merge lifecycle events (`session_memory_merge_started`, `session_memory_merged`, `session_memory_merge_failed`)
  4. Root session is non-deletable (stable identity target for integrations/cron)
  5. Expanded session lifecycle surface (`stop`, `resume`, `delete`) plus `fork_session`

### Why this design wins

The platform already runs multiple manager agents concurrently — each with its own runtime, workers, conversation history, and memory file. Rather than building a complex multiplexing layer, we reuse this existing parallelism. Each session becomes a virtual manager agent grouped under a profile.

**Result:** True concurrent sessions with ~400–600 lines of backend changes, zero modifications to the three most complex subsystems (runtime factory, agent runtime, conversation projector), and a zero-disruption migration path.

---

## 2. Goals & Non-Goals

### Goals (v1)

1. **True concurrency** — Multiple sessions running simultaneously under one manager identity. Start a 60-minute task in Session A, immediately pivot to Session B.
2. **Non-destructive `/new`** — Creates a new session, preserves the old one.
3. **Full config inheritance** — Every new session is functionally identical to the original manager (same model, system prompt, skills, CWD, integration access, memory access).
4. **Session-scoped conversation history and worker ownership.**
5. **On-demand memory merge** — Consolidate session learnings back into profile base memory.
6. **Backward-compatible protocol evolution.**
7. **Zero-disruption migration** from existing single-session data.

### Non-Goals (v1)

1. Automated periodic memory consolidation (Memory Custodian runs as a follow-up phase).
2. Integration thread-to-session binding (integrations route to default session; thread binding is v2).
3. Session archival/pruning UX (idle sessions and old forks accumulate; cleanup UX is follow-up).
4. Cross-session worker communication (workers talk to their owning session only).
5. CRDT/operational-transform memory sync between sessions.

---

## 3. Architecture Overview

### 3.1 Conceptual Model

```
ManagerProfile "opus-manager"
├── profileId: "opus-manager"
├── displayName: "Opus Manager"
├── defaultSessionAgentId: "opus-manager"
├── memory: ~/.middleman/memory/opus-manager.md (shared base memory)
│
├── Session Agent "opus-manager" (the original/default — root session)
│   ├── profileId: "opus-manager"
│   ├── sessionLabel: "Main"
│   ├── runtime: active SwarmAgentRuntime
│   ├── sessionFile: ~/.middleman/sessions/opus-manager.jsonl
│   ├── memory: reads base memory directly (profile memory IS this session's memory)
│   ├── worker: codex-worker-1
│   └── worker: codex-worker-2
│
├── Session Agent "opus-manager--s2"
│   ├── profileId: "opus-manager"
│   ├── sessionLabel: "Refactor auth"
│   ├── runtime: active SwarmAgentRuntime  ← runs concurrently!
│   ├── sessionFile: ~/.middleman/sessions/opus-manager--s2.jsonl
│   ├── session memory: ~/.middleman/memory/opus-manager--s2.md
│   └── worker: opus-reviewer
│
└── Session Agent "opus-manager--s3"
    ├── profileId: "opus-manager"
    ├── sessionLabel: "Bug triage"
    ├── mergedAt: "2026-02-28T15:30:00Z"
    ├── lifecycle: "idle" (runtime stopped, resumable)
    └── (no runtime, no workers)
```

Running sessions execute concurrently. Idle sessions keep full conversation history + session memory and can be resumed at any time. The UI groups them under the "opus-manager" profile.

### 3.2 Core Design Principles

1. **Sessions ARE agents.** A session agent is a manager-role `AgentDescriptor` with a `profileId`. No new entity types.
2. **Profiles are grouping metadata only.** A `ManagerProfile` is 5 fields. It groups session agents and identifies the default session.
3. **Single atomic store.** Profiles live in `agents.json` alongside agent descriptors. One file, one atomic write.
4. **Existing machinery, reused.** The `runtimes: Map<string, SwarmAgentRuntime>` already supports N concurrent managers. Each session agent is just another key.
5. **Root session is special.** The default/original session is non-deletable (but can be stopped/resumed). It provides a stable target for integrations, cron, and the configured `managerId`.

### 3.3 Session Lifecycle Semantics (v1)

- **Running** — Session has an active runtime, can have workers, and accepts messages.
- **Idle** — Session runtime is stopped and workers are terminated. Conversation history + session memory are preserved and the session is resumable.
- **Delete (destructive)** — Permanently removes the session descriptor, JSONL history file, and session memory file (confirmation required).

Implementation note: this lifecycle is derived from existing runtime/descriptors. We continue using existing `AgentStatus`; sessions with an active runtime (`idle`/`streaming`) are treated as **running**. Sessions without a runtime are treated as **idle**. `terminated` is reserved for permanent deletion paths.

---

## 4. Data Model

### 4.1 ManagerProfile (new type)

**File:** `packages/protocol/src/shared-types.ts`

```ts
export interface ManagerProfile {
  profileId: string              // e.g. "opus-manager" — same as original manager agentId
  displayName: string            // e.g. "Opus Manager"
  defaultSessionAgentId: string  // the root session agent id (equals profileId for migration)
  createdAt: string              // ISO timestamp
  updatedAt: string              // ISO timestamp
}
```

**File:** `apps/backend/src/swarm/types.ts` — mirror in backend types

### 4.2 AgentDescriptor Extensions

**File:** `packages/protocol/src/shared-types.ts` — extend existing interface

```ts
export interface AgentDescriptor {
  // ... all existing fields unchanged ...
  agentId: string
  displayName: string
  role: 'manager' | 'worker'
  managerId: string
  archetypeId?: string
  status: AgentStatus
  createdAt: string
  updatedAt: string
  cwd: string
  model: AgentModelDescriptor
  sessionFile: string
  contextUsage?: AgentContextUsage

  // NEW fields (all optional for backward compat)
  profileId?: string             // Links session agents to their profile
  sessionLabel?: string          // Human-readable session name, e.g. "Refactor auth"
  mergedAt?: string              // ISO timestamp of last memory merge, if any
}
```

**File:** `apps/backend/src/swarm/types.ts` — mirror additions

### 4.3 AgentsStoreFile Extension

**File:** `apps/backend/src/swarm/types.ts`

```ts
export interface AgentsStoreFile {
  agents: AgentDescriptor[]
  profiles?: ManagerProfile[]    // NEW — optional for backward compat on load
}
```

No separate `sessions.json`. One file, one atomic write. This eliminates cross-file atomicity problems entirely.

### 4.4 Session Identity Convention

| Concept | Format | Example |
|---|---|---|
| Profile id | Same as original manager agent id | `"opus-manager"` |
| Root session agent id | Same as profile id | `"opus-manager"` |
| Additional session agent id | `<profileId>--s<N>` | `"opus-manager--s2"` |
| Session file | `~/.middleman/sessions/<agentId>.jsonl` | `opus-manager--s2.jsonl` |
| Session memory file | `~/.middleman/memory/<agentId>.md` | `opus-manager--s2.md` |
| Profile base memory | `~/.middleman/memory/<profileId>.md` | `opus-manager.md` |

The root session agent id equals the profile id, which equals the original manager agent id. **This means the existing agent id is preserved through migration — zero disruption.**

### 4.5 Full Config Inheritance Specification

When `createSession` clones from the template agent (the default session agent), **every field** that defines the manager's identity and capabilities must be copied. Here is the exhaustive field-by-field specification:

| Field | Source | Notes |
|---|---|---|
| `agentId` | Generated | `<profileId>--s<N>` format |
| `displayName` | Generated | Same as agentId |
| `role` | Fixed | Always `"manager"` |
| `managerId` | Self-referencing | `= agentId` (same as all managers) |
| `archetypeId` | **Cloned from template** | `"manager"` — ensures same system prompt archetype |
| `profileId` | Set to profile id | Links to the owning profile |
| `sessionLabel` | From options or default | `"Session N"` or user-provided label |
| `status` | Fixed | `"idle"` |
| `createdAt` | Generated | Current timestamp |
| `updatedAt` | Generated | Current timestamp |
| `cwd` | **Cloned from template** | Same working directory |
| `model` | **Cloned from template** (deep copy) | Same `{ provider, modelId, thinkingLevel }` |
| `sessionFile` | Generated | `<sessionsDir>/<agentId>.jsonl` |
| `contextUsage` | `undefined` | Fresh session, no context yet |
| `mergedAt` | `undefined` | No merge yet |

**What this inherits indirectly:**
- **System prompt:** `resolveSystemPromptForDescriptor` uses `archetypeId` → archetype prompt registry → same prompt.
- **Skills:** `getMemoryRuntimeResources` calls `skillMetadataService.getAdditionalSkillPaths()` — global, same for all agents.
- **CWD:** Copied from template. `getSwarmContextFiles(cwd)` will resolve the same `SWARM.md` files.
- **Integration access:** Integrations route to the profile's default session. Non-default sessions can be targeted explicitly in v2.
- **Base memory read access:** `getMemoryRuntimeResources` injects the profile base memory as read-only context for non-default sessions.

---

## 5. Memory Model

### 5.1 Memory File Layout

```
~/.middleman/memory/
├── opus-manager.md              ← profile base memory (shared identity, durable)
├── opus-manager--s2.md          ← session s2's writable memory
└── opus-manager--s3.md          ← session s3's writable memory (may be merged & cleared)
```

### 5.2 Root Session vs. Non-Default Sessions

**Root session** (`opus-manager`): Uses the profile base memory file directly. Its `resolveMemoryOwnerAgentId()` returns itself, which maps to `opus-manager.md`. This is exactly how it works today — zero change.

**Non-default sessions** (`opus-manager--s2`): Get their own session memory file (`opus-manager--s2.md`). Their runtimes load **two** memory contexts:
1. Profile base memory — injected as **read-only reference** in the system prompt context.
2. Session memory — set as the writable `SWARM_MEMORY_FILE`.

### 5.3 Runtime Memory Resolution

**File:** `apps/backend/src/swarm/swarm-manager.ts` — `getMemoryRuntimeResources`

Currently returns one `memoryContextFile`. Extended to compose base + session memory for non-default sessions:

```ts
protected async getMemoryRuntimeResources(descriptor: AgentDescriptor): Promise<{
  memoryContextFile: { path: string; content: string }
  additionalSkillPaths: string[]
}> {
  const memoryOwnerAgentId = this.resolveMemoryOwnerAgentId(descriptor)
  const memoryFilePath = this.getAgentMemoryPath(memoryOwnerAgentId)
  await this.ensureAgentMemoryFile(memoryOwnerAgentId)

  const sessionMemoryContent = await readFile(memoryFilePath, 'utf8')

  // For non-default session agents: inject profile base memory as read-only
  let combinedContent = sessionMemoryContent
  if (
    descriptor.role === 'manager' &&
    descriptor.profileId &&
    descriptor.agentId !== descriptor.profileId
  ) {
    const baseMemoryPath = this.getAgentMemoryPath(descriptor.profileId)
    try {
      const baseMemoryContent = await readFile(baseMemoryPath, 'utf8')
      combinedContent = [
        '# Profile Memory (read-only — shared across all sessions)',
        '',
        baseMemoryContent,
        '',
        '---',
        '',
        '# Session Memory (writable — specific to this session)',
        '',
        sessionMemoryContent,
      ].join('\n')
    } catch {
      // Base memory may not exist yet — continue with session memory only
    }
  }

  await this.skillMetadataService.ensureSkillMetadataLoaded()

  return {
    memoryContextFile: { path: memoryFilePath, content: combinedContent },
    additionalSkillPaths: this.skillMetadataService.getAdditionalSkillPaths(),
  }
}
```

For Codex runtime: `SWARM_MEMORY_FILE` env var points to the session memory file. Base memory is injected into the system prompt by `RuntimeFactory.buildCodexRuntimeSystemPrompt`.

**Worker memory resolution:** `resolveMemoryOwnerAgentId(workerDescriptor)` returns `workerDescriptor.managerId`, which is the session agent id. Workers read their session's memory — correct behavior, no change needed.

### 5.4 Memory Merge

#### On-demand merge (v1 default)

User explicitly triggers `merge_session_memory` for a session. The merge:

1. Reads the session memory file.
2. Reads the profile base memory file.
3. Spawns a short-lived merger worker (using the existing `"merger"` archetype) with both files as context, instructing it to produce an updated base memory.
4. Writes the updated base memory.
5. Sets `mergedAt` on the session descriptor.
6. Emits `session_memory_merged` event.

#### Per-profile merge serialization (from Track B)

**File:** `apps/backend/src/swarm/swarm-manager.ts`

```ts
private readonly profileMergeMutexes = new Map<string, Promise<void>>()

private async acquireMergeLock(profileId: string): Promise<() => void> {
  // Chain on existing promise for this profile
  const current = this.profileMergeMutexes.get(profileId) ?? Promise.resolve()
  let releaseFn: () => void
  const next = new Promise<void>((resolve) => { releaseFn = resolve })
  this.profileMergeMutexes.set(profileId, next)
  await current
  return releaseFn!
}
```

This ensures two sessions merging into the same base memory are serialized, preventing concurrent write corruption.

#### Merge failure handling (from Track B)

If the merge fails (worker error, timeout, file I/O error):
- The session descriptor's `mergedAt` remains unset.
- Emit `session_memory_merge_failed` event with error message.
- Session memory file is preserved (not deleted).
- UI can show "merge pending" state.

#### Merge trigger model

v1 uses explicit, on-demand `merge_session_memory` calls. A follow-up phase adds a scheduled **Memory Custodian** manager that performs periodic consolidation automatically across unmerged sessions.

---

## 6. Protocol Changes

### 6.1 New Shared Types

**File:** `packages/protocol/src/shared-types.ts`

```ts
export interface ManagerProfile {
  profileId: string
  displayName: string
  defaultSessionAgentId: string
  createdAt: string
  updatedAt: string
}

// AgentDescriptor gains: profileId?, sessionLabel?, mergedAt?
```

### 6.2 New Client Commands

**File:** `packages/protocol/src/client-commands.ts`

```ts
export type ClientCommand =
  // ... existing commands unchanged ...
  | { type: 'create_session'; profileId: string; label?: string; requestId?: string }
  | { type: 'stop_session'; agentId: string; requestId?: string }
  | { type: 'resume_session'; agentId: string; requestId?: string }
  | { type: 'fork_session'; sourceAgentId: string; label?: string; requestId?: string }
  | { type: 'rename_session'; agentId: string; label: string; requestId?: string }
  | { type: 'merge_session_memory'; agentId: string; requestId?: string }
  | { type: 'delete_session'; agentId: string; requestId?: string }
```

**No `switch_session` command.** Sessions are agents. The existing `subscribe` command with `agentId` handles switching the UI view. The existing `user_message` with `agentId` targets a specific session. This is the key simplification of the sessions-as-agents architecture.

### 6.3 New Server Events

**File:** `packages/protocol/src/server-events.ts`

```ts
export interface SessionCreatedEvent {
  type: 'session_created'
  profile: ManagerProfile
  sessionAgent: AgentDescriptor
  requestId?: string
}

export interface SessionStoppedEvent {
  type: 'session_stopped'
  profileId: string
  agentId: string
  terminatedWorkerIds: string[]
  requestId?: string
}

export interface SessionResumedEvent {
  type: 'session_resumed'
  profileId: string
  agentId: string
  requestId?: string
}

export interface SessionForkedEvent {
  type: 'session_forked'
  sourceAgentId: string
  newSessionAgent: AgentDescriptor
  profile: ManagerProfile
  requestId?: string
}

export interface SessionDeletedEvent {
  type: 'session_deleted'
  profileId: string
  agentId: string
  deletedWorkerIds: string[]
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

export interface SessionMemoryMergeStartedEvent {
  type: 'session_memory_merge_started'
  agentId: string
  requestId?: string
}

export interface SessionMemoryMergedEvent {
  type: 'session_memory_merged'
  agentId: string
  mergedAt: string
  requestId?: string
}

export interface SessionMemoryMergeFailedEvent {
  type: 'session_memory_merge_failed'
  agentId: string
  message: string
  requestId?: string
}

// Add to ServerEvent union:
export type ServerEvent =
  // ... existing event types ...
  | SessionCreatedEvent
  | SessionStoppedEvent
  | SessionResumedEvent
  | SessionForkedEvent
  | SessionDeletedEvent
  | SessionRenamedEvent
  | ProfilesSnapshotEvent
  | SessionMemoryMergeStartedEvent
  | SessionMemoryMergedEvent
  | SessionMemoryMergeFailedEvent
```

### 6.4 Backward Compatibility

| Concern | Resolution |
|---|---|
| Old clients see session agents | They appear as normal manager agents in `agents_snapshot`. `profileId` field is optional and ignored. |
| Old clients receive `profiles_snapshot` | Unknown event type — silently ignored. |
| Old clients receive lifecycle/merge events | Unknown event types — silently ignored. |
| `subscribe`, `user_message`, `kill_agent` | Work unchanged with session agent ids. |
| `/new` command | Still works — creates a new session and emits `conversation_reset`. |
| Rollback to pre-multi-session build | `profiles` array in `agents.json` silently ignored. `profileId`/`sessionLabel`/`mergedAt` on descriptors silently ignored. Session agents appear as separate managers — functional but ungrouped. Original manager works exactly as before. |

---

## 7. Backend Changes

### 7.1 SwarmManager — New State

**File:** `apps/backend/src/swarm/swarm-manager.ts`

```ts
// New instance state
private readonly profiles = new Map<string, ManagerProfile>()
private readonly profileMergeMutexes = new Map<string, Promise<void>>()
```

### 7.2 SwarmManager — New Public Methods

```ts
// Profile listing
listProfiles(): ManagerProfile[]

// Session lifecycle
async createSession(
  profileId: string,
  options?: { label?: string }
): Promise<{ profile: ManagerProfile; sessionAgent: AgentDescriptor }>

async stopSession(agentId: string): Promise<{ terminatedWorkerIds: string[] }>
async resumeSession(agentId: string): Promise<void>
async forkSession(
  sourceAgentId: string,
  options?: { label?: string }
): Promise<{ profile: ManagerProfile; sourceAgentId: string; newSessionAgent: AgentDescriptor }>
async deleteSession(agentId: string): Promise<{ deletedWorkerIds: string[] }>

async renameSession(agentId: string, label: string): Promise<void>

// Memory merge
async mergeSessionMemory(agentId: string): Promise<void>
```

### 7.3 `createSession` — Implementation Sketch

```ts
async createSession(
  profileId: string,
  options?: { label?: string }
): Promise<{ profile: ManagerProfile; sessionAgent: AgentDescriptor }> {
  const profile = this.profiles.get(profileId)
  if (!profile) throw new Error(`Unknown profile: ${profileId}`)

  // Find the template: the default session agent
  const templateAgent = this.descriptors.get(profile.defaultSessionAgentId)
  if (!templateAgent) throw new Error(`Profile default agent missing: ${profile.defaultSessionAgentId}`)

  // Generate unique session agent id
  const sessionNumber = this.nextSessionNumber(profileId)
  const sessionAgentId = `${profileId}--s${sessionNumber}`

  const now = this.now()
  const descriptor: AgentDescriptor = {
    // Identity
    agentId: sessionAgentId,
    displayName: sessionAgentId,
    role: 'manager',
    managerId: sessionAgentId,        // self-referencing, same as all managers

    // FULL CONFIG INHERITANCE from template
    archetypeId: templateAgent.archetypeId,     // same archetype → same system prompt
    cwd: templateAgent.cwd,                      // same working directory
    model: { ...templateAgent.model },           // same model (deep copy)

    // Session metadata
    profileId,
    sessionLabel: options?.label ?? `Session ${sessionNumber}`,
    status: 'idle',
    createdAt: now,
    updatedAt: now,
    sessionFile: join(this.config.paths.sessionsDir, `${sessionAgentId}.jsonl`),
  }

  this.descriptors.set(sessionAgentId, descriptor)

  // Ensure session memory file exists
  await this.ensureAgentMemoryFile(sessionAgentId)

  // Create runtime (same path as createManager)
  const runtime = await this.createRuntimeForDescriptor(
    descriptor,
    this.resolveSystemPromptForDescriptor(descriptor)
  )
  this.runtimes.set(sessionAgentId, runtime)

  const contextUsage = runtime.getContextUsage()
  descriptor.contextUsage = contextUsage

  await this.saveStore()

  this.emitStatus(sessionAgentId, descriptor.status, runtime.getPendingCount(), contextUsage)
  this.emitAgentsSnapshot()
  this.emitProfilesSnapshot()

  return { profile, sessionAgent: cloneDescriptor(descriptor) }
}

private nextSessionNumber(profileId: string): number {
  let max = 1
  for (const descriptor of this.descriptors.values()) {
    if (descriptor.profileId !== profileId) continue
    if (descriptor.agentId === profileId) continue // skip root
    const match = descriptor.agentId.match(/--s(\d+)$/)
    if (match) {
      max = Math.max(max, parseInt(match[1], 10) + 1)
    }
  }
  // Ensure uniqueness
  while (this.descriptors.has(`${profileId}--s${max}`)) {
    max++
  }
  return max
}
```

### 7.4 Session Lifecycle Methods — Implementation Sketches

#### `stopSession`

Stops runtime + workers, keeps descriptor/history/memory intact, and leaves the session **idle**.

```ts
async stopSession(agentId: string): Promise<{ terminatedWorkerIds: string[] }> {
  const descriptor = this.descriptors.get(agentId)
  if (!descriptor || descriptor.role !== 'manager' || !descriptor.profileId) {
    throw new Error(`Unknown session agent: ${agentId}`)
  }

  // Terminate workers owned by this session
  const terminatedWorkerIds: string[] = []
  for (const workerDescriptor of Array.from(this.descriptors.values())) {
    if (workerDescriptor.role !== 'worker') continue
    if (workerDescriptor.managerId !== agentId) continue

    terminatedWorkerIds.push(workerDescriptor.agentId)
    await this.terminateDescriptor(workerDescriptor, { abort: true, emitStatus: true })
    this.descriptors.delete(workerDescriptor.agentId)
    this.conversationProjector.deleteConversationHistory(workerDescriptor.agentId)
  }

  // Stop runtime for this session (descriptor remains)
  const runtime = this.runtimes.get(agentId)
  if (runtime) {
    await runtime.abortAll('session_stopped')
    this.runtimes.delete(agentId)
  }

  descriptor.status = 'idle'
  descriptor.updatedAt = this.now()

  await this.saveStore()
  this.emitAgentsSnapshot()
  this.emitProfilesSnapshot()

  return { terminatedWorkerIds }
}
```

#### `resumeSession`

Resumes an idle session by creating a fresh runtime. Conversation history is loaded from the session JSONL.

```ts
async resumeSession(agentId: string): Promise<void> {
  const descriptor = this.descriptors.get(agentId)
  if (!descriptor || descriptor.role !== 'manager' || !descriptor.profileId) {
    throw new Error(`Unknown session agent: ${agentId}`)
  }
  if (this.runtimes.has(agentId)) {
    return // already running
  }

  const runtime = await this.createRuntimeForDescriptor(
    descriptor,
    this.resolveSystemPromptForDescriptor(descriptor)
  )
  this.runtimes.set(agentId, runtime)

  descriptor.status = 'idle'
  descriptor.contextUsage = runtime.getContextUsage()
  descriptor.updatedAt = this.now()

  await this.saveStore()
  this.emitStatus(agentId, descriptor.status, runtime.getPendingCount(), descriptor.contextUsage)
  this.emitAgentsSnapshot()
  this.emitProfilesSnapshot()
}
```

#### `deleteSession`

The only destructive lifecycle action. Permanently removes session descriptor + JSONL history + session memory.

```ts
async deleteSession(agentId: string): Promise<{ deletedWorkerIds: string[] }> {
  const descriptor = this.descriptors.get(agentId)
  if (!descriptor || descriptor.role !== 'manager' || !descriptor.profileId) {
    throw new Error(`Unknown session agent: ${agentId}`)
  }

  const profile = this.profiles.get(descriptor.profileId)
  if (profile && profile.defaultSessionAgentId === agentId) {
    throw new Error(`Cannot delete the default/root session for profile ${descriptor.profileId}`)
  }

  // Ensure runtime/workers are stopped first
  const { terminatedWorkerIds } = await this.stopSession(agentId)

  this.descriptors.delete(agentId)
  this.conversationProjector.deleteConversationHistory(agentId)

  await rm(descriptor.sessionFile, { force: true })
  await rm(this.getAgentMemoryPath(agentId), { force: true })

  await this.saveStore()
  this.emitAgentsSnapshot()
  this.emitProfilesSnapshot()

  return { deletedWorkerIds: terminatedWorkerIds }
}
```

#### `forkSession`

Creates a new session by cloning profile template config and duplicating source conversation history.

Backend flow:
1. Validate source is a session agent (`role === 'manager'` and `profileId` present).
2. Create new session agent from profile template (same config cloning as `createSession`).
3. Copy source JSONL conversation file to the new session JSONL path.
4. Create a fresh session memory file with fork header.
5. Spin up runtime for the new session (loads copied history).
6. Emit `session_forked` + `agents_snapshot` + `profiles_snapshot`.

```ts
async forkSession(
  sourceAgentId: string,
  options?: { label?: string }
): Promise<{ profile: ManagerProfile; sourceAgentId: string; newSessionAgent: AgentDescriptor }> {
  // 1) Validate source is a session manager agent
  const source = this.descriptors.get(sourceAgentId)
  if (!source || source.role !== 'manager' || !source.profileId) {
    throw new Error(`Invalid source session: ${sourceAgentId}`)
  }

  // 2) Create new session agent from profile template (same as createSession)
  const { profile, sessionAgent } = await this.createSession(source.profileId, {
    label: options?.label,
  })

  // Stop the just-created runtime so we can seed files before final resume
  await this.stopSession(sessionAgent.agentId)

  // 3) Copy source JSONL to new session JSONL path (full history duplication)
  await copyFile(source.sessionFile, sessionAgent.sessionFile)

  // 4) Create fresh session memory with fork header
  const sourceLabel = source.sessionLabel ?? source.agentId
  const header = [
    '# Session Memory',
    `> Forked from session "${sourceLabel}" (${sourceAgentId}) on ${this.now()}`,
    '> Parent session conversation history was duplicated at fork time.',
    '',
  ].join('\n')
  await writeFile(this.getAgentMemoryPath(sessionAgent.agentId), header, 'utf8')

  // 5) Resume runtime for new session (loads copied conversation history)
  await this.resumeSession(sessionAgent.agentId)

  // 6) Emit lifecycle + snapshots
  this.emit('session_forked', {
    type: 'session_forked',
    sourceAgentId,
    newSessionAgent: cloneDescriptor(this.descriptors.get(sessionAgent.agentId)!),
    profile,
  } satisfies ServerEvent)
  this.emitAgentsSnapshot()
  this.emitProfilesSnapshot()

  return {
    profile,
    sourceAgentId,
    newSessionAgent: cloneDescriptor(this.descriptors.get(sessionAgent.agentId)!),
  }
}
```

### 7.5 `mergeSessionMemory` — Implementation Sketch

```ts
async mergeSessionMemory(agentId: string): Promise<void> {
  const descriptor = this.descriptors.get(agentId)
  if (!descriptor || descriptor.role !== 'manager' || !descriptor.profileId) {
    throw new Error(`Invalid session for merge: ${agentId}`)
  }

  const profileId = descriptor.profileId

  // Emit started event
  this.emit('session_memory_merge_started', {
    type: 'session_memory_merge_started',
    agentId,
  } satisfies ServerEvent)

  // Acquire per-profile merge lock
  const releaseLock = await this.acquireMergeLock(profileId)

  try {
    const sessionMemoryPath = this.getAgentMemoryPath(agentId)
    const baseMemoryPath = this.getAgentMemoryPath(profileId)

    const sessionMemory = await readFile(sessionMemoryPath, 'utf8')
    const baseMemory = await readFile(baseMemoryPath, 'utf8')

    if (sessionMemory.trim().length === 0) {
      // Nothing to merge
      descriptor.mergedAt = this.now()
      descriptor.updatedAt = this.now()
      await this.saveStore()

      this.emit('session_memory_merged', {
        type: 'session_memory_merged',
        agentId,
        mergedAt: descriptor.mergedAt,
      } satisfies ServerEvent)
      return
    }

    // Spawn a merger worker to combine memories
    // Uses the existing merger archetype
    const mergePrompt = [
      'You have two memory files to merge.',
      '',
      '## Base Memory (the durable profile memory):',
      '```',
      baseMemory,
      '```',
      '',
      '## Session Memory (learnings from a specific session):',
      '```',
      sessionMemory,
      '```',
      '',
      'Produce an updated base memory that incorporates any new facts, decisions, or preferences from the session memory.',
      'Preserve the existing structure and sections. Add new items; do not remove existing items unless the session explicitly contradicts them.',
      'Output ONLY the final merged memory content (no code fences, no explanation).',
    ].join('\n')

    // Implementation: Use a synchronous merge approach for v1
    // (spawn a short-lived worker, wait for output, extract result)
    // Full implementation details in Phase 3

    const mergedContent = await this.executeMergeWorker(profileId, mergePrompt)
    await writeFile(baseMemoryPath, mergedContent, 'utf8')

    descriptor.mergedAt = this.now()
    descriptor.updatedAt = this.now()
    await this.saveStore()

    this.emit('session_memory_merged', {
      type: 'session_memory_merged',
      agentId,
      mergedAt: descriptor.mergedAt,
    } satisfies ServerEvent)

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    this.emit('session_memory_merge_failed', {
      type: 'session_memory_merge_failed',
      agentId,
      message,
    } satisfies ServerEvent)

    throw error
  } finally {
    releaseLock()
  }
}
```

### 7.6 `resetManagerSession` — Revised

The existing `/new` command calls `resetManagerSession`. Change it to create a new session:

```ts
async resetManagerSession(
  managerIdOrReason: string | 'user_new_command' | 'api_reset' = 'api_reset',
  maybeReason?: 'user_new_command' | 'api_reset'
): Promise<void> {
  const parsed = this.parseResetManagerSessionArgs(managerIdOrReason, maybeReason)
  const managerId = parsed.managerId
  const reason = parsed.reason

  const descriptor = this.getRequiredManagerDescriptor(managerId)
  const profileId = descriptor.profileId ?? descriptor.agentId

  // Create a new session under this profile
  const { sessionAgent } = await this.createSession(profileId, { label: 'New chat' })

  // Emit conversation_reset so the subscribed UI clears and knows to switch
  this.emitConversationReset(managerId, reason)

  // The old session keeps running with its workers.
  // The UI will receive agents_snapshot with the new session agent
  // and can auto-navigate to it.

  this.logDebug('manager:reset:new_session', {
    managerId,
    reason,
    newSessionAgentId: sessionAgent.agentId,
  })
}
```

### 7.7 `createManager` — Revised

When a new manager is created, also create a profile:

```ts
async createManager(
  callerAgentId: string,
  input: { name: string; cwd: string; model?: SwarmModelPreset }
): Promise<AgentDescriptor> {
  // ... existing descriptor creation logic (unchanged) ...

  // NEW: Create a profile for this manager
  const profile: ManagerProfile = {
    profileId: descriptor.agentId,
    displayName: descriptor.displayName,
    defaultSessionAgentId: descriptor.agentId,
    createdAt: descriptor.createdAt,
    updatedAt: descriptor.createdAt,
  }
  this.profiles.set(profile.profileId, profile)

  // Set profileId on the manager descriptor
  descriptor.profileId = descriptor.agentId

  // ... existing runtime creation, bootstrap message, save (unchanged) ...

  this.emitProfilesSnapshot()
  return cloneDescriptor(descriptor)
}
```

### 7.8 `deleteManager` — Revised

Deleting a manager profile deletes ALL its session agents and their workers:

```ts
async deleteManager(
  callerAgentId: string,
  targetManagerId: string
): Promise<{ managerId: string; terminatedWorkerIds: string[] }> {
  this.assertManager(callerAgentId, 'delete managers')

  // targetManagerId is the profile id (= original manager agent id)
  const profile = this.profiles.get(targetManagerId)

  // Find all session agents for this profile
  const sessionAgents = Array.from(this.descriptors.values())
    .filter(d => d.profileId === targetManagerId && d.role === 'manager')

  // If no profile found, fall back to single-agent delete (backward compat)
  if (!profile && sessionAgents.length === 0) {
    // Existing single-agent delete logic...
    const target = this.descriptors.get(targetManagerId)
    if (!target || target.role !== 'manager') {
      throw new Error(`Unknown manager: ${targetManagerId}`)
    }
    sessionAgents.push(target)
  }

  const terminatedWorkerIds: string[] = []

  for (const sessionAgent of sessionAgents) {
    // Terminate workers
    for (const worker of Array.from(this.descriptors.values())) {
      if (worker.role !== 'worker' || worker.managerId !== sessionAgent.agentId) continue
      terminatedWorkerIds.push(worker.agentId)
      await this.terminateDescriptor(worker, { abort: true, emitStatus: true })
      this.descriptors.delete(worker.agentId)
      this.conversationProjector.deleteConversationHistory(worker.agentId)
    }

    // Terminate session agent
    await this.terminateDescriptor(sessionAgent, { abort: true, emitStatus: true })
    this.descriptors.delete(sessionAgent.agentId)
    this.conversationProjector.deleteConversationHistory(sessionAgent.agentId)
  }

  if (profile) {
    this.profiles.delete(targetManagerId)
  }

  await this.saveStore()
  this.emitAgentsSnapshot()
  this.emitProfilesSnapshot()

  return { managerId: targetManagerId, terminatedWorkerIds }
}
```

### 7.9 `boot()` — Profile Reconciliation

Add to `SwarmManager.boot()`, after loading agents and before saving:

```ts
// Boot reconciliation: ensure every manager has a profile
private reconcileProfilesOnBoot(): void {
  for (const descriptor of this.descriptors.values()) {
    if (descriptor.role !== 'manager') continue

    // If this manager has no profileId, it's a pre-migration manager
    if (!descriptor.profileId) {
      descriptor.profileId = descriptor.agentId

      // Create profile if it doesn't exist
      if (!this.profiles.has(descriptor.agentId)) {
        this.profiles.set(descriptor.agentId, {
          profileId: descriptor.agentId,
          displayName: descriptor.displayName,
          defaultSessionAgentId: descriptor.agentId,
          createdAt: descriptor.createdAt,
          updatedAt: descriptor.createdAt,
        })
      }
    }
  }

  // Ensure every profile's defaultSessionAgentId points to a valid agent
  for (const profile of this.profiles.values()) {
    if (!this.descriptors.has(profile.defaultSessionAgentId)) {
      // Profile's default agent was deleted — find another session
      const fallback = Array.from(this.descriptors.values())
        .filter(d => d.profileId === profile.profileId && d.role === 'manager')
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]

      if (fallback) {
        profile.defaultSessionAgentId = fallback.agentId
      }
    }
  }

  // Remove orphaned profiles (no session agents)
  for (const [profileId, _profile] of this.profiles.entries()) {
    const hasSessionAgents = Array.from(this.descriptors.values())
      .some(d => d.profileId === profileId && d.role === 'manager')
    if (!hasSessionAgents) {
      this.profiles.delete(profileId)
    }
  }
}
```

This runs every boot and is idempotent. Add to `boot()` after loading store, before `saveStore`:

```ts
async boot(): Promise<void> {
  // ... existing: ensureDirectories, loadSecrets, reloadSkills, loadArchetypes ...

  const loaded = await this.loadStore()
  for (const descriptor of loaded.agents) {
    this.descriptors.set(descriptor.agentId, descriptor)
  }
  for (const profile of (loaded.profiles ?? [])) {
    this.profiles.set(profile.profileId, profile)
  }

  this.reconcileProfilesOnBoot()  // NEW
  this.normalizeStreamingStatusesForBoot()

  // ... existing: ensureMemoryFiles, saveStore, loadHistories, restoreRuntimes ...
}
```

### 7.10 `emitProfilesSnapshot` — New Helper

```ts
private emitProfilesSnapshot(): void {
  const payload: ProfilesSnapshotEvent = {
    type: 'profiles_snapshot',
    profiles: this.listProfiles(),
  }
  this.emit('profiles_snapshot', payload satisfies ServerEvent)
}
```

### 7.11 `spawnAgent` — No Changes Needed

Workers bind to their owning session agent via `managerId: manager.agentId`. Since each session agent is a normal manager, the existing `spawnAgent` path works:

```ts
// Existing code — no change needed:
const descriptor: AgentDescriptor = {
  agentId,
  managerId: manager.agentId,  // This IS the session agent id
  // ...
}
```

Workers of session `opus-manager--s2` will have `managerId: "opus-manager--s2"`. Their memory resolves to `opus-manager--s2.md` via `resolveMemoryOwnerAgentId`. Their conversation events route to the session agent's context. All correct.

### 7.12 PersistenceService — Minimal Changes

**File:** `apps/backend/src/swarm/persistence-service.ts`

```ts
// Extend dependencies interface
interface PersistenceServiceDependencies {
  // ... existing ...
  sortedProfiles: () => ManagerProfile[]    // NEW
}

// Extend loadStore
async loadStore(): Promise<AgentsStoreFile> {
  // ... existing agent loading ...
  return {
    agents: validAgents,
    profiles: Array.isArray(parsed.profiles) ? parsed.profiles : [],  // NEW
  }
}

// Extend saveStore
async saveStore(): Promise<void> {
  const payload: AgentsStoreFile = {
    agents: this.deps.sortedDescriptors(),
    profiles: this.deps.sortedProfiles(),    // NEW
  }
  // ... existing atomic write ...
}
```

### 7.13 RuntimeFactory, ConversationProjector — NO Changes

These are the three most complex modules. The sessions-as-agents architecture means:

- **RuntimeFactory**: Takes an `AgentDescriptor`, creates a runtime. Doesn't care about profiles or sessions.
- **ConversationProjector**: Keys everything by `agentId`. Each session agent is a separate `agentId`. All history, events, and trimming work without modification.
- **AgentRuntime / CodexAgentRuntime**: Unchanged.

### 7.14 Integration Routing — NO Changes for v1

**Files:** `apps/backend/src/integrations/slack/slack-router.ts`, `apps/backend/src/integrations/telegram/telegram-router.ts`

Both routers set `this.managerId` during integration setup and call `handleUserMessage(text, { targetAgentId: this.managerId })`. Since `this.managerId` is the profile id which IS the default session agent id, inbound messages route to the root session. This remains correct in v1 because that root session is non-deletable and resumable.

### 7.15 Scheduler — NO Changes for v1

**File:** `apps/backend/src/scheduler/cron-scheduler-service.ts`

The scheduler targets `this.managerId` which equals the profile id = default session agent id. Works unchanged.

### 7.16 `collectManagerIds` — Filter for Profile Managers

**File:** `apps/backend/src/index.ts`

The existing `collectManagerIds` function finds all manager-role agents. With multi-session, this would include session agents, which would spin up duplicate integrations/schedulers. Filter to profile managers only:

```ts
function collectManagerIds(agents: unknown[], fallbackManagerId?: string): Set<string> {
  const managerIds = new Set<string>()

  for (const agent of agents) {
    if (!agent || typeof agent !== 'object' || Array.isArray(agent)) continue
    const descriptor = agent as Partial<AgentDescriptor>
    if (descriptor.role !== 'manager') continue
    if (typeof descriptor.agentId !== 'string' || descriptor.agentId.trim().length === 0) continue

    // NEW: Only include profile root managers (not session agents)
    // A session agent has profileId set AND profileId !== agentId
    const profileId = (descriptor as any).profileId as string | undefined
    if (profileId && profileId !== descriptor.agentId.trim()) {
      continue  // Skip non-default session agents
    }

    managerIds.add(descriptor.agentId.trim())
  }

  // ... existing fallback logic ...
  return managerIds
}
```

---

## 8. Frontend/UI Changes

### 8.1 WS State

**File:** `apps/ui/src/lib/ws-state.ts`

```ts
import type { ManagerProfile } from '@middleman/protocol'

export interface ManagerWsState {
  // ... all existing fields unchanged ...
  profiles: ManagerProfile[]     // NEW
}

export function createInitialManagerWsState(targetAgentId: string | null): ManagerWsState {
  return {
    // ... existing ...
    profiles: [],                // NEW
  }
}
```

### 8.2 WS Client

**File:** `apps/ui/src/lib/ws-client.ts`

Add to `WsRequestResultMap`:

```ts
type WsRequestResultMap = {
  // ... existing ...
  create_session: { profile: ManagerProfile; sessionAgent: AgentDescriptor }
  stop_session: { profileId: string; agentId: string; terminatedWorkerIds: string[] }
  resume_session: { profileId: string; agentId: string }
  fork_session: { sourceAgentId: string; profile: ManagerProfile; newSessionAgent: AgentDescriptor }
  rename_session: { agentId: string; label: string }
  merge_session_memory: { agentId: string; mergedAt: string }
  delete_session: { profileId: string; agentId: string; deletedWorkerIds: string[] }
}
```

Add to `handleServerEvent`:

```ts
case 'profiles_snapshot':
  this.updateState({ profiles: event.profiles })
  break

case 'session_created':
  this.requestTracker.resolve('create_session', event.requestId, {
    profile: event.profile,
    sessionAgent: event.sessionAgent,
  })
  break

case 'session_stopped':
  this.requestTracker.resolve('stop_session', event.requestId, {
    profileId: event.profileId,
    agentId: event.agentId,
    terminatedWorkerIds: event.terminatedWorkerIds,
  })
  break

case 'session_resumed':
  this.requestTracker.resolve('resume_session', event.requestId, {
    profileId: event.profileId,
    agentId: event.agentId,
  })
  break

case 'session_forked':
  this.requestTracker.resolve('fork_session', event.requestId, {
    sourceAgentId: event.sourceAgentId,
    profile: event.profile,
    newSessionAgent: event.newSessionAgent,
  })
  this.subscribeToAgent(event.newSessionAgent.agentId) // auto-navigate to fork
  break

case 'session_deleted':
  this.requestTracker.resolve('delete_session', event.requestId, {
    profileId: event.profileId,
    agentId: event.agentId,
    deletedWorkerIds: event.deletedWorkerIds,
  })
  break

case 'session_renamed':
  this.requestTracker.resolve('rename_session', event.requestId, {
    agentId: event.agentId,
    label: event.label,
  })
  break

case 'session_memory_merged':
  this.requestTracker.resolve('merge_session_memory', event.requestId, {
    agentId: event.agentId,
    mergedAt: event.mergedAt,
  })
  break

case 'session_memory_merge_failed':
  this.requestTracker.rejectByRequestId(
    event.requestId,
    new Error(`Memory merge failed: ${event.message}`)
  )
  break
```

Add public methods:

```ts
async createSession(profileId: string, label?: string) {
  return this.enqueueRequest('create_session', (requestId) => ({
    type: 'create_session', profileId, label, requestId,
  }))
}

async stopSession(agentId: string) {
  return this.enqueueRequest('stop_session', (requestId) => ({
    type: 'stop_session', agentId, requestId,
  }))
}

async resumeSession(agentId: string) {
  return this.enqueueRequest('resume_session', (requestId) => ({
    type: 'resume_session', agentId, requestId,
  }))
}

async forkSession(sourceAgentId: string, label?: string) {
  return this.enqueueRequest('fork_session', (requestId) => ({
    type: 'fork_session', sourceAgentId, label, requestId,
  }))
}

async renameSession(agentId: string, label: string) {
  return this.enqueueRequest('rename_session', (requestId) => ({
    type: 'rename_session', agentId, label, requestId,
  }))
}

async mergeSessionMemory(agentId: string) {
  return this.enqueueRequest('merge_session_memory', (requestId) => ({
    type: 'merge_session_memory', agentId, requestId,
  }))
}

async deleteSession(agentId: string) {
  return this.enqueueRequest('delete_session', (requestId) => ({
    type: 'delete_session', agentId, requestId,
  }))
}
```

### 8.3 Agent Hierarchy

**File:** `apps/ui/src/lib/agent-hierarchy.ts`

```ts
import type { AgentDescriptor, ManagerProfile } from '@middleman/protocol'

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
  profiles: ManagerProfile[],
): {
  profileRows: ProfileTreeRow[]
  orphanManagers: ManagerTreeRow[]
  orphanWorkers: AgentDescriptor[]
} {
  const activeAgents = agents.filter(isActiveAgent)
  const profileMap = new Map(profiles.map(p => [p.profileId, p]))

  // Group managers by profileId
  const sessionsByProfile = new Map<string, AgentDescriptor[]>()
  const orphanManagers: ManagerTreeRow[] = []

  for (const agent of activeAgents) {
    if (agent.role !== 'manager') continue

    if (agent.profileId && profileMap.has(agent.profileId)) {
      const sessions = sessionsByProfile.get(agent.profileId) ?? []
      sessions.push(agent)
      sessionsByProfile.set(agent.profileId, sessions)
    } else {
      // Legacy manager without profile — show as standalone
      orphanManagers.push({
        manager: agent,
        workers: activeAgents.filter(w => w.role === 'worker' && w.managerId === agent.agentId),
      })
    }
  }

  // Group workers by managerId (session agent id)
  const workersByManager = new Map<string, AgentDescriptor[]>()
  const assignedWorkerIds = new Set<string>()
  for (const worker of activeAgents.filter(a => a.role === 'worker')) {
    const entries = workersByManager.get(worker.managerId) ?? []
    entries.push(worker)
    workersByManager.set(worker.managerId, entries)
    assignedWorkerIds.add(worker.agentId)
  }

  // Build profile rows
  const profileRows: ProfileTreeRow[] = []
  for (const profile of profiles) {
    const sessionAgents = (sessionsByProfile.get(profile.profileId) ?? [])
      .sort(byCreatedAtThenId)

    const sessions: SessionRow[] = sessionAgents.map(sa => ({
      sessionAgent: sa,
      workers: (workersByManager.get(sa.agentId) ?? []).sort(byCreatedAtThenId),
      isDefault: sa.agentId === profile.defaultSessionAgentId,
    }))

    if (sessions.length > 0) {
      profileRows.push({ profile, sessions })
    }
  }

  // Orphan workers: workers whose managerId doesn't match any known agent
  const allManagerIds = new Set(activeAgents.filter(a => a.role === 'manager').map(a => a.agentId))
  const orphanWorkers = activeAgents
    .filter(a => a.role === 'worker' && !allManagerIds.has(a.managerId))
    .sort(byCreatedAtThenId)

  return { profileRows, orphanManagers, orphanWorkers }
}

// Existing functions preserved:
export { isActiveAgent, getPrimaryManagerId, chooseFallbackAgentId, buildManagerTreeRows }
```

### 8.4 Sidebar

**File:** `apps/ui/src/components/chat/AgentSidebar.tsx`

Sidebar tree rendering changes to:

```
Profile: "Opus Manager"
  ├── Session: "Main" [default] [🟢 running]   ← click to subscribe
  │   ├── worker: codex-auth-worker
  │   └── worker: codex-test-runner
  │
  ├── Session: "Refactor auth" [🟢 running]
  │   └── worker: opus-reviewer
  │
  ├── Session: "Bug triage" [⚪ idle] [merged ✓]
  │
  └── [+ New Session]
```

**Context menu on session rows:**
- Rename
- Fork
- Stop (if running)
- Resume (if idle)
- Merge Memory
- Delete (confirmation required)

Rules:
- Root/default session is **non-deletable**
- Root/default session **can be stopped/resumed**

**Context menu on profile (manager name):**
- Delete Manager Profile (deletes all sessions + workers)

**"New Manager" button:** Unchanged — creates a profile + default session.

**"New Session" action:** Per-profile button/link. Calls `wsClient.createSession(profileId)`.

### 8.5 Route State

**File:** `apps/ui/src/hooks/index-page/use-route-state.ts`

**No fundamental changes needed.** Session agents are agents, so the existing route state works:

```ts
type AppRouteState =
  | { view: 'chat'; agentId: string }  // agentId IS the session agent id
  | { view: 'settings' }
```

URL examples:
- `/agent/opus-manager` — root session
- `/agent/opus-manager--s2` — second session

The `--s2` suffix in URLs is readable and unambiguous.

### 8.6 Auto-Navigate on `/new` and Fork

When `/new` is typed, the backend creates a new session and emits `conversation_reset` for the current session, plus `agents_snapshot` with the new session. The UI's `applyAgentsSnapshot` in `ws-client.ts` already handles fallback navigation. After receiving the snapshot, the UI should navigate to the new session agent.

Fork should do the same: when `session_forked` arrives, auto-subscribe to `newSessionAgent.agentId`.

```ts
case 'session_created':
  if (event.sessionAgent.agentId) {
    this.subscribeToAgent(event.sessionAgent.agentId)
  }
  break

case 'session_forked':
  if (event.newSessionAgent.agentId) {
    this.subscribeToAgent(event.newSessionAgent.agentId)
  }
  break
```

---

## 9. Integration & Scheduler Routing

### 9.1 Current Behavior (Preserved)

| System | Current target | With multi-session |
|---|---|---|
| Slack messages | `this.managerId` (set at integration setup) | Same — `managerId` = profileId = default session agent id |
| Telegram messages | `this.managerId` | Same |
| Cron scheduled tasks | `this.managerId` | Same |

All inbound messages route to the root/default session. This remains correct because the root session is always addressable (non-deletable).

Operational note: if an inbound message targets an idle session, the backend should resume that session runtime before dispatching the message.

### 9.2 Future: Thread-to-Session Binding (v2)

A Slack thread or Telegram chat could be bound to a specific session:

```ts
// Future: per-thread session override
await swarmManager.handleUserMessage(text, {
  targetAgentId: resolvedSessionAgentId ?? this.managerId,
  // ...
})
```

This is purely additive — add an optional lookup step before the `handleUserMessage` call.

### 9.3 Integration/Scheduler Manager Discovery

**File:** `apps/backend/src/index.ts`

The `collectManagerIds` function must filter out non-default session agents to avoid spinning up duplicate integrations/schedulers. See §7.16 above.

---

## 10. Migration

### 10.1 Boot Reconciliation (Idempotent)

On every boot, `reconcileProfilesOnBoot()` runs:

1. For each manager agent without a `profileId`:
   - Set `descriptor.profileId = descriptor.agentId`
   - Create a `ManagerProfile` with `profileId = agentId`, `defaultSessionAgentId = agentId`

2. Validate all profile references (default session exists, no orphaned profiles).

3. Persist to `agents.json`.

This is **idempotent** — running it multiple times produces the same result.

### 10.2 Existing Data Preservation

| Artifact | Preserved? | Notes |
|---|---|---|
| Manager agent id | ✅ | Unchanged — becomes the profile id AND the root session agent id |
| Manager session file | ✅ | Root session uses the existing session file path |
| Manager memory file | ✅ | Root session uses the existing memory file directly |
| Workers | ✅ | `managerId` still points to the same agent id |
| Conversation history | ✅ | Session file and JSONL entries unchanged |
| Integration config | ✅ | `managerId` references unchanged |
| Cron schedules | ✅ | `managerId` references unchanged |

**Zero-disruption migration.** The user sees their existing manager with a new ability to create additional sessions.

### 10.3 Rollback Safety

If the user rolls back to a pre-multi-session build:
- `profiles` array in `agents.json` is silently ignored (unknown field in `AgentsStoreFile`).
- `profileId`, `sessionLabel`, `mergedAt` on descriptors are silently ignored (the `validateAgentDescriptor` function ignores unknown fields — it only rejects missing required fields).
- Session agents created as `opus-manager--s2` would appear as separate standalone managers in the old UI — functional but visually ungrouped.
- The original manager works exactly as before.

---

## 11. Implementation Phases

### Phase 1: Data Model + Profiles (Backend Only)

**Changes:**
- `packages/protocol/src/shared-types.ts` — Add `ManagerProfile`, extend `AgentDescriptor` with `profileId?`, `sessionLabel?`, `mergedAt?`
- `apps/backend/src/swarm/types.ts` — Mirror protocol additions, extend `AgentsStoreFile` with `profiles?`
- `apps/backend/src/swarm/persistence-service.ts` — Load/save profiles in `agents.json`
- `apps/backend/src/swarm/swarm-manager.ts` — `profiles` map, `reconcileProfilesOnBoot()`, `listProfiles()`, `emitProfilesSnapshot()`

**Test checkpoint:** Boot with existing data → profile auto-created → data round-trips correctly in `agents.json`. `listProfiles()` returns expected profiles. Existing behavior unchanged.

**Risk:** None. Additive-only changes. All new fields optional.

**Depends on:** Nothing.

---

### Phase 2: Session Lifecycle (Backend)

**Changes:**
- `apps/backend/src/swarm/swarm-manager.ts` — `createSession`, `stopSession`, `resumeSession`, `forkSession`, `deleteSession`, `renameSession`, revised `resetManagerSession`, revised `deleteManager`, `nextSessionNumber`

**Test checkpoint:**
- Create session → new agent descriptor with `profileId` and `sessionLabel` → runtime starts → can send messages
- Stop session → runtime removed + workers terminated → session remains visible as idle and resumable
- Resume session → fresh runtime starts → copied JSONL history is available in chat replay
- Fork session → new session created with duplicated conversation history and fork-header session memory, then auto-navigated
- Delete non-root session (with confirmation) → descriptor + JSONL + session memory removed permanently
- Delete root/default session → error thrown (non-deletable policy)
- `/new` → creates new session → old session keeps running → `conversation_reset` emitted
- Delete manager profile → all sessions and workers terminated/deleted → profile removed

**Depends on:** Phase 1.

---

### Phase 3: Memory Isolation + Merge

**Changes:**
- `apps/backend/src/swarm/swarm-manager.ts` — Extended `getMemoryRuntimeResources` for profile base memory injection, `mergeSessionMemory`, `acquireMergeLock`, `profileMergeMutexes`

**Test checkpoint:**
- Root session reads/writes base memory directly (unchanged behavior)
- Non-default session sees combined prompt: base memory (read-only) + session memory (writable)
- Workers of a session read that session's memory
- `mergeSessionMemory` produces combined base memory → `mergedAt` set
- Two concurrent merges on same profile are serialized (second waits for first)
- Merge failure → `mergedAt` unset → `session_memory_merge_failed` emitted

**Depends on:** Phase 2.

---

### Phase 4: Protocol + WS Wiring

**Changes:**
- `packages/protocol/src/client-commands.ts` — Add 7 new command types (`create_session`, `stop_session`, `resume_session`, `fork_session`, `rename_session`, `merge_session_memory`, `delete_session`)
- `packages/protocol/src/server-events.ts` — Add lifecycle + merge events (`session_created`, `session_stopped`, `session_resumed`, `session_forked`, `session_deleted`, `session_renamed`, `profiles_snapshot`, `session_memory_merge_started`, `session_memory_merged`, `session_memory_merge_failed`)
- `apps/backend/src/ws/ws-command-parser.ts` — Parse new commands, extend `extractRequestId`
- `apps/backend/src/ws/routes/session-routes.ts` — **New file**: handle `create_session`, `stop_session`, `resume_session`, `fork_session`, `rename_session`, `merge_session_memory`, `delete_session`
- `apps/backend/src/ws/ws-handler.ts` — Wire `session-routes`, include `profiles_snapshot` in subscription bootstrap, register event broadcasting for new event types
- `apps/backend/src/index.ts` — Filter `collectManagerIds` to exclude non-default session agents

**Test checkpoint:**
- WS client sends `create_session` → receives `session_created` + `agents_snapshot` + `profiles_snapshot`
- WS client sends `fork_session` → receives `session_forked` + snapshots and can auto-subscribe to fork target
- WS client sends `stop_session`/`resume_session`/`delete_session` → receives corresponding lifecycle events
- WS client subscribes to session agent id → receives correct conversation history
- Integration/scheduler only discover profile root managers

**Depends on:** Phase 2 (session lifecycle API contracts must be stable).

---

### Phase 5: UI

**Changes:**
- `apps/ui/src/lib/ws-state.ts` — Add `profiles: ManagerProfile[]`
- `apps/ui/src/lib/ws-client.ts` — Handle new events, add `createSession`, `stopSession`, `resumeSession`, `forkSession`, `renameSession`, `mergeSessionMemory`, `deleteSession` methods, update request tracker
- `apps/ui/src/lib/agent-hierarchy.ts` — Add `ProfileTreeRow`, `SessionRow`, `buildProfileTreeRows`
- `apps/ui/src/components/chat/AgentSidebar.tsx` — Profile → Session → Worker hierarchy, session context menus, "New Session" action
- `apps/ui/src/components/chat/ChatHeader.tsx` — Show session label alongside manager name

**Test checkpoint:**
- Sidebar shows `Profile → Sessions → Workers` hierarchy
- Click session → subscribes to that session agent → shows that session's conversation
- "New Session" → creates session → navigates to it
- Session row shows running (🟢) vs idle (⚪) indicator
- Context menu: Rename, Fork, Stop/Resume, Merge Memory, Delete (with confirmation)
- Default session shows "(default)" badge, Delete is disabled (Stop remains available)

**Depends on:** Phase 4.

---

### Phase 6 (Future): Integration Thread Binding

**Changes (not for v1):**
- `apps/backend/src/integrations/slack/slack-router.ts` — Thread-to-session binding lookup
- `apps/backend/src/integrations/telegram/telegram-router.ts` — Chat-to-session binding
- `apps/backend/src/scheduler/cron-scheduler-service.ts` — Optional `sessionId` on schedules

**Depends on:** Phase 5 complete and stable.

---

### Phase 7 (Follow-up): Memory Custodian Manager

A dedicated **Memory Custodian** manager performs scheduled memory consolidation:

- Runs on cron (e.g. every few hours or daily)
- Scans all profiles for sessions with unmerged memory (`mergedAt` unset and session memory non-empty)
- For each unmerged session, reads session memory + profile base memory and performs intelligent consolidation
- Marks that session `mergedAt` with merge timestamp
- Eliminates routine manual merge clicks in steady-state usage

Implementation uses existing primitives only:
- Manager with a specific archetype/system prompt
- Existing cron scheduler
- Existing memory skill/tooling

No new backend machinery is required.

**Depends on:** Phase 3 and Phase 6 stability. Not blocking v1.

---

### Parallelization Guidance

- Phases 1–3 are backend-only and sequential.
- Phase 4 can start once Phase 2 API contracts are stable (protocol types can be written before backend is complete).
- Phase 5 can start UI scaffolding (hierarchy components, sidebar layout) during Phase 3–4, using mock data.
- Phase 7 is an optional follow-up stream and should not block v1 launch.

---

## 12. Open Questions — RESOLVED

1. **Session naming** — **RESOLVED:** Start with `Session N` naming. Auto-titling is a future enhancement.

2. **Max concurrent sessions** — **RESOLVED:** No cap in v1. Users self-regulate.

3. **Session lifecycle** — **RESOLVED:** Running/idle model. No "closed" state. Delete is permanent. Sessions can always be resumed.

4. **`/new` with active workers** — **RESOLVED:** Leave current session running. `/new` creates a new session.

5. **New session memory** — **RESOLVED:** New sessions start with an empty session memory file. Profile core memory is injected as read-only context.

6. **Merge strategy** — **RESOLVED:** On-demand merge for v1. A scheduled Memory Custodian manager is a follow-up phase.

---

## Appendix A: File-by-File Change Checklist

### Protocol (Phase 1 + 4)
- [ ] `packages/protocol/src/shared-types.ts` — `ManagerProfile`, extend `AgentDescriptor`
- [ ] `packages/protocol/src/client-commands.ts` — 7 new command types (`create`, `stop`, `resume`, `fork`, `rename`, `merge`, `delete`)
- [ ] `packages/protocol/src/server-events.ts` — 10 new event types, extend union

### Backend Core (Phase 1–3)
- [ ] `apps/backend/src/swarm/types.ts` — Mirror protocol, extend `AgentsStoreFile`
- [ ] `apps/backend/src/swarm/persistence-service.ts` — Load/save profiles
- [ ] `apps/backend/src/swarm/swarm-manager.ts` — Profiles, session lifecycle (`create/stop/resume/fork/delete/rename`), memory merge, boot reconciliation

### Backend WS (Phase 4)
- [ ] `apps/backend/src/ws/ws-command-parser.ts` — Parse `create/stop/resume/fork/rename/merge/delete` commands
- [ ] `apps/backend/src/ws/routes/session-routes.ts` — **New file** (session lifecycle handlers)
- [ ] `apps/backend/src/ws/ws-handler.ts` — Wire routes, bootstrap, broadcasting

### Backend Routing (Phase 4)
- [ ] `apps/backend/src/index.ts` — Filter `collectManagerIds`

### Frontend (Phase 5)
- [ ] `apps/ui/src/lib/ws-state.ts` — Add `profiles`
- [ ] `apps/ui/src/lib/ws-client.ts` — Events, methods, request tracker
- [ ] `apps/ui/src/lib/agent-hierarchy.ts` — Profile tree builder
- [ ] `apps/ui/src/components/chat/AgentSidebar.tsx` — Profile/session hierarchy
- [ ] `apps/ui/src/components/chat/ChatHeader.tsx` — Session label

### Unchanged (verified)
- `apps/backend/src/swarm/runtime-factory.ts` — No changes
- `apps/backend/src/swarm/agent-runtime.ts` — No changes
- `apps/backend/src/swarm/codex-agent-runtime.ts` — No changes
- `apps/backend/src/swarm/conversation-projector.ts` — No changes
- `apps/backend/src/swarm/conversation-validators.ts` — No changes
- `apps/backend/src/swarm/memory-paths.ts` — No changes
- `apps/backend/src/integrations/slack/slack-router.ts` — No changes (v1)
- `apps/backend/src/integrations/telegram/telegram-router.ts` — No changes (v1)
- `apps/backend/src/scheduler/cron-scheduler-service.ts` — No changes (v1)
- `apps/ui/src/hooks/index-page/use-route-state.ts` — No changes

---

## Appendix B: Simplicity Audit

### What's intentionally NOT in this design

| Tempting complexity | Why we skip it |
|---|---|
| Session state machine (active/paused/closed/archived) | Keep it binary: **running** vs **idle**. No separate closed state. Delete is explicit and permanent. |
| Session switching protocol command | Sessions are agents. `subscribe` to a session agent id = view that session. Already works. |
| Runtime multiplexing / event muxing | Each session has its own runtime. Events route by `agentId`. Already works. |
| `sessions.json` separate store file | Profiles in `agents.json`. One atomic write. No cross-file consistency bugs. |
| Session tagging on conversation events | Conversation projector keys by `agentId`. Sessions are agents. No tagging needed. |
| Mandatory auto-merge on lifecycle transitions | Keep v1 merge on-demand. Follow-up Memory Custodian handles routine scheduled consolidation. |
| Cross-session worker messaging | Workers talk to their session agent. Period. |
| New conversation projector logic | Projector keys by `agentId`. Zero changes. |

### Key wins

1. **Zero changes to RuntimeFactory, AgentRuntime, ConversationProjector** — the three most complex backend modules.
2. **Zero changes to existing wire protocol commands** — `subscribe`, `user_message`, `kill_agent` unchanged.
3. **Migration is a no-op for users** — profiles auto-created on boot, existing data preserved bit-for-bit.
4. **Rollback is safe** — old builds ignore new fields.
5. **Concurrency model is proven** — multiple managers already run in parallel today. Sessions reuse that exact machinery.
6. **~400–600 lines of backend changes** — vs. ~800–1200 for the alternative approaches.
