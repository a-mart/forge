# Developer Guide

Reference for AI assistants and developers working on the Middleman codebase. Covers architecture patterns, key files, and the best places to make changes.

## Project Layout

```
middleman/
├── apps/
│   ├── backend/src/
│   │   ├── index.ts                    # Entry point, boot sequence
│   │   ├── config.ts                   # Runtime config from env
│   │   ├── ws/
│   │   │   ├── server.ts               # HTTP + WS server shell
│   │   │   ├── ws-handler.ts           # WS connection lifecycle
│   │   │   ├── ws-command-parser.ts    # Command validation
│   │   │   ├── http-utils.ts           # HTTP helpers (CORS, JSON, etc.)
│   │   │   ├── attachment-parser.ts    # Attachment validation + persistence
│   │   │   └── routes/                 # HTTP route handlers
│   │   │       ├── agent-routes.ts     # /api/agents/* (compact)
│   │   │       ├── conversation-routes.ts  # WS user_message handling
│   │   │       ├── manager-routes.ts   # WS create/delete manager
│   │   │       ├── file-routes.ts      # /api/read-file
│   │   │       ├── health-routes.ts    # /api/reboot
│   │   │       ├── scheduler-routes.ts # /api/managers/*/schedules
│   │   │       ├── integration-routes.ts # /api/managers/*/integrations/*
│   │   │       ├── settings-routes.ts  # /api/settings/*
│   │   │       └── transcription-routes.ts # /api/transcribe
│   │   ├── swarm/
│   │   │   ├── swarm-manager.ts        # Core orchestration (agent CRUD, routing, settings)
│   │   │   ├── agent-runtime.ts        # Pi agent runtime wrapper
│   │   │   ├── codex-agent-runtime.ts  # Codex agent runtime (subprocess)
│   │   │   ├── agent-state-machine.ts  # Status transitions
│   │   │   ├── runtime-factory.ts      # Creates appropriate runtime per model
│   │   │   ├── runtime-utils.ts        # Runtime helper functions
│   │   │   ├── conversation-projector.ts # Events → conversation entries → broadcast
│   │   │   ├── conversation-validators.ts # Type guards for all event types
│   │   │   ├── message-utils.ts        # Extract text/role/errors from messages
│   │   │   ├── persistence-service.ts  # agents.json + memory files
│   │   │   ├── secrets-env-service.ts  # Env vars + auth credential management
│   │   │   ├── skill-frontmatter.ts    # Parse SKILL.md YAML frontmatter
│   │   │   ├── skill-metadata-service.ts # Discover and index skills
│   │   │   ├── types.ts                # Core type definitions
│   │   │   └── skills/builtins/        # Built-in skills
│   │   ├── integrations/
│   │   │   ├── base-*.ts               # Abstract base classes
│   │   │   ├── registry.ts             # Integration registry (all providers)
│   │   │   ├── slack/                  # Slack Socket Mode integration
│   │   │   └── telegram/               # Telegram polling integration
│   │   ├── scheduler/
│   │   │   └── cron-scheduler-service.ts # Cron task firing
│   │   └── test/                       # Vitest test files
│   └── ui/src/
│       ├── routes/index.tsx            # Main page component
│       ├── components/
│       │   ├── chat/                   # Chat UI components
│       │   │   ├── AgentSidebar.tsx    # Left panel (agent tree)
│       │   │   ├── ChatHeader.tsx      # Top bar (status, controls)
│       │   │   ├── MessageInput.tsx    # Text input + attachments + voice
│       │   │   ├── MessageList.tsx     # Conversation feed
│       │   │   ├── ArtifactsSidebar.tsx # Right panel (artifacts, schedules)
│       │   │   ├── CreateManagerDialog.tsx
│       │   │   ├── DeleteManagerDialog.tsx
│       │   │   └── message-list/       # Message row components
│       │   ├── settings/               # Settings tabs
│       │   └── ui/                     # Radix UI primitives (shadcn)
│       ├── hooks/index-page/           # Extracted state management hooks
│       │   ├── use-ws-connection.ts    # WS client + state subscription
│       │   ├── use-route-state.ts      # URL ↔ app state sync
│       │   ├── use-manager-actions.ts  # Manager CRUD + compaction
│       │   ├── use-visible-messages.ts # Message filtering by channel/scope
│       │   ├── use-context-window.ts   # Token usage estimation
│       │   ├── use-pending-response.ts # Loading state detection
│       │   └── use-file-drop.ts        # Drag-and-drop files
│       └── lib/
│           ├── ws-client.ts            # ManagerWsClient class
│           ├── ws-state.ts             # ManagerWsState type
│           ├── ws-request-tracker.ts   # Request/response correlation
│           ├── agent-hierarchy.ts      # Manager/worker tree building
│           ├── collect-artifacts.ts    # Artifact extraction from messages
│           ├── file-attachments.ts     # File → attachment conversion
│           ├── api-endpoint.ts         # WS URL → HTTP URL
│           └── model-preset.ts         # Model name mapping
└── packages/protocol/src/
    ├── index.ts                        # Re-exports
    ├── shared-types.ts                 # AgentDescriptor, status types, etc.
    ├── client-commands.ts              # UI → Backend command types
    ├── server-events.ts                # Backend → UI event types
    └── attachments.ts                  # Attachment type definitions
```

## Common Change Patterns

### Adding a New WS Command

1. **Define the type** in `packages/protocol/src/client-commands.ts`
2. **Add parsing** in `apps/backend/src/ws/ws-command-parser.ts`
3. **Add the handler** in the appropriate route file under `apps/backend/src/ws/routes/`
4. **Wire it up** in `apps/backend/src/ws/ws-handler.ts` (dispatch to handler)
5. **Add client method** in `apps/ui/src/lib/ws-client.ts`

