# 🔨 Forge

A local-first multi-agent orchestration platform. One manager, many workers, zero tab-juggling.

If you're using agentic coding tools, you've probably hit this wall: you start with one agent, then two, then five. You're branching, worktree-ing, reviewing, merging, context-switching. The agents are cranking out code, but your entire day is spent *managing them*. Sequencing work, checking output, nudging things along.

You're not an IC anymore. You've become a project manager. You need a middle manager.

Forge gives you one.

---

### Contents

- [Why Forge?](#why-forge)
- [Installation](#installation)
- [Core Concepts](#core-concepts)
- [Dashboard](#dashboard)
- [Skills](#skills)
- [Integrations](#integrations)
- [Getting the Most Out of Forge](#getting-the-most-out-of-forge)
- [Architecture](#architecture)
- [Configuration](#configuration)
- [Development](#development)
- [Platform Notes](#platform-notes)

---

You talk to a single persistent manager agent per project. Describe what needs to happen (a feature, a batch of bug fixes, a refactor) and the manager dispatches workers, parallelizes where it makes sense, and surfaces only the things that need your attention. If you're spending more time managing AI agents than doing your work, Forge is the next step.

## Why Forge?

There are plenty of good coding agents. Forge isn't trying to replace them. It orchestrates them, learns from you, and gets better over time.

**Your manager writes better prompts than you do at 2am.** We're all mediocre prompt writers, especially when tired or frustrated. Forge's manager agent sits between you and the workers. Your rough instructions become precise, well-structured worker prompts. It's the "write a prompt to write a prompt" workflow you were doing manually, except automatic.

**Parallelism kills latency.** Waiting 5 minutes for a model response is painful. Waiting 5 minutes while ten things run simultaneously? You barely notice. Dump a list of tasks and move on. Plan the next thing while the first one builds. You might have five sessions active with fifty workers running concurrently. That's fifty terminal windows you don't have to manage.

**It remembers things.** Most AI tools reset every session. Forge's Cortex reviews your conversations, learns your preferences, and builds persistent knowledge over time. After a few weeks, it knows your review process, your naming conventions, your code style.

**Context doesn't die.** When Claude Code compacts, you get amnesia. Forge's smart compaction writes structured handoff files, retains the most recent context, and summarizes the rest. Pin critical messages and they'll survive every compaction. The pin navigator in the chat header lets you jump directly to any pinned message. Conversations that have compacted 50+ times still maintain coherence.

**Forge builds Forge.** Every feature you see was built using Forge itself. It's been the primary development tool for this project since day one.

## Installation

### Desktop App (Recommended)

Download the native installer for your platform from [GitHub Releases](https://github.com/a-mart/forge/releases):

| Platform | Download | Notes |
|----------|----------|-------|
| **macOS** (Apple Silicon) | `Forge-<version>.dmg` | Signed and notarized |
| **Windows** (x64) | `Forge-Setup-<version>.exe` | Unsigned (SmartScreen warning expected) |
| **Linux** | `Forge-<version>.AppImage` | |

No Node.js or pnpm required. The desktop app bundles everything and updates automatically. Check for updates manually in Settings → About, or toggle beta releases to get early access to new features.

On first launch, go to Settings and sign in with your OpenAI, Anthropic, or Claude SDK account. OpenAI and Anthropic support OAuth or API key sign-in; Claude SDK uses Claude Code CLI OAuth and does not require an API key. Forge will walk you through a short welcome conversation to learn your preferences.

Then create a manager, point it at a project directory, and start chatting. See the [Getting Started Guide](docs/GETTING_STARTED.md) for a full walkthrough.

### Building from Source

If you need more control over the runtime environment or want to contribute to development:

**Prerequisites:**
- Node.js 22+
- pnpm (`npm install -g pnpm`)
- An OpenAI, Anthropic, or Claude SDK account (Claude SDK uses Claude Code CLI OAuth; no API key required)

**Setup:**
```bash
git clone https://github.com/a-mart/forge.git
cd middleman
cp .env.example .env          # Review and set any needed env vars
pnpm install
pnpm prod:daemon              # Run as background daemon
```

Open the UI at [http://127.0.0.1:47189](http://127.0.0.1:47189) and configure your API credentials in Settings.

> **Windows users:** See [docs/WINDOWS_SETUP.md](docs/WINDOWS_SETUP.md) for platform-specific setup notes.

**Build the desktop app:**
```bash
pnpm package:electron
```

The package step clears `apps/electron/release/` first, then writes the current build there and runs a staged packaged-runtime preflight before handing off to `electron-builder`.

**Desktop release safety:** `pnpm package:electron` is the build step. It now treats `apps/electron/release/` as ephemeral output for the current run, so stale assets are cleared before packaging. Official desktop releases still follow a build-first, publish-last, draft-first flow. Desktop rollout is beta-first: beta versions must be published as GitHub prereleases, and stable release happens later as a separate intentional promotion. The old `pnpm release:electron` shortcut is intentionally disabled. Use the workflow documented in [`apps/electron/README.md`](apps/electron/README.md): bump and push the version first, build macOS locally, run Windows via GitHub Actions `workflow_dispatch`, create a draft GitHub Release, keep beta builds marked as prereleases, then upload the full updater asset set (installers, archives, `latest*.yml`, `*.blockmap`, and related release files) before publishing.

### Your First Session

Before you start throwing tasks at Forge, take five minutes to have a conceptual conversation with your manager. Tell it how you like to work: your review process, your branching strategy, how you think about testing. This isn't small talk. It's calibration. The more your manager understands your style, the better it orchestrates workers on your behalf.

The builtin manager is designed to keep user-facing updates concise and outcome-focused. It will favor meaningful results, blockers, and completion updates over routine progress narration.

Then start rating messages. Thumbs up when the manager nails it, thumbs down when it misses, comments when you notice patterns. This feedback feeds directly into Cortex's learning cycle.

## Core Concepts

### Manager & Workers

Every Forge manager is tied to a project directory. You talk to the manager; the manager talks to the workers. Describe work at a high level ("implement the search feature," "fix these three bugs," "refactor the auth module") and the manager breaks it down, spawns workers, and coordinates the results.

Workers run in isolated worktrees so they don't step on each other. The manager tracks status, handles merging, and reports back. You can watch it all happen in real time from the dashboard, or walk away and check in later.

Need to run unrelated tasks at the same time? Just tell the manager. It'll figure out what can run concurrently and spin up workers in parallel.

### Sessions & Forking

Each manager supports multiple named sessions. These are independent workstreams with their own conversation history, context, and memory. Working on a backend refactor and a UI redesign at the same time? Separate sessions under the same manager.

Session forking lets you run discovery in one conversation, gather context, narrow down an approach, then fork into parallel workstreams that all inherit that context. You can fork from the current point or from any earlier message, carrying forward only the relevant context. It's branching for conversations.

**Project Agents** — Sessions can be promoted to discoverable Project Agents within a profile. Right-click any session in the sidebar and select "Promote to Project Agent." Promoted agents are stored in dedicated per-handle directories under `profiles/<profileId>/project-agents/<handle>/`, with a `config.json`, editable `prompt.md` file, and per-agent `reference/` documents. Handles are immutable after promotion, so renaming the underlying session does not change the agent handle. Other session agents in the same profile can discover and message them asynchronously using `send_message_to_agent`. Use this for dedicated specialists (documentation, testing, research) that multiple sessions need to coordinate with. Derived history caches rebuild from canonical `session.jsonl` if they were truncated, so affected project-agent conversations should show full history again after reload. The promotion UI includes AI-assisted configuration to help you write effective discovery descriptions and system prompts. Alternatively, use the Agent Creator wizard (right-click a profile header → "Create Project Agent") for a guided creation flow: it explores your codebase, interviews you about the agent's role, and configures everything automatically.

### Cortex

Cortex is a dedicated subsystem that reviews your sessions and improves Forge's behavior over time. It maintains two layers of persistent knowledge:

- **Common knowledge** — cross-project preferences and habits that apply everywhere. How you like code reviewed, your naming conventions, your communication style. Injected into every session's context.
- **Project knowledge** — per-project learned guidance. Architecture patterns, testing conventions, deployment quirks specific to each codebase. Updated more frequently.

Cortex keeps internal notes, reviews its own review process, and refines how it identifies patterns. All changes are versioned in git, so you can see exactly what changed and roll back anything that went wrong.

You can trigger reviews manually, queue up batch reviews, or schedule them on a cron. Sessions can be excluded from review if they contain sensitive or one-off work. Cortex detects both transcript drift (new conversation content) and feedback drift (new ratings since last review) to know when a session needs re-analysis.

### Smart Compaction

Every AI tool hits context limits. Most just truncate and hope for the best.

When a session reaches ~85% context capacity, Forge pauses and writes a structured markdown handoff file capturing the current operational state, then compacts. The compacted context retains the most recent ~20,000 tokens verbatim and summarizes everything older. The handoff file ensures no critical context is lost.

You can pin up to 10 messages per session (user or assistant) by clicking the pin icon. Pinned messages are preserved verbatim through all compaction types — their full content is injected into the summary under a dedicated section.

Sessions can run indefinitely. Conversations that have compacted 50+ times still maintain full coherence. No amnesia, no confusion about what was decided three hours ago.

### Worker Safeguards

Agents hang. Models stall. Workers finish their work and forget to report back. Forge handles all of this:

- **Idle detection** — if a worker completes a task but doesn't report to the manager, Forge detects the idle state and notifies the manager, which can nudge or re-engage the worker.
- **Stall detection** — workers stuck in a streaming state with no progress for five minutes get flagged. The manager is notified and can intervene.
- **Auto-kill** — if a stalled worker doesn't recover after a second five-minute window, it's terminated and reported to the manager.

Worker turn failures are projected into the manager conversation as system messages with preserved error context, and duplicate callback or summary reports for the same turn are suppressed.

You can also manually stop any agent from the UI, but you'll rarely need to.

### Feedback

Every message has a thumbs up, thumbs down, and comment button. These aren't decorative. Your ratings feed into Cortex's review cycle to identify what's working and what isn't.

You don't need to rate every message. Focus on the meaningful moments: when the manager does something clever, when a worker produces garbage, when you notice a recurring pattern. Sessions can also be rated holistically.

## Dashboard

The web UI is designed to be the only window you need open.

- **Chat** — real-time conversation with your manager. Stream worker activity or filter to just the messages directed at you. Mermaid diagrams render inline with interactive controls. Pin important messages to preserve them through compaction, then use the pin navigator to jump between them.
- **File browser** — full repository file browser with click-to-open in your editor (configurable: VS Code, Cursor, etc.).
- **Git view** — diff and commit history view, built into the dashboard.
- **Worker pills** — green indicators show active workers. Click for a quick peek at what each worker is doing.
- **Plans & artifacts** — working files, plans, and non-repo artifacts surfaced in the sidebar and inline in chat.
- **Schedules** — view and manage scheduled jobs per session.
- **Context meter** — visual indicator of context utilization with manual smart-compact trigger.
- **Session search** — search across session names and message content with highlighted results.
- **Notifications** — global notification defaults with per-manager overrides and custom sound uploads. Set baseline sounds once and all managers inherit them. Cortex is excluded from defaults so automated reviews stay quiet.
- **Prompt preview** — view the full effective system prompt being sent, including memory, knowledge, and skills.

## Skills

Managers and workers have access to built-in skills:

| Skill | Description | Requires |
|-------|-------------|----------|
| Web Search | Search the web via Brave Search API | `BRAVE_API_KEY` |
| Image Generation | Generate images with Google Gemini | `GEMINI_API_KEY` |
| Browser | Interactive web browsing and extraction | [`agent-browser`](https://github.com/vercel-labs/agent-browser) CLI |
| Chrome CDP | Inspect and interact with local Chrome tabs via DevTools Protocol | Local Chrome instance |
| Playwright | Browser automation with real-time dashboard and live preview (macOS/Linux) | `FORGE_PLAYWRIGHT_DASHBOARD_ENABLED=true` |
| Cron Scheduling | Persistent scheduled tasks with cron expressions | — |
| Slash Commands | Create and manage prompt auto-expansion commands | — |
| Memory | Persistent agent memory across sessions | — |

Skill API keys can be configured in the dashboard under Settings → Environment Variables, or via `.env` / shell environment.

Forge also supports custom skills. Place them in `${FORGE_DATA_DIR}/skills` (default: `~/.forge/skills`) using the standard `SKILL.md` frontmatter format and they'll be available to all agents. You can even have agents create new skills for you. See [docs/CONFIGURATION.md](docs/CONFIGURATION.md#machine-local-skills).

### Extensions

Forge has two extension systems:
- [Forge Extensions](docs/FORGE_EXTENSIONS.md) for Forge-native hooks like session lifecycle, runtime errors, versioning commits, and cross-runtime tool interception
- [Pi Extensions & Packages](docs/PI_EXTENSIONS.md) for Pi-native custom tools, event handlers, packages, skills, prompts, and themes

Forge Extensions are fail-open for normal thrown or rejected load, setup, and handler errors, so one bad hook usually does not take down a session. They still run in-process with no sandbox or timeout isolation, so process-level side effects like `process.exit()` or synchronous infinite loops can still affect the backend.

Beyond skills, Forge also exposes the full Pi extension and package system. Pi extensions let you deeply customize agent behavior:

- **Custom tools** — Register new tools the LLM can call (ticket lookups, API integrations, internal databases)
- **Event interception** — Block dangerous commands, redact secrets from output, audit every tool call
- **Context injection** — Modify system prompts or message history before each LLM call
- **Custom model providers** — Connect to enterprise proxies, self-hosted models, or novel APIs

Drop a TypeScript file into `~/.forge/agent/extensions/` and it's loaded for all workers — no build step, no restart required. Extensions load per-session via [jiti](https://github.com/nicolo-ribaudo/jiti) with full TypeScript support.

There's also a growing ecosystem of community Pi packages available from npm and git. Install them by adding a `settings.json` to your agent config directory. See the [Pi Extensions guide](docs/PI_EXTENSIONS.md) for the full reference.

## Integrations

- **Telegram** — create a bot via [@BotFather](https://t.me/botfather), add the token in Settings. Full bidirectional messaging with your manager, including code blocks and file attachments.
- **Mobile app** — iOS and Android companion app with push notifications. Get notified when workers finish, reply to your manager from anywhere. Currently in TestFlight beta.

See [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) for setup instructions.

## Getting the Most Out of Forge

### Teach It How You Work

Don't just assign tasks. Have conversations about your process. If you have a review methodology, explain it. If you prefer certain models for certain tasks (one model for backend, another for frontend), tell the manager. If you have a multi-phase workflow (brainstorm, plan with review, implement, code review), describe it.

Forge is deliberately un-opinionated. It doesn't ship with a baked-in workflow because everyone works differently.

### The Prompt Quality Multiplier

When you set up a review cycle (plan gets written, reviewed by a separate model, remediated before implementation) you get compounding prompt quality. The manager writes a better prompt than you would for the review worker, which catches things a tired human wouldn't, which produces a better implementation prompt.

This is how people one-shot features that span thousands of lines of code.

### Use It for More Than Code

Forge doesn't have to be a coding tool. Feed it a meeting transcript and ask it to extract action items and build a plan. Use it for research, documentation, whatever. The manager-worker model works for any task that benefits from delegation and parallel execution.

### Run It Continuously

Forge is designed to run 24/7. With the mobile app and push notifications, you can fire off a complex task, close your laptop, and check in from your phone when it's done. Smart compaction means sessions don't degrade over time.

## Architecture

Forge runs three layers on your machine:

| Layer | Description |
|-------|-------------|
| **Dashboard UI** (`apps/ui`) | TanStack Start + Vite SPA. Real-time agent monitoring, chat, file browser, settings. |
| **Backend Daemon** (`apps/backend`) | Node.js HTTP + WebSocket server. Agent orchestration, message routing, persistence, scheduler. |
| **Agents** | Manager and worker agents powered by [pi](https://github.com/badlogic/pi-mono). Each worker runs in its own worktree. |

Communication between UI and backend is over WebSocket. The backend spawns and manages agent processes, persists all state to disk, and handles integrations and scheduling. Agents are extensible through both [Forge Extensions](docs/FORGE_EXTENSIONS.md) and Pi's [extension system](docs/PI_EXTENSIONS.md).

All runtime data lives locally. No cloud, no database. Just JSON, JSONL, and markdown files under `~/.forge` (or `%LOCALAPPDATA%\forge` on Windows). Backup means copying a folder. Recovery means pasting it back. See [docs/CONFIGURATION.md](docs/CONFIGURATION.md) for the full data layout.

## Configuration

Copy the example environment file and edit as needed:

```bash
cp .env.example .env
```

The `.env.example` file documents all available options with comments. Key categories:

- **Core** — host, port, data directory, debug mode
- **UI** — WebSocket URL override (dev only, production auto-resolves)
- **Skills** — API keys for Brave Search, Gemini image generation
- **Agent Runtimes** — Codex API key and binary path
- **Playwright** — dashboard toggle (macOS/Linux only)

API keys for LLM providers (OpenAI, Anthropic, xAI) are configured in the dashboard UI under **Settings → Authentication**, not in `.env`. The **Settings → Models** tab provides a full catalog of supported models with visibility controls and context window overrides.

See [docs/CONFIGURATION.md](docs/CONFIGURATION.md) for the full configuration reference.

## Development

```bash
# Start backend + UI in dev mode (hot reload)
pnpm dev
# Backend: http://127.0.0.1:47187
# UI:      http://127.0.0.1:47188

# Build everything
pnpm build

# Package the Electron app locally (build only, no publish)
pnpm package:electron

# Run tests
pnpm test

# Typecheck (run from each package, not root)
# Backend note: tsconfig.build.json is production-only and excludes tests.
# Pair it with backend tests for test-file validation.
cd apps/backend && pnpm exec tsc -p tsconfig.build.json --noEmit
cd apps/ui && pnpm exec tsc --noEmit
```

Desktop releases are draft-first, beta-first, and publish-last. Use `workflow_dispatch` for Windows release builds, `electron/*` branches for Windows validation only, publish beta builds only as GitHub prereleases, and upload the full updater asset set when publishing. For backend validation, treat `tsconfig.build.json` as a production-only typecheck and rely on `pnpm test` (or `pnpm --filter @forge/backend test`) for test coverage. See [`apps/electron/README.md`](apps/electron/README.md) for the current release runbook.

### Production

```bash
# Build and start in foreground
pnpm prod

# Or run as a background daemon
pnpm prod:daemon

# Restart a running daemon
pnpm prod:restart
```

Production defaults:
- Backend: `http://127.0.0.1:47287`
- UI: `http://127.0.0.1:47189`

## Platform Notes

Forge runs on macOS, Linux, and Windows.

| | macOS | Linux | Windows |
|---|---|---|---|
| Core functionality | ✅ | ✅ | ✅ |
| Dashboard UI | ✅ | ✅ | ✅ |
| Agent orchestration | ✅ | ✅ | ✅ |
| Playwright dashboard | ✅ | ✅ | ❌ (Unix sockets required) |
| Shell scripts (`scripts/*.sh`) | ✅ | ✅ | Requires WSL or Git Bash |
| Default data directory | `~/.forge` | `~/.forge` | `%LOCALAPPDATA%\forge` |

See [docs/WINDOWS_SETUP.md](docs/WINDOWS_SETUP.md) for detailed Windows setup instructions.

## Project Structure

```
forge/
├── apps/
│   ├── backend/       # Node.js daemon — orchestration, persistence, integrations
│   └── ui/            # React dashboard — TanStack Start + Vite SPA
├── packages/
│   └── protocol/      # Shared TypeScript types and wire contracts
├── scripts/           # Production daemon, dev helpers (see scripts/README.md)
├── docs/              # Documentation
└── .env               # Environment config (copy from .env.example)
```

## A Note

Forge is built on [Middleman](https://github.com/SawyerHood/middleman) by Sawyer Hood.

This project started as a personal tool and is shared in that spirit. It's functional, actively used in production, and being improved continuously. Forge is the primary tool used to develop itself. The system you see today will probably be unrecognizable in a month. It prioritizes practical utility over enterprise polish.

These are powerful tools with broad system access. Agents can create files, run commands, and modify your environment. Use version control, keep backups, and be thoughtful about what you let agents do unsupervised.

Fork it, tear it apart, or use it as a starting point to build your own middle manager.

## License

[Apache-2.0](LICENSE)
