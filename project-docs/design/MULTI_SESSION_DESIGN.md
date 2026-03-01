# Multi-Session Per Manager — Design Document (Final)

> **Status:** Finalized for implementation  
> **Date:** 2026-02-28  
> **Audience:** Backend/UI implementers and reviewers

---

## Review Notes (what changed during final review)

This revision replaces the prior draft with a code-verified design aligned to the current codebase.

### Corrected inaccuracies

- Corrected UI file paths:
  - `apps/ui/src/components/chat/AgentSidebar.tsx` (not `components/sidebar/...`)
  - `apps/ui/src/hooks/index-page/use-route-state.ts` (not `lib/use-route-state.ts`)
- Corrected current `/new` behavior:
  - `resetManagerSession()` currently resets **manager runtime/history only** and does **not** terminate workers.
- Corrected storage paths:
  - Existing store lives under `~/.middleman/swarm/agents.json`; new session store should live alongside it (`~/.middleman/swarm/sessions.json`), not top-level `~/.middleman/sessions.json`.
- Corrected conversation projector assumptions:
  - Current history is keyed by agent id and preloaded only for descriptors in `idle|streaming`; session switching needs explicit reload behavior.

### Design-quality improvements

- Tightened protocol to match current patterns (`snake_case` commands/events, optional `requestId` for request/response commands).
- Added explicit migration reconciliation (idempotent + crash-recoverable), not a one-shot migration assumption.
- Added explicit worker/session isolation rules to prevent cross-session event contamination.
- Re-ordered phases to avoid unsafe partial rollouts (persistence + manager lifecycle before UI wiring).
- Added concrete file-by-file change checklist and test plan.

---

## 1. Goals and Non-Goals

### Goals (v1)

1. **Non-destructive new chat** for managers.
2. Multiple named sessions per manager profile.
3. Session-scoped conversation history and worker ownership.
4. Backward-compatible protocol evolution.
5. Safe migration from existing single-session data.

### Non-goals (v1)

1. Multiple concurrently active manager runtimes per manager.
2. Full historical replay into model context for every session switch policy choice (kept implementation-configurable; default is runtime restore from that session file).
3. Full integration thread binding UX in UI (backend hooks included; advanced controls can follow).

---

## 2. Verified Current Architecture Constraints

The following constraints are from current source and drive this design:

- Protocol shapes live in:
  - `packages/protocol/src/client-commands.ts`
  - `packages/protocol/src/server-events.ts`
  - `packages/protocol/src/shared-types.ts`
- Swarm runtime/orchestration is centralized in:
  - `apps/backend/src/swarm/swarm-manager.ts`
- Persistence currently stores only agents (`agents.json`) in:
  - `apps/backend/src/swarm/persistence-service.ts`
- Conversation projection and persistence currently key by `agentId`:
  - `apps/backend/src/swarm/conversation-projector.ts`
- WS dispatch path:
  - `apps/backend/src/ws/ws-handler.ts`
  - `apps/backend/src/ws/routes/conversation-routes.ts`
- Frontend state and routing:
  - `apps/ui/src/lib/ws-client.ts`
  - `apps/ui/src/lib/ws-state.ts`
  - `apps/ui/src/lib/agent-hierarchy.ts`
  - `apps/ui/src/components/chat/AgentSidebar.tsx`
  - `apps/ui/src/hooks/index-page/use-route-state.ts`

Critical behavior today:

- One manager runtime per manager descriptor (`runtimes: Map<agentId, runtime>`).
- Manager reset (`/new`) deletes the manager session file and recreates manager runtime.
- Worker activity for manager context is currently emitted with `agentId = managerId`; without session tagging this would bleed across sessions.

---

## 3. Target Architecture

A **manager remains the durable profile** (memory, integrations, settings, model defaults), and gains multiple **sessions**.

- Exactly **one active session runtime** per manager at a time.
- Each session has its own `sessionFile` (JSONL runtime/history store).
- Workers are session-owned (`worker.sessionId`).
- Manager session switch updates manager descriptor binding (`manager.sessionId` + `manager.sessionFile`) and rebuilds manager runtime against the target session file.

---

## 4. Data Model and Persistence

### 4.1 Protocol/shared types

**File:** `packages/protocol/src/shared-types.ts`

