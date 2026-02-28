# User Guide

## Prerequisites

- Node.js 22+
- pnpm 10.30.1+

## Installation

```bash
git clone https://github.com/radopsai/middleman.git
cd middleman
pnpm i
```

## Running

### Development

```bash
pnpm dev
```

Opens:
- **Backend** (WS + HTTP): `ws://127.0.0.1:47187`
- **UI**: `http://127.0.0.1:47188`

### Production

```bash
pnpm prod
```

Builds all apps first, then runs:
- **Backend**: port `47287`
- **UI**: port `47289`

### Background Daemon

```bash
pnpm prod:daemon      # Start in background (survives shell close)
pnpm prod:restart     # Graceful restart (SIGUSR1)
```

The daemon auto-restarts on `pnpm-lock.yaml` changes and uses a PID file to prevent duplicate instances.

## First-Time Setup

1. Open the UI at `http://127.0.0.1:47188`
2. Go to **Settings** (gear icon, bottom of sidebar)
3. Under **Auth**, add your API keys:
   - **Anthropic** — for Pi agents (pi-opus, pi-codex)
   - **OpenAI Codex** — for Codex agents (codex-app)
4. Close settings and click **New Manager** (+ icon, top of sidebar)
5. Fill in:
   - **Name** — display name for the manager
   - **Working Directory** — the project directory the manager will work in
   - **Model** — choose a model preset
6. Click **Create**

The manager starts with a bootstrap interview asking about your project, preferences, and tools. Answer its questions — it saves your responses to its memory file for future reference.

## Daily Usage

### Chat Interface

The main view is a chat with your active agent:

- **Left sidebar** — Agent hierarchy (managers and their workers)
- **Center** — Conversation with message input
- **Right sidebar** — Artifacts and schedules (toggle via button in header)

### Sending Messages

- Type in the message box and press **Ctrl+Enter** / **Cmd+Enter** to send
- Attach files by:
  - Clicking the attachment button
  - Dragging files onto the chat
  - Pasting from clipboard
- Supported attachments: images, text files, binary files (up to limits)

### Voice Input

Click the microphone button to record audio. It transcribes via OpenAI Whisper and fills the text box. Requires an OpenAI API key configured in settings.

### Channel Views

The header has two channel filter buttons:

- **Web** — Only messages from the web UI
- **All** — Messages from all channels (web + Slack + Telegram)

### Agent Sidebar

- Click any agent to view its conversation
- Managers show as bold entries; workers are nested underneath
- Status indicators:
  - Green dot = idle
  - Spinning = streaming (actively working)
- Right-click an agent for options (e.g., delete)
- Collapsed managers show a badge with count of active workers

### Artifacts

The right sidebar collects artifacts from conversations:
- File links (swarm-file://, vscode://)
- Markdown links
- `[artifact:path]` shortcodes

Click an artifact to view its contents in a panel overlay.

### Schedules

The **Schedules** tab in the right sidebar shows cron jobs for the active manager:
- Next fire time
- Last fired time
- Cron expression (with human-readable translation)
- Message payload

Schedules are managed via the cron-scheduling skill or the REST API.

## Manager Operations

Available from the header dropdown menu (three dots):

| Action | Description |
|--------|-------------|
| **Compact Context** | Compress conversation history to free up context window. Use when the context usage indicator gets high. |
| **Clear Conversation** | Reset the manager's session (starts fresh). |
| **Stop All Agents** | Gracefully stop the manager and all its workers. |

### Context Window

The header shows a context usage indicator (token count / total). When it gets close to full:
- **Manager**: Use "Compact Context" to compress history
- **Workers**: They terminate on overflow; the manager spawns replacements as needed

### Creating Multiple Managers

Each manager operates independently with its own:
- Working directory
- Conversation history
- Memory file
- Integration profiles (Slack/Telegram)
- Scheduled tasks

Click **+** in the sidebar to create additional managers for different projects.

## Settings

### Auth

Configure API keys for AI providers:
- **Anthropic** — Required for Pi agents
- **OpenAI Codex** — Required for Codex agents

Supports API key entry and OAuth login flows.

### Environment Variables

Skill-specific API keys (these can also be set in `.env`):
- `BRAVE_API_KEY` — Brave Search skill
- `GEMINI_API_KEY` — Image generation skill
- `OPENAI_API_KEY` — Voice transcription + Codex fallback
- `CODEX_API_KEY` — Codex agent runtime (overrides OPENAI_API_KEY)

### Integrations

Per-manager Slack and Telegram configuration. See [Integrations](INTEGRATIONS.md).

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Ctrl+Enter / Cmd+Enter | Send message |
| Escape | Close dialogs and panels |

## Troubleshooting

### "Reconnecting" status
The WebSocket connection dropped. The client auto-reconnects with 1.2s backoff. Check that the backend is running.

### Agent stuck in "streaming"
The agent may have hit an error during inference. Try:
1. Check the tool log entries for errors (expand them in the message list)
2. Use "Stop All Agents" from the header menu
3. If persistent, restart the backend

### Context overflow
If a manager's context fills up, it auto-compacts. If that fails:
1. Manually trigger "Compact Context" from the menu
2. As a last resort, "Clear Conversation" to reset

### Workers not responding
Workers terminate on context overflow. The manager should auto-spawn replacements. If not, send the manager a follow-up message describing what you need.
