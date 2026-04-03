# Forge — Contributor & Development Guide

> This file is auto-loaded by AI coding agents (e.g., the `pi` runtime) when working in this
> directory. It also serves as the primary development reference for human contributors. Instructions
> here apply to both audiences unless otherwise noted.

## What This Project Is

Forge is a local-first multi-agent orchestration platform. It provides:

1. A **Node.js backend** for manager/worker agent orchestration, persistence, and integrations.
2. A **React SPA** (TanStack Start + Vite) for dashboard, chat, settings, and artifacts.
3. An **Electron desktop app** that bundles backend, UI, and all dependencies for macOS and Windows.
4. **Real-time updates** over WebSocket.

The builtin manager archetype is intentionally concise and outcome-first in user-facing communication, so docs and UI copy should avoid promising constant progress narration.

**Stack:** TypeScript, React 19, TanStack Start, Radix UI/shadcn, Tailwind v4, Vitest, Electron, pnpm monorepo

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
  - `agent-routes.ts` includes `GET /api/agents/:agentId/system-prompt` for retrieving persisted system prompts (used by the System Prompt Viewer UI).
- Agent orchestration and runtime logic in `apps/backend/src/swarm/*`.
- Integrated terminal system in `apps/backend/src/terminal/*`.
- Integrations (Telegram) in `apps/backend/src/integrations/*`.
- Scheduler in `apps/backend/src/scheduler/*`.

### Terminals

Per-session integrated terminals backed by `node-pty` (backend) and `xterm.js` (frontend). Each terminal gets a dedicated WebSocket for raw I/O, separate from the main app WebSocket. A headless `xterm.js` instance on the backend tracks terminal state for snapshot/restore.

- **Persistence:** Periodic VT state snapshots + an output journal (`delta.ndjson`). On server restart, terminals are restored from the most recent snapshot plus any subsequent journal entries, preserving scrollback and screen state.
- **Session scoping:** Terminals belong to a manager session and are cleaned up when the session is deleted.
- **Cross-platform:** macOS/Linux use the user's default shell; Windows uses ConPTY. Shell can be overridden via `FORGE_TERMINAL_DEFAULT_SHELL`.
- **Access control:** Terminal WebSocket connections use short-lived tickets issued over the authenticated main WebSocket.

For design details, see `.internal/research/integrated-terminals/`.

### Protocol

Shared TypeScript types and API message definitions live in `packages/protocol/`. Both backend and UI import from this package — any changes to message shapes must be made here first.

**Recent protocol changes:**
- `UnreadNotificationEvent` now includes optional `reason?: 'message' | 'choice_request'` to distinguish notification triggers, and `sessionAgentId?: string` for per-manager preference resolution on worker-originated events. This supports dedicated question notification sounds that take priority over regular unread sounds.

### Additional Subsystems

These are briefly described for orientation. Most have both backend and UI components.

