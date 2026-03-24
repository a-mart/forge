# Forge — Contributor & Development Guide

> This file is auto-loaded by AI coding agents (e.g., the `pi` runtime) when working in this
> directory. It also serves as the primary development reference for human contributors. Instructions
> here apply to both audiences unless otherwise noted.

## What This Project Is

Forge is a local-first multi-agent orchestration platform. It provides:

1. A **Node.js backend** for manager/worker agent orchestration, persistence, and integrations.
2. A **React SPA** (TanStack Start + Vite) for dashboard, chat, settings, and artifacts.
3. **Real-time updates** over WebSocket.

**Stack:** TypeScript, React 19, TanStack Start, Radix UI/shadcn, Tailwind v4, Vitest, pnpm monorepo

## Prerequisites

- **Node.js 22+**
- **pnpm 10.30+** — install with `npm install -g pnpm` (exact version pinned in `package.json` → `packageManager`)
- An **OpenAI** or **Anthropic** account (OAuth or API key, configured through the UI after first launch)

## Getting Started

```bash
git clone https://github.com/a-mart/forge.git
cd middleman
cp .env.example .env          # Review and set any needed env vars
pnpm install
pnpm dev                      # Starts backend + UI in dev mode
```

See the [README](README.md) for full setup instructions, including Windows-specific notes.

## Architecture Overview

### Frontend

- SPA with TanStack Start + Vite in `apps/ui`.
- Real-time client state and WebSocket transport in `apps/ui/src/lib/ws-client.ts`.
- Core UI surfaces in `apps/ui/src/components/chat/*` and `apps/ui/src/components/settings/*`.

### Backend

- HTTP + WebSocket server in `apps/backend/src/ws/server.ts`.
- Route handlers in `apps/backend/src/ws/routes/*` (one file per domain: agents, sessions, settings, etc.).
- Agent orchestration and runtime logic in `apps/backend/src/swarm/*`.
- Integrations (Telegram) in `apps/backend/src/integrations/*`.
- Scheduler in `apps/backend/src/scheduler/*`.

### Protocol

Shared TypeScript types and API message definitions live in `packages/protocol/`. Both backend and UI import from this package — any changes to message shapes must be made here first.

### Additional Subsystems

These are briefly described for orientation. Most have both backend and UI components.

| Subsystem | Backend | UI | Purpose |
|-----------|---------|-----|---------|
| **Prompt system** | `swarm/prompt-registry.ts`, `swarm/archetypes/` | Settings UI | Prompt templates, archetypes, and resolution (profile → repo → builtin) |
| **Memory system** | `swarm/memory-merge.ts`, `swarm/memory-paths.ts` | Chat UI | Per-session and per-profile persistent memory with merge lifecycle |
| **Cortex** | `swarm/operational/` | `components/chat/cortex/` | AI self-improvement, first-launch welcome preferences, and knowledge management |
| **Playwright dashboard** | `playwright/*` | `components/playwright/*` | Live browser preview and automation dashboard |
| **Codex runtime** | `swarm/codex-agent-runtime.ts`, `swarm/codex-*.ts` | — | OpenAI Codex agent runtime integration |
| **Mobile push** | `mobile/*` | — | Expo push notification service for mobile companion app |
| **Voice/transcription** | `ws/routes/transcription-routes.ts` | `lib/voice-transcription-client.ts` | Voice input and transcription |
| **Feedback** | `swarm/feedback-service.ts` | `lib/feedback-client.ts` | User feedback collection |
| **Daemon management** | `reboot/`, `scripts/prod-daemon*.mjs` | — | Production process lifecycle (start, restart, PID tracking) |
| **Reference docs** | `swarm/reference-docs.ts` | Settings UI | Profile-scoped reference documents |
| **Worker stall detector** | `swarm/swarm-manager.ts` (WorkerStallState, checkForStalledWorkers) | — | Periodic wall-clock detection of workers stuck mid-tool-execution; two-stage nudge then auto-kill |
| **Choice Picker** | `swarm/swarm-manager.ts` (pending registry), `swarm/swarm-tools.ts` (present_choices tool) | `components/chat/message-list/ChoiceRequestCard.tsx`, `components/chat/message-list/ChoiceAnsweredRow.tsx` | Interactive structured choice picker for agent-user decision points |
| **Pi extensions** | Agent runtime (`pi-agent-runtime.ts`: `bindExtensions()`, `session_shutdown`, auto-discovery) | — | In-process custom tools, event interception, context modification, and packages via Pi's extension system. Auto-discovered from `~/.forge/agent/extensions/` (workers), `~/.forge/agent/manager/extensions/` (managers), and `<cwd>/.pi/extensions/` (project-local). See [`docs/PI_EXTENSIONS.md`](docs/PI_EXTENSIONS.md) |

