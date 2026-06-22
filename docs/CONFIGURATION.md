# Configuration

Forge is configured through environment variables, a `.env` file, and the dashboard UI.

## Environment Variables

### Core

| Variable | Default | Description |
|----------|---------|-------------|
| `FORGE_HOST` | `127.0.0.1` | Backend bind address. Set to `0.0.0.0` for network/remote access. |
| `FORGE_PORT` | `47187` (dev) / `47287` (prod) | Backend HTTP + WebSocket port. |
| `FORGE_DATA_DIR` | `~/.forge` (macOS/Linux) or `%LOCALAPPDATA%\forge` (Windows) | Data directory for all persistent state. |
| `FORGE_DEBUG` | `false` | Enable debug logging. Also enables extension tool-call logging, which surfaces tool invocations from Pi extensions in the backend logs. |
| `FORGE_TELEMETRY` | `true` | Enable or disable anonymous telemetry. Only aggregate counts are sent. |
| `FORGE_RUNTIME_TARGET` | `builder` | Runtime surface to boot. Supported values: `builder` and `collaboration-server`. `builder` starts the local Builder backend; `collaboration-server` starts the deployable collaboration runtime used by the public Docker/self-host path. |

### UI

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_FORGE_WS_URL` | Auto-resolved from page URL | WebSocket URL for the UI to connect to the backend. Only needed if running UI and backend on different hosts/ports. |

### Skills

| Variable | Default | Description |
|----------|---------|-------------|
| `BRAVE_API_KEY` | — | API key for the [Brave Search](https://brave.com/search/api/) web search skill. |
| `GEMINI_API_KEY` | — | API key for the Google Gemini image generation skill. |
| `OPENAI_API_KEY` | — | API key for OpenAI Codex models when using external API-key auth. |

Skill API keys can also be configured in the dashboard under **Settings → Environment Variables**. `.env` values remain supported as fallback.

### Skill Sharing

| Variable | Default | Description |
|----------|---------|-------------|
| `FORGE_SKILL_SHARE_BASE_URL` | `https://forgeskills.radops.ai` | Skill share service origin used to generate share links and resolve import URLs. |
| `FORGE_SKILL_SHARE_DISABLED` | `false` | Disable the anonymous skill-share service. |

Legacy `MIDDLEMAN_SKILL_SHARE_BASE_URL` and `MIDDLEMAN_SKILL_SHARE_DISABLED` aliases are still accepted. See [`apps/skill-share-worker/README.md`](../apps/skill-share-worker/README.md) for the worker-side quotas and Cloudflare guardrails.

### Agent Runtimes

| Variable | Default | Description |
|----------|---------|-------------|
| `XAI_API_KEY` | — | API key for xAI/Grok models (when using external API key mode). |
| `FORGE_OPENAI_CODEX_TRANSPORT` | `sse` | Transport override for OpenAI Codex Responses models. Supported values: `sse` (stable reliability default and rollback path), `websocket`, `websocket-cached` (explicit experimental/canary opt-in; retries a fresh full-context WebSocket before falling back to SSE on pre-output close-before-completion failures), and `auto` (safe pre-start SSE fallback). Invalid values fail safe to `sse`. |
| `FORGE_OPENAI_CODEX_AUTH_MODE` | `local` | OpenAI/Codex auth source. Use `central_broker` to make Forge use the Forge Auth broker for OpenAI/Codex in v1. |
| `FORGE_OPENAI_AUTH_BROKER_URL` | — | Forge Auth broker base URL used when `FORGE_OPENAI_CODEX_AUTH_MODE=central_broker`. |
| `FORGE_OPENAI_AUTH_BROKER_TOKEN` | — | Bearer token for the Forge Auth broker. |
| `FORGE_OPENAI_AUTH_BROKER_INSTANCE_ID` | — | Optional stable install identifier sent to the Forge Auth broker. |
| `FORGE_OPENAI_AUTH_BROKER_INSTANCE_LABEL` | — | Optional human-readable install label sent to the Forge Auth broker. |
| `FORGE_CODEX_TRANSPORT_DEBUG` | — | Optional debugging flag. Set to `1` to enable the sanitized Codex transport diagnostics endpoint at `/api/debug/codex-transport` for transport selection and counter inspection; otherwise it stays disabled/404. |

The OpenAI/Codex auth-mode settings are intentionally scoped to OpenAI/Codex in v1. The primary Settings setup path is invite redemption: a broker administrator creates a one-time setup link for a user name/email, and Forge redeems that link server-to-server for a broker runtime token. The setup link contains only an invite id and secret, not runtime, OpenAI, admin, or provisioning tokens. Forge stores the returned broker runtime token in secrets and masks status in the UI. Manual broker URL/token entry and the env vars above remain available for advanced or older deployments.

