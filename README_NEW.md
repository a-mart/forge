<div align="center">

# Forge

**Local-first AI orchestration for real software projects.**

[![Latest Release](https://img.shields.io/github/v/release/a-mart/forge?style=flat-square)](https://github.com/a-mart/forge/releases)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square)](LICENSE)
[![Platforms](https://img.shields.io/badge/platforms-macOS%20%C2%B7%20Windows%20%C2%B7%20Linux-lightgrey?style=flat-square)](#quick-start)
[![GitHub Stars](https://img.shields.io/github/stars/a-mart/forge?style=flat-square)](https://github.com/a-mart/forge/stargazers)

[**Download Desktop App**](https://github.com/a-mart/forge/releases) &nbsp;&middot;&nbsp; [**Get Started**](docs/GETTING_STARTED.md) &nbsp;&middot;&nbsp; [**Build from Source**](CONTRIBUTING.md)

</div>

<!-- Hero screenshot: capture the desktop app showing sidebar with sessions, main chat view with manager conversation, visible worker activity, and integrated terminal. Provide dark and light variants. -->
<p align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/readme/hero-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/images/readme/hero-light.png">
  <img alt="Forge desktop app showing local multi-agent orchestration with chat, worker activity, and integrated terminal" src="docs/images/readme/hero-light.png" width="1200">
</picture>
</p>

## What Forge Is

Using one coding agent is easy. Using five turns you into their project manager — sequencing work, checking output, nudging things along, switching between tabs and terminals. Your day becomes agent choreography.

Forge gives you one persistent manager that handles the choreography for you. Describe what needs to happen and the manager breaks it down, dispatches specialist workers in parallel, keeps context alive across long-running sessions, and surfaces only what needs your attention.

Your sessions, prompts, memory, terminals, and artifacts live on disk. No cloud dependency for the core product. Backup is copying a folder. When sessions hit context limits, smart compaction writes structured handoff files and preserves pinned messages verbatim — conversations that have compacted dozens of times still maintain coherence.

Configure once, delegate forever.

## Quick Start

### Desktop App (Recommended)

Download the installer from [**GitHub Releases**](https://github.com/a-mart/forge/releases):

| Platform | Download | Notes |
|----------|----------|-------|
| **macOS** (Apple Silicon) | `Forge-<version>.dmg` | Signed and notarized |
| **Windows** (x64) | `Forge-Setup-<version>.exe` | |
| **Linux** | `Forge-<version>.AppImage` | |

No dependencies required. The desktop app bundles everything and auto-updates.

On first launch, sign in with your **OpenAI**, **Anthropic**, or **Claude SDK** account in Settings. Then create a project, point it at a directory, and start chatting.

> Claude SDK uses Claude Code CLI OAuth and does not require an API key.

### From Source

```bash
git clone https://github.com/a-mart/forge.git
cd middleman
pnpm install        # requires Node.js 22+ and pnpm 10.30+
pnpm dev            # starts backend + UI with hot reload
```

Open [http://127.0.0.1:47188](http://127.0.0.1:47188) and configure credentials in Settings.

See the [Getting Started Guide](docs/GETTING_STARTED.md) for a full walkthrough, or [Windows Setup](docs/WINDOWS_SETUP.md) for platform-specific notes.

## A Typical Forge Workflow

<!-- Workflow GIF/MP4: short clip showing a user giving a high-level task, the manager spawning workers, parallel activity appearing, and results flowing back in chat. -->
<!--
<p align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/readme/workflow-dark.gif">
  <source media="(prefers-color-scheme: light)" srcset="docs/images/readme/workflow-light.gif">
  <img alt="Forge workflow: one prompt becomes coordinated parallel work" src="docs/images/readme/workflow-light.gif" width="900">
</picture>
</p>
-->

You talk to one manager per project. Describe work at a high level — a feature, a batch of fixes, a refactor across multiple files — and the manager handles the rest:

1. **Breaks it down** into discrete tasks and spawns specialist workers in parallel
2. **Routes each task** to the right model and runtime for the job
3. **Tracks progress** across workers, handles merging, detects stalls
4. **Reports back** with results, blockers, or decisions that need your input

Workers run in isolated worktrees so they don't step on each other. You can watch everything happen in real time from the dashboard — green worker pills show who's active, click for a peek at what each one is doing — or walk away and check in later from the mobile companion app.

Fork any session from any point to branch into parallel workstreams that share prior context. The more you use Forge, the better it gets. Rate messages, explain your preferences, describe your review process — Cortex learns and adapts over time.

## Core Capabilities

### Multi-Agent Orchestration

One persistent manager coordinates parallel workers across your project. Describe what needs to happen — a feature, a batch of fixes, a cross-cutting refactor — and Forge handles task decomposition, worker lifecycle, progress tracking, and result synthesis. Workers that stall or fail to report back are detected and recovered automatically.

### Named Specialists

Define named specialist workers with per-specialist model configuration, system prompts, and tool access. Route backend work to one model, frontend to another, code review to a third. Cross-vendor fallback (Anthropic ↔ OpenAI) keeps work moving transparently if a provider has issues.

### Integrated Terminals

Per-session terminals with full PTY support, persistent across restarts. Terminal state is periodically snapshotted and restored from disk — close your laptop, reopen it, and pick up exactly where you left off. No more managing dozens of terminal windows.

### Cortex + Durable Memory

Cortex reviews your sessions and builds persistent knowledge over time — naming conventions, review process, architecture preferences, communication style. Common knowledge applies across all projects; project knowledge is scoped per codebase. All changes are versioned in git. Schedule reviews on a cron, trigger them manually, or let Cortex detect when sessions have new content worth analyzing.

### Project Agents

Promote any session to a discoverable Project Agent with a dedicated handle, editable system prompt, and reference documents. Other sessions can discover and message them asynchronously. Use this for persistent roles — documentation, testing, research — that multiple workstreams coordinate with.

### Extensions

Two extension systems, both zero-restart. **Forge Extensions** hook into session lifecycle, runtime errors, versioning commits, and cross-runtime tool interception. **Pi Extensions** add custom tools, event interception, context injection, and custom model providers. Drop a TypeScript file into the right directory and it loads on the next session — no build step required.

<!-- Feature screenshots: three side-by-side images showing (1) specialists/model routing config, (2) integrated terminal with persistence, (3) Project Agents in sidebar -->
<!--
<p align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/readme/specialists-dark.png">
  <img alt="Named specialists with per-model configuration" src="docs/images/readme/specialists-dark.png" width="380">
</picture>
&nbsp;
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/readme/terminals-dark.png">
  <img alt="Integrated terminal with state persistence" src="docs/images/readme/terminals-dark.png" width="380">
</picture>
&nbsp;
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/readme/project-agents-dark.png">
  <img alt="Project Agents in the sidebar" src="docs/images/readme/project-agents-dark.png" width="380">
</picture>
</p>
-->

## Architecture at a Glance

Forge runs three layers on your machine:

```
┌─────────────────────────────────────────────┐
│  Desktop App / Dashboard UI                 │  Electron + React (TanStack Start + Vite)
├─────────────────────────────────────────────┤
│  Backend Daemon                             │  Node.js — HTTP + WebSocket
│  ┌──────────┐ ┌──────────┐ ┌─────────────┐ │
│  │ Manager  │ │ Workers  │ │ Terminals   │ │
│  │          │ │ (parallel│ │ (persistent │ │
│  │          │ │  agents) │ │  PTY)       │ │
│  └──────────┘ └──────────┘ └─────────────┘ │
├─────────────────────────────────────────────┤
│  Local Disk                                 │  ~/.forge — JSON, JSONL, Markdown
│  Sessions · Memory · Prompts · Terminals    │  No cloud, no database
└─────────────────────────────────────────────┘
```

**Stack:** TypeScript, React 19, TanStack Start, Vite, Electron, pnpm monorepo

All state lives in `~/.forge` (or `%LOCALAPPDATA%\forge` on Windows). Backup is copying a folder. Recovery is pasting it back.

## Documentation

| | |
|---|---|
| **[Getting Started](docs/GETTING_STARTED.md)** | Full onboarding walkthrough |
| **[Configuration](docs/CONFIGURATION.md)** | Environment, auth, models, data layout |
| **[Specialists](docs/SPECIALISTS.md)** | Named worker setup, model routing, fallback |
| **[Forge Extensions](docs/FORGE_EXTENSIONS.md)** | Session lifecycle hooks, tool interception |
| **[Pi Extensions](docs/PI_EXTENSIONS.md)** | Custom tools, packages, prompts, themes |
| **[Integrations](docs/INTEGRATIONS.md)** | Telegram, mobile app, push notifications |
| **[Windows Setup](docs/WINDOWS_SETUP.md)** | Platform-specific notes for Windows |

## Contributing

Forge is actively developed and contributions are welcome. See [**CONTRIBUTING.md**](CONTRIBUTING.md) for development setup, testing, and PR workflow. The project's [AGENTS.md](AGENTS.md) file has the full architecture reference.

```bash
pnpm dev              # backend + UI with hot reload
pnpm test             # run all tests
pnpm build            # build all packages
```

## Attribution

Forge is built on [Middleman](https://github.com/SawyerHood/middleman) by Sawyer Hood.

## License

[Apache-2.0](LICENSE)
