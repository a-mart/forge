# Integrations

Middleman supports Slack and Telegram as external messaging channels. Each integration is configured per-manager — different managers can connect to different workspaces/bots.

## Slack

### Overview

Slack integration uses **Socket Mode** (WebSocket connection to Slack, no public URL required). Messages flow in both directions:

- **Inbound**: Slack messages → SwarmManager → Agent processes → response
- **Outbound**: Agent responses → Slack message via Web API

### Setup

1. Create a Slack App at [api.slack.com/apps](https://api.slack.com/apps)
2. Enable **Socket Mode** and generate an **App-Level Token** (starts with `xapp-`)
3. Add a **Bot User** and generate a **Bot Token** (starts with `xoxb-`)
4. Required bot scopes: `chat:write`, `channels:read`, `files:read`, `app_mentions:mention`
5. In Middleman UI: **Settings > Integrations > Slack**
6. Enter the App Token and Bot Token
7. Click **Test Connection** to verify
8. Toggle **Enabled** on

### Configuration Options

```typescript
{
  enabled: boolean,
  mode: "socket",                    // Only supported mode
  appToken: string,                  // xapp-... (Socket Mode)
  botToken: string,                  // xoxb-... (Bot API)
  listen: {
    dm: boolean,                     // Listen to direct messages (default: true)
    channelIds: string[],            // Specific channels (empty = all)
    includePrivateChannels: boolean  // Include private channels
  },
  response: {
    respondInThread: boolean,        // Reply in threads (default: true)
    replyBroadcast: boolean,         // Broadcast thread replies to channel
    wakeWords: string[]              // Trigger words (default: ["swarm", "bot"])
  },
  attachments: {
    maxFileBytes: number,            // Max file size (default: 10MB, max: 100MB)
    allowImages: boolean,
    allowText: boolean,
    allowBinary: boolean
  }
}
```

### Wake Words

In channels (not DMs), the bot only responds when triggered by:
- Direct `@mention`
- Wake word patterns: `"hey swarm"`, `"hi bot"`, `"swarm:"`, `"bot!"`
- Direct requests: `"can you..."`, `"could you..."`, `"please..."`
- In a thread: question mark + second-person language

In DMs, the bot always responds (no wake words needed).

### Message Formatting

Markdown in agent responses is converted to Slack `mrkdwn` format:
- `**bold**` → `*bold*`
- `*italic*` → `_italic_`
- Code blocks preserved
- Links converted to Slack format
- Messages split at 4096 characters (Slack's limit)

### Storage

Config: `~/.middleman/integrations/managers/<managerId>/slack.json`

---

## Telegram

### Overview

Telegram integration uses **long polling** (no webhook/public URL required). The bot polls Telegram servers for new messages.

### Setup

1. Create a bot via [@BotFather](https://t.me/botfather) on Telegram
2. Copy the **Bot Token**
3. In Middleman UI: **Settings > Integrations > Telegram**
4. Enter the Bot Token
5. Click **Test Connection** to verify
6. Toggle **Enabled** on

### Configuration Options

```typescript
{
  enabled: boolean,
  mode: "polling",                   // Only supported mode
  botToken: string,                  // From BotFather
  allowedUserIds: string[],          // User allowlist (empty = all users)
  polling: {
    timeoutSeconds: number,          // Long-poll timeout (default: 25, max: 60)
    limit: number,                   // Updates per request (default: 100, max: 100)
    dropPendingUpdatesOnStart: boolean // Skip old messages (default: true)
  },
  delivery: {
    parseMode: "HTML",               // Message format
    disableLinkPreview: boolean,     // Hide URL previews
    replyToInboundMessageByDefault: boolean  // Quote original message
  },
  attachments: {
    maxFileBytes: number,            // Max file size (default: 10MB, max: 100MB)
    allowImages: boolean,
    allowText: boolean,
    allowBinary: boolean
  }
}
```

### User Allowlist

By default, any Telegram user can message the bot. Set `allowedUserIds` to restrict access to specific user IDs.

### Message Formatting

Markdown in agent responses is converted to Telegram HTML:
- `**bold**` → `<b>bold</b>`
- `*italic*` → `<i>italic</i>`
- `~~strikethrough~~` → `<s>strikethrough</s>`
- Code blocks with language class
- Links: `[label](url)` → `<a href="url">label</a>`
- HTML entities escaped for safety
- Messages split at 4096 characters (Telegram's limit)

### Storage

Config: `~/.middleman/integrations/managers/<managerId>/telegram.json`

---

## Common Patterns

### Multi-Manager Integrations

Each manager can have independent Slack and Telegram profiles. Example setup:

- **project-a-manager** → Connected to `#project-a` Slack channel + dedicated Telegram bot
- **project-b-manager** → Connected to `#project-b` Slack channel

### Deduplication

Both integrations track message IDs for 30 minutes to prevent processing the same message twice (important for Slack retries and Telegram polling overlap).

### Rate Limiting

Both clients handle API rate limits automatically:
- Detect 429 responses
- Respect `retry_after` headers
- Exponential backoff on repeated failures

### Error Recovery

- **Slack**: Socket Mode auto-reconnects on disconnect
- **Telegram**: Polling retries with backoff on error, resumes with last known offset

## REST API

Both integrations expose HTTP endpoints for programmatic management:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/managers/:id/integrations/slack` | GET | Get Slack config + status |
| `/api/managers/:id/integrations/slack` | PUT | Update Slack config |
| `/api/managers/:id/integrations/slack` | DELETE | Disable Slack |
| `/api/managers/:id/integrations/slack/test` | POST | Test Slack connection |
| `/api/managers/:id/integrations/slack/channels` | GET | List Slack channels |
| `/api/managers/:id/integrations/telegram` | GET | Get Telegram config + status |
| `/api/managers/:id/integrations/telegram` | PUT | Update Telegram config |
| `/api/managers/:id/integrations/telegram` | DELETE | Disable Telegram |
| `/api/managers/:id/integrations/telegram/test` | POST | Test Telegram connection |
