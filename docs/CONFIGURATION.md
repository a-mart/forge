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

### Agent Runtimes

| Variable | Default | Description |
|----------|---------|-------------|
| `XAI_API_KEY` | — | API key for xAI/Grok models (when using external API key mode). |

### Collaboration

| Variable | Default | Description |
|----------|---------|-------------|
| `FORGE_ADMIN_EMAIL` | — | Bootstrap email for the first collaboration admin account. Required on first boot if no admin exists yet. |
| `FORGE_ADMIN_PASSWORD` | — | Bootstrap password for the first collaboration admin account. Required on first boot if no admin exists yet. |
| `FORGE_COLLABORATION_BASE_URL` | — | Canonical collaboration browser URL used for login redirects and invite links. For local `docker compose`, use `http://127.0.0.1:47387` by default and keep it aligned with `FORGE_PUBLIC_PORT` if you override the host mapping. |
| `FORGE_COLLABORATION_TRUSTED_ORIGINS` | — | Comma-separated Builder/UI origins allowed to talk to the collaboration server in split deployments. Local `docker-compose.yml` defaults this to `http://127.0.0.1:47188,http://127.0.0.1:47189`. Use `127.0.0.1` consistently for local HTTP split deployments; mixing `localhost` and `127.0.0.1` becomes cross-site and requires HTTPS. |
| `FORGE_COLLABORATION_AUTH_SECRET` | generated locally if unset | Optional auth secret for the collaboration server. If omitted, the server generates and persists one in the data directory. |

### Playwright Dashboard

| Variable | Default | Description |
|----------|---------|-------------|
| `FORGE_PLAYWRIGHT_DASHBOARD_ENABLED` | — | Force enable (`true`) or disable (`false`) the Playwright dashboard. By default, it is disabled on Windows and follows persisted settings elsewhere. |

For compatibility, startup also accepts legacy `MIDDLEMAN_*` environment variables (for example, `MIDDLEMAN_HOST`, `MIDDLEMAN_PORT`, `MIDDLEMAN_DATA_DIR`, `MIDDLEMAN_DEBUG`, `VITE_MIDDLEMAN_WS_URL`, `MIDDLEMAN_PLAYWRIGHT_DASHBOARD_ENABLED`, `MIDDLEMAN_RUNTIME_TARGET`). When `FORGE_RUNTIME_TARGET` is unset, legacy `FORGE_COLLABORATION_ENABLED=true` or `MIDDLEMAN_COLLABORATION_ENABLED=true` maps to the `collaboration-server` runtime target.

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

Provider auth for **OpenAI**, **Anthropic**, and **xAI** is configured through the dashboard UI under **Settings → Authentication**. The pane shows provider labels with auth-mode badges so you can see whether a row is using OAuth or an API key.

OpenAI and Anthropic support either OAuth or API key auth. Claude SDK is separate and OAuth-only: it uses Claude Code CLI OAuth, with credentials stored in macOS Keychain on macOS and `~/.claude/.credentials.json` on Linux and Windows.

Model availability and behavior are managed through **Settings → Models**, which provides visibility controls and context window overrides for all supported models. Those visibility settings also control whether a model can appear in manager create-session, change-default, and per-session override selectors. See [docs/MODEL_CATALOG.md](MODEL_CATALOG.md) for details on the model catalog system.

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
│   │   ├── playwright-dashboard.json      # Playwright dashboard settings
│   │   ├── slash-commands.json            # Global slash commands
│   │   ├── terminal-settings.json         # Terminal runtime settings
│   │   └── integrations/      # Shared integration configs
│   ├── cache/                 # Regenerable/ephemeral
│   │   ├── generated/
│   │   │   └── pi-models.json # Generated Pi-compatible model projection
│   │   ├── stats-cache.json   # Cached dashboard statistics
│   │   ├── provider-usage-cache.json      # Cached provider subscription usage snapshots
│   │   └── provider-usage-history.jsonl   # Historical provider usage samples
│   ├── state/                 # Runtime state & markers
│   │   ├── mobile-devices.json            # Registered mobile devices
│   │   ├── .compaction-count-backfill-v2-done  # Compaction-count backfill sentinel
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
│   │   ├── prompt.md          # Editable system prompt
│   │   └── reference/         # Per-agent reference docs
│   └── sessions/<sessionId>/  # Per-session data
│       ├── session.jsonl      # Conversation history
│       ├── memory.md          # Session-level memory
│       ├── meta.json          # Session metadata
│       ├── feedback.jsonl     # User feedback
│       ├── pinned-messages.json  # Pin state (up to 10 message IDs)
│       ├── context/
│       │   └── prompt.md      # Collaboration channel additional instructions
│       ├── reference/         # Collaboration channel reference docs
│       └── workers/           # Worker session logs
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

Discovery precedence is:
1. `${FORGE_DATA_DIR}/skills`
2. built-in skill definitions shipped with Forge

Skills are loaded from the machine-local directory first, and then from Forge's built-in definitions. There is no repo-local `.swarm/skills` layer in the current setup.

Discovered skills are injected into all agent/runtime sessions the same way other loaded skills are.

Use this for station-specific workflows that should stay outside a shared repository. The built-in `create-skill` helper can scaffold reusable global skills or project skills and validate the resulting structure. A local skill should live at:

```text
${FORGE_DATA_DIR}/skills/<skillName>/SKILL.md
```

`SKILL.md` uses the normal skill frontmatter format (`name`, `description`, optional `env` declarations, then markdown body).

On a default macOS/Linux install this becomes:

```text
~/.forge/skills/<skillName>/SKILL.md
```

### Forge Extensions

Forge exposes a Forge-native hook system for session lifecycle, runtime errors, versioning commits, and tool interception.

**Forge extension directories**:

| Path | Scope |
|------|-------|
| `${FORGE_DATA_DIR}/extensions/` | Global |
| `${FORGE_DATA_DIR}/profiles/<id>/extensions/` | Profile |
| `<cwd>/.forge/extensions/` | Project-local |

Global and profile Forge extension directories are auto-created. Project-local directories are not.

See [FORGE_EXTENSIONS.md](FORGE_EXTENSIONS.md) for the full guide.

### Pi Extensions & Packages

Forge also exposes Pi's extension and package system for deeper customization — custom tools, event interception, context modification, and more.

**Extension auto-discovery directories** (created automatically on startup):

| Path | Scope |
|------|-------|
| `${FORGE_DATA_DIR}/agent/extensions/` | All workers |
| `${FORGE_DATA_DIR}/agent/manager/extensions/` | All managers |
| `<cwd>/.pi/extensions/` | Project-local (agents with that CWD) |

**Skill auto-discovery directories** (created automatically on startup):

| Path | Scope |
|------|-------|
| `${FORGE_DATA_DIR}/agent/skills/` | All workers |
| `${FORGE_DATA_DIR}/agent/manager/skills/` | All managers |
| `<cwd>/.pi/skills/` | Project-local (agents with that CWD) |

**Package configuration** via optional `settings.json` files:

| Path | Scope |
|------|-------|
| `${FORGE_DATA_DIR}/agent/settings.json` | Worker packages |
| `${FORGE_DATA_DIR}/agent/manager/settings.json` | Manager packages |
| `<cwd>/.pi/settings.json` | Project-local packages |

Packages can be installed from npm (`npm:@scope/name`), git (`git:github.com/user/repo`), or local paths. These files do not need to exist — create them only when you want to install packages.

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