Backend paths above are relative to `apps/backend/src/`. UI paths are relative to `apps/ui/src/`.

## Project Structure

```
forge/
├── apps/
│   ├── backend/           # Node.js daemon — orchestration, persistence, integrations
│   └── ui/                # React SPA — dashboard, chat, settings
├── packages/
│   └── protocol/          # Shared TypeScript types and API message definitions
├── scripts/               # Production daemon scripts, test helpers, migration tools
└── .env.example           # Environment variable reference
```

### Data Storage

All runtime state lives in `~/.forge` (or `%LOCALAPPDATA%\forge` on Windows), overridable via `FORGE_DATA_DIR`. The layout is profile-scoped:

```
~/.forge/
├── swarm/
│   └── agents.json                        # Global agent registry
├── agent/                                 # Pi agent runtime config
│   ├── extensions/                        #   Global worker extensions (auto-created)
│   ├── manager/extensions/                #   Global manager extensions (auto-created)
│   ├── skills/                            #   Global worker skills (Pi-discovered, auto-created)
│   ├── manager/skills/                    #   Global manager skills (Pi-discovered, auto-created)
│   ├── settings.json                      #   Global worker package config (optional)
│   └── manager/settings.json             #   Global manager package config (optional)
├── uploads/                               # User-uploaded files
├── shared/
│   ├── auth/auth.json                     # Authentication credentials
│   ├── secrets.json                       # Encrypted secrets
│   ├── integrations/                      # Telegram integration configs
│   ├── knowledge/                         # Knowledge base
│   │   ├── common.md                      #   Common knowledge (cross-profile, including a managed onboarding preferences block)
│   │   ├── onboarding-state.json          #   First-launch user preferences
│   │   └── profiles/<profileId>.md        #   Per-profile knowledge
│   ├── slash-commands.json                # Global slash commands
│   ├── playwright-dashboard.json          # Playwright dashboard settings
│   ├── mobile-devices.json                # Registered mobile devices
│   └── mobile-notification-prefs.json     # Mobile push preferences
└── profiles/<profileId>/
    ├── memory.md                          # Profile-level memory
    ├── reference/                         # Profile reference documents
    ├── integrations/                      # Profile integration configs
    ├── pi/                                # Profile-scoped Pi runtime resources
    │   ├── extensions/                    #   Profile extensions (auto-created)
    │   ├── skills/                        #   Profile skills (auto-created)
    │   ├── prompts/                       #   Profile prompts (auto-created)
    │   └── themes/                        #   Profile themes (auto-created)
    ├── schedules/schedules.json           # Scheduled tasks
    ├── slash-commands.json                # Profile slash commands
    └── sessions/<sessionId>/
        ├── session.jsonl                  # Conversation history
        ├── memory.md                      # Session working memory
        ├── meta.json                      # Session metadata
        ├── feedback.jsonl                 # User feedback
        └── workers/<workerId>.jsonl       # Worker conversation logs
```

Session forks now support a **partial fork** from a specific message: the forked `session.jsonl` is copied up to that message only.
The forked session memory header also records that truncation point so the parent history boundary is explicit.

See `apps/backend/src/swarm/data-paths.ts` for the canonical path resolution logic.

## Development Commands

### Development

```bash
pnpm dev                    # Start backend + UI in dev mode (with hot reload)
pnpm dev:backend            # Start backend only
pnpm dev:ui                 # Start UI only
```

Dev ports:
- Backend HTTP + WS: `http://127.0.0.1:47187`
- UI: `http://127.0.0.1:47188`

### Production

```bash
pnpm prod                   # Build all packages, then start backend + UI
pnpm prod:daemon            # Start as a background daemon (recommended for production)
pnpm prod:restart           # Restart a running daemon
```

> `pnpm prod` implicitly runs `pnpm build` before starting. The daemon commands in `scripts/` manage PID tracking and process lifecycle.

Production ports:
- Backend HTTP + WS: `http://127.0.0.1:47287`
- UI preview: `http://127.0.0.1:47189`

### Validation