If `FORGE_OPENAI_CODEX_AUTH_MODE` is set, the environment is authoritative: saved Settings mode and broker URL/token values are ignored while the env override is present, and Settings disables invite redemption and manual broker edits. In `central_broker` mode, Forge acquires short-lived OpenAI/Codex leases from the Forge Auth broker and renews, reports, and releases them during runtime use. Broker URLs must use HTTPS unless they are localhost/dev HTTP URLs.

The OpenAI Codex Responses transport settings above apply to normal Codex model runtimes. Builder web also has a separate direct sidecar route: a plain leading `@Codex` or `[@Codex]` text message starts or continues a Codex CLI app-server sidecar thread. Selector forms like `@Codex -<plugin>`, `@Codex:<plugin>`, and `[@Codex:<plugin>]` scope the turn to a plugin, reach the manager, and are delegated to the visible `Codex Plugin` specialist worker with server-owned scoped exact plugin tools. The direct sidecar path is Builder web only, text-only, excluded from Collaboration, and limited to one active direct Codex turn globally. Sidecar display cards are persisted in the parent session by default but are excluded from manager model context and from forked-session history.

### Active Work Plans

Settings → General includes a Builder-only, default-on **Enable Active Work Plans** toggle backed by `shared/config/work-plans.json`. When enabled, managers get the `task` tool, the Active Work skill/guidance/context, and the live Active Work UI. When disabled, those live surfaces are hidden and runtimes recycle or defer recycle as needed; historical read-only Work Plan receipts remain visible.

### Phoenix Observability

Settings → Observability configures Builder-only Arize Phoenix tracing. Settings persist in `shared/config/phoenix-observability.json`. Export uses OTLP HTTP/protobuf to a local Phoenix traces endpoint, defaulting to `http://127.0.0.1:6006/v1/traces`.

V1 only accepts loopback `http://` endpoints: `localhost`, `127.0.0.0/8`, or `::1`, with a path ending in `/v1/traces`. Embedded credentials, query strings, and fragments are rejected. Rich capture can include runtime, prompt, LLM, tool, delivery, lifecycle, error, and feedback spans. Capture toggles, redaction, identifier/path modes, extra redaction patterns, and content/attribute caps control what is attached to spans.

Collaboration runtime is unsupported in V1. It uses the no-op/fail-closed observability facade and does not write Phoenix settings or export traces.

### Collaboration

| Variable | Default | Description |
|----------|---------|-------------|
| `FORGE_ADMIN_EMAIL` | — | Bootstrap email for the first collaboration admin account. Required on first boot if no admin exists yet. |
| `FORGE_ADMIN_PASSWORD` | — | Bootstrap password for the first collaboration admin account. Required on first boot if no admin exists yet. |
| `FORGE_COLLABORATION_BASE_URL` | — | Canonical collaboration browser URL used for login redirects and invite links. For local `docker compose`, use `http://127.0.0.1:47387` by default and keep it aligned with `FORGE_PUBLIC_PORT` if you override the host mapping. |
| `FORGE_SECONDARY_PUBLIC_PORT` / `FORGE_SECONDARY_COLLABORATION_BASE_URL` | `47388` / `http://127.0.0.1:47388` | Optional secondary local Docker Compose collaboration server settings for multi-backend UI testing. |
| `FORGE_COLLABORATION_TRUSTED_ORIGINS` | — | Comma-separated Builder/UI origins allowed to talk to the collaboration server in split deployments. Local `docker-compose.yml` defaults this to `http://127.0.0.1:47188,http://127.0.0.1:47189`. Use `127.0.0.1` consistently for local HTTP split deployments; mixing `localhost` and `127.0.0.1` becomes cross-site and requires HTTPS. |
| `FORGE_COLLABORATION_AUTH_SECRET` | generated locally if unset | Optional auth secret for the collaboration server. If omitted, the server generates and persists one in the data directory. |
| `FORGE_COLLABORATION_AUTH_COOKIE_NAME` | `forge_collab_session` | Optional session cookie name. Use a distinct value only when multiple collaboration servers share one browser cookie scope. Custom values also namespace Better Auth auxiliary cookies as `<name>_session_data` and `<name>_dont_remember`. |
| `FORGE_SECONDARY_COLLABORATION_AUTH_COOKIE_NAME` | `forge_collab_secondary_session` | Optional Docker Compose secondary-service cookie-name override for local multi-backend testing. |

