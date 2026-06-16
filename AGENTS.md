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

## Collaboration mode

Use this public repo/worktree (`/Users/adam/repos/middleman`) as the source of truth for collaboration work, including the collaboration server/runtime target, backend auth/DB/routes/WS, UI, protocol, and Docker Compose/full UI serving path. Do not default to the stale `/Users/adam/repos/forge-collab` repo for current collaboration backend, development, Docker, or project-tracking work. Always pass an explicit `cwd` before editing.

Keep durable collaboration project tracking in [docs/collaboration/project/](docs/collaboration/project/). For any Collab SQLite schema or migration work, follow [docs/collaboration/README.md](docs/collaboration/README.md#collaboration-sqlite-migration-policy). Structured Collab state belongs in SQLite, while user-authored specialist markdown, prompts, reference docs, and skill definitions stay file-backed; SQLite stores only structured skill-selection state.

## Prerequisites

- **Node.js 22+**
- **pnpm 10.30+** — install with `npm install -g pnpm` (exact version pinned in `package.json` → `packageManager`)
- An **OpenAI**, **Anthropic**, or **Claude SDK** account (Settings → Authentication shows provider labels with auth-mode badges; OpenAI/Anthropic can use OAuth or API key auth, while Claude SDK is OAuth-only via Claude Code CLI and does not require an API key)

## Getting Started

```bash
git clone https://github.com/a-mart/forge.git
cd forge
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
- **Session scoping:** Terminals belong to a manager session and are cleaned up when the session is deleted. Project archives suspend running profile terminals and restore brings them back; archived sessions cannot use terminals until restored. Archive does not delete terminal data, and deletion cleanup is separate.
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
| **Agent runtime dispatch** | `swarm/runtime/runtime-factory.ts`, `swarm/runtime/runtime-{binding,callback-gate,prompt-plan,resource-plan,recovery-state,tool-plan}.ts`, `swarm/runtime/{claude,cursor-sdk,pi}/` | Settings UI (manager model selectors and specialist selectors) | Thin provider-dispatch facade plus shared planning/projector helpers and provider-specific runtime creators. Keep provider construction inside the creator modules, keep the facade stable, and preserve the public import surface while refactoring. |
| **Cursor SDK runtime** | `swarm/runtime/cursor-sdk/` | Settings UI (manager and specialist selectors) | Native Cursor SDK agent runtime via `@cursor/sdk` for manager and specialist agents. Uses API-key auth from `CURSOR_API_KEY` in Settings → Authentication, secrets, or env, persists Forge-owned `stateRoot` and `sdkAgentId`. Runtime containment is provider-local and fail-closed: Cursor/ConnectRPC/HTTP2 failures are classified before projection, attributed transient transport or throttle failures may retry once pre-output, auth/permission/cancel/user-state failures are contained and projected without retry, and unattributed/generic/protocol/config failures stay fatal. This prevents background ConnectRPC/HTTP2 errors like `NGHTTP2_ENHANCE_YOUR_CALM` from crashing backend/Electron child processes without implying broad exception swallowing. Usage is recorded from turn-ended deltas into session custom entries, which feed dashboard stats, token analytics, and telemetry provider inference. Electron packaging stages and preflights `@cursor/sdk`, `sqlite3`, and platform binaries. |
| **Codex app-server sidecar** | `swarm/codex-app-server/`, `swarm-manager.ts`, `session/conversation-*` | `components/chat/*`, `hooks/index-page/*` | Builder web supports two Codex entry paths: a plain leading `@Codex` / `[@Codex]` text turn stays a direct Codex app-server sidecar thread, while selector forms like `@Codex -<plugin>`, `@Codex:<plugin>`, and `[@Codex:<plugin>]` scope the turn to a plugin and delegate it to the visible `Codex Plugin` specialist worker. The plugin-scoped path uses server-owned scoped exact plugin tools, stays read-only/safety-gated, and returns redacted bounded results. Direct sidecar threads persist by default as worker-like external-thread cards; plugin-scoped turns stay in the normal `agent_tool_call` audit trail and do not create external-thread audit cards. Parent-session display cards are append-only and excluded from manager/model context; forked sessions omit historical Codex display cards. Lifecycle guardrails separate stop/preserve reuse from kill/delete cleanup, keep CWD synchronized for fresh and reused sends, and allow only one active Codex turn globally. Detailed worker-view rows are projected from live app-server notifications through existing `conversation_log` / `agent_tool_call` primitives with normalized and bounded stream details, stable `toolCallId`, strict turn/item routing, redaction/truncation, model-context exclusion, and boot cleanup for stale in-progress rows. Minimal ToolLogRow labels are `codex_command`, `codex_plugin_tool`, `codex_file_change`, and `codex_plan`. Builder/web only; Collaboration excluded. |
| **Mobile push** | `mobile/*` | — | Expo push notification service for mobile companion app |
| **Voice/transcription** | `ws/routes/transcription-routes.ts` | `lib/voice-transcription-client.ts` | Voice input and transcription |
| **Feedback** | `swarm/feedback-service.ts` | `lib/feedback-client.ts` | User feedback collection |
| **Phoenix observability** | `observability/`, `ws/http/routes/phoenix-observability-routes.ts` | `components/settings/SettingsObservability.tsx` | Builder-only Arize Phoenix tracing over loopback OTLP HTTP/protobuf. Settings live under Settings → Observability and persist to `shared/config/phoenix-observability.json`. Rich traces cover runtime, prompt, LLM, tool, delivery, lifecycle, error, and feedback paths with redaction, caps, capture toggles, and fail-open export safeguards. Collaboration runtime uses the no-op/fail-closed facade and does not export traces. Live Phoenix/golden-trace and Electron package/preflight validation remain user-owned gates. |
| **Daemon management** | `reboot/`, `scripts/prod-daemon*.mjs` | — | Production process lifecycle (start, restart, PID tracking) |
| **Reference docs** | `swarm/reference-docs.ts` | Settings UI | Profile-scoped reference documents |
| **Repo-root .forge project resources** | `.forge/skills/`, `.forge/specialists/`, `.forge/reference/`, `.forge/extensions/`, `.forge/pi/extensions/`, `.forge/pi/settings.json` | Repo-scoped resources that live in the repository root. Passive text resources stay visible if executable trust is denied; only executable surfaces are gated. Do not introduce split `.forge/manager` or `.forge/worker` trees in v1. See [docs/PROJECT_RESOURCES.md](docs/PROJECT_RESOURCES.md) |
| **Worker stall detector** | `swarm/swarm-manager.ts` (WorkerStallState, checkForStalledWorkers) | — | Periodic wall-clock detection of workers stuck mid-tool-execution; projects worker turn failures into system messages with preserved error context, suppresses duplicate callback/summary reports, and suppresses nudge/report/auto-kill while worker or parent runtime recovery is active. Bare runtime `errorMessage: "terminated"` is held behind a 60-second grace before failure projection; progress or self-report cancels the transient error. |
| **Idle worker watchdog** | `swarm/swarm-manager.ts` (WorkerWatchdogState, finalizeWorkerIdleTurn) | — | Dual-path detection (onAgentEnd + status-idle) of workers that complete their turn without reporting back to the parent manager. Auto-report can succeed on `agent_end`/turn end before the runtime flips to idle; the idle watchdog/status-idle path is a fallback and noise-suppression layer, not the only completion gate. It still auto-sends the worker's last output to the manager and emits a batched ⚠️ system notification in chat, but suppresses that path while worker or parent runtime recovery is active. Complementary to the stall detector (which handles workers stuck mid-tool-execution); if a transient terminated error does not recover, it expires through the normal watchdog/error path exactly once. |
| **Choice Picker** | `swarm/swarm-manager.ts` (pending registry), `swarm/swarm-tools.ts` (present_choices tool) | `components/chat/message-list/ChoiceRequestCard.tsx`, `components/chat/message-list/ChoiceAnsweredRow.tsx` | Interactive structured choice picker for agent-user decision points. Choice requests trigger a dedicated notification sound (configurable per-manager, default ON) that takes priority over regular notification sounds. |
| **Active Work Plans** | `swarm/coordination/`, `swarm/skills/builtins/active-work-plans/SKILL.md`, manager-only `task` tool | `components/chat/active-work/`, chat header, `components/chat/message-list/WorkPlanCreatedRow.tsx` | Manager-owned, session-scoped coordination plans persisted to `tasks.json`, with durable `work_plan_created` chat-history receipts when plans are created. Live UI state is delivered with `session_task_state_snapshot`; historical receipts replay from chat history and hydrate their displayed status/items/summary from the latest active or recent task snapshot when available, falling back to the creation snapshot only when the newer snapshot is unavailable. Provider-facing `task` v1 supports `get`, `upsert_plan` with create-time `itemsText`, status-only `update_item_status`, worker `link`, and `finish_plan`; mutation actions return compact ack-style results, and managers should call `task.get` when they need the full state. Structured item revisions remain internal. |
| **Forge extensions** | `swarm/forge-extension-*.ts`, `runtime/*`, provider creators, `swarm-manager.ts`, `versioning/embedded-git-versioning-service.ts` | Settings Extensions UI | Forge-native hook system for session lifecycle, runtime errors, versioning commits, and cross-runtime tool interception. Auto-discovered from `~/.forge/extensions/`, `~/.forge/profiles/<id>/extensions/`, and `<cwd>/.forge/extensions/`. See [`docs/FORGE_EXTENSIONS.md`](docs/FORGE_EXTENSIONS.md) |
| **Skill sharing** | `swarm/skills/skill-sharing-service.ts` | `apps/skill-share-worker/` | Temporary anonymous skill transfer service for user-created global/project skills. Share links and imports use the configured worker origin (default `https://forgeskills.radops.ai`); see [`apps/skill-share-worker/README.md`](apps/skill-share-worker/README.md) for quotas, TTL, and Cloudflare guardrails. |
| **Pi extensions** | Agent runtime (`pi-agent-runtime.ts`: `bindExtensions()`, `session_shutdown`, auto-discovery) | Settings Extensions UI | In-process custom tools, event interception, context modification, and packages via Pi's extension system. Auto-discovered from `~/.forge/agent/extensions/` (workers), `~/.forge/agent/manager/extensions/` (managers), and `<cwd>/.pi/extensions/` (project-local). See [`docs/PI_EXTENSIONS.md`](docs/PI_EXTENSIONS.md) |
| **Integrated terminals** | `terminal/` | `components/terminal/` | Per-session PTY terminals with persistence and state restoration |
| **Archive** | `swarm/archive/*`, `swarm/agents.json` | `components/index-page/ArchiveView.tsx` | Reversible, lossless project/session archive state stored inline in `swarm/agents.json` via `ManagerProfile.archivedAt` and `AgentDescriptor.archivedAt`. Builder Archive shows archived projects and directly archived sessions with restore actions, sorted by last user-message activity and displaying the last-used date. |
| **Specialists** | `swarm/specialists/` | `components/settings/SettingsSpecialists.tsx` | Named worker spawn templates with model config, silent worker/runtime fallback recovery, per-profile overrides, and specialist-specific research guidance such as the Brave-backed `web-researcher` |
| **Model catalog** | `swarm/model-catalog-service.ts`, `swarm/model-catalog-projection.ts` | `components/settings/SettingsModels.tsx` | Authoritative single-source model metadata catalog with Pi projection, local overrides, and audit workflow for upstream sync. See [`docs/ADDING_MODELS.md`](docs/ADDING_MODELS.md) for how to add new models. |
| **Model overrides** | `swarm/model-overrides.ts` | Settings Models UI | User-scoped model visibility and context-window caps persisted to `model-overrides.json` |
| **Model-specific instructions** | `swarm/model-catalog-service.ts`, `packages/protocol/src/model-prompt-instructions.ts` | Settings Models UI | Per-model prompt instructions injected into the manager prompt via `${MODEL_SPECIFIC_INSTRUCTIONS}`. Built-in defaults for GPT-5 and Claude families; user overrides in `model-overrides.json`. Custom prompts must include the placeholder to opt in. |
| **Mermaid diagrams** | `ws/routes/mermaid-preview-route.ts` | `components/chat/message-list/MermaidBlock.tsx`, artifact/file/diff markdown previews | Sandboxed iframe rendering for Mermaid code fences with inline toolbar controls for code/diagram toggle, copy source, SVG/PNG export, fullscreen, and theme-reactive/error fallback |
| **File browser / inline editor** | `ws/http/routes/file-browser-routes.ts`, `ws/http/services/file-browser-service.ts` | `components/file-browser/*`, `hooks/index-page/use-panel-state.ts` | Repository browser with desktop-only direct single-file text editing. Supported editable text files open directly in CodeMirror with syntax highlighting; editable Markdown defaults to source/editor mode. Non-editable files and mobile stay read-only. `/api/files/content` supports versioned `GET`/`PUT` saves with required `baseVersion`, strict stale-version conflicts, and explicit overwrite handling; do not allow silent overwrite paths. Dirty guards cover file switches, panel close, session switches, and Source Control transitions. Preserve exact path whitespace for file names with leading/trailing spaces when reading or saving. |
| **Source Control workspace** | `ws/http/routes/git-source-control-routes.ts`, `ws/http/services/git-source-control-service.ts`, `ws/http/services/git-hosted-provider.ts`, `versioning/git-cli.ts` | `components/diff-viewer/*`, `components/file-browser/*`, `hooks/index-page/use-panel-state.ts` | Desktop workspace rail Source Control surface for selected-worktree Changes, History, Worktrees, and Pull Requests. Selecting a worktree scopes Source Control and Files browsing/editing without changing chat session CWD. Branch actions support fetch, switch, create, and fast-forward-only pull with confirmation plus head/status preflight. Same-workspace file saves refresh Source Control; same-worktree dirty inline edits guard Source Control transitions and mutations. Pull Requests use GitHub `gh` and degrade when no GitHub remote or `gh` auth/availability is missing; merge confirmation uses GitHub match-head-commit and does not delete branches or use admin bypass. Force push, stash, discard, rebase, branch deletion, and worktree create/remove are out of scope. |
| **Electron desktop app** | `apps/electron/src/main.ts`, `auto-updater.ts`, `preload.ts`, `window-state.ts` | `components/settings/SettingsAbout.tsx` | Standalone desktop application for macOS and Windows. Bundles backend, UI, and dependencies. Auto-updates via GitHub Releases with beta channel support. Persists and restores window position, size, maximized state, and fullscreen state across launches. Dark mode by default. Windows uses standard title bar with hidden menu (Alt to show); macOS uses standard title bar. Provides shell integration for revealing files in Finder/Explorer. |
| **Message pins** | `swarm/message-pins.ts` | `components/chat/message-list/` | Pin up to 10 messages per session; pinned content is preserved through all compaction types via custom instructions and extension hooks. Pin count badge in chat header opens a navigator popover with prev/next buttons to jump directly to any pinned message. |
| **Session pins** | `swarm/swarm-manager.ts` (pinSession method) | `components/chat/AgentSidebar.tsx` | Pin sessions to top of sidebar; right-click pin/unpin with three-tier sort (project agents → pinned → regular). Pinned sessions never hidden by pagination. State stored as `pinnedAt` timestamp on `AgentDescriptor`. |
| **Project Agents** | `swarm/project-agents.ts`, `swarm/project-agent-*` (registry/mutation/delivery/sharing helpers), `swarm/project-agent-analysis.ts` | `components/chat/AgentSidebar.tsx`, `components/chat/MessageInput.tsx`, `components/chat/message-list/ConversationMessageRow.tsx` | Cross-session agent messaging via lightweight session promotion with discovery, AI-assisted configuration, fire-and-forget async messaging, and source-owned cross-profile sharing grants. Promoted agents live in dedicated per-handle storage directories with `config.json`, editable `prompt.md` files, and per-agent reference docs. Handles are immutable after promotion. Local discovery covers same-profile agents; external discovery covers only explicitly granted shared agents, with sanitized metadata/prompt rendering, separate local/shared prompt caps, authorized external delivery/contact replies, attachment rejection for Project Agent sends, capability suppression on external/shared turns, and runtime/prompt refresh after sharing changes. Some project agents can be granted same-profile session creation capability, and created sessions show creator attribution in the sidebar. |
| **Project Agent Creator** | `swarm/agent-creator-context.ts`, `swarm/agent-creator-tool.ts`, `swarm/archetypes/builtins/agent-architect.md` | `components/chat/AgentSidebar.tsx` (context menu + violet Sparkles icon) | Conversational project agent creation flow. Right-click profile header to create a session with the Agent Architect archetype. Gathers context (existing agents + recent memory excerpts, 3,200-char seed context budget), interviews user about the new agent's role, then atomically creates and promotes the session via `create_project_agent` tool. Created agents are stored in dedicated per-handle directories with editable `prompt.md` files and scoped reference docs. Cannot be promoted, forked, or created in Cortex profile. Some created agents may later be configured to create sessions from their Settings panel. |
| **Provider usage monitoring** | `stats/provider-usage-service.ts` | `components/chat/SidebarUsageWidget.tsx`, `components/stats/sections/ProviderUsage.tsx` | OAuth-based subscription rate-limit monitoring for OpenAI Codex and Anthropic Claude. Uses a restart-persistent cache (`shared/cache/provider-usage-cache.json`), shows 5-hour rolling and weekly windows with deficit/reserve pace labels, supports manual refresh in the sidebar detail panel, and estimates weekly pace from historical usage curves. Pooled OAuth tokens are refreshed before usage polling. API-key or malformed auth stays unavailable silently. |
| **Credential pool** | `swarm/credential-pool.ts`, `ws/routes/settings-routes.ts` | `components/settings/CredentialPoolPanel.tsx` | Multi-account OpenAI and Anthropic OAuth credential pooling with failover. Pool metadata stored in `shared/config/auth/credential-pool.json`; pooled OAuth credentials refresh through the shared auth path before runtime selection and persist back into `auth.json` under the pooled key. Missing or obviously expired pooled OAuth creds surface as `auth_error`. Supports add/remove/rename/set-primary and strategy selection (fill_first, least_used). Auth modes are mutually exclusive per provider (API key or pooled OAuth, not both). |
| **Token analytics** | `stats/token-analytics-service.ts` | `components/stats/token-analytics/` | Per-worker, per-specialist, and Cursor SDK token usage analytics with attribution tracking, filtering, drill-down, and disk-cached scanning. Stats page adds an Overview \| Token Analytics tab layout. |

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
│   └── agents.json                        # Global agent registry (ManagerProfile.archivedAt, AgentDescriptor.archivedAt)
├── extensions/                            # Global Forge extensions (auto-created)
├── agent/                                 # Pi agent runtime config
│   ├── extensions/                        #   Global worker extensions (auto-created)
│   ├── manager/extensions/                #   Global manager extensions (auto-created)
│   ├── skills/                            #   Global worker skills (Pi-discovered, auto-created)
│   ├── manager/skills/                    #   Global manager skills (Pi-discovered, auto-created)
│   ├── settings.json                      #   Global worker package config (optional)
│   └── manager/settings.json             #   Global manager package config (optional)
├── uploads/                               # User-uploaded files
├── shared/
│   ├── config/
│   │   ├── auth/
│   │   │   ├── auth.json                  # Authentication credentials
│   │   │   └── credential-pool.json       # Multi-account credential pool metadata
│   │   ├── secrets.json                   # Encrypted secrets
│   │   ├── model-overrides.json           # User model visibility/context caps
│   │   ├── cortex-auto-review.json        # Cortex auto-review schedule settings
│   │   ├── mobile-notification-prefs.json # Mobile push preferences
│   │   ├── slash-commands.json            # Global slash commands
│   │   ├── terminal-settings.json         # Terminal runtime settings
│   │   ├── phoenix-observability.json     # Builder-only Phoenix tracing settings
│   │   └── integrations/                  # Telegram integration configs
│   ├── cache/
│   │   ├── generated/
│   │   │   └── pi-models.json             # Generated Pi-compatible model projection
│   │   ├── stats-cache.json               # Cached dashboard statistics
│   │   ├── provider-usage-cache.json      # Cached provider subscription usage snapshots
│   │   ├── provider-usage-history.jsonl   # Historical provider usage samples\n│   │   └── token-analytics-cache.json    # Cached token analytics scan results
│   ├── state/
│   │   ├── mobile-devices.json            # Registered mobile devices
│   │   ├── .compaction-count-backfill-v2-done  # Legacy compaction-count backfill sentinel
│   │   ├── .compaction-count-reconcile-v3-done  # Monotonic compaction-count reconciliation sentinel
│   │   ├── .shared-config-migration-done  # Shared-config layout migration sentinel
│   │   └── .shared-config-cleanup-done    # Shared-config old-path cleanup sentinel
│   ├── knowledge/                         # Knowledge base
│   │   ├── common.md                      #   Common knowledge (cross-profile, including a managed onboarding preferences block)
│   │   ├── onboarding-state.json          #   First-launch user preferences
│   │   └── profiles/<profileId>.md        #   Per-profile knowledge
│   └── specialists/                       # Global specialist definitions (.md files)
└── profiles/<profileId>/
    ├── memory.md                          # Profile-level memory
    ├── extensions/                        # Profile-scoped Forge extensions (auto-created)
    ├── specialists/                       # Profile-specific specialist overrides
    ├── project-agents/<handle>/
    │   ├── config.json                    # Agent config (handle, whenToUse, agentId, timestamps)
    │   ├── prompt.md                      # System prompt (editable, takes effect on restart)
    │   └── reference/                     # Per-agent reference documents
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
        ├── tasks.json                     # Active Work Plans active/session sidecar state; creation receipts live in chat history
        ├── shared/config/work-plans.json   # Builder-only default-on Active Work Plans toggle
        ├── specialists/<handle>.md        # Channel-local specialist definitions (under _collaboration sessions)
        ├── workers/<workerId>.jsonl       # Worker conversation logs
        └── terminals/<terminalId>/
            ├── meta.json                  # Terminal metadata (shell, cwd, title, cols/rows)
            ├── snapshot.vt                # Serialized terminal state (xterm.js headless)
            └── delta.ndjson               # Raw output journal for replay between snapshots
```

Session forks now support a **partial fork** from a specific message: the forked `session.jsonl` is copied up to that message only.
The forked session memory header also records that truncation point so the parent history boundary is explicit. Cursor SDK runtime state and usage records are omitted from forks so resumes do not leak prior SDK state or double-count usage. Historical Codex app-server sidecar display cards are also omitted from forks. Manager-routed Codex turns are preserved only as normal manager audit rows; forked sessions omit the external-thread cards. Cached conversation sidecars rebuild from canonical `session.jsonl` on first load if they are stale or truncated, including after async project-agent deliveries. Archive ordering uses last user-message activity rather than a generic activity timestamp, with lazy hydration of that value and no global backfill.

Repo-root project resources live beside the checkout, not under `~/.forge`: `.forge/skills/`, `.forge/specialists/`, `.forge/reference/`, `.forge/extensions/`, `.forge/pi/extensions/`, and `.forge/pi/settings.json`. Only executable repo resources are trust-gated; passive text resources remain available if trust is denied. Do not introduce split `.forge/manager` or `.forge/worker` trees in v1.

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

### In-app help content

In-app help article **bodies** live in Markdown under `apps/ui/src/components/help/content/articles/<category>/<article-id>.md`. Article **metadata** (`id`, `title`, `category`, `summary`, `keywords`, `relatedIds`, `contextKeys`) stays in `apps/ui/src/components/help/content/*-articles.ts` with explicit per-article `?raw` imports. Do not use frontmatter in v1.

When adding or editing help content:

1. Edit the `.md` body directly; do not put Markdown bodies in TS template literals.
2. Update the matching metadata entry and `?raw` import in the owning `*-articles.ts` module.
3. Run `pnpm help:validate` (permanent structural checks only; no baseline file required).
4. Run UI typecheck and, for help-content changes, `pnpm quality:changed` or `pnpm quality:quick` (the local quality runner routes help-content paths to `pnpm help:validate`).

**Migration-only fidelity:** To compare against a one-time pre-migration baseline (handoff/review only), use `pnpm help:validate:migration` with a provenance-safe `.internal/help-content-baseline.json` captured from unmigrated TS via `pnpm help:baseline`. Do not regenerate that baseline from migrated sources, and do not require it for normal authoring.

### Validation

```bash
pnpm help:validate                                        # Permanent strict help structural checks (no baseline)
pnpm help:validate:migration                              # One-time migration fidelity vs provenance-safe baseline
pnpm quality:quick                                        # Fast changed-file validation with a local JSON report
pnpm quality:changed                                      # Conservative path-aware validation before merge/push
pnpm quality:full                                         # Full local validation, including build
pnpm quality:report                                       # Print the latest .forge/quality/latest.json report
pnpm build                                                # Build all packages
pnpm lint                                                 # Run repo-wide ESLint
pnpm exec knip                                            # Detect unused code, exports, and dependency issues
pnpm test                                                 # Run all tests (backend + UI, including backend test files)
cd apps/backend && pnpm exec tsc -p tsconfig.build.json --noEmit   # Backend production typecheck only (tests excluded by tsconfig.build.json)
cd apps/ui && pnpm exec tsc --noEmit                               # UI typecheck
pnpm model-catalog:audit                                  # Audit model catalog against Pi upstream
```

The local quality runner writes agent-readable results to `.forge/quality/latest.json` by default. Use `pnpm quality:changed -- --json --no-write` for machine-readable output without updating the local artifact. Git hooks remain optional and run local quality checks only after `core.hooksPath` opt-in on protected-branch push/merge paths.

Run individual test files with Vitest:
```bash
cd apps/backend && pnpm exec vitest run src/swarm/__tests__/some-test.ts
cd apps/ui && pnpm exec vitest run src/components/chat/SomeComponent.test.ts
```

**Before finishing any task, run `pnpm lint`, `pnpm exec knip`, `pnpm test`, plus both typecheck commands above and fix all reported errors.**

## Environment Variables

Copy `.env.example` to `.env` and uncomment/set values as needed. Key variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `FORGE_HOST` | `127.0.0.1` | Backend bind address |
| `FORGE_PORT` | `47187` | Backend port (production uses `47287`) |
| `FORGE_DATA_DIR` | `~/.forge` | Data storage root |
| `FORGE_DEBUG` | `false` | Enable debug logging (also enables extension tool-call logging) |
| `FORGE_TELEMETRY` | `true` | Enable or disable anonymous telemetry. Only aggregate counts are sent. |
| `FORGE_CORTEX_ENABLED` | `true` | Enable or disable the Cortex subsystem |
| `VITE_FORGE_WS_URL` | auto-detected | WebSocket URL override (dev mode only) |
| `BRAVE_API_KEY` | — | Brave Search skill |
| `GEMINI_API_KEY` | — | Image generation skill |
| `XAI_API_KEY` | — | xAI/Grok models (when using external API key mode) |
| `CURSOR_API_KEY` | — | Cursor SDK runtime API key (enables Composer 2.5 in manager and specialist selectors; detached auth/connect errors stay inside the worker runtime and fail closed as worker failures) |
| `FORGE_TERMINAL_ENABLED` | `true` | Enable integrated terminal subsystem |
| `FORGE_TERMINAL_MAX_PER_SESSION` | `10` | Max terminals per session |
| `FORGE_TERMINAL_SNAPSHOT_INTERVAL_MS` | `30000` | Terminal state snapshot interval |
| `FORGE_TERMINAL_SCROLLBACK_LINES` | `5000` | Max scrollback lines per terminal |
| `FORGE_TERMINAL_DEFAULT_SHELL` | auto-detected | Override default shell |
| `FORGE_DESKTOP` | auto-detected | Set to `true` when running in Electron desktop app |
| `FORGE_RESOURCES_DIR` | auto-detected | Path to bundled resources in Electron app |
| `FORGE_SKILL_SHARE_BASE_URL` | `https://forgeskills.radops.ai` | Skill share worker origin used for share links and preview/import. |
| `FORGE_SKILL_SHARE_DISABLED` | `false` | Disable skill sharing and import from share URLs. |

For compatibility, legacy `MIDDLEMAN_*` names are still accepted during startup, and legacy `MIDDLEMAN_SKILL_SHARE_BASE_URL` / `MIDDLEMAN_SKILL_SHARE_DISABLED` aliases are still accepted.

See `.env.example` for the full reference.

## Working Conventions

### Conventions

- Review/design markdown artifacts (plans, review docs) should be kept in the `.internal/` directory locally. This directory is gitignored and must never be committed — it is strictly for local working documents.
- A pre-commit hook is provided in `.githooks/pre-commit` to block accidental commits of internal files. Enable it with: `git config core.hooksPath .githooks`
- **Never run destructive git operations** (`git reset --hard`, `git push --force`, `git rebase`) on `main` or `master` without first verifying there are no unpushed local commits. Check with `git log --oneline origin/main..HEAD` before any hard reset. If unpushed commits exist, push them first or move the work to a feature branch. A Pi extension (`protected-git.ts`) enforces this at runtime, but agents should avoid attempting these operations in the first place.

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
   pnpm lint
   pnpm exec knip
   pnpm test
   cd apps/backend && pnpm exec tsc -p tsconfig.build.json --noEmit   # production-only backend typecheck; tests are covered by pnpm test
   cd apps/ui && pnpm exec tsc --noEmit
   ```

## Structural Refactor Conventions

When changing file layout or module boundaries, keep the old surface stable until callers have moved.

### Core rules

- **Test first for risky refactors:** add characterization tests before structural changes so behavior stays pinned.
- **Seam first:** keep facades thin and stable, then delegate into extracted services or modules behind compatibility seams. For runtime construction, keep provider-specific setup in `swarm/runtime/{claude,cursor-sdk,pi}/` creator modules and shared planning in `runtime-*plan.ts` helpers.
- **Compatibility shims:** use re-exports from old paths during moves; remove them only after dependent imports are updated.
- **Protocol DTO placement:** shared message and transport types live in `packages/protocol/`; keep domain-specific leaf modules there and re-export through package barrels.
- **Worktree and rollback:** use isolated git worktree branches for non-trivial or high-risk structural changes, and keep a rollback path before merging.

### Directory-specific rules

- **`swarm/`:** treat `swarm-manager.ts` as the facade/orchestrator. Extract runtime, agents, storage, catalog, skills, prompts, and session logic into dedicated subdirectories and services. Keep runtime provider dispatch in `swarm/runtime/runtime-factory.ts` and move provider-specific construction into creator modules rather than widening the facade.
- **`ws/`:** keep HTTP routes in `ws/http/routes/`, WebSocket commands in `ws/commands/`, and shared HTTP services in `ws/http/services/`.
- **`packages/protocol/`:** organize by domain leaf modules, with barrel re-exports at package boundaries and event-family files grouped by protocol surface.
- **Frontend:** decompose large components into leaf components and hooks, then expose stable barrel exports for shared UI surfaces.

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