```bash
pnpm build                                                # Build all packages
pnpm test                                                 # Run all tests (backend + UI)
cd apps/backend && pnpm exec tsc -p tsconfig.build.json --noEmit   # Backend typecheck
cd apps/ui && pnpm exec tsc --noEmit                               # UI typecheck
```

Run individual test files with Vitest:
```bash
cd apps/backend && pnpm exec vitest run src/swarm/__tests__/some-test.ts
cd apps/ui && pnpm exec vitest run src/components/chat/SomeComponent.test.ts
```

**Before finishing any task, run both typecheck commands above and fix all reported errors.**

## Environment Variables

Copy `.env.example` to `.env` and uncomment/set values as needed. Key variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `FORGE_HOST` | `127.0.0.1` | Backend bind address |
| `FORGE_PORT` | `47187` | Backend port (production uses `47287`) |
| `FORGE_DATA_DIR` | `~/.forge` | Data storage root |
| `FORGE_DEBUG` | `false` | Enable debug logging (also enables extension tool-call logging) |
| `VITE_FORGE_WS_URL` | auto-detected | WebSocket URL override (dev mode only) |
| `BRAVE_API_KEY` | — | Brave Search skill |
| `GEMINI_API_KEY` | — | Image generation skill |
| `CODEX_API_KEY` | — | OpenAI Codex runtime |
| `CODEX_BIN` | `codex` | Path to Codex binary |
| `FORGE_PLAYWRIGHT_DASHBOARD_ENABLED` | `false` | Enable Playwright dashboard (macOS/Linux only) |

For compatibility, legacy `MIDDLEMAN_*` names are still accepted during startup.

See `.env.example` for the full reference.

## Working Conventions

### UI Components

Use [shadcn/ui](https://ui.shadcn.com/) for all shared UI primitives. Prefer shadcn components over hand-rolled HTML elements.

To add a new shadcn component:
```bash
cd apps/ui                                      # Must run from apps/ui/ (where components.json lives)
pnpm dlx shadcn@latest add <component-name>     # e.g., button, dialog, tabs
```

Generated components go to `apps/ui/src/components/ui/`. Check that directory for currently installed components. Browse the [shadcn docs](https://ui.shadcn.com/docs) for usage and available components.

### Code Quality

1. **Preserve existing behavior** unless explicitly asked to change it. The UI replays conversation history from JSONL files — event handling must work identically for both live-streamed and replayed messages.
2. **Respect backend/frontend boundaries.** Shared types go in `packages/protocol/`. Don't duplicate type definitions across apps.
3. **Validate changes** with smoke checks: manager creation, chat send/stop, settings updates.
4. **Run typechecks** before finishing any task:
   ```bash
   cd apps/backend && pnpm exec tsc -p tsconfig.build.json --noEmit
   cd apps/ui && pnpm exec tsc --noEmit
   ```

## Platform Support

Forge supports **macOS**, **Linux**, and **Windows**. When working on cross-platform code:

### Path Handling
- Use `path.join()` and `path.resolve()` instead of string concatenation.
- Use `os.tmpdir()` for temporary directories.
- Use `path.isAbsolute()` to check path types.
- Normalize paths with `path.normalize()` when comparing.

### Process & Signals
- Signal handling (e.g., `SIGTERM`, `SIGINT`) should be gated for Windows compatibility.
- Use `process.platform` checks when platform-specific behavior is required.

### Feature Gating
- Playwright dashboard is gated by the `FORGE_PLAYWRIGHT_DASHBOARD_ENABLED` env var and requires macOS or Linux (Unix sockets).

### File System
- Be mindful of case sensitivity differences (macOS is case-insensitive by default, Linux is case-sensitive).
- Use `fs.promises` for async file operations.
- Handle `ENOENT` and permission errors gracefully.

## Testing

### Automated Tests

```bash
pnpm test                                       # Run all tests
cd apps/backend && pnpm exec vitest run          # Backend tests only
cd apps/ui && pnpm exec vitest run               # UI tests only
cd apps/backend && pnpm exec vitest run path/to/test.ts   # Single test file
```

### Smoke Test Checklist

After making changes, manually verify these core flows in the UI (at `http://127.0.0.1:47188` in dev mode):

- Create a new manager session
- Send a chat message and verify the response streams correctly
- Stop an active manager mid-response
- Update settings (model, system prompt, etc.) and verify they persist
- Verify WebSocket reconnection after a backend restart
- If making platform-specific changes, test on macOS, Linux, and Windows