Collaboration keeps structured state in SQLite and user-authored specialist bodies on disk. Workspace, category, and channel metadata, membership, read state, category default selected specialist handles, channel selected specialist handles, and collaboration skill-selection state belong in the collaboration database. Specialist markdown files, prompt bodies, reference docs, and skill definitions remain file-backed. `NULL` or all-includes means every optional global skill is included; custom arrays filter both the prompt roster and runtime-loaded skills. `memory` is always-on/core. No channel-local skill authoring exists in V1. Global specialists live in `${FORGE_DATA_DIR}/shared/specialists/`; collaboration channel-local specialists live in `${FORGE_DATA_DIR}/profiles/_collaboration/sessions/<sessionId>/specialists/`. Specialist `TargetSpace` frontmatter controls whether a shared specialist appears in Builder, Collaboration, or both. Collaboration servers seed the union of Builder and `collab-` prefixed Collaboration built-ins, then UI/runtime rosters filter by `TargetSpace`. See [Collaboration development](collaboration/DEVELOPMENT.md#sqlite-migration-policy) for the migration policy and [Collaboration operations](collaboration/OPERATIONS.md) for deployment guidance.

For compatibility, startup also accepts legacy `MIDDLEMAN_*` environment variables (for example, `MIDDLEMAN_HOST`, `MIDDLEMAN_PORT`, `MIDDLEMAN_DATA_DIR`, `MIDDLEMAN_DEBUG`, `VITE_MIDDLEMAN_WS_URL`, `MIDDLEMAN_RUNTIME_TARGET`). When `FORGE_RUNTIME_TARGET` is unset, legacy `FORGE_COLLABORATION_ENABLED=true` or `MIDDLEMAN_COLLABORATION_ENABLED=true` maps to the `collaboration-server` runtime target.

## `.env` File

Create a `.env` file in the project root. It is loaded automatically on startup.

```bash
# Example .env
FORGE_HOST=127.0.0.1
FORGE_PORT=47187
# FORGE_DATA_DIR=/custom/path
# BRAVE_API_KEY=your-brave-key
# GEMINI_API_KEY=your-gemini-key
```

## Provider Authentication

Provider auth for **OpenAI**, **Anthropic**, **xAI**, and **Cursor SDK** is configured through the dashboard UI under **Settings → Authentication**. The pane shows provider labels with auth-mode badges so you can see whether a row is using OAuth, an API key, or Forge Auth broker mode.

OpenAI and Anthropic support either OAuth or API key auth. OpenAI/Codex can also use Forge Auth broker mode, which requests short-lived leases from a separate broker instead of using local OpenAI credentials. In Settings, the normal v1 broker setup path is to paste a one-time setup link from the broker admin UI and let Forge redeem it server-to-server. One-time links cannot be replayed after redemption. Manual broker URL/token entry is still available under advanced setup for older deployments. While broker mode is active, local OpenAI OAuth/API-key and pool credentials remain visible for reference but are read-only and cannot be changed from Settings. Forge Auth broker mode is v1-scoped to OpenAI/Codex only.

Claude SDK is separate and OAuth-only: it uses Claude Code CLI OAuth, with credentials stored in macOS Keychain on macOS and `~/.claude/.credentials.json` on Linux and Windows. Cursor SDK is API-key-based: set `CURSOR_API_KEY` in Settings → Authentication, shared secrets, or the environment. Cursor SDK/Composer can appear in specialist model selectors when credentials and model visibility allow it; manager selectors intentionally do not offer Cursor SDK models. Cursor SDK uses a provider-local, fail-closed Cursor/ConnectRPC/HTTP2 classifier: attributed transient transport or throttle failures can retry once before output, auth/permission/cancel/user-state failures are contained and projected without retry, and unattributed/generic/protocol/config failures remain fatal. Usage from Cursor SDK sessions is recorded into session custom entries and contributes to dashboard stats, token analytics, and telemetry provider inference.

For the native Cursor runtime, Forge uses the Forge-owned Cursor SDK `stateRoot` and persisted `sdkAgentId` to keep runtime state local to the app.


Model availability and behavior are managed through **Settings → Models**, which provides visibility controls and context window overrides for all supported models. Those visibility settings also control whether a model can appear in manager create-session, change-default, and per-session override selectors. Codex selector mentions are handled separately as plugin-scoped turns that delegate to the visible Codex Plugin specialist, not through the manager model selector list. See [docs/MODEL_CATALOG.md](MODEL_CATALOG.md) for details on the model catalog system.

Appearance preferences are separate from server/shared configuration. They are stored in local renderer/browser state for the active UI only, so changes to Light/Dark/System mode, templates, colors, or fonts stay local to that client instead of syncing through shared profile config.

## Data Directory

All persistent state lives in a single data directory:

```
<data-dir>/
├── shared/                    # Shared config
│   ├── config/                # User settings & credentials
│   │   ├── auth/
│   │   │   └── auth.json      # API keys and auth tokens
│   │   ├── secrets.json       # Additional secrets
│   │   ├── model-overrides.json   # User model visibility/context caps (Settings → Models)
│   │   ├── cortex-auto-review.json        # Cortex auto-review schedule settings
│   │   ├── mobile-notification-prefs.json # Mobile push preferences
│   │   ├── slash-commands.json            # Global slash commands
│   │   ├── terminal-settings.json         # Terminal runtime settings
│   │   ├── work-plans.json                # Builder-only default-on Active Work Plans toggle
│   │   ├── phoenix-observability.json     # Builder-only Phoenix tracing settings
│   │   └── integrations/      # Shared integration configs
│   ├── cache/                 # Regenerable/ephemeral
│   │   ├── generated/
│   │   │   └── pi-models.json # Generated Pi-compatible model projection
│   │   ├── stats-cache.json   # Cached dashboard statistics
│   │   ├── provider-usage-cache.json      # Cached provider subscription usage snapshots
│   │   └── provider-usage-history.jsonl   # Historical provider usage samples
│   ├── state/                 # Runtime state & markers
│   │   ├── mobile-devices.json            # Registered mobile devices
│   │   ├── .compaction-count-backfill-v2-done  # Legacy compaction-count backfill sentinel
│   │   ├── .compaction-count-reconcile-v3-done  # Monotonic compaction-count reconciliation sentinel
│   │   ├── .shared-config-migration-done  # Shared-config layout migration sentinel
│   │   └── .shared-config-cleanup-done    # Shared-config old-path cleanup sentinel
│   ├── knowledge/             # Knowledge base
│   │   ├── common.md          # Common knowledge (cross-profile)
│   │   ├── onboarding-state.json  # First-launch user preferences
│   │   └── profiles/<profileId>.md  # Per-profile knowledge
│   └── specialists/           # Global specialist definitions (.md files)
├── profiles/<profileId>/      # Per-manager-profile data
│   ├── memory.md              # Profile-level memory
│   ├── project-agents/<handle>/  # Per-project-agent data
│   │   ├── config.json        # Agent config
│   │   ├── prompt.md          # Editable Project Agent role instructions
│   │   └── reference/         # Per-agent reference docs
│   └── sessions/<sessionId>/  # Per-session data
│       ├── session.jsonl      # Conversation history
│       ├── memory.md          # Session-level memory
│       ├── meta.json          # Session metadata
│       ├── feedback.jsonl     # User feedback
│       ├── pinned-messages.json  # Pin state (up to 10 message IDs)
│       ├── tasks.json         # Active Work Plans state
│       ├── context/
│       │   └── prompt.md      # Collaboration channel additional instructions
│       ├── reference/         # Collaboration channel reference docs
│       ├── specialists/       # Collaboration channel-local specialist markdown (no channel-local skill authoring in V1)
│       └── workers/           # Worker session logs
├── profiles/_collaboration/   # System collaboration profile; channel sessions use the same session layout
├── swarm/
│   └── agents.json            # Agent registry
├── extensions/                # Forge extensions (global, auto-created)
├── agent/                     # Pi agent runtime config (extensions, skills, packages)
│   ├── extensions/            #   Global worker extensions (auto-created at startup)
│   ├── manager/extensions/    #   Global manager extensions (auto-created at startup)
│   ├── skills/                #   Global worker skills (Pi-discovered, auto-created)
│   ├── manager/skills/        #   Global manager skills (Pi-discovered, auto-created)
│   ├── settings.json          #   Global worker package config (optional)
│   └── manager/settings.json  #   Global manager package config (optional)
├── skills/                    # Machine-local skills (optional, station-specific)
│   └── <skillName>/SKILL.md
└── uploads/                   # File uploads
```

### Default Locations

| Platform | Default Path |
|----------|-------------|
| macOS / Linux | `~/.forge` |
| Windows | `%LOCALAPPDATA%\forge` |

Override with `FORGE_DATA_DIR` in your environment or `.env` file.

### Machine-local skills

Forge automatically scans `${FORGE_DATA_DIR}/skills` for optional machine-local skills.

Baseline global skill precedence is:
1. `${FORGE_DATA_DIR}/skills`
2. built-in skill definitions shipped with Forge

Session-specific profile skills and trusted repo-root `.forge/skills` resources are layered into sessions for the active profile/workspace. There is no repo-local `.swarm/skills` layer in the current setup.

Discovered skills are injected into all agent/runtime sessions the same way other loaded skills are.

Use this for station-specific workflows that should stay outside a shared repository. The built-in `create-skill` helper can scaffold reusable global, profile/project, or repository skills and validate the resulting structure. A local skill should live at:

```text
${FORGE_DATA_DIR}/skills/<skillName>/SKILL.md
```

`SKILL.md` uses the normal skill frontmatter format (`name`, `description`, optional `env` declarations, then markdown body).

On a default macOS/Linux install this becomes:

```text
~/.forge/skills/<skillName>/SKILL.md
```

### Project Resources

Repositories can provide project-scoped resources from a repo-root `.forge/` directory: project skills, specialists, reference docs, Forge extensions, and Pi extensions/packages. Passive resources are available as text context; executable resources are gated by an explicit trust/block prompt.

See [PROJECT_RESOURCES.md](PROJECT_RESOURCES.md) for the layout, override rules, and security model.

### Forge Extensions

Forge exposes a Forge-native hook system for session lifecycle, runtime errors, versioning commits, and tool interception.

**Forge extension directories**:

| Path | Scope |
|------|-------|
| `${FORGE_DATA_DIR}/extensions/` | Global |
| `${FORGE_DATA_DIR}/profiles/<id>/extensions/` | Profile |
| `<repo>/.forge/extensions/` | Project-local, trust-gated |

Global and profile Forge extension directories are auto-created. Project-local directories are not. Project-local executable extensions are loaded only after the repository `.forge` directory is trusted.

See [FORGE_EXTENSIONS.md](FORGE_EXTENSIONS.md) and [PROJECT_RESOURCES.md](PROJECT_RESOURCES.md) for the full guides.

### Pi Extensions & Packages

Forge also exposes Pi's extension and package system for deeper customization — custom tools, event interception, context modification, and more.

**Extension auto-discovery directories**:

| Path | Scope |
|------|-------|
| `${FORGE_DATA_DIR}/agent/extensions/` | All workers |
| `${FORGE_DATA_DIR}/agent/manager/extensions/` | All managers |
| `<repo>/.forge/pi/extensions/` | Project-local, trust-gated |

**Skill directories**:

| Path | Scope |
|------|-------|
| `${FORGE_DATA_DIR}/agent/skills/` | All workers |
| `${FORGE_DATA_DIR}/agent/manager/skills/` | All managers |
| `<repo>/.forge/skills/` | Project-local project skills |

**Package configuration** via optional `settings.json` files:

| Path | Scope |
|------|-------|
| `${FORGE_DATA_DIR}/agent/settings.json` | Worker packages |
| `${FORGE_DATA_DIR}/agent/manager/settings.json` | Manager packages |
| `<repo>/.forge/pi/settings.json` | Project-local packages, trust-gated |

Packages can be installed from npm (`npm:@scope/name`), git (`git:github.com/user/repo`), or local paths. These files do not need to exist — create them only when you want to install packages. Trusted repo-root `.forge/pi/settings.json` replaces the old exact-CWD `.pi/settings.json` location for new projects; legacy exact-CWD surfaces remain compatibility-only and are active only when inside or identical to the selected trusted `.forge` directory.

Drop a `.ts` or `.js` file into the appropriate extensions directory and it's loaded for all sessions of that role. TypeScript works without a build step via [jiti](https://github.com/nicolo-ribaudo/jiti). Extensions load per-session, so new extensions are picked up without restarting the backend.

See [PI_EXTENSIONS.md](PI_EXTENSIONS.md) for the full guide, including writing extensions, event hooks, package filtering, and headless mode caveats.

## Ports

| Mode | Backend | UI |
|------|---------|-----|
| Development (`pnpm dev`) | `47187` | `47188` |
| Production (`pnpm prod`) | `47287` | `47189` |
| Docker collaboration compose (host -> container) | `47387 -> 47287` by default | Same origin on `47387` by default; data bind-mounted at `./.forge-collaboration-data -> /var/lib/forge` |

## Remote / Network Access

To access Forge from other devices on your network:

1. Set `FORGE_HOST=0.0.0.0` to bind to all interfaces.
2. Use the machine's IP or hostname in your browser.
3. If using a reverse proxy or Tailscale, ensure `allowedHosts` covers your hostname (the Vite preview server has `allowedHosts: true` by default).
