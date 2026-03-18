# 🔨 Forge

A local-first multi-agent orchestration platform. One manager, many workers, zero tab-juggling.

If you're using agentic coding tools, you've probably hit this wall: you start with one agent, then two, then five. You're branching, worktree-ing, reviewing, merging, context-switching. The agents are cranking out code. But your entire day is spent *managing them* — sequencing work, checking output, nudging things along.

You're not an IC anymore. You've become a project manager. You need a middle manager.

**Forge gives you one.** You talk to a single persistent manager agent per project. You describe what needs to be done — a feature, a batch of bug fixes, a refactor — and the manager dispatches workers, parallelizes where it makes sense, and surfaces only the things that need your attention.

## Quick Start

### Prerequisites

- **Node.js 22+**
- **pnpm** (`npm install -g pnpm`)
- An **OpenAI** or **Anthropic** account (OAuth or API key)

### Install & Run

<!-- TODO: confirm canonical URL before publish -->
```bash
git clone https://github.com/radopsai/middleman.git
cd middleman
pnpm i
pnpm prod:daemon
```

Default configuration works out of the box. See [Configuration](#configuration) to customize.

Open the UI at [http://127.0.0.1:47189](http://127.0.0.1:47189), go to **Settings**, and sign in with your OpenAI or Anthropic account (OAuth or API key). Create a manager, point it at your project directory, and start chatting.

> **Windows users:** See [docs/WINDOWS_SETUP.md](docs/WINDOWS_SETUP.md) for platform-specific setup notes.

## Features

- **Persistent managers** — Onboard once, work for days. Managers remember your preferences, workflow, and project context across sessions via compacting memory.
- **Worker dispatch** — The manager spawns workers and routes tasks between them. Describe work at a high level; it handles the breakdown.
- **Parallel execution** — Dump a list of tasks and the manager figures out what can run concurrently. Stream-of-thought voice dumps welcome.
- **Dashboard UI** — Real-time web interface for watching agents work, chatting with your manager, and managing settings.
- **Multi-session** — Run multiple sessions per manager for different workstreams, each with their own context and memory.
- **Integrations** — Chat with your manager from Telegram or Slack. See [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md).
- **Built-in skills** — Web search, image generation, browser automation, cron scheduling, and persistent memory. See [Skills](#skills).
- **Cortex review queue** — Scan backlog, launch review runs, track queued/running/completed work, and open backing review sessions without cluttering the main sidebar. See [docs/CORTEX_REVIEW_RUNS.md](docs/CORTEX_REVIEW_RUNS.md).

## Architecture

Forge runs three layers on your machine:

| Layer | Description |
|-------|-------------|
| **Dashboard UI** (`apps/ui`) | TanStack Start + Vite SPA. Real-time agent monitoring, chat, settings, artifacts. |
| **Backend Daemon** (`apps/backend`) | Node.js HTTP + WebSocket server. Agent orchestration, message routing, persistence, scheduler. |
| **Agents** | Manager and worker agents powered by [pi](https://github.com/badlogic/pi-mono). Each worker runs in its own worktree. |

Communication between UI and backend is over WebSocket. The backend spawns and manages agent processes, persists all state to disk, and handles integrations and scheduling.

## Development

```bash
# Start backend + UI in dev mode (hot reload)
pnpm dev
# Backend: http://127.0.0.1:47187
# UI:      http://127.0.0.1:47188

# Build everything
pnpm build

# Run tests
pnpm test

# Typecheck (run from each package, not root)
cd apps/backend && pnpm exec tsc -p tsconfig.build.json --noEmit
cd apps/ui && pnpm exec tsc --noEmit
```

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

Forge runs on **macOS**, **Linux**, and **Windows**.

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

## Configuration

Copy the example environment file and edit as needed:

```bash
cp .env.example .env
```

The `.env.example` file documents all available options with comments. Key categories:

- **Core** — Host, port, data directory, debug mode
- **UI** — WebSocket URL override (dev only — production auto-resolves)
- **Skills** — API keys for Brave Search, Gemini image generation
- **Agent Runtimes** — Codex API key and binary path
- **Playwright** — Dashboard toggle (macOS/Linux only)

**API keys** for LLM providers (OpenAI, Anthropic) are configured in the dashboard UI under **Settings**, not in `.env`.

See [docs/CONFIGURATION.md](docs/CONFIGURATION.md) for the full configuration reference.

## Integrations

Forge supports messaging integrations so you can chat with your manager from mobile or desktop messaging apps:

- **Telegram** — Create a bot via [@BotFather](https://t.me/botfather), add the token in Settings.
- **Slack** — Create a Slack app with Socket Mode, add the bot and app tokens in Settings.

Both integrations support bidirectional messaging: send tasks to your manager and receive responses, including formatted code blocks and file attachments.

See [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) for detailed setup instructions.

## Skills

Managers and workers have access to built-in skills:

| Skill | Description | Requires |
|-------|-------------|----------|
| **Web Search** | Search the web via Brave Search API | `BRAVE_API_KEY` |
| **Image Generation** | Generate images with Google Gemini | `GEMINI_API_KEY` |
| **Browser** | Interactive web browsing and extraction | [`agent-browser`](https://github.com/vercel-labs/agent-browser) CLI |
| **Chrome CDP** | Inspect and interact with a local Chrome session via DevTools Protocol | Local Chrome instance |
| **Cron Scheduling** | Persistent scheduled tasks with cron expressions | — |
| **Slash Commands** | Create and manage global slash commands | — |
| **Memory** | Persistent agent memory across sessions | — |

Skill API keys can be configured in the dashboard under **Settings → Environment Variables**. `.env` (or shell env vars) is still supported as a fallback.

For machine-local extensions, Forge also scans `${FORGE_DATA_DIR}/skills` (default: `~/.forge/skills` on macOS/Linux, `%LOCALAPPDATA%\forge\skills` on Windows) before repo-local `.swarm/skills` overrides and built-ins. Skills there use the normal `SKILL.md` frontmatter format and are injected into all agent/runtime sessions. See [docs/CONFIGURATION.md](docs/CONFIGURATION.md#machine-local-skills).

## A Note

Forge is built on [Middleman](https://github.com/SawyerHood/middleman) by Sawyer Hood.

This project started as a personal tool and is shared in that spirit. It's functional, actively used in production, and being improved continuously — but it prioritizes practical utility over enterprise polish. Fork it, tear it apart, or use it as a starting point to build your own middle manager.

## License

[Apache-2.0](LICENSE)
