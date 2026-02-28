# Configuration

## Environment Variables

### Backend Server

| Variable | Default | Description |
|----------|---------|-------------|
| `MIDDLEMAN_HOST` | `127.0.0.1` | HTTP/WS server bind address |
| `MIDDLEMAN_PORT` | `47187` (dev) / `47287` (prod) | HTTP/WS server port |
| `NODE_ENV` | — | `production` for prod mode |

### AI Provider Keys

| Variable | Required For | Description |
|----------|-------------|-------------|
| `OPENAI_API_KEY` | Voice transcription, Codex fallback | OpenAI API key |
| `CODEX_API_KEY` | Codex agents | Overrides OPENAI_API_KEY for Codex runtime |
| `CODEX_BIN` | Codex agents | Path to `codex` binary (defaults to `codex` in PATH) |

### Skill API Keys

| Variable | Skill | Description |
|----------|-------|-------------|
| `BRAVE_API_KEY` | brave-search | Brave Search API |
| `GEMINI_API_KEY` | image-generation | Google Gemini API |

### Production Daemon

| Variable | Default | Description |
|----------|---------|-------------|
| `SWARM_PROD_DAEMON_COMMAND` | `pnpm prod` | Override the production start command |
| `SWARM_PROD_DAEMON_INSTALL_COMMAND` | `pnpm i` | Override the install command |

All variables can be set in a `.env` file at the repo root (loaded via dotenv) or configured through the UI at **Settings > Environment Variables**.

## Data Directory

All persistent data lives under `~/.middleman` (hardcoded, not configurable).

```
~/.middleman/
├── .swarm/
│   ├── agents.json                     # Agent registry (all managers + workers)
│   ├── sessions/
│   │   ├── <managerId>.jsonl           # Manager session history
│   │   └── <workerId>.jsonl            # Worker session history
│   ├── memory/
│   │   └── <managerId>/
│   │       └── <agentId>.md            # Per-agent persistent memory
│   ├── uploads/                        # Web attachment files
│   ├── attachments/
│   │   └── <agentId>/<batchId>/*       # Binary attachment spill files
│   └── secrets.json                    # Environment variable secrets
├── auth.json                           # Provider credentials (API keys, OAuth tokens)
├── integrations/
│   └── managers/
│       └── <managerId>/
│           ├── slack.json              # Slack integration config
│           └── telegram.json           # Telegram integration config
└── schedules/
    └── <managerId>.json                # Cron schedule definitions
```

## Data Isolation

### Per-Manager (Isolated)

Each manager has its own independent:
- Worker agents (ownership enforced via `managerId`)
- Session history file
- Persistent memory
- Cron schedules
- Slack integration profile
- Telegram integration profile

### Global (Shared)

These resources are shared across all managers:
- Agent registry (`agents.json`)
- Auth credentials (`auth.json`)
- Environment secrets (`secrets.json`)
- Built-in skills and archetypes
- Upload directory (flat, not partitioned)

## Port Mapping

| Mode | Backend (WS + HTTP) | UI |
|------|---------------------|----|
| Development | 47187 | 47188 |
| Production | 47287 | 47289 |

The UI auto-detects the backend port based on its own port. HTTPS connections automatically upgrade WebSocket to `wss://`.

## Skills Configuration

Skills are discovered from three locations (in priority order):

1. **`.swarm/skills/`** — User/project-specific skills (in working directory)
2. **`apps/backend/src/swarm/skills/builtins/`** — Repo built-in skills
3. **Built-in fallback** — Default skill location

Each skill is a directory containing a `SKILL.md` file with YAML frontmatter:

```yaml
---
name: "Skill Name"
env:
  - name: API_KEY_NAME
    description: "What this key is for"
    required: true
    helpUrl: "https://example.com/get-key"
---
```

## Archetype Prompts

Archetypes define the system prompts for manager and worker roles. Like skills, they can be overridden:

1. **`.swarm/archetypes/`** — Project-specific overrides
2. **Built-in** — Default prompts in the backend

## Auth Storage

Provider credentials are stored in `~/.middleman/auth.json` and managed through the UI settings or OAuth login flows. Supported providers:

- `anthropic` — Claude API key
- `openai-codex` — OpenAI/Codex access

All credentials are masked in API responses (`********`).