```ts
export type SessionStatus = 'active' | 'closed'

export interface SessionDescriptor {
  sessionId: string
  managerId: string
  title: string
  status: SessionStatus
  createdAt: string
  updatedAt: string
  closedAt?: string
  sessionFile: string
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

  // NEW:
  // - manager: currently active session id
  // - worker: owning session id
  sessionId?: string
}
```

### 4.2 Backend types

**File:** `apps/backend/src/swarm/types.ts`

Mirror the protocol additions and add:

```ts
export interface SessionsStoreFile {
  sessions: SessionDescriptor[]
}
```

### 4.3 Config paths

**Files:**
- `apps/backend/src/swarm/types.ts` (`SwarmPaths`)
- `apps/backend/src/config.ts`

Add:

```ts
sessionsStoreFile: string
```

Default path:

```txt
~/.middleman/swarm/sessions.json
```

### 4.4 Session id and file naming

- `sessionId` format: `<managerId>:<slug>`
- `slug` format: time+entropy (e.g. `20260228-7f3a`)
- Session file format: `<managerId>--<slug>.jsonl`

Examples:

- `sessionId`: `manager:20260228-7f3a`
- `sessionFile`: `~/.middleman/sessions/manager--20260228-7f3a.jsonl`

### 4.5 Persistence service additions

**File:** `apps/backend/src/swarm/persistence-service.ts`

Add methods:

```ts
async loadSessionsStore(): Promise<SessionsStoreFile>
async saveSessionsStore(): Promise<void>
async deleteSessionFile(sessionFile: string): Promise<void>
```

Implementation requirements:

- Same temp-file + rename atomic write pattern used for `agents.json`.
- Graceful ENOENT handling for missing session files.

---

## 5. Protocol Changes

### 5.1 Client commands

**File:** `packages/protocol/src/client-commands.ts`

Add commands:

```ts
| { type: 'create_session'; managerId?: string; title?: string; requestId?: string }
| { type: 'switch_session'; sessionId: string; requestId?: string }
| { type: 'rename_session'; sessionId: string; title: string; requestId?: string }
| { type: 'close_session'; sessionId: string; requestId?: string }
| { type: 'list_sessions'; managerId?: string; includeClosed?: boolean; requestId?: string }
```

Extend existing command:

```ts
| {
    type: 'user_message'
    text: string
    attachments?: ConversationAttachment[]
    agentId?: string
    delivery?: DeliveryMode
    sessionId?: string // NEW optional override when target is manager
  }
```

### 5.2 Server events

**File:** `packages/protocol/src/server-events.ts`

Add:

```ts
export interface SessionCreatedEvent {
  type: 'session_created'
  session: SessionDescriptor
  requestId?: string
}

export interface SessionSwitchedEvent {
  type: 'session_switched'
  managerId: string
  sessionId: string
  requestId?: string
}

export interface SessionRenamedEvent {
  type: 'session_renamed'
  sessionId: string
  title: string
  requestId?: string
}

export interface SessionClosedEvent {
  type: 'session_closed'
  managerId: string
  sessionId: string
  terminatedWorkerIds: string[]
  switchedToSessionId?: string
  requestId?: string
}

export interface SessionsListedEvent {
  type: 'sessions_listed'
  managerId: string
  sessions: SessionDescriptor[]
  activeSessionId: string | null
  requestId?: string
}

export interface SessionsSnapshotEvent {
  type: 'sessions_snapshot'
  sessions: SessionDescriptor[]
}
```

### Session tagging on conversation events

To prevent manager-session leakage, add optional `sessionId` on conversation events:

- `conversation_message`
- `conversation_log`
- `agent_message`
- `agent_tool_call`
- `conversation_history`
- `conversation_reset`

Rule: manager-context events must carry the owning session id.

### 5.3 Parser/router updates

**Files:**
- `apps/backend/src/ws/ws-command-parser.ts`
- `apps/backend/src/ws/routes/` (new `session-routes.ts`)
- `apps/backend/src/ws/ws-handler.ts`

Requirements:

- Parse/validate new commands.
- Extend `extractRequestId` for request/response-style session commands.
- Route session commands before unknown-command fallback.

### 5.4 Backward compatibility

- Old clients that never send session commands keep working with the manager’s active session.
- New optional fields are additive.
- `/new` semantics change from destructive reset to “create + switch to new session”, while preserving empty-history UX for old clients.

