# 🔨 Forge

A local-first multi-agent orchestration platform. One manager, many workers, zero tab-juggling.

Local projects keep their data and execution on your Forge instance. Optional **Remote Projects** can connect the same Builder UI to projects on another Forge collaboration server; those profiles, sessions, workspaces, terminals, and agents remain on that selected server and are never cloned or synchronized into the local data directory.

If you're using agentic coding tools, you've probably hit this wall: you start with one agent, then two, then five. You're branching, worktree-ing, reviewing, merging, context-switching. The agents are cranking out code, but your entire day is spent *managing them*. Sequencing work, checking output, nudging things along.

You're not an IC anymore. You've become a project manager. You need a middle manager.

Forge gives you one.

---

### Contents

- [Why Forge?](#why-forge)
- [Installation](#installation)
- [Command Line Interface](#command-line-interface)
- [Core Concepts](#core-concepts)
- [Dashboard](#dashboard)
- [Skills](#skills)
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

**It remembers things.** Most AI tools reset every session. Forge's Cortex captures your corrections and preferences as they happen and builds persistent, provenance-tracked knowledge over time. After a few weeks, it knows your review process, your naming conventions, your code style.

**Context doesn't die.** When Claude Code compacts, you get amnesia. Forge's smart compaction writes structured handoff files, retains the most recent context, and summarizes the rest. Manual Smart compact on an already-idle manager keeps it idle on Pi-backed managers, while active or interrupted work resumes after compaction. Active compaction or context recovery also shows a violet pulsing `C` badge in the sidebar. Pin critical messages and they'll survive every compaction. The pin navigator in the chat header lets you jump directly to any pinned message. Conversations that have compacted 50+ times still maintain coherence.

**Forge builds Forge.** Every feature you see was built using Forge itself. It's been the primary development tool for this project since day one.

## Installation

### Desktop App (Recommended)

Download the native installer for your platform from [GitHub Releases](https://github.com/a-mart/forge/releases):

| Platform | Download | Notes |
|----------|----------|-------|
| **macOS** (Apple Silicon) | `Forge-<version>.dmg` | Signed and notarized |
| **Windows** (x64) | `Forge-Setup-<version>.exe` | Signed; SmartScreen may still warn until reputation is established |
| **Linux** | `Forge-<version>.AppImage` | |

No Node.js or pnpm required. The desktop app bundles everything and updates automatically. Check for updates manually in Settings → About, or toggle beta releases to get early access to new features.

On first launch, configure at least one model provider in Settings to run agents. **Settings → Authentication** currently shows OAuth account-pool cards for OpenAI and Anthropic. xAI has one direct, non-pooled credential row that accepts either an API key or OAuth; saving one replaces the other. OpenRouter and Cursor SDK remain key/token-only rows. Status and auth-type badges appear only on applicable cards. OpenAI/Codex can also use the Forge Auth broker in v1, which supplies short-lived leases that Forge acquires, renews, reports, and releases while runtimes are active. The primary broker setup path is a one-time setup link from your broker administrator: paste it in Settings → Authentication → OpenAI → Forge Auth broker, and Forge redeems it server-to-server without asking you to copy runtime tokens. While broker mode is active, local OpenAI credentials stay visible but are read-only. See [Provider Authentication](docs/CONFIGURATION.md#provider-authentication) for details. Forge will walk you through a short welcome conversation to learn your preferences.

Then create a manager, point it at a project directory, and start chatting. See the [Getting Started Guide](docs/GETTING_STARTED.md) for a full walkthrough.

Need terminal automation? Open **Settings → CLI Access** to generate a CLI key and install the bundled `forge` command. Desktop installs do not require Node.js for CLI use.

You can also customize **Settings → Appearance** with Light, Dark, or System mode, appearance templates, and editable accent/background/foreground colors and UI/code fonts. Changes are drafted first and only applied when you click **Apply**; the saved appearance lives in local renderer/browser state, not shared server profile config.

### Building from Source

If you need more control over the runtime environment or want to contribute to development:

**Prerequisites:**
- Node.js 22.19.0+
- pnpm (`npm install -g pnpm`)
- Credentials for at least one supported agent provider (for example, OpenAI, Anthropic, xAI, OpenRouter, or Cursor SDK). For OpenAI/Codex only, a Forge Auth broker setup link can configure broker-backed access instead of local OpenAI credentials.

**Setup:**
```bash
git clone https://github.com/a-mart/forge.git
cd forge
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

## Command Line Interface

Forge includes a first-party `forge` CLI for headless automation. Use it to inspect profiles and sessions, send messages, run one-shot tasks, wait for completion, and answer pending choices from scripts.

Desktop users should configure it from **Settings → CLI Access**: generate a key, click **Install CLI**, then add the shown user-local bin directory to `PATH` if needed. The desktop shim uses the bundled app runtime, so no separate Node.js install is required.

Source or server installs can use npm:

```bash
npm install -g @forge/cli
export FORGE_URL=http://127.0.0.1:47287
export FORGE_CLI_API_KEY=...
forge doctor
```

For automation, prefer `FORGE_CLI_API_KEY` or `--api-key` over saved plaintext config. CLI keys are managed separately from model-provider credentials and should be rotated or revoked from Settings when no longer needed. See [`docs/CLI.md`](docs/CLI.md) for the full command reference and validation notes.

### Your First Session

Before you start throwing tasks at Forge, take five minutes to have a conceptual conversation with your manager. Tell it how you like to work: your review process, your branching strategy, how you think about testing. This isn't small talk. It's calibration. The more your manager understands your style, the better it orchestrates workers on your behalf.

The builtin manager is designed to keep user-facing updates concise and outcome-focused. It will favor meaningful results, blockers, and completion updates over routine progress narration.

Then start rating messages. Thumbs up when the manager nails it, thumbs down when it misses, comments when you notice patterns. This feedback feeds directly into Cortex's learning cycle.

## Core Concepts

### Manager & Workers

Every Forge manager is tied to a project directory. You talk to the manager; the manager talks to the workers. Describe work at a high level ("implement the search feature," "fix these three bugs," "refactor the auth module") and the manager breaks it down, spawns workers, and coordinates the results.

Workers run in isolated worktrees so they don't step on each other. They execute focused tasks and report evidence; the manager retains accountability, performs the smallest focused check needed to accept their work, handles merging, and reports the accepted result or a material blocker. You can watch it all happen in real time from the dashboard, or walk away and check in later.

Need to run unrelated tasks at the same time? Just tell the manager. It'll figure out what can run concurrently and spin up workers in parallel.

### Sessions & Forking

Each manager supports multiple named sessions. These are independent workstreams with their own conversation history, context, and memory. Working on a backend refactor and a UI redesign at the same time? Separate sessions under the same manager.

Session forking lets you run discovery in one conversation, gather context, narrow down an approach, then fork into parallel workstreams that all inherit that context. You can fork from the current point or from any earlier message, carrying forward only the relevant context. It's branching for conversations. Cursor SDK runtime state and usage records are omitted from forks so resumed branches do not leak SDK state or double-count usage. Historical Codex sidecar display cards are also omitted from forked sessions.

### Remote Projects

Remote Projects lets Builder show normal projects from an authenticated Forge collaboration server alongside local projects. Add and test the server under **Settings → Collaboration**, sign in, and enable **Remote projects** for that connection. In Builder, a blue, globe-marked project header expands or collapses its session list; select a nested session row, which uses a status dot rather than the globe marker, to make that server the active origin. Chat and agent execution, Files, Source Control, attachments, Session Audit, and terminals then target the remote instance. Selecting a local session switches those surfaces back.

Remote Projects is not replication: remote profiles, sessions, files, repositories, PTYs, credentials, and agent execution stay on the selected server, with no local clone, sync, or fallback copy. Non-chat Settings, Stats, Archive, Cortex, onboarding, provider usage, and sidebar-order persistence remain local. Remote Projects is intended for trusted members because an enabled server grants broad Builder read/write access rather than per-project ACLs. See the [Remote Projects guide](docs/collaboration/REMOTE_PROJECTS.md) for setup, supported surfaces, security boundaries, and operator controls.

**Progressive coordination** — For substantial multi-step work, Builder managers can maintain a concise current checklist through `update_plan`. When work genuinely needs independent streams, dependencies, gates, retries, or fan-in, `update_work_graph` promotes that same session state into an executable graph: Forge launches dependency-ready nodes under a concurrency cap, chooses economical worker policies from node shape, pauses successful nodes for manager acceptance, and releases dependents only after acceptance. Direct requests and short plans remain graph-free. Both forms persist in `plan.json` and use the existing live/replay plan surface; graph nodes add dependency, attempt, and routing detail to the same card rather than creating another project-management system. Worker assignment and completed-plan usage receipts remain in `plan-usage.ndjson` for offline analysis.

**Session goals** — When a user explicitly asks for sustained pursuit, a Builder manager can keep one durable outcome active across turns, compaction, restarts, and multiple working plans. A compact bar below the chat header exposes status, active elapsed time, optional token budget, and user controls. Current state lives in `goal.json`; completed and cancelled records append to `goal-history.ndjson`. Stop and archive preserve a goal without pursuing it, clear cancels and archives it, and forks omit it.

**Project Agents** — Sessions can be promoted to discoverable Project Agents within a profile. Right-click any session in the sidebar and select "Promote to Project Agent." Profile-local promoted agents are stored in dedicated per-handle directories under `profiles/<profileId>/project-agents/<handle>/`, with a `config.json`, editable `prompt.md` file, and per-agent `reference/` documents. Repositories can also ship definitions under `.forge/project-agents/<definitionId>/` (`config.json`, live `prompt.md`, optional read-only `reference/*.md`) that users activate/link into normal sessions; unlinking clears the repo source link without deleting session history or repo files. Valid repo-defined Project Agents appear in the sidebar as inactive/repo-defined rows; clicking one opens the Repository Resources activation sheet, and the agent stays unavailable until it is activated/linked. Handles are immutable after promotion, so renaming the underlying session does not change the agent handle. Other local session agents in the same profile can discover and message them asynchronously using `send_message_to_agent`. Project Agents can also be shared to other profiles, but only through explicit grants controlled from the source agent's Project Agent settings. Granted shared agents appear in the target profile's external/shared-agent directory and @mention autocomplete, visually distinct from local agents. Shared turns are constrained: they do not inherit source-only capabilities from the target session, and Project Agent sends reject attachments. Some project agents can also be granted session-creation capability in the same profile, so they can create new manager sessions without changing that scope boundary. Created sessions show creator attribution in the sidebar, and the creator can continue messaging those sessions through the existing routing path. Use this for dedicated specialists (documentation, testing, research) that multiple sessions need to coordinate with. Derived history caches rebuild from canonical `session.jsonl` if they were truncated, so affected project-agent conversations should show full history again after reload. Archived sessions and projects stay reversible, but they are read-only and unavailable for runtime use until restored. Archive entries are sorted by last user-message activity and show the last-used date. The promotion UI includes AI-assisted configuration to help you write effective discovery descriptions and role instructions layered with Forge's Project Agent base prompt. Alternatively, use the Agent Creator wizard (right-click a profile header → "Create Project Agent") for a guided creation flow: it explores your codebase, interviews you about the agent's role, and configures everything automatically.

### Cortex

Cortex is Forge's persistent knowledge system. It is surfaced in the Builder sidebar as a pinned entry, while other system profiles and collaboration-surface sessions remain hidden. The Knowledge v2 preview stores small provenance-bearing entries in two scopes:

- **Global knowledge** — cross-project preferences and habits that apply everywhere, such as review, naming, and communication conventions.
- **Profile-scoped knowledge** — learned guidance for one profile, such as architecture patterns, testing conventions, and deployment gotchas.

Knowledge v2 is **off by default**. When enabled, managers receive token-capped global and profile `INDEX.md` files plus the current session's `memory.md`; they pull full entries on demand with the `knowledge` tool. Canonical profile `memory.md` continues to be maintained in v2 mode. Legacy shared `common.md` is preserved during normal switching, but neither is prompt-injected in that mode. Normal switching preserves both stores, and turning v2 off restores legacy common + profile + session injection while those legacy originals remain. Explicit legacy cleanup archives and removes those originals, after which OFF alone cannot restore their prior content.

Before a normal false→true activation, an operator must run the guarded migration. A successful migration commits a valid manifest and immediately activates v2. If activation persistence fails after that commit, the manifest remains an authorized recovery point with v2 OFF; it also permits ordinary re-enable after a later disable. Settings reports when migration is required, while first-launch v2 onboarding withholds unsafe activation. The backend fails closed if capability cannot be proven and rejects unsafe activation with HTTP 409 / `KNOWLEDGE_V2_MIGRATION_REQUIRED`. While v2 is ON, the consolidator reads entries—not transcripts—to merge duplicates, resolve contradictions, archive stale entries, and regenerate indexes. The Cortex dashboard exposes **Index**, read-only **Entries**, consolidation **Log**, and **Run** (Consolidate now, Last run, and Promotion review queue).

### Smart Compaction

Every AI tool hits context limits. Most just truncate and hope for the best.

When a session reaches ~85% context capacity, Forge pauses and writes a structured markdown handoff file capturing the current operational state, then compacts. The compacted context retains the most recent ~20,000 tokens verbatim and summarizes everything older. The handoff file ensures no critical context is lost. While compaction or context recovery is active, the session row shows a violet pulsing `C` badge in the sidebar. If you trigger Smart compact manually on an already-idle Pi-backed manager, it stays idle afterward; if the manager is active, interrupted, or dispatch-pending, it resumes after compaction. **Settings → General → Compaction** controls the compaction model, reasoning, and timeout for supported Pi-backed OpenAI/Codex and Anthropic manager compaction runtimes only, not Cursor SDK or xAI/Grok runtimes.

You can pin up to 10 messages per session (user or assistant) by clicking the pin icon. Pinned messages are preserved verbatim through all compaction types — their full content is injected into the summary under a dedicated section.

Sessions can run indefinitely. Conversations that have compacted 50+ times still maintain full coherence. No amnesia, no confusion about what was decided three hours ago.

### Worker Safeguards

Agents hang. Models stall. Workers finish their work and forget to report back. Forge handles all of this:

- **Idle detection** — if a worker completes a task and reports on turn end before the runtime flips fully idle, Forge auto-reports that completion to the manager. The idle watchdog/status-idle path remains a fallback and noise-suppression layer, not the only completion gate, so normal completion reporting is not duplicated during worker or parent runtime recovery.
- **Stall detection** — workers stuck in a streaming state with no progress for five minutes get flagged. The manager is notified and can intervene, unless worker or parent runtime recovery is active.
- **Auto-kill** — if a stalled worker doesn't recover after a second five-minute window, it's terminated and reported to the manager, again skipped during runtime recovery.
- **Transient terminated errors** — a bare runtime `errorMessage: "terminated"` waits out a 60-second grace period before failure projection. If the worker resumes progress or self-reports during that window, the transient error is canceled; otherwise it expires through the normal worker error/watchdog path once.

Worker turn failures are projected into the manager conversation as system messages with preserved error context, and duplicate callback or summary reports for the same turn are suppressed.

Manager turns have a separate liveness watchdog. On an approximately 60-second polling cycle, amber System notices can escalate after roughly 30 seconds, 5 minutes, and 10 minutes without progress; tool execution, compaction, and recovery can affect that clock. The notices do not provide an inline recycle action—if a manager stays stuck, use **Stop All** and send again. After a backend restart Forge does not auto-resume: when recovery data is available, Builder shows a banner with **Resume all** (best effort from the last persisted state) and **Dismiss** (hide the snapshot only). Mid-generation output is not reconstructed, so inspect state before resuming actions that may have side effects.

You can also manually stop any agent from the UI, but you'll rarely need to.

### Feedback

Message feedback is collected through a single feedback trigger and popover with **Good response**, **Needs work**, and **Add/update comment** actions. These aren't decorative: feedback can trigger a bounded Cortex capture check so durable learning is not missed.

You don't need to rate every message. Focus on the meaningful moments: when the manager does something clever, when a worker produces garbage, when you notice a recurring pattern. Sessions can also be rated holistically.

## Dashboard

The web UI is designed to be the only window you need open.

- **Chat** — real-time conversation with your manager. Stream worker activity or filter to just the messages directed at you. Builder chat supports per-message Reply annotations on normal visible user and assistant messages; sent replies show compact quotes and carry persisted `replyTo` metadata into the manager's structured model context. Session Audit Log provides the diagnostic path for canonical persisted rows: a compact row list plus JSON detail inspector, with a draggable/resizable split pane on desktop. Supported provider rows are classified as hidden runtime rows instead of unknown messages, while provider internals stay out of normal summaries and previews unless you inspect the JSON detail. Mermaid diagrams render inline with interactive controls. Pin important messages to preserve them through compaction, then use the pin navigator to jump between them.
- **Unified local/remote sidebar** — project headers expand or collapse their nested sessions; they do not select a conversation. Enabled remote headers appear blue with a globe marker beside local projects, while their session rows use status dots. Remote project actions are limited: **Change Working Directory** is available on the project header through the server directory browser, while local rename, archive, delete, fork, and model actions are absent. Connections can show connecting, sign-in-required, unreachable, server-disabled, update-required, or empty states. Selecting a remote session makes its server the active origin for supported project surfaces; selecting a local session switches back. Author chips identify other users in remote chat, while the viewer indicator is presence for subscribed session viewers only—not typing, editing, or locking. The saved mixed order is a local preference and does not grant access to any remote project.
- **Workspace rail** — the desktop app adds a left activity rail for Chat, Browser, Files, Source Control, Terminal, Cron/Schedules, and Artifacts/Dashboard. Chat returns to the current manager/session conversation, including from a selected worker route back to its parent manager thread. Browser opens one automatic local workspace for the current manager: an embedded Forge view or a compact card for a Chrome-backed tab that remains in Chrome. Files opens in a left split pane beside the rail with a resizable tree and file surface for direct text editing or previews. Source Control opens inline with Changes, History, Worktrees, and Pull Requests tabs. Selecting a worktree changes the Source Control and Files browsing context without changing the chat session CWD. Browser, Files, Source Control, Artifacts/Dashboard, and Schedules switch mutually exclusively so panes do not stack or hide behind each other. Terminal stays independent and persistent instead of being part of that surface switch. Mobile keeps the header/drawer workspace controls.
- **Browser automation** — Forge Desktop's local Automatic Browser can render an embedded tab in Forge or keep a Chrome-backed tab in Chrome with **Show in Chrome**. An enabled and authenticated Forge extension grants profile-wide access to eligible ordinary web tabs; `browser_status` returns a bounded `eligibleTabs` inventory across ready authenticated profiles; its transient manager/model metadata is not shown in Browser workspace UI or persisted renderer state. Tabless `browser_open(reuseExistingTab: true)` selects the active/most-recent eligible tab without OS focus. Passing an inventory `tabId` selects that exact tab; non-open operations remain sticky. Normal supported navigation stays on the same Chrome-backed target, while explicit targets never migrate. `reuseExistingTab: false`, or no eligible tab, may create an inactive neutral `about:blank` tab for one authorized initial navigation. There is no profile confirmation prompt or picker, and Chrome-internal/restricted pages remain excluded by platform capability. Embedded tabs include viewport, transient screenshot, recording, and dock/pop-out controls; Chrome omits embedded-only controls. Set up optional Chrome use under **Settings → Use Chrome with Forge**. The capability is not forwarded to Remote Projects or Collaboration. See [Browser automation](docs/BROWSER_AUTOMATION.md) for behavior, setup, persistence, and security boundaries.
- **File browser** — tabbed repository browser with direct text editing on desktop. A single click opens one replaceable italic preview tab; double-clicking, creating a file, or making the first edit makes that tab sticky so multiple files can stay open. Markdown (`.md`, `.markdown`, and `.mdx`) defaults to rendered Preview—even when editable—and can switch to Source; Preview renders the current draft. Files remembers tabs, the active/preview tab, tree/filter/search/scroll state, and text/Markdown content scroll in memory per session and selected worktree while the app remains open. Create empty files, rename files or directories, and permanently delete files or folders; successful changes refresh Files and Source Control, with renamed paths remapped and deleted tabs removed. Dirty-tab guards appear only when needed: closing a dirty tab, navigating to another session/route, renaming or deleting an affected path, or running a branch switch/create or fast-forward-only pull in the same worktree. Selecting another file, hiding Files, or opening Source Control preserves drafts without prompting. Saves remain versioned with explicit conflict handling. Mobile content editing is read-only. The selected Source Control worktree scopes Files without moving the active chat session or manager workspace.
- **Source Control** — review current changes, commit history, worktrees, and GitHub pull requests from the workspace rail. Forge may quietly auto-fetch stale origin data when you enter Source Control or change context, while manual Fetch stays explicit and reports errors. Branch actions support fetch, switch branch, create branch, and fast-forward-only pull with confirmation and preflight checks before any write. File create, rename, save, and delete operations refresh Changes. Opening Source Control preserves Files drafts; branch switch/create and fast-forward-only pull guard dirty tabs in the matching worktree with Save, Discard, or Cancel. Pull Requests uses the `gh` CLI and shows unavailable or degraded states when there is no GitHub remote, `gh` is missing, or `gh` is not authenticated. PR merge requires confirmation, re-checks the head commit with GitHub's match-head-commit guard, and does not delete branches or use admin bypass. Force push, stash, discard, rebase, branch deletion, and worktree create/remove are intentionally out of scope.
- **Worker pills and external threads** — green indicators show active workers. Click for a quick peek at what each worker is doing. Builder web also supports Codex app-server sidecars: a plain leading `@Codex` or `[@Codex]` message starts or continues a direct sidecar text turn, while selector forms like `@Codex -<plugin>`, `@Codex:<plugin>`, and `[@Codex:<plugin>]` scope the turn to a Codex plugin. The selector turn reaches the manager, which delegates to the visible `Codex Plugin` specialist worker; the backend attaches server-owned scoped exact plugin tools to that worker. Direct sidecar threads persist by default and appear as worker-like external-thread cards; the plugin-scoped path stays read-only and safety-gated, with preview/metadata-only normal tool output and no raw manager MCP tool flow. Full connector exports, such as Fireflies transcripts or summaries, use a server-owned export tool that writes redacted JSON artifacts under the session instead of relaying chunks through chat.
- **Working plans** — substantial work can expose a compact current checklist in the chat header and transcript.
- **Session goals** — explicit sustained outcomes stay visible below the chat header and can continue safely across turns, restarts, and multiple plans.
- **Plans & artifacts** — working files, plans, and non-repo artifacts surfaced in the sidebar and inline in chat. On desktop, the rail opens Artifacts or Cron/Schedules in the left activity-pane slot with a single selected surface at a time. Terminal remains separate and persistent.
- **Schedules** — view and manage scheduled jobs per session.
- **Context meter** — visual indicator of context utilization with manual smart-compact trigger.
- **Session search** — search across session names and message content with highlighted results.
- **Archive** — open the Builder Archive view from the sidebar to see archived projects and directly archived sessions. Archive entries are sorted by last user-message activity and show the last-used date. Restore them with a single button; restoring can immediately reopen the restored target.
- **Stats** — usage and activity summaries. Session totals are historical and include archived data, while active counts exclude archived projects and sessions. When Cursor SDK is used, its usage is included in dashboard stats, token analytics, and telemetry provider inference.
- **Observability** — Settings → Observability can export Builder-only runtime traces to a local Arize Phoenix OTLP HTTP/protobuf endpoint. Rich traces cover runtime, prompt, LLM, tool, delivery, lifecycle, error, and feedback paths, with redaction, content caps, capture toggles, and loopback-only endpoint validation. Collaboration is unsupported in V1 and remains no-op/fail-closed.
- **Notifications** — global notification defaults with per-manager overrides and custom sound uploads. Set baseline sounds once and all managers inherit them. Cortex is excluded from defaults so scheduled consolidation and other Cortex activity do not inherit normal manager sounds.
- **Prompt preview** — view the full effective system prompt being sent, including memory, knowledge, and skills.

## Skills

Managers and workers have access to built-in skills. These are separate from Forge Desktop's [Automatic Browser](docs/BROWSER_AUTOMATION.md), which has no Skills toggle and remains local to Desktop. The `agent-browser` workflow remains a Skill:

| Skill | Description | Requires |
|-------|-------------|----------|
| Web Search | Search the web via Brave Search API | `BRAVE_API_KEY` |
| Image Generation | Generate images with Google Gemini | `GEMINI_API_KEY` |
| `agent-browser` | Interactive web browsing and extraction through a separate CLI/browser lifecycle | [`agent-browser`](https://github.com/vercel-labs/agent-browser) CLI |
| Cron Scheduling | Persistent scheduled tasks with cron expressions | — |
| Slash Commands | Create and manage prompt auto-expansion commands | — |
| Memory | Persistent agent memory across sessions | — |

Skill API keys can be configured in the dashboard under Settings → Environment Variables, or via `.env` / shell environment.

Forge also supports custom skills. Place global skills in `${FORGE_DATA_DIR}/skills` (default: `~/.forge/skills`) or project skills in a repository-root `.forge/skills/` directory using the standard `SKILL.md` frontmatter format. Repo-root `.forge/` can also hold `.forge/specialists/`, `.forge/reference/`, `.forge/extensions/`, `.forge/pi/extensions/`, and `.forge/pi/settings.json`. The Create Project dialog seeds those repo resources by default, and the Files panel scaffold action can add the starter `.forge/` tree and README without overwriting existing files. For reusable custom skills, use the built-in `create-skill` helper to scaffold, place, and validate global skills or project skills. See [docs/CONFIGURATION.md](docs/CONFIGURATION.md#machine-local-skills) and [docs/PROJECT_RESOURCES.md](docs/PROJECT_RESOURCES.md).

Forge can also share user-created global/project skills through the separate skill-share worker at `apps/skill-share-worker/`. The default service origin is `https://forgeskills.radops.ai`; override it with `FORGE_SKILL_SHARE_BASE_URL` or disable sharing with `FORGE_SKILL_SHARE_DISABLED` (legacy `MIDDLEMAN_SKILL_SHARE_BASE_URL` and `MIDDLEMAN_SKILL_SHARE_DISABLED` are still accepted). Sharing generates a temporary bearer link from the service, and importing from a share link or `forge://skill-import` deep link always opens a preview/review step first. Built-in and repository skills are not shareable in v1. See [`apps/skill-share-worker/README.md`](apps/skill-share-worker/README.md) for the service contract and guardrails.

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

Drop a TypeScript file into `~/.forge/agent/extensions/` and it's loaded for all workers — no build step, no restart required. Repository-local executable extensions can also live under `.forge/extensions/`, `.forge/pi/extensions/`, or `.forge/pi/settings.json`, but they are gated by an explicit trust prompt. Passive repo resources like `.forge/skills/`, `.forge/specialists/`, and `.forge/reference/` remain available even if you deny trust. Extensions load per-session via [jiti](https://github.com/nicolo-ribaudo/jiti) with full TypeScript support.

There's also a growing ecosystem of community Pi packages available from npm and git. Install them by adding a `settings.json` to your agent config directory. See the [Pi Extensions guide](docs/PI_EXTENSIONS.md) for the full reference.

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
| **Agents** | Manager and worker agents run through Forge's runtime facade, backed by Pi or Cursor SDK depending on the selected model/provider. Cursor SDK exposes Composer 2.5 and Cursor Grok 4.5 for manager and specialist selectors when enabled, and background auth/transport failures stay contained inside the worker runtime so they surface as worker failures instead of crashing the backend or Electron child. Builder web also supports Codex sidecars: a plain leading `@Codex` / `[@Codex]` text message stays a direct sidecar turn, while selector-based mentions delegate through the visible `Codex Plugin` specialist to plugin-scoped Codex tools. Direct sidecar cards stay append-only and excluded from manager model context; manager-routed Codex turns stay in the normal manager audit trail and use ephemeral app-server threads with read-only/safety gates. Normal scoped tool calls return bounded previews/metadata only; full exportable connector payloads are written as session artifacts when the scoped export tool is used. Each Forge-managed worker runs in its own worktree. |

Communication between UI and backend is over WebSocket. The backend spawns and manages agent processes, persists all state to disk, and handles integrations and scheduling. In normal Builder chat, `conversation_message` rows can persist optional `replyTo` metadata; the backend canonicalizes the target from session history when available and adds a structured `[replyTo]` JSON context block to model input. Collaboration chat does not support Quote/Reply in v1. Agents are extensible through both [Forge Extensions](docs/FORGE_EXTENSIONS.md) and Pi's [extension system](docs/PI_EXTENSIONS.md).

Backend internals are split into thin facades and leaf modules. Runtime selection now goes through a provider-dispatch facade, with provider-specific creators under `apps/backend/src/swarm/runtime/{claude,cursor-sdk,pi}/` and shared planning/projector helpers in `runtime-*` modules. When changing those areas, keep the public facade stable and move new behavior behind it.

For local projects, runtime data stays on the local Forge instance under `~/.forge` (or `%LOCALAPPDATA%\forge` on Windows). Remote Projects preserve the same server-authoritative model: their profile/session data stays in the remote instance's `FORGE_DATA_DIR`, and repository files stay in its server-hosted workspace; the client does not clone or synchronize them locally. Back up each authoritative Forge data directory and its workspace mounts. See [docs/CONFIGURATION.md](docs/CONFIGURATION.md) for the full data layout and the [Remote Projects guide](docs/collaboration/REMOTE_PROJECTS.md) for the topology.

## Configuration

Copy the example environment file and edit as needed:

```bash
cp .env.example .env
```

The `.env.example` file documents all available options with comments. Key categories:

- **Core** — host, port, data directory, debug mode
- **UI** — WebSocket URL or backend-port override (dev only, production auto-resolves)
- **Skills** — API keys for Brave Search, Gemini image generation
- **Skill sharing** — anonymous worker origin and disable flag
- **Agent Runtimes** — OpenAI Codex Responses transport defaults to `sse` for reliability when `FORGE_OPENAI_CODEX_TRANSPORT` is unset, blank, or invalid; `websocket-cached` remains an explicit experimental/canary opt-in via `FORGE_OPENAI_CODEX_TRANSPORT=websocket-cached`, with `websocket` and `auto` also supported. Sanitized transport diagnostics stay opt-in via `FORGE_CODEX_TRANSPORT_DEBUG=1` at `GET /api/debug/codex-transport`. Builder web supports both plain Codex sidecar text turns and manager-routed selector turns: the plain `@Codex` / `[@Codex]` path uses the Codex CLI app-server sidecar, while `@Codex -<selector>` and inline `@Codex:<selector>` / `[@Codex:<selector>]` route through the manager, inject guidance, and delegate to the visible `Codex Plugin` specialist for plugin-scoped Codex tools. The sidecar path remains text-only and excluded from Collaboration; the manager-routed path stays in the normal manager audit trail. Normal scoped tool output is bounded, while full redacted connector exports are written to session artifacts and returned to chat only as path/metadata plus a bounded preview.

Provider auth for OpenAI, Anthropic, xAI, OpenRouter, and Cursor SDK is managed under **Settings → Authentication**. OpenAI and Anthropic use the current OAuth account-pool cards. xAI uses one direct, non-pooled row for either an API key or OAuth, with either choice replacing the previously stored xAI credential. OpenRouter and Cursor SDK remain masked key/token-only rows with provider links. Status and auth-type badges appear only on applicable cards. Cursor SDK can also use shared secrets or environment-based `CURSOR_API_KEY`. Cursor SDK Composer 2.5 and Cursor Grok 4.5 can appear in manager and specialist selectors when credentials and model visibility allow them. Background auth/transport failures are contained inside the worker runtime and report as worker failures rather than crashing the backend or Electron child. OpenAI/Codex Forge Auth broker and local-credential behavior, plus xAI OAuth paths and environment fallback semantics, are described under [Provider Authentication](docs/CONFIGURATION.md#provider-authentication). The **Settings → Models** tab provides a full catalog of supported models with visibility controls and context window overrides. **Settings → Observability** configures the local Phoenix exporter and persists its settings under `shared/config/phoenix-observability.json`; live Phoenix/golden-trace validation and Electron package/preflight validation remain user-owned gates for this V1 feature.

See [docs/CONFIGURATION.md](docs/CONFIGURATION.md) for the full configuration reference.

## Development

```bash
# Start backend + UI in dev mode (hot reload)
pnpm dev
# Backend: http://127.0.0.1:47187
# UI:      http://127.0.0.1:47188

# Start Electron locally
pnpm dev:electron

# Also expose that same Electron-owned backend on a trusted network
pnpm dev:electron:remote
# Remote UI: http://<station-address>:47188

# Build everything
pnpm build

# Package the Electron app locally (build only, no publish)
pnpm package:electron

# Run tests
pnpm test

# Run routed local quality checks (manual; writes .forge/quality/latest.json)
pnpm quality:quick
pnpm quality:changed
pnpm quality:full

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
- Docker collaboration compose: `http://127.0.0.1:47387` on the host by default (`47287` stays container-internal), with persistent data visible in `./.forge-collaboration-data` (`/var/lib/forge` in the container). Its default trusted origins allow local Forge UI dev on `http://127.0.0.1:47188` and local preview on `http://127.0.0.1:47189`.

## Platform Notes

Forge runs on macOS, Linux, and Windows.

| | macOS | Linux | Windows |
|---|---|---|---|
| Core functionality | ✅ | ✅ | ✅ |
| Dashboard UI | ✅ | ✅ | ✅ |
| Agent orchestration | ✅ | ✅ | ✅ |
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

This project started as a personal tool and is shared in that spirit. It's functional, actively used in production, and being improved continuously. Forge is the primary tool used to develop itself. The system you see today will probably be unrecognizable in a month. It prioritizes practical utility over enterprise polish.

These are powerful tools with broad system access. Agents can create files, run commands, and modify your environment. Use version control, keep backups, and be thoughtful about what you let agents do unsupervised.

Fork it, tear it apart, or use it as a starting point to build your own middle manager.

## License

[Apache-2.0](LICENSE)