### Adding a New Server Event

1. **Define the type** in `packages/protocol/src/server-events.ts`
2. **Emit it** from `SwarmManager` or the relevant service
3. **Register listener** in `apps/backend/src/ws/server.ts` (event → broadcast)
4. **Handle it** in `apps/ui/src/lib/ws-client.ts` (update `ManagerWsState`)
5. **Render it** in the appropriate UI component

### Adding a New HTTP Endpoint

1. **Create a route handler** in `apps/backend/src/ws/routes/` (or add to existing)
2. **Register it** in `apps/backend/src/ws/server.ts` → `handleHttpRequest()` method
3. **Call it** from the UI via `fetch()` using `resolveApiEndpoint()` to build the URL

### Adding a New Settings Tab

1. **Create component** `apps/ui/src/components/settings/SettingsXxx.tsx`
2. **Add tab** in `apps/ui/src/components/chat/SettingsDialog.tsx`
3. **Add API functions** in `apps/ui/src/components/settings/settings-api.ts` if needed

### Adding a New Message Display Type

1. **Define the event** in `packages/protocol/src/server-events.ts`
2. **Create row component** in `apps/ui/src/components/chat/message-list/`
3. **Add to display entries** in `MessageList.tsx` → `buildDisplayEntries()`
4. **Add rendering case** in `MessageList.tsx` render function

## Key Patterns

### Concurrency Control

Services use `runExclusive()` (queue-based concurrency) to prevent race conditions during config updates, integration lifecycle, and other state mutations. This is critical for operations that read-modify-write config files.

### Atomic File Writes

All persistent writes use the tmp-rename pattern:
1. Write to `file.tmp`
2. Rename `file.tmp` → `file`

This prevents corruption from partial writes or crashes.

### Event-Driven Architecture

The backend is event-driven via Node.js `EventEmitter`:
- `SwarmManager` emits conversation/agent events
- `IntegrationRegistryService` emits status events
- `WsServer` listens and broadcasts to subscribed clients
- Integration delivery bridges listen for `conversation_message` events

### Subscription Model

Each WebSocket client subscribes to exactly one agent at a time. Events are filtered by the subscribed agent's ID (or its manager's scope for agent-to-agent messages). This keeps the frontend focused on one conversation.

### State in the Frontend

No Redux or external state library. State flows through:
1. `ManagerWsClient` receives WS events → updates internal `ManagerWsState`
2. Listener function pushes state to React via `useState` setter
3. Hooks (`use-*.ts`) derive computed values from state
4. Components render from hook outputs

This keeps the state model simple and debuggable.

### Delivery Modes

When sending a message to an agent:

| Requested | Agent State | Result |
|-----------|-------------|--------|
| `auto` | idle | `prompt` (dispatch immediately) |
| `auto` | streaming | `steer` (queue for inline injection) |
| `followUp` | any | `followUp` (queue for next turn) |
| `steer` | any | `steer` (queue for inline injection) |

## Testing

### Running Tests

```bash
pnpm test                    # All tests (backend + UI)
pnpm --filter @middleman/backend test   # Backend only
pnpm --filter @middleman/ui test        # UI only
```

### Test Framework

- **Vitest** with jsdom environment for UI tests
- `@testing-library/react` for component testing
- `FakeWebSocket` class for mocking WS connections

### Test Patterns

- Mock `SwarmManager` methods for backend tests
- Use `FakeWebSocket.emit()` for simulating server events in UI tests
- Temp directories for file I/O tests
- `vi.fn()` for tracking function calls
- Fake timers for async scheduling tests

## Reliability Notes

### Most Stable Areas (safe to build on)

- **Protocol types** (`packages/protocol/`) — Well-defined, typed contracts
- **Integration base classes** — Clean abstractions with consistent lifecycle
- **Conversation validators** — Thorough type guards
- **Persistence service** — Simple, atomic file operations
- **Frontend hooks** — Clean separation, focused responsibilities

### Areas Requiring Care

- **SwarmManager** (`swarm-manager.ts`) — Large file, many responsibilities. Changes here have wide blast radius.
- **WS Server** (`server.ts`) — Routing shell with many HTTP endpoints. Easy to break one endpoint while fixing another.
- **Agent runtimes** — Complex state management with pending deliveries, retries, and error recovery. Test changes thoroughly.
- **Conversation projector** — Converts runtime events to conversation entries. Format changes affect both storage and display.

### Known Gaps

- 52 pre-existing test failures (from upstream re-architecture)
- No schema versioning for stored data (file-presence migrations only)
- `data/` directory tracked in git but contains runtime state
- Default manager ID mismatch: UI defaults to `opus-manager`, backend to `manager`

## Build & CI

### Local Build

```bash
pnpm build    # Builds: protocol → backend → UI → site
```

Build order matters — protocol must build first since both apps depend on it.

### CI Pipeline (`.github/workflows/ci.yml`)

1. Install dependencies (frozen lockfile)
2. Build all apps
3. Backend typecheck
4. UI typecheck
5. Backend tests

Runs on push to `main` and PRs targeting `main`.

## Debugging Tips

### Backend Logs

The backend logs to stdout. Key events to watch:
- Agent spawn/kill lifecycle
- Runtime errors (context overflow, API failures)
- Integration connection state changes
- Scheduler task firing

### WS Traffic

In the browser devtools, filter WebSocket messages to see the full command/event flow between frontend and backend.

### Memory Files

Check `~/.middleman/.swarm/memory/<managerId>/<agentId>.md` to see what an agent "remembers" across sessions.

### Session Files

Raw session history is in `~/.middleman/.swarm/sessions/<agentId>.jsonl` — useful for debugging conversation replay issues.
