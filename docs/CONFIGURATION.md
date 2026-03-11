# Configuration

Middleman is configured through environment variables, a `.env` file, and the dashboard UI.

## Environment Variables

### Core

| Variable | Default | Description |
|----------|---------|-------------|
| `MIDDLEMAN_HOST` | `127.0.0.1` | Backend bind address. Set to `0.0.0.0` for network/remote access. |
| `MIDDLEMAN_PORT` | `47187` (dev) / `47287` (prod) | Backend HTTP + WebSocket port. |
| `MIDDLEMAN_DATA_DIR` | `~/.middleman` (macOS/Linux) or `%LOCALAPPDATA%\middleman` (Windows) | Data directory for all persistent state. |
| `NODE_ENV` | — | Set to `production` for production mode. |

### UI

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_MIDDLEMAN_WS_URL` | Auto-resolved from page URL | WebSocket URL for the UI to connect to the backend. Only needed if running UI and backend on different hosts/ports. |

### Skills

| Variable | Default | Description |
|----------|---------|-------------|
| `BRAVE_API_KEY` | — | API key for the [Brave Search](https://brave.com/search/api/) web search skill. |
| `GEMINI_API_KEY` | — | API key for the Google Gemini image generation skill. |
| `OPENAI_API_KEY` | — | OpenAI API key (alternative to setting it in the UI). |

### Agent Runtimes

| Variable | Default | Description |
|----------|---------|-------------|
| `CODEX_BIN` | — | Path to a custom Codex binary. |
| `CODEX_API_KEY` | — | API key for the Codex agent runtime. |

### Playwright Dashboard

| Variable | Default | Description |
|----------|---------|-------------|
| `MIDDLEMAN_PLAYWRIGHT_DASHBOARD_ENABLED` | — | Force enable (`true`) or disable (`false`) the Playwright dashboard. By default, it is disabled on Windows and follows persisted settings elsewhere. |

## `.env` File

Create a `.env` file in the project root. It is loaded automatically on startup.

```bash
# Example .env
MIDDLEMAN_HOST=127.0.0.1
MIDDLEMAN_PORT=47187
# MIDDLEMAN_DATA_DIR=/custom/path
# BRAVE_API_KEY=your-brave-key
# GEMINI_API_KEY=your-gemini-key
```

## API Keys (LLM Providers)

API keys for LLM providers — **OpenAI** and **Anthropic** — are configured through the dashboard UI under **Settings → API Keys**. They are stored locally in the data directory and never leave your machine.

## Data Directory

All persistent state lives in a single data directory:

```
<data-dir>/
├── shared/                    # Shared config
│   ├── auth/auth.json         # API keys and auth tokens
│   ├── secrets.json           # Additional secrets
│   ├── integrations/          # Shared integration configs
│   └── playwright-dashboard.json
├── profiles/<profileId>/      # Per-manager-profile data
│   ├── memory.md              # Profile-level memory
│   └── sessions/<sessionId>/  # Per-session data
│       ├── session.jsonl      # Conversation history
│       ├── memory.md          # Session-level memory
│       ├── meta.json          # Session metadata
│       ├── feedback.jsonl     # User feedback
│       └── workers/           # Worker session logs
├── swarm/
│   └── agents.json            # Agent registry
└── uploads/                   # File uploads
```

### Default Locations

| Platform | Default Path |
|----------|-------------|
| macOS / Linux | `~/.middleman` |
| Windows | `%LOCALAPPDATA%\middleman` |

Override with `MIDDLEMAN_DATA_DIR` in your environment or `.env` file.

## Ports

| Mode | Backend | UI |
|------|---------|-----|
| Development (`pnpm dev`) | `47187` | `47188` |
| Production (`pnpm prod`) | `47287` | `47289` |

## Remote / Network Access

To access Middleman from other devices on your network:

1. Set `MIDDLEMAN_HOST=0.0.0.0` to bind to all interfaces.
2. Use the machine's IP or hostname in your browser.
3. If using a reverse proxy or Tailscale, ensure `allowedHosts` covers your hostname (the Vite preview server has `allowedHosts: true` by default).
