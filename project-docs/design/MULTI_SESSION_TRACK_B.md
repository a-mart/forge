# Multi-Session Per Manager — Track B (Concurrent Runtime Reuse)

> **Status:** Proposed revision (concurrency-first)
> **Date:** 2026-02-28
> **Goal:** Replace single-active-session switching with true concurrent sessions while keeping implementation as simple as possible.

---

## 1) Design philosophy

### Core idea

Do **not** multiplex many sessions through one manager runtime.

Instead, model each session as its **own manager runtime** (internally), because the backend already supports many managers running concurrently (`apps/backend/src/swarm/swarm-manager.ts`, `runtimes: Map<string, SwarmAgentRuntime>`).

That gives us concurrency “for free” by reusing existing machinery:
- runtime lifecycle,
- worker ownership checks,
- conversation projection,
- status streaming,
- persistence of per-runtime JSONL session files.

### Why this is simplest

Compared to a manager+session multiplexer, this avoids invasive changes to:
- `SwarmToolHost` call signatures,
- runtime callback signatures (`onSessionEvent(agentId, ...)`),
- conversation event keying,
- delivery routing internals.

We keep current agent-oriented flow and add a thin session layer on top.

---

## 2) Architecture

## 2.1 Concepts

### Manager Profile (durable identity)
- Integrations/settings/scheduler identity.
- Owns **core memory** file.
- Represented by a manager descriptor where `profileManagerId === agentId`.

### Session Runtime (concurrent execution unit)
- One runtime manager agent per session.
- Root session reuses profile manager `agentId`; additional sessions get synthetic manager ids.
- Each session runtime can stream concurrently and spawn its own workers.

### Session Workers
- Workers are owned by the session runtime manager (`worker.managerId = runtimeManagerId`).
- Workers carry `sessionId` + `profileManagerId` for UI/grouping and routing.

---

## 2.2 Data model

### Protocol/backend shared type additions

**Files:**
- `packages/protocol/src/shared-types.ts`
- `apps/backend/src/swarm/types.ts`

```ts
export type SessionStatus = 'active' | 'closed'

export interface SessionDescriptor {
  sessionId: string
  profileManagerId: string
  runtimeManagerId: string // manager agent id that owns this runtime
  title: string
  status: SessionStatus
  createdAt: string
  updatedAt: string
  closedAt?: string
  sessionFile: string
  sessionMemoryFile: string
  mergedAt?: string
}

export interface AgentDescriptor {
  agentId: string
  managerId: string
  displayName: string
  role: 'manager' | 'worker'
  archetypeId?: string
  status: AgentStatus
  createdAt: string
  updatedAt: string
  cwd: string
  model: AgentModelDescriptor
  sessionFile: string
  contextUsage?: AgentContextUsage

  // NEW
  profileManagerId?: string
  sessionId?: string
}
```

### Store file

Add a dedicated sessions store (same directory as agents store):
- `~/.middleman/swarm/sessions.json`

```ts
export interface SessionsStoreFile {
  sessions: SessionDescriptor[]
}
```

---

## 2.3 Runtime model (true concurrency)

**Key point:** one session = one manager runtime key in existing `runtimes` map.

- Root session runtime key: profile manager id (no migration shock).
- Extra session runtime key: generated synthetic manager id, e.g. `manager--s-20260228-7f3a`.

This preserves current runtime code paths in:
- `apps/backend/src/swarm/swarm-manager.ts`
- `apps/backend/src/swarm/runtime-factory.ts`
- `apps/backend/src/swarm/agent-runtime.ts`
- `apps/backend/src/swarm/codex-agent-runtime.ts`

### Worker isolation

Because workers are owned by `runtimeManagerId`, existing manager ownership checks mostly continue to work. Add explicit guards in `SwarmManager.sendMessage()` to prevent cross-session leakage for worker-origin traffic:
- worker -> manager allowed only to own runtime manager,
- worker -> worker allowed only if same owning runtime manager.

No global "active session" state is required.

---

## 2.4 Conversation model

**Good news:** we can avoid conversation-event session multiplexing.

