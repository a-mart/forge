# Integrations

Forge supports Telegram messaging integration so you can chat with your manager outside the web UI. Telegram supports bidirectional messaging — send tasks and receive responses with formatted text, code blocks, and file attachments.

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
| Allowed Users | Optional allowlist of Telegram user IDs |
| Max File Size | Maximum file size for attachments (default: 10 MB) |
| Poll Timeout / Limit | Long-polling behavior tuning |

## Per-Manager Configuration

Telegram supports per-manager configuration overrides. If you have multiple managers, you can set different Telegram settings for each one in the dashboard under the manager's settings page.

Shared (default) Telegram config applies to all managers unless overridden.

## Troubleshooting

- **Bot not responding** — Check that Telegram integration is enabled and the bot token is valid.
- **Messages not arriving** — Confirm you started a chat with the bot (or added it to the group) and that your Telegram user is allowed if an allowlist is configured.
- **Connection issues** — Check backend logs for `telegram_status` events and Bot API errors.
- **Attachment failures** — Verify attachment size and type settings in Telegram integration config.