| Subsystem | Backend | UI | Purpose |
|-----------|---------|-----|---------|
| **Prompt system** | `swarm/prompt-registry.ts`, `swarm/archetypes/` | Settings UI | Prompt templates, archetypes (including Agent Architect for project agent creation), and resolution (profile → repo → builtin) |
| **Memory system** | `swarm/memory-merge.ts`, `swarm/memory-paths.ts` | Chat UI | Per-session and per-profile persistent memory with merge lifecycle |
| **Cortex** | `swarm/operational/` | `components/chat/cortex/` | AI self-improvement, first-launch welcome preferences, and knowledge management |
| **Cortex auto-review** | `swarm/cortex-auto-review-settings.ts`, `ws/routes/cortex-auto-review-routes.ts` | `components/settings/SettingsGeneral.tsx`, `components/settings/cortex-auto-review-api.ts` | Periodic automated reviews that run only when sessions have changed (deterministic pre-check prevents unnecessary LLM sessions) |
| **Playwright dashboard** | `playwright/*` | `components/playwright/*` | Live browser preview and automation dashboard |
| **Codex runtime** | `swarm/codex-agent-runtime.ts`, `swarm/codex-*.ts` | — | OpenAI Codex agent runtime integration |
| **Mobile push** | `mobile/*` | — | Expo push notification service for mobile companion app |
| **Voice/transcription** | `ws/routes/transcription-routes.ts` | `lib/voice-transcription-client.ts` | Voice input and transcription |
| **Feedback** | `swarm/feedback-service.ts` | `lib/feedback-client.ts` | User feedback collection |
| **Daemon management** | `reboot/`, `scripts/prod-daemon*.mjs` | — | Production process lifecycle (start, restart, PID tracking) |
| **Reference docs** | `swarm/reference-docs.ts` | Settings UI | Profile-scoped reference documents |
| **Worker stall detector** | `swarm/swarm-manager.ts` (WorkerStallState, checkForStalledWorkers) | — | Periodic wall-clock detection of workers stuck mid-tool-execution; projects worker turn failures into system messages with preserved error context, suppresses duplicate callback/summary reports, then nudges or auto-kills |
| **Choice Picker** | `swarm/swarm-manager.ts` (pending registry), `swarm/swarm-tools.ts` (present_choices tool) | `components/chat/message-list/ChoiceRequestCard.tsx`, `components/chat/message-list/ChoiceAnsweredRow.tsx` | Interactive structured choice picker for agent-user decision points. Choice requests trigger a dedicated notification sound (configurable per-manager, default ON) that takes priority over regular notification sounds. |
| **Pi extensions** | Agent runtime (`pi-agent-runtime.ts`: `bindExtensions()`, `session_shutdown`, auto-discovery) | — | In-process custom tools, event interception, context modification, and packages via Pi's extension system. Auto-discovered from `~/.forge/agent/extensions/` (workers), `~/.forge/agent/manager/extensions/` (managers), and `<cwd>/.pi/extensions/` (project-local). See [`docs/PI_EXTENSIONS.md`](docs/PI_EXTENSIONS.md) |
| **Integrated terminals** | `terminal/` | `components/terminal/` | Per-session PTY terminals with persistence and state restoration |
| **Specialists** | `swarm/specialists/` | `components/settings/SettingsSpecialists.tsx` | Named worker spawn templates with model config, silent worker/runtime fallback recovery, per-profile overrides, and provider-native tool config (e.g., xAI web search) |
| **Model catalog** | `swarm/model-catalog-service.ts`, `swarm/model-catalog-projection.ts` | `components/settings/SettingsModels.tsx` | Authoritative single-source model metadata catalog with Pi projection, local overrides, and audit workflow for upstream sync |
| **Model overrides** | `swarm/model-overrides.ts` | Settings Models UI | User-scoped model visibility and context-window caps persisted to `model-overrides.json` |
| **Mermaid diagrams** | `ws/routes/mermaid-preview-route.ts` | `components/chat/message-list/MermaidBlock.tsx`, artifact/file/diff markdown previews | Sandboxed iframe rendering for Mermaid code fences with inline toolbar controls for code/diagram toggle, copy source, SVG/PNG export, fullscreen, and theme-reactive/error fallback |
| **Electron desktop app** | `apps/electron/src/main.ts`, `auto-updater.ts`, `preload.ts`, `window-state.ts` | `components/settings/SettingsAbout.tsx` | Standalone desktop application for macOS and Windows. Bundles backend, UI, and dependencies. Auto-updates via GitHub Releases with beta channel support. Persists and restores window position, size, maximized state, and fullscreen state across launches. Dark mode by default. Windows uses standard title bar with hidden menu (Alt to show); macOS uses standard title bar. Provides shell integration for revealing files in Finder/Explorer. |
| **Message pins** | `swarm/message-pins.ts` | `components/chat/message-list/` | Pin up to 10 messages per session; pinned content is preserved through all compaction types via custom instructions and extension hooks. Pin count badge in chat header opens a navigator popover with prev/next buttons to jump directly to any pinned message. |
| **Session pins** | `swarm/swarm-manager.ts` (pinSession method) | `components/chat/AgentSidebar.tsx` | Pin sessions to top of sidebar; right-click pin/unpin with three-tier sort (project agents → pinned → regular). Pinned sessions never hidden by pagination. State stored as `pinnedAt` timestamp on `AgentDescriptor`. |
| **Project Agents** | `swarm/project-agents.ts`, `swarm/project-agent-analysis.ts` | `components/chat/AgentSidebar.tsx`, `components/chat/MessageInput.tsx`, `components/chat/message-list/ConversationMessageRow.tsx` | Cross-session agent messaging via lightweight session promotion with discovery, AI-assisted configuration, and fire-and-forget async messaging. Promoted sessions appear with dedicated handles in sidebar and are discoverable by sibling session agents. |
| **Project Agent Creator** | `swarm/agent-creator-context.ts`, `swarm/agent-creator-tool.ts`, `swarm/archetypes/builtins/agent-architect.md` | `components/chat/AgentSidebar.tsx` (context menu + violet Sparkles icon) | Conversational project agent creation flow. Right-click profile header to create a session with the Agent Architect archetype. Gathers context (existing agents + recent memory excerpts, 3,200-char seed context budget), interviews user about the new agent's role, then atomically creates and promotes the session via `create_project_agent` tool. Cannot be promoted, forked, or created in Cortex profile. |
| **Provider usage monitoring** | `stats/provider-usage-service.ts` | `components/chat/SidebarUsageWidget.tsx`, `components/stats/sections/ProviderUsage.tsx` | OAuth-based subscription rate-limit monitoring for OpenAI Codex and Anthropic Claude. Shows 5-hour rolling and weekly usage windows with reset timers in sidebar widget and dashboard stats panel. Cached per-provider with 3-minute TTL. |