Current projector/event model is agent-keyed (`agentId`) in:
- `apps/backend/src/swarm/conversation-projector.ts`
- `apps/backend/src/ws/ws-handler.ts`

Since each session runtime has a unique manager `agentId` (`runtimeManagerId`), session separation is naturally preserved:
- manager conversation stream is per session runtime manager id,
- worker tool calls flow into that session’s manager context (already uses worker `managerId` today).

So we do **not** need to add `sessionId` to every conversation event type.

---

## 2.5 Memory model (session-scoped writes + deferred merge)

### Files

- Core memory per profile manager (durable):
  - `~/.middleman/memory/<profileManagerId>.md`
- Session delta memory per session (write target during work):
  - `~/.middleman/memory/sessions/<sessionId>.md`

### Runtime behavior

For any runtime bound to a session (manager runtime + workers):
- `SWARM_MEMORY_FILE` points to `sessionMemoryFile` (writes go here).
- Core memory is injected as read-only context (additional context file / prompt section).

Changes touch:
- `apps/backend/src/swarm/swarm-manager.ts` (`getMemoryRuntimeResources`)
- `apps/backend/src/swarm/runtime-factory.ts` (context composition for Pi + Codex)
- memory skill docs copy (`apps/backend/src/swarm/skills/builtins/memory/SKILL.md`) to clarify session file semantics.

This removes concurrent writes to the shared core memory file.

---

## 3) Session-memory-merge pattern

### Merge triggers

- **Automatic (default):** when closing a session.
- **Manual:** explicit “Merge memory” action.

### Merge execution

Use a dedicated merge worker task (simple and explicit):
1. Read `sessionMemoryFile`.
2. Read profile core memory file.
3. Apply minimal edits to core memory sections.
4. Report result.

Implementation hooks in `SwarmManager`:
- `mergeSessionMemory(sessionId, options)`
- `scheduleSessionMemoryMerge(sessionId, trigger)`

### Serialization

Merges to the same profile core memory should be serialized per `profileManagerId` (simple in-memory queue/mutex) to avoid merge races.

### Failure handling

If merge fails:
- session closes anyway,
- emit explicit merge failure event,
- keep `mergedAt` unset so UI can show “pending merge”.

---

## 4) Protocol changes

## 4.1 Client commands

**File:** `packages/protocol/src/client-commands.ts`

Add:

```ts
| { type: 'create_session'; managerId: string; title?: string; requestId?: string }
| { type: 'rename_session'; sessionId: string; title: string; requestId?: string }
| { type: 'close_session'; sessionId: string; requestId?: string }
| { type: 'list_sessions'; managerId: string; includeClosed?: boolean; requestId?: string }
| { type: 'merge_session_memory'; sessionId: string; requestId?: string }
```

No mandatory changes to `subscribe` or `user_message` shape are required for core concurrency.

## 4.2 Server events

**File:** `packages/protocol/src/server-events.ts`

Add:

```ts
interface SessionsSnapshotEvent {
  type: 'sessions_snapshot'
  sessions: SessionDescriptor[]
}

interface SessionCreatedEvent { type: 'session_created'; session: SessionDescriptor; requestId?: string }
interface SessionRenamedEvent { type: 'session_renamed'; sessionId: string; title: string; requestId?: string }
interface SessionClosedEvent {
  type: 'session_closed'
  sessionId: string
  profileManagerId: string
  runtimeManagerId: string
  terminatedWorkerIds: string[]
  requestId?: string
}
interface SessionsListedEvent {
  type: 'sessions_listed'
  managerId: string
  sessions: SessionDescriptor[]
  requestId?: string
}
interface SessionMemoryMergeStartedEvent { type: 'session_memory_merge_started'; sessionId: string; requestId?: string }
interface SessionMemoryMergedEvent { type: 'session_memory_merged'; sessionId: string; mergedAt: string; requestId?: string }
interface SessionMemoryMergeFailedEvent { type: 'session_memory_merge_failed'; sessionId: string; message: string; requestId?: string }
```

---

## 5) Backend changes

## 5.1 Paths + persistence