---

## 6. Backend Design

### 6.1 SwarmManager state additions

**File:** `apps/backend/src/swarm/swarm-manager.ts`

```ts
private readonly sessions = new Map<string, SessionDescriptor>()
```

Active session source of truth:

- manager descriptor `sessionId` field.

Public APIs to add:

```ts
getSession(sessionId: string): SessionDescriptor | undefined
listSessions(managerId: string, options?: { includeClosed?: boolean }): SessionDescriptor[]
getActiveSessionId(managerId: string): string | null

createSession(managerId: string, options?: { title?: string; switchTo?: boolean }): Promise<SessionDescriptor>
switchSession(managerId: string, sessionId: string, options?: { reason?: 'api' | 'user' | 'integration' }): Promise<void>
renameSession(sessionId: string, title: string): Promise<void>
closeSession(sessionId: string): Promise<{ terminatedWorkerIds: string[]; switchedToSessionId?: string }>
```

### 6.2 Boot and reconciliation flow

On boot:

1. Load `agents.json`.
2. Load `sessions.json` (if missing => empty).
3. Reconcile invariants (idempotent):
   - every manager has at least one active session;
   - manager `sessionId` points to valid active session;
   - manager `sessionFile` equals active session `sessionFile`;
   - every worker has valid `sessionId` under its manager (or reassigned to manager active session);
   - sessions for deleted managers are removed.
4. Persist changed stores (sessions first, agents second).
5. Continue existing boot flow (history load, runtime restore, snapshots).

This reconciliation runs every boot and heals partial migration crashes.

### 6.3 Session lifecycle behavior

### `createSession`

- Validate manager ownership/running state.
- Create descriptor in `sessions` map with `active` status.
- Persist sessions store.
- If `switchTo !== false`, call `switchSession()`.
- Emit:
  - `session_created`
  - `sessions_snapshot`

### `switchSession`

- Validate target session exists, belongs to manager, and is active.
- If already active: no-op.
- Terminate current manager runtime (`abort: true`), remove from runtime map.
- Update manager descriptor:
  - `sessionId = targetSessionId`
  - `sessionFile = targetSession.sessionFile`
  - status/context usage reset before runtime recreate
- Persist agents store.
- Recreate manager runtime from target session file.
- Reload manager conversation history cache for target session.
- Emit:
  - `session_switched`
  - `agents_snapshot`
  - `sessions_snapshot`

### `resetManagerSession` (existing API used by `/new`)

Change implementation to:

1. create new session (title `New chat`) under target manager.
2. switch to it.
3. emit `conversation_reset` with new `sessionId` and existing reason.

No destructive deletion of previous session files.

### `closeSession`

- Mark session `closed`, set `closedAt`.
- Terminate workers owned by that session.
- If closed session was active:
  - switch manager to most recently updated active session, or
  - auto-create+switch a new session if none active remain.
- Persist stores.
- Emit `session_closed`, `agents_snapshot`, `sessions_snapshot`.

### 6.4 Worker/session isolation rules

Required to avoid cross-session contamination:

1. `spawnAgent()` sets `worker.sessionId = manager.sessionId`.
2. Manager can directly control only workers in its active session.
3. Worker-to-worker messaging requires same `sessionId`.
4. Worker-to-manager messaging when worker session is inactive:
   - recorded as `agent_message` in worker’s session,
   - **not** delivered into currently active manager runtime.

(Deferred enhancement: queued replay when session becomes active.)

### 6.5 Conversation projector changes

**File:** `apps/backend/src/swarm/conversation-projector.ts`

Add manager-session-aware history handling.

Implementation requirements:

- Support `getConversationHistory(agentId, sessionId?)`.
  - manager: load by manager+session
  - worker: load by worker id
- Persist manager-context entries to the correct session file (from event/session ownership), not implicitly to whichever manager session is currently active.
- Keep existing trim policy (`MAX_CONVERSATION_HISTORY`) per logical stream.
- Expose explicit reload method for manager session switch.

Also update validators:

- `apps/backend/src/swarm/conversation-validators.ts`

to accept optional `sessionId` fields on conversation events.

### 6.6 WS behavior changes