Backend paths above are relative to `apps/backend/src/`. UI paths are relative to `apps/ui/src/`.

## Project Structure

```
forge/
├── apps/
│   ├── backend/           # Node.js daemon — orchestration, persistence, integrations
│   ├── ui/                # React SPA — dashboard, chat, settings
│   └── electron/          # Electron desktop app wrapper
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
│   ├── model-overrides.json               # User model visibility/context caps
│   ├── generated/
│   │   └── pi-models.json                 # Generated Pi-compatible model projection
│   ├── integrations/                      # Telegram integration configs
│   ├── knowledge/                         # Knowledge base
│   │   ├── common.md                      #   Common knowledge (cross-profile, including a managed onboarding preferences block)
│   │   ├── onboarding-state.json          #   First-launch user preferences
│   │   └── profiles/<profileId>.md        #   Per-profile knowledge
│   ├── slash-commands.json                # Global slash commands
│   ├── playwright-dashboard.json          # Playwright dashboard settings
│   ├── cortex-auto-review.json            # Cortex auto-review schedule settings
│   ├── mobile-devices.json                # Registered mobile devices
│   ├── mobile-notification-prefs.json     # Mobile push preferences
│   └── specialists/                       # Global specialist definitions (.md files)
└── profiles/<profileId>/
    ├── memory.md                          # Profile-level memory
    ├── specialists/                       # Profile-specific specialist overrides
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
        ├── meta.json                      # Session metadata (includes sessionPurpose: 'agent_creator' for Agent Architect sessions)
        ├── feedback.jsonl                 # User feedback
        ├── pinned-messages.json           # Pin state (up to 10 message IDs)
        ├── workers/<workerId>.jsonl       # Worker conversation logs
        └── terminals/<terminalId>/
            ├── meta.json                  # Terminal metadata (shell, cwd, title, cols/rows)
            ├── snapshot.vt                # Serialized terminal state (xterm.js headless)
            └── delta.ndjson               # Raw output journal for replay between snapshots
```

Session forks now support a **partial fork** from a specific message: the forked `session.jsonl` is copied up to that message only.
The forked session memory header also records that truncation point so the parent history boundary is explicit. Cached conversation sidecars rebuild from canonical `session.jsonl` on first load if they are stale or truncated, including after async project-agent deliveries.

See `apps/backend/src/swarm/data-paths.ts` for the canonical path resolution logic.

## Development Commands

### Development

```bash
pnpm dev                    # Start backend + UI in dev mode (with hot reload)
pnpm dev:backend            # Start backend only
pnpm dev:ui                 # Start UI only
pnpm dev:electron           # Start Electron desktop app in dev mode
```

Dev ports:
- Backend HTTP + WS: `http://127.0.0.1:47187`
- UI: `http://127.0.0.1:47188`
- Electron: Launches desktop window (UI runs on port 47188)

### Production

```bash
pnpm prod                   # Build all packages, then start backend + UI
pnpm prod:daemon            # Start as a background daemon (recommended for production)
pnpm prod:restart           # Restart a running daemon
pnpm package:electron       # Build standalone desktop app for distribution (build only; no publish)
pnpm release:electron       # Intentionally disabled; use the guarded draft-first desktop release flow in apps/electron/README.md
```