### `apps/backend/src/swarm/types.ts`
Add `sessionsStoreFile` to `SwarmPaths`.

### `apps/backend/src/config.ts`
Set default:
- `paths.sessionsStoreFile = resolve(swarmDir, 'sessions.json')`

### `apps/backend/src/swarm/persistence-service.ts`
Add:
- `loadSessionsStore()`
- `saveSessionsStore()`
- `ensureSessionMemoryFile(path)`

Continue atomic temp-file + rename writes.

---

## 5.2 SwarmManager

**File:** `apps/backend/src/swarm/swarm-manager.ts`

Add session state:

```ts
private readonly sessions = new Map<string, SessionDescriptor>()
private readonly sessionsByRuntimeManagerId = new Map<string, SessionDescriptor>()
```

### New APIs

```ts
listSessions(profileManagerId: string, options?: { includeClosed?: boolean }): SessionDescriptor[]
createSession(profileManagerId: string, options?: { title?: string }): Promise<SessionDescriptor>
renameSession(sessionId: string, title: string): Promise<void>
closeSession(sessionId: string): Promise<{ terminatedWorkerIds: string[] }>
mergeSessionMemory(sessionId: string): Promise<void>
```

### Existing APIs to adjust

- `createManager(...)`
  - set `profileManagerId = agentId`
  - create root session descriptor with `runtimeManagerId = agentId`
  - set `sessionId` on profile manager descriptor.

- `spawnAgent(...)`
  - copy `profileManagerId` + `sessionId` from caller manager descriptor.

- `resetManagerSession(...)`
  - replace destructive behavior with `createSession(profileManagerId, { title: 'New chat' })`.

- `deleteManager(...)`
  - deleting a profile manager cascades across all sessions in same profile and all workers bound to those session runtimes.

- `sendMessage(...)`
  - enforce worker cross-session isolation as noted above.

---

## 5.3 Conversation projector

**File:** `apps/backend/src/swarm/conversation-projector.ts`

Only minimal changes needed:
- no new session multiplexer logic,
- optional helper for session-based retrieval (`sessionId -> runtimeManagerId -> history`) for convenience.

Current append/load behavior already stores by descriptor `sessionFile` and agent key.

---

## 5.4 WS parser/routes/bootstrap

### `apps/backend/src/ws/ws-command-parser.ts`
- parse new session commands,
- include them in `extractRequestId()`.

### `apps/backend/src/ws/routes/session-routes.ts` (new)
- handle create/list/rename/close/merge session commands.

### `apps/backend/src/ws/ws-handler.ts`
- wire `session-routes` before unknown-command fallback,
- include `sessions_snapshot` in subscribe bootstrap:
  1. `ready`
  2. `agents_snapshot`
  3. `sessions_snapshot`
  4. `conversation_history`

### `apps/backend/src/ws/routes/conversation-routes.ts`
- `/new` path calls `createSession()` instead of destructive reset.

---

## 5.5 Integrations and scheduler

### `apps/backend/src/index.ts`
`collectManagerIds(...)` must include **profile managers only** (`role==='manager' && profileManagerId===agentId`) so we do not start duplicate integrations/schedulers for internal session runtimes.

### Inbound routing defaults
- `slack-router.ts`, `telegram-router.ts`, `cron-scheduler-service.ts` continue to target profile manager id by default (root session runtime).
- Add optional session targeting (`targetSessionId`) as a follow-up extension.

---

## 6) Frontend / UI changes

## 6.1 WebSocket state/client

**Files:**
- `apps/ui/src/lib/ws-state.ts`
- `apps/ui/src/lib/ws-client.ts`

Add state:

```ts
sessions: SessionDescriptor[]
selectedSessionId: string | null
```

Add client methods:
- `createSession(managerId, title?)`
- `renameSession(sessionId, title)`
- `closeSession(sessionId)`
- `listSessions(managerId, includeClosed?)`
- `mergeSessionMemory(sessionId)`

Handle new session events and snapshots.

## 6.2 Routing

**File:** `apps/ui/src/hooks/index-page/use-route-state.ts`

Use session-aware chat routes:

```ts
type AppRouteState =
  | { view: 'chat'; managerId: string; sessionId: string; agentId?: string }
  | { view: 'settings' }
```

URL params: `manager`, `session`, optional `agent`.

## 6.3 Sidebar hierarchy

**Files:**
- `apps/ui/src/lib/agent-hierarchy.ts`
- `apps/ui/src/components/chat/AgentSidebar.tsx`

Render:
- Profile Manager
  - Sessions
    - Workers in that session

Session row actions:
- Rename
- Close (except root)
- Merge memory

Manager row action:
- New chat (create session)

## 6.4 Header UX

**File:** `apps/ui/src/components/chat/ChatHeader.tsx`

- Show `manager / session` label.
- Replace clear-conversation behavior with create-session behavior.

## 6.5 Settings filtering

**Files:**
- `apps/ui/src/routes/index.tsx`
- `apps/ui/src/components/settings/SettingsIntegrations.tsx`

Use profile managers only (`role==='manager' && profileManagerId===agentId`) in settings/integration pickers.

---

## 7) Migration

Migration runs as idempotent reconciliation at boot in `SwarmManager.boot()`.

1. Load `agents.json` and `sessions.json`.
2. For every existing manager descriptor lacking session metadata:
   - set `profileManagerId = agentId`,
   - create root session descriptor:
     - `runtimeManagerId = agentId`
     - `sessionFile = manager.sessionFile`
     - `sessionMemoryFile = ~/.middleman/memory/sessions/<sessionId>.md`
   - set manager `sessionId = rootSessionId`.
3. For existing workers under that manager:
   - set `profileManagerId = managerId`
   - set `sessionId = rootSessionId`.
4. Ensure session memory files exist.
5. Persist `sessions.json` then `agents.json` atomically.

Crash safety: same as current store model—per-file atomic writes + boot reconciliation healing.

---

## 8) Implementation phases (ordered)

### Phase 1 — Types + store
- Protocol/backend type additions.
- `sessionsStoreFile` path.
- `PersistenceService` session load/save.

### Phase 2 — SwarmManager concurrent sessions
- Session CRUD APIs.
- Root session creation in `createManager`.
- `/new` -> create session.
- Worker/session metadata propagation.
- Isolation checks in `sendMessage`.

### Phase 3 — Memory model
- Session memory files.
- Core memory read-only context injection.
- Merge API + per-profile merge serialization.

### Phase 4 — WS command/event wiring
- parser + requestId extraction updates.
- new session routes.
- bootstrap `sessions_snapshot`.

### Phase 5 — UI session UX
- ws state/client session support.
- route-state changes.
- sidebar session tree + actions.
- header/session labels.

### Phase 6 — Integrations/scheduler refinement
- profile-manager filtering in backend manager discovery.
- optional inbound session binding (`targetSessionId`) per channel/thread.

### Phase 7 — Tests/hardening
- `swarm-manager.test.ts`
- `ws-server.test.ts`
- `ws-client.test.ts`
- `agent-hierarchy.test.ts`
- migration/reconciliation tests for partial-write recovery.

---

## 9) Simplicity audit

## What we explicitly avoided

1. **No runtime multiplexing state machine** inside one manager runtime.
2. **No per-event session tagging rewrite** for conversation events.
3. **No global active-session lock/switch logic**.
4. **No CRDT/operational-transform memory sync**.
5. **No multi-subscription websocket fanout redesign**.

## Intentional constraints (v1 of concurrent model)

1. Root session is not closable (keeps stable default for integrations/scheduler).
2. One UI subscription at a time remains unchanged.
3. Integration thread->session binding can ship after core concurrency.
4. Merge conflicts are handled by serialized merge jobs, not fancy diff engines.

## Why this is the right trade-off

- Concurrency is real (all session runtimes are live simultaneously).
- The largest existing subsystems stay mostly intact (`SwarmManager`, `ConversationProjector`, runtimes).
- Complexity is concentrated in session metadata + routing, not in low-level runtime plumbing.

This is the minimal path that satisfies the new must-have requirements without architectural gymnastics.
