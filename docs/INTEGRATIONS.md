# Integrations

Forge supports messaging integrations that let you chat with your manager from Telegram or Slack. Both support bidirectional messaging — send tasks and receive responses with formatted text, code blocks, and file attachments.

## Telegram

### Setup

1. **Create a bot** — Talk to [@BotFather](https://t.me/botfather) on Telegram and create a new bot. Copy the bot token.

2. **Configure in Forge** — Open the dashboard, go to **Settings → Integrations → Telegram**, and paste your bot token.

3. **Start chatting** — Send a message to your bot on Telegram. It will be routed to your manager.

### Features

- Text messages and file attachments (images, documents)
- Formatted responses with Telegram-compatible markdown
- Forum/topic support — the bot can create and manage topics in Telegram group chats
- Configurable polling settings

### Configuration Options

| Setting | Description |
|---------|-------------|
| Bot Token | Your Telegram bot token from @BotFather |
| Enabled | Toggle the integration on/off |
| Max File Size | Maximum file size for attachments (default: 10 MB) |

## Slack

### Setup

1. **Create a Slack app** — Go to [api.slack.com/apps](https://api.slack.com/apps) and create a new app.

2. **Enable Socket Mode** — In your app settings, enable Socket Mode and generate an **App-Level Token** with the `connections:write` scope.

3. **Add bot scopes** — Under **OAuth & Permissions**, add these bot token scopes:
   - `chat:write` — Send messages
   - `channels:history` — Read channel messages
   - `channels:read` — List channels
   - `files:read` — Read file attachments
   - `groups:history` — Read private channel messages (if needed)
   - `im:history` — Read DMs
   - `im:read` — List DMs
   - `mpim:history` — Read group DMs (if needed)

4. **Enable Events** — Under **Event Subscriptions**, subscribe to:
   - `message.channels`
   - `message.groups`
   - `message.im`
   - `message.mpim`

5. **Install the app** — Install to your workspace and copy the **Bot User OAuth Token**.

6. **Configure in Forge** — Open the dashboard, go to **Settings → Integrations → Slack**, and enter:
   - **Bot Token** — The Bot User OAuth Token (`xoxb-...`)
   - **App Token** — The App-Level Token (`xapp-...`)

7. **Invite the bot** — Add the bot to any channel where you want to interact with it.

### Features

- Direct messages and channel mentions
- Thread support — responses can be threaded
- Formatted responses with Slack mrkdwn
- File attachment handling
- Channel routing — map channels to specific managers

### Configuration Options

| Setting | Description |
|---------|-------------|
| Bot Token | Slack Bot User OAuth Token (`xoxb-...`) |
| App Token | Slack App-Level Token (`xapp-...`) |
| Enabled | Toggle the integration on/off |
| Max File Size | Maximum file size for attachments (default: 10 MB) |

## Per-Manager Configuration

Both integrations support per-manager configuration overrides. If you have multiple managers, you can set different integration settings for each one in the dashboard under the manager's settings page.

Shared (default) integration configs apply to all managers unless overridden.

## Troubleshooting

- **Bot not responding** — Check that the integration is enabled in Settings and the token is valid.
- **Messages not arriving** — For Slack, ensure the bot is invited to the channel and the correct event subscriptions are configured.
- **Connection issues** — The backend logs connection status for both integrations. Check the terminal output for errors.
