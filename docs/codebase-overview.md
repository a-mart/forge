# Middleman Codebase Overview

Last updated: 2026-02-23

## Architecture Summary

Middleman is a pnpm monorepo with two primary applications:

- `apps/backend`: Node.js orchestration backend (HTTP + WebSocket).
- `apps/ui`: TanStack Start + Vite React SPA.

At runtime, the UI sends WebSocket commands to the backend and receives streaming events for agent status, conversation output, and integration updates.

## Repository Layout

```text
swarm/
├── AGENTS.md
├── SWARM.md
├── README.md
├── package.json
├── apps/
│   ├── backend/
│   │   └── src/
│   │       ├── index.ts
│   │       ├── config.ts
│   │       ├── ws/server.ts
│   │       ├── swarm/
│   │       ├── integrations/
│   │       ├── scheduler/
│   │       └── test/
│   └── ui/
│       └── src/
│           ├── routes/
│           ├── components/
│           ├── lib/
│           └── styles.css
├── packages/
│   └── protocol/
├── docs/
└── scripts/
```

## Backend (`apps/backend`)

### Entry Flow

`apps/backend/src/index.ts`:

1. Loads `.env`.
2. Builds runtime config via `createConfig()`.
3. Boots `SwarmManager`.
4. Starts `SwarmWebSocketServer`.

### Key Modules

- `swarm/swarm-manager.ts`: manager/worker lifecycle, routing, persistence, context assembly.
- `swarm/agent-runtime.ts`: session execution wrapper.
- `swarm/codex-agent-runtime.ts`: Codex app-server runtime integration.
- `ws/server.ts`: WebSocket transport + HTTP API surface.
- `integrations/*`: Slack and Telegram integrations.
- `scheduler/*`: cron schedule persistence and execution.

### HTTP Surface (selected)

Implemented in `apps/backend/src/ws/server.ts`:

- `POST /api/reboot`
- `GET|POST /api/read-file`
- `POST /api/transcribe`
- `GET|POST|DELETE /api/schedules`
- `GET|POST|DELETE /api/managers/:managerId/schedules`
- `POST /api/agents/:agentId/compact`
- `GET|PUT|DELETE /api/settings/env` and `/api/settings/env/:key`
- `GET|PUT|DELETE /api/settings/auth` and `/api/settings/auth/:provider`
- `POST /api/settings/auth/login` and `/api/settings/auth/login/:provider`
- Slack/Telegram integration settings and test endpoints under `/api/managers/:managerId/integrations/*`

### WebSocket Protocol

Contracts are defined in:

- `packages/protocol/`

Main client commands:

- `subscribe`
- `user_message`
- `kill_agent`
- `create_manager`
- `delete_manager`
- `list_directories`
- `validate_directory`
- `pick_directory`
- `ping`

Main server events:

- `ready`
- `conversation_history`
- `conversation_message`
- `conversation_log`
- `conversation_reset`
- `agent_status`
- `agents_snapshot`
- `manager_created`
- `manager_deleted`
- `error`
- integration status events (`slack_status`, `telegram_status`)

## Frontend (`apps/ui`)

### Core Areas

- `src/routes/index.tsx`: main app surface.
- `src/components/chat/*`: sidebar, chat feed, composer, artifact panel.
- `src/components/settings/*`: auth, skills, integrations, and environment settings UI.
- `src/lib/ws-client.ts`: WebSocket connection + state synchronization.
- `src/lib/file-attachments.ts`: attachment conversion for chat uploads.

### Runtime Endpoint Behavior

By default, UI dev mode runs on `47188` and targets backend WebSocket on `47187`.
In production preview mode, UI runs on `47289` and targets backend on `47287`.

## Configuration Surface

### Environment Variables (common)

- `MIDDLEMAN_HOST` (default `127.0.0.1`)
- `MIDDLEMAN_PORT` (default `47187`)
- `VITE_MIDDLEMAN_WS_URL`

### Persistent Data

Middleman backend state is stored under `~/.middleman` (fixed path):

- `swarm/agents.json`
- `sessions/*.jsonl`
- `uploads/*`
- `auth/auth.json`
- `memory/*.md`
- `secrets.json`
- `integrations/managers/<manager-id>/slack.json`
- `integrations/managers/<manager-id>/telegram.json`

### Skills and Archetypes

Built-in skills live under `apps/backend/src/swarm/skills/builtins/`:

- `memory`
- `brave-search`
- `cron-scheduling`
- `agent-browser`
- `image-generation`

Archetype prompts live under `apps/backend/src/swarm/archetypes/builtins/`.
Repository-local overrides can be provided in `.swarm/skills/` and `.swarm/archetypes/`.

## Commands

From repo root:

```bash
pnpm dev
pnpm build
pnpm test
pnpm exec tsc --noEmit
```

Production helpers:

```bash
pnpm prod
pnpm prod:daemon
pnpm prod:restart
```
