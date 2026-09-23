# Native Codex managers

Choose **Codex native** in the manager model selector to run a local Builder manager
through the Codex app-server. The existing Codex choices continue to use Pi. Native
managers use the same Forge sidebar, conversations, task notes, history, workers,
and browser integration tools. No existing session changes runtime automatically.

## Setup

- Install Codex CLI 0.155 or newer, or a desktop app containing that version.
- Configure an OpenAI/Codex account in Forge's Authentication settings. Native
  managers honor Forge's credential pool selection and Forge Auth broker mode.
- On macOS, Forge first looks for the executable in ChatGPT.app or Codex.app under
  `/Applications` and `~/Applications`, then searches PATH. On Windows, Forge finds
  `codex.exe` on PATH or resolves the native binary behind a standard npm Codex
  installation (including `%APPDATA%\\npm`). It launches that executable directly;
  Windows `.cmd` and PowerShell wrappers are not executable through the native
  version-check/RPC path. Set `CODEX_BIN` to the full native `codex.exe` path for a
  custom installation. Windows execution still requires live validation.
- Select **Hands-on** or **Adaptive** for direct execution. The selected work mode
  still applies; Delegation-first continues to ask Forge workers to do project work.

If the CLI is missing or too old, Forge's error includes the install/update command
for the backend's operating system: `npm.cmd install -g @openai/codex@latest` in
Windows PowerShell, or `npm install -g @openai/codex@latest` in a macOS/Linux terminal.
These commands require Node.js/npm. Restart Forge after installation so it picks up
PATH changes. For a selected macOS desktop-bundled CLI, update the desktop app or
use `CODEX_BIN` to select a separately installed CLI; upgrading npm alone does not
replace the bundled copy. Recognized Homebrew installations show the Homebrew
update command. Permission and executable-format errors show their own recovery steps.

Each manager owns an app-server process and a persistent native thread. Native data
lives under `<FORGE_DATA_DIR>/shared/state/codex-native`, separate from the desktop
app's Codex home. Forge sends the selected access token/account identity over stdio
and configures ephemeral credential storage; OAuth refresh tokens remain with
Forge. The subprocess receives a small environment allowlist, not Forge's provider
keys or secrets environment. This is credential hygiene, not a Secure Session boundary.

## Prompts and continuity

Codex retains its native base instructions, coding tools, repository instruction
discovery, and context management. Forge adds a compact developer contract for
work mode, worker ownership, proportionate verification, routing, notes, and history.
Forge memory, selected skill descriptions/paths, and SWARM.md context are included.
User-authored manager prompts and model instructions remain authoritative Forge
configuration and are preserved. Review those overrides if old delegation or
verification rules still affect an existing project.

When a session resumes with a changed Forge prompt, Forge explicitly updates the
developer contract in native history. Ordinary restarts resume the native thread;
resume errors fail visibly instead of silently starting over. Native compaction
waits for completion before reporting success. Forge's Pi compaction-model settings
and Context v2 do not control native Codex compaction.

Stopping a session interrupts its active turn and clears its background terminals.
Acknowledged steering messages not yet consumed by Codex are retained as historical
context for a later turn; stopping does not restart the cancelled work. As with the
existing Forge dispatcher, a process crash in the acknowledgement/persistence gap
does not provide exactly-once input delivery.

Message-level forks and model changes recover bounded conversation context from
Forge's durable transcript into a new native thread. Forks include only the selected
history boundary. This retains visible conversation context, not the native thread's
complete internal context. Older Forge history remains available through history
recall. Changing dynamic tool definitions requires a fork or new session; Forge
does not silently resume a thread with an incompatible tool contract. Resume compares
the persisted native tool schemas with the current implementation; a legacy optional
Pi output-budget parameter is accepted without replacing the native thread or history.
Each runtime receives independent schemas so Pi instrumentation cannot change another
session's native tool definitions.

## First-release boundaries

- Native Codex is a local Builder manager option. Workers continue to use their
  configured existing runtimes. Collaboration, system sessions, and native workers
  are excluded.
- Secure Sessions and secret-delivery tools are unavailable for native managers.
  A model switch cannot bypass an active Secure Session. Use the existing Pi runtime
  for secret-backed work during this validation phase.
- Native managers run with full access (`danger-full-access`) and command approvals
  disabled (`never`), including when resuming existing threads. Native commands can
  access the host filesystem and network without per-command approval prompts.
  Genuine clarification questions use Forge's choice UI. Native asynchronous
  questions become Forge choice cards, with answers sent back as new user input.
  If the server sends an exceptional approval request, Forge presents it rather
  than auto-accepting it;
  file approval requires a complete bounded diff. Unknown requests and secret-entry
  questions fail closed; MCP elicitation is declined.
- Forge tool hooks apply to bridged Forge tools. Pi extensions do not run inside
  Codex, and Forge hooks do not intercept native Codex coding tools. Native plugins
  or MCP servers are not imported from the user's desktop Codex configuration.
- Custom compaction instructions are unsupported. Context usage and turn timing
  are projected; Pi's per-generation throughput and cost instrumentation is not
  equivalent to native app-server telemetry.

## Validation and comparison

Start with an isolated Forge data directory and distinct backend/UI ports. Keep its
authentication copy private. Never point two Forge processes at the same data directory.
Compare the same model, effort, work mode, repository state, and requested outcome.
Measure elapsed completion time and useful acceptance evidence across several real
tasks. A successful small fixture establishes functionality, not a performance win.

Implementation references: the [Codex app-server protocol](https://learn.chatgpt.com/docs/app-server),
and the local BB and T3 Code implementations reviewed for process ownership,
instruction layering, native session continuity, and asynchronous compaction.
