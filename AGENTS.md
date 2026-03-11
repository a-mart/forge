# Middleman - Contributor Guide

## What This Project Is
`middleman` is a local-first multi-agent orchestration platform. It runs:

1. A Node.js backend for manager/worker orchestration and persistence.
2. A TanStack Start + Vite SPA for dashboard, chat, settings, and artifacts.
3. Realtime updates over WebSocket.

**Stack:** TypeScript, React 19, TanStack Router, Radix UI/shadcn, Tailwind v4, Vitest, pnpm monorepo

**Structure:**
- `apps/backend` — Node.js daemon (HTTP + WebSocket server)
- `apps/ui` — React SPA (TanStack Start + Vite)
- `apps/site` — Landing page
- `packages/protocol` — Shared types and wire contracts

**Data Storage:** All state lives in `~/.middleman` (or `%USERPROFILE%\.middleman` on Windows) with a hierarchical profile-scoped layout:
- `profiles/<profileId>/` — sessions, memory, integrations, schedules
- `shared/` — auth, secrets, global config
- `swarm/agents.json` — agent registry

See `apps/backend/src/swarm/data-paths.ts` for path resolution logic.

## Architecture Overview

### Frontend
- SPA with TanStack Start + Vite in `apps/ui`.
- Real-time client state and transport in `apps/ui/src/lib/ws-client.ts`.
- Core UI surfaces in `apps/ui/src/components/chat/*` and `apps/ui/src/components/settings/*`.

### Backend
- HTTP + WebSocket server in `apps/backend/src/ws/server.ts`.
- Agent orchestration and runtime logic in `apps/backend/src/swarm/*`.
- Integrations in `apps/backend/src/integrations/*`.
- Scheduler in `apps/backend/src/scheduler/*`.

### Contracts
Canonical wire contracts are defined in `packages/protocol/`.

## Development Commands

### Development
```bash
pnpm dev
```
Starts backend + UI in one command (two local ports):
- Backend HTTP + WS: `http://127.0.0.1:47187` / `ws://127.0.0.1:47187`
- UI: `http://127.0.0.1:47188`

### Production
```bash
pnpm prod
```
Default production ports:
- Backend HTTP + WS: `http://127.0.0.1:47287` / `ws://127.0.0.1:47287`
- UI preview: `http://127.0.0.1:47289`

### Validation
```bash
pnpm build          # Build all packages
pnpm test           # Run tests
pnpm typecheck      # TypeScript validation across all packages
```

**Before finishing any task, run `pnpm typecheck` and fix reported errors.**

## Working Conventions

### UI Components
Use [shadcn/ui](https://ui.shadcn.com/) for shared UI primitives and new component additions. **Always prefer shadcn components over hand-rolled HTML elements.**

Add components from the `apps/ui` directory using the shadcn CLI:

```bash
cd apps/ui
pnpm dlx shadcn@latest add <component-name>
```

For example:
```bash
cd apps/ui
pnpm dlx shadcn@latest add button label switch select tabs separator scroll-area checkbox tooltip textarea
```

**Important:** The `shadcn` CLI must be run from `apps/ui/` (where `components.json` lives), not from the repo root.

Generated components go to `apps/ui/src/components/ui/`. Check available components and usage at https://ui.shadcn.com/docs.

Currently installed: badge, button, card, checkbox, context-menu, dialog, input, label, scroll-area, select, separator, switch, tabs, textarea, tooltip.

### Code Quality
1. Preserve existing behavior and interaction patterns unless explicitly asked to change them.
2. Keep event handling deterministic across live stream and replayed history.
3. Prefer working within existing backend/frontend boundaries.
4. Validate changes with smoke checks (manager creation, chat send/stop, settings updates).
5. Run `pnpm typecheck` before finishing any task.
6. Prefer shadcn/ui components over hand-rolled HTML for UI controls and surfaces.

## Platform Support

Middleman supports both **macOS** and **Windows**. When working on cross-platform code:

### Path Handling
- Use `path.join()` and `path.resolve()` instead of string concatenation.
- Use `os.tmpdir()` for temporary directories.
- Use `path.isAbsolute()` to check path types.
- Normalize paths with `path.normalize()` when comparing.

### Process & Signals
- Signal handling (e.g., `SIGTERM`, `SIGINT`) should be gated for Windows compatibility.
- Use `process.platform` checks when platform-specific behavior is required.

### Feature Gating
- Some features (like Playwright integration) are conditionally enabled based on platform capabilities.
- Check `apps/backend/src/utils/platform.ts` for platform detection utilities.

### File System
- Be mindful of case sensitivity differences (macOS is case-insensitive by default, Linux is not).
- Use `fs.promises` for async file operations.
- Handle `ENOENT` and permission errors gracefully.

## Testing

Smoke test checklist:
- Create a new manager session
- Send a chat message and verify response
- Stop an active manager
- Update settings (model, system prompt, etc.)
- Verify WebSocket reconnection behavior
- Test on both macOS and Windows if making platform-specific changes
