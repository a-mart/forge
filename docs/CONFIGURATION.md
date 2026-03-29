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

### UI

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_FORGE_WS_URL` | Auto-resolved from page URL | WebSocket URL for the UI to connect to the backend. Only needed if running UI and backend on different hosts/ports. |

### Skills

| Variable | Default | Description |
|----------|---------|-------------|
| `BRAVE_API_KEY` | — | API key for the [Brave Search](https://brave.com/search/api/) web search skill. |
| `GEMINI_API_KEY` | — | API key for the Google Gemini image generation skill. |
| `OPENAI_API_KEY` | — | Codex runtime API key fallback (used when `CODEX_API_KEY` is not set). |

Skill API keys can also be configured in the dashboard under **Settings → Environment Variables**. `.env` values remain supported as fallback.

### Agent Runtimes

| Variable | Default | Description |
|----------|---------|-------------|
| `CODEX_BIN` | — | Path to a custom Codex binary. |
| `CODEX_API_KEY` | — | API key for the Codex agent runtime (deprecated; prefer managed auth in Settings). |
| `XAI_API_KEY` | — | API key for xAI/Grok models (when using external API key mode). |

### Playwright Dashboard

| Variable | Default | Description |
|----------|---------|-------------|
| `FORGE_PLAYWRIGHT_DASHBOARD_ENABLED` | — | Force enable (`true`) or disable (`false`) the Playwright dashboard. By default, it is disabled on Windows and follows persisted settings elsewhere. |

For compatibility, startup also accepts legacy `MIDDLEMAN_*` environment variables (for example, `MIDDLEMAN_HOST`, `MIDDLEMAN_PORT`, `MIDDLEMAN_DATA_DIR`, `MIDDLEMAN_DEBUG`, `VITE_MIDDLEMAN_WS_URL`, `MIDDLEMAN_PLAYWRIGHT_DASHBOARD_ENABLED`).

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

## API Keys (LLM Providers)

API keys for LLM providers — **OpenAI**, **Anthropic**, and **xAI** — are configured through the dashboard UI under **Settings → Providers**. They are stored locally in the data directory and never leave your machine.

Model availability and behavior are managed through **Settings → Models**, which provides visibility controls and context window overrides for all supported models. See [docs/MODEL_CATALOG.md](MODEL_CATALOG.md) for details on the model catalog system.

## Data Directory

All persistent state lives in a single data directory:

```
<data-dir>/
├── shared/                    # Shared config
│   ├── auth/auth.json         # API keys and auth tokens
│   ├── secrets.json           # Additional secrets
│   ├── model-overrides.json   # User model visibility/context caps (Settings → Models)
│   ├── generated/
│   │   └── pi-models.json     # Generated Pi-compatible model projection
│   ├── integrations/          # Shared integration configs
│   └── playwright-dashboard.json
├── profiles/<profileId>/      # Per-manager-profile data
│   ├── memory.md              # Profile-level memory
│   └── sessions/<sessionId>/  # Per-session data
│       ├── session.jsonl      # Conversation history
│       ├── memory.md          # Session-level memory
│       ├── meta.json          # Session metadata
│       ├── feedback.jsonl     # User feedback
│       ├── pinned-messages.json  # Pin state (up to 10 message IDs)
│       └── workers/           # Worker session logs
├── swarm/
│   └── agents.json            # Agent registry
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
2. repo-local `.swarm/skills`
3. built-in skill definitions shipped with Forge

Discovered skills are injected into all agent/runtime sessions the same way other loaded skills are.

Use this for station-specific workflows that should stay outside a shared repository. A local skill should live at:

```text
${FORGE_DATA_DIR}/skills/<skillName>/SKILL.md
```

`SKILL.md` uses the normal skill frontmatter format (`name`, `description`, optional `env` declarations, then markdown body).

On a default macOS/Linux install this becomes:

```text
~/.forge/skills/<skillName>/SKILL.md
```

### Pi Extensions & Packages

Forge exposes Pi's extension and package system for deeper customization — custom tools, event interception, context modification, and more.

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

## Remote / Network Access

To access Forge from other devices on your network:

1. Set `FORGE_HOST=0.0.0.0` to bind to all interfaces.
2. Use the machine's IP or hostname in your browser.
3. If using a reverse proxy or Tailscale, ensure `allowedHosts` covers your hostname (the Vite preview server has `allowedHosts: true` by default).
