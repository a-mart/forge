<p align="center">
  <img src="docs/images/middleman-header.png" alt="Middleman" width="100%">
</p>

# 👔 Middleman

A local-first multi-agent orchestration platform. One manager, many workers, zero tab-juggling.

If you're using agentic coding tools, you've probably hit this wall: you start with one agent, then two, then five. You're branching, worktree-ing, reviewing, merging, context-switching. The agents are cranking out code. But your entire day is spent *managing them* — sequencing work, checking output, nudging things along.

You're not an IC anymore. You've become a project manager. You need a middle manager.

**Middleman gives you one.** You talk to a single persistent manager agent per project. You describe what needs to be done — a feature, a batch of bug fixes, a refactor — and the manager dispatches workers, parallelizes where it makes sense, and surfaces only the things that need your attention.

![Middleman UI](docs/images/ui-screenshot.png)

## Quick Start

### Prerequisites

- **Node.js 22+**
- **pnpm** (`npm install -g pnpm`)
- An **OpenAI** or **Anthropic** account (OAuth or API key)

### Install & Run

```bash
git clone https://github.com/radopsai/middleman.git
cd middleman
pnpm i
pnpm prod:daemon
```

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

## Architecture

Middleman runs three layers on your machine:

<p align="center">
  <img src="docs/architecture.svg" alt="Architecture" width="600">
</p>

| Layer | Description |
|-------|-------------|
| **Dashboard UI** (`apps/ui`) | TanStack Start + Vite SPA. Real-time agent monitoring, chat, settings, artifacts. |
| **Backend Daemon** (`apps/backend`) | Node.js HTTP + WebSocket server. Agent orchestration, message routing, persistence, scheduler. |
| **Agents** | Manager and worker agents powered by [pi](https://github.com/nichochar/pi-mono). Each worker runs in its own worktree. |

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
cd apps/backend && pnpm exec tsc --noEmit
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

Middleman runs on **macOS**, **Linux**, and **Windows**.

| | macOS / Linux | Windows |
|---|---|---|
| Core functionality | ✅ | ✅ |
| Dashboard UI | ✅ | ✅ |
| Agent orchestration | ✅ | ✅ |
| Playwright dashboard | ✅ | ❌ (Unix sockets required) |
| Shell scripts (`scripts/*.sh`) | ✅ | Requires WSL or Git Bash |
| Default data directory | `~/.middleman` | `%LOCALAPPDATA%\middleman` |

See [docs/WINDOWS_SETUP.md](docs/WINDOWS_SETUP.md) for detailed Windows setup instructions.

## Project Structure

```
middleman/
├── apps/
│   ├── backend/       # Node.js daemon — orchestration, persistence, integrations
│   ├── ui/            # React dashboard — TanStack Start + Vite SPA
│   └── site/          # Landing page
├── packages/
│   └── protocol/      # Shared TypeScript types and wire contracts
├── scripts/           # Production daemon, dev helpers (see scripts/README.md)
├── docs/              # Documentation
└── .env               # Environment config (create from .env example below)
```

## Configuration

Create a `.env` file in the project root for environment overrides:

```bash
# Backend host and port
MIDDLEMAN_HOST=127.0.0.1
MIDDLEMAN_PORT=47187

# Data directory (default: ~/.middleman on macOS/Linux, %LOCALAPPDATA%\middleman on Windows)
# MIDDLEMAN_DATA_DIR=/path/to/data

# WebSocket URL for UI to connect to backend (dev only — production auto-resolves)
# VITE_MIDDLEMAN_WS_URL=ws://127.0.0.1:47187

# Skill API keys (optional — enables specific skills)
# BRAVE_API_KEY=...        # Web search skill
# GEMINI_API_KEY=...       # Image generation skill

# Playwright dashboard (macOS/Linux only)
# MIDDLEMAN_PLAYWRIGHT_DASHBOARD_ENABLED=true
```

**API keys** for LLM providers (OpenAI, Anthropic) are configured in the dashboard UI under **Settings**, not in `.env`.

See [docs/CONFIGURATION.md](docs/CONFIGURATION.md) for the full configuration reference.

## Integrations

Middleman supports messaging integrations so you can chat with your manager from mobile or desktop messaging apps:

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
| **Browser** | Interactive web browsing and extraction | `agent-browser` CLI |
| **Cron Scheduling** | Persistent scheduled tasks with cron expressions | — |
| **Memory** | Persistent agent memory across sessions | — |

Skill API keys can be configured in the dashboard under **Settings → Environment Variables**. `.env` (or shell env vars) is still supported as a fallback.

## A Note

This is a vibecoded project. It's here to inspire, not to be a polished product. Fork it, tear it apart, or use it as a starting point to build your own middle manager.

## License

[Apache-2.0](LICENSE)