Desktop release rules:
- **Build first, publish last.** Bump and push the Electron version before any release build.
- **Beta-first channel policy.** New desktop rollouts go out on beta first. Beta versions must be published as GitHub prereleases; stable rollout happens later as a separate intentional release.
- **Draft-first only.** Create the GitHub Release as a draft, upload the full updater asset set (`.dmg`, `.zip`, `.exe`, `latest*.yml`, `*.blockmap`, and related files), then publish.
- **Never publish beta assets to stable.** If the version is a beta/prerelease version, keep the GitHub Release marked as a prerelease when publishing.
- **Windows release builds use `workflow_dispatch`.** Pushes to `electron/*` branches are validation-only and must not be treated as published release builds.
- **`apps/electron/release/` is disposable build output.** `pnpm package:electron` now clears it before packaging so stale installers/blockmaps do not get mixed into validation or manual upload steps.
- **Packaged-runtime smoke should come from staged assets, not repo fallbacks.** The Electron package build now resolves and loads staged runtime externals from `.stage/backend/node_modules/`; if you change packaged dependencies, keep that preflight passing.
- See `apps/electron/README.md` for the current packaged layout and release workflow.

> `pnpm prod` implicitly runs `pnpm build` before starting. The daemon commands in `scripts/` manage PID tracking and process lifecycle.

Production ports:
- Backend HTTP + WS: `http://127.0.0.1:47287`
- UI preview: `http://127.0.0.1:47189`
- Electron: Defaults to port 47287 for backend, configurable via `FORGE_PORT`

### Validation

```bash
pnpm build                                                # Build all packages
pnpm test                                                 # Run all tests (backend + UI, including backend test files)
cd apps/backend && pnpm exec tsc -p tsconfig.build.json --noEmit   # Backend production typecheck only (tests excluded by tsconfig.build.json)
cd apps/ui && pnpm exec tsc --noEmit                               # UI typecheck
pnpm model-catalog:audit                                  # Audit model catalog against Pi upstream
```

Run individual test files with Vitest:
```bash
cd apps/backend && pnpm exec vitest run src/swarm/__tests__/some-test.ts
cd apps/ui && pnpm exec vitest run src/components/chat/SomeComponent.test.ts
```

**Before finishing any task, run `pnpm test` plus both typecheck commands above and fix all reported errors.**

## Environment Variables

Copy `.env.example` to `.env` and uncomment/set values as needed. Key variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `FORGE_HOST` | `127.0.0.1` | Backend bind address |
| `FORGE_PORT` | `47187` | Backend port (production uses `47287`) |
| `FORGE_DATA_DIR` | `~/.forge` | Data storage root |
| `FORGE_DEBUG` | `false` | Enable debug logging (also enables extension tool-call logging) |
| `FORGE_TELEMETRY` | `true` | Enable or disable anonymous telemetry. Only aggregate counts are sent. |
| `VITE_FORGE_WS_URL` | auto-detected | WebSocket URL override (dev mode only) |
| `BRAVE_API_KEY` | — | Brave Search skill |
| `GEMINI_API_KEY` | — | Image generation skill |
| `CODEX_API_KEY` | — | OpenAI Codex runtime (deprecated; use managed auth) |
| `XAI_API_KEY` | — | xAI/Grok models (when using external API key mode) |
| `CODEX_BIN` | `codex` | Path to Codex binary |
| `FORGE_TERMINAL_ENABLED` | `true` | Enable integrated terminal subsystem |
| `FORGE_TERMINAL_MAX_PER_SESSION` | `10` | Max terminals per session |
| `FORGE_TERMINAL_SNAPSHOT_INTERVAL_MS` | `30000` | Terminal state snapshot interval |
| `FORGE_TERMINAL_SCROLLBACK_LINES` | `5000` | Max scrollback lines per terminal |
| `FORGE_TERMINAL_DEFAULT_SHELL` | auto-detected | Override default shell |
| `FORGE_PLAYWRIGHT_DASHBOARD_ENABLED` | `false` | Enable Playwright dashboard (macOS/Linux only) |
| `FORGE_DESKTOP` | auto-detected | Set to `true` when running in Electron desktop app |
| `FORGE_RESOURCES_DIR` | auto-detected | Path to bundled resources in Electron app |

For compatibility, legacy `MIDDLEMAN_*` names are still accepted during startup.

See `.env.example` for the full reference.

## Working Conventions

### Conventions

- Review/design markdown artifacts (plans, review docs) should be kept in the `.internal/` directory locally. This directory is gitignored and must never be committed — it is strictly for local working documents.
- A pre-commit hook is provided in `.githooks/pre-commit` to block accidental commits of internal files. Enable it with: `git config core.hooksPath .githooks`

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
4. **Run validation** before finishing any task:
   ```bash
   pnpm test
   cd apps/backend && pnpm exec tsc -p tsconfig.build.json --noEmit   # production-only backend typecheck; tests are covered by pnpm test
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