**Files:**
- `apps/backend/src/ws/ws-handler.ts`
- `apps/backend/src/ws/routes/conversation-routes.ts`
- `apps/backend/src/ws/routes/session-routes.ts` (new)

Behavior:

- On subscribe bootstrap, send:
  1. `ready`
  2. `agents_snapshot`
  3. `sessions_snapshot`
  4. `conversation_history` for subscribed target (manager history uses active session)
- `/new` in `conversation-routes.ts` for manager targets calls `createSession(...switchTo)` path.
- `user_message` with `sessionId` targeting manager triggers `switchSession` first when needed.

---

## 7. Frontend/UI Design

### 7.1 WS state and client

**Files:**
- `apps/ui/src/lib/ws-state.ts`
- `apps/ui/src/lib/ws-client.ts`

State additions:

```ts
sessions: SessionDescriptor[]
selectedSessionId: string | null
```

Client methods to add:

```ts
createSession(managerId?: string, title?: string): Promise<SessionDescriptor>
switchSession(sessionId: string): Promise<void>
renameSession(sessionId: string, title: string): Promise<void>
closeSession(sessionId: string): Promise<{ terminatedWorkerIds: string[] }>
listSessions(managerId?: string, includeClosed?: boolean): Promise<{ sessions: SessionDescriptor[]; activeSessionId: string | null }>
```

Update request-tracker maps and request error hints for new request types.

### 7.2 Route state

**File:** `apps/ui/src/hooks/index-page/use-route-state.ts`

Extend chat route state:

```ts
type AppRouteState =
  | { view: 'chat'; agentId: string; sessionId?: string }
  | { view: 'settings' }
```

Search params:

- existing: `agent`
- new: `session`

Behavior:

- If route targets manager + session and it is not active, call `switchSession`.
- If route targets worker, ignore `session`.

### 7.3 Sidebar hierarchy

**Files:**
- `apps/ui/src/lib/agent-hierarchy.ts`
- `apps/ui/src/components/chat/AgentSidebar.tsx`

Hierarchy becomes:

- Manager
  - Session (active/closed badges)
    - Workers owned by that session

Required updates:

- `buildManagerTreeRows(agents, sessions)`
- Session row context menu: Rename, Close
- Per-manager “New chat” action

### 7.4 Header / UX

**File:** `apps/ui/src/components/chat/ChatHeader.tsx`

- Show active session title alongside manager label.
- “Clear conversation” action becomes session-aware “New chat” semantics.
- Keep `/compact` and Stop All behavior unchanged.

---

## 8. Integrations and Scheduler

### 8.1 Slack/Telegram routing (phase after core)

Current inbound routers always call `handleUserMessage(...targetAgentId: managerId)`.

Add optional session targeting support:

- `handleUserMessage(..., { targetSessionId?: string })`
- Per-manager binding store:
  - Slack key: `channelId + threadTs(or ts)`
  - Telegram key: `chatId + message_thread_id(or message_id)`
- On inbound message:
  1. resolve bound session or default to active session,
  2. pass `targetSessionId`.

If bound session is closed/missing, rebind to current active session.

### 8.2 Cron scheduler routing

**Files:**
- `apps/backend/src/scheduler/cron-scheduler-service.ts`
- `apps/backend/src/swarm/skills/builtins/cron-scheduling/schedule.js`
- `apps/backend/src/swarm/skills/builtins/cron-scheduling/SKILL.md`

Add optional schedule field:

```ts
sessionId?: string
```

Dispatch behavior:

- if `sessionId` present: target that session (auto-switch when needed)
- else: target manager active session

No breaking migration required (field optional).

---

## 9. Migration and Rollback

### 9.1 Migration strategy

Migration is implemented as **reconciliation on boot**, not one-time irreversible conversion.

When first running multi-session build:

- For each manager lacking session records:
  - create default session bound to existing manager `sessionFile`.
- Set manager `sessionId` to default session.
- Assign orphan workers to manager active session.
- Persist sessions + agents stores.

### 9.2 Crash safety

Because there are two store files (`agents.json`, `sessions.json`), true cross-file atomicity is unavailable.

Safety approach:

- each file uses atomic temp+rename
- boot reconciliation is idempotent and repairs partial writes
- invariants are checked every boot before runtime restore

### 9.3 Rollback behavior

Older binaries (without session support):

- ignore `sessions.json`
- read `agents.json` and whichever manager `sessionFile` is currently set
- extra `sessionId` fields are additive and safe

Result: no data corruption; only reduced visibility (single active session behavior).

---

## 10. Implementation Phases

### Phase 1 — Types, config paths, persistence store

- Add `SessionDescriptor`, `SessionStatus`, `sessionId` fields.
- Add `sessionsStoreFile` path.
- Add sessions load/save persistence methods.
- Add tests for sessions store IO.

### Phase 2 — SwarmManager session lifecycle + reconciliation

- Boot reconciliation.
- `create/switch/rename/close/list` session APIs.
- `/new` -> create+switch behavior via `resetManagerSession` rewrite.
- Worker ownership tagging in `spawnAgent`.
- Add unit tests in `swarm-manager.test.ts`.

### Phase 3 — Protocol parser/routes/ws broadcast

- Add command/event types.
- Extend `ws-command-parser.ts` and request-id extraction.
- Add `session-routes.ts` and wire in `ws-handler.ts`.
- Bootstrap includes `sessions_snapshot`.
- Add WS integration tests in `ws-server.test.ts`.

### Phase 4 — Conversation projector session scoping + isolation

- Session-tagged conversation events.
- Correct persistence target by session.
- Manager session history reload on switch.
- Cross-session worker message isolation rule.
- Add projector-focused tests.

### Phase 5 — UI session UX

- `ws-state`, `ws-client`, request tracker updates.
- Route state `session` query param.
- Sidebar session tree and actions.
- Header/session labeling.
- Update UI tests (`ws-client.test.ts`, `agent-hierarchy.test.ts`, `AgentSidebar.test.ts`, route tests).

### Phase 6 — Integrations + scheduler session targeting

- Thread/session binding store and router updates.
- Cron `sessionId` support.
- Skill docs/CLI updates.

### Parallelization guidance

- Phase 5 can start once Phase 3 protocol contracts are stable.
- Phase 6 can proceed in parallel with late Phase 5 once `targetSessionId` plumbing exists.

---

## 11. Risks and Open Decisions

1. **Cross-session worker->manager replay policy**
   - v1: record but do not replay into manager runtime automatically.
   - open follow-up: queued replay on session activation.

2. **Session list growth/retention**
   - closed sessions accumulate; consider archival pruning policy later.

3. **Integration auto-switch churn**
   - high-traffic thread-to-session routing may cause frequent manager runtime switches.
   - mitigation may require debounce/queue policy in later iteration.

---

## 12. File-by-File Change Checklist

### Protocol
- `packages/protocol/src/shared-types.ts`
- `packages/protocol/src/client-commands.ts`
- `packages/protocol/src/server-events.ts`

### Backend core
- `apps/backend/src/swarm/types.ts`
- `apps/backend/src/config.ts`
- `apps/backend/src/swarm/persistence-service.ts`
- `apps/backend/src/swarm/swarm-manager.ts`
- `apps/backend/src/swarm/conversation-projector.ts`
- `apps/backend/src/swarm/conversation-validators.ts`

### Backend WS
- `apps/backend/src/ws/ws-command-parser.ts`
- `apps/backend/src/ws/ws-handler.ts`
- `apps/backend/src/ws/routes/conversation-routes.ts`
- `apps/backend/src/ws/routes/session-routes.ts` (new)

### Frontend
- `apps/ui/src/lib/ws-state.ts`
- `apps/ui/src/lib/ws-client.ts`
- `apps/ui/src/lib/agent-hierarchy.ts`
- `apps/ui/src/hooks/index-page/use-route-state.ts`
- `apps/ui/src/components/chat/AgentSidebar.tsx`
- `apps/ui/src/components/chat/ChatHeader.tsx`
- `apps/ui/src/routes/index.tsx`

### Integrations / scheduler (phase 6)
- `apps/backend/src/integrations/slack/slack-router.ts`
- `apps/backend/src/integrations/telegram/telegram-router.ts`
- `apps/backend/src/scheduler/cron-scheduler-service.ts`
- `apps/backend/src/swarm/skills/builtins/cron-scheduling/schedule.js`
- `apps/backend/src/swarm/skills/builtins/cron-scheduling/SKILL.md`

---

This document is now aligned to the current codebase and structured for phased implementation with explicit safety guarantees.