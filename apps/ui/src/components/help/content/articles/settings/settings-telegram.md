Forge can connect to a Telegram bot so you can chat with your agents from Telegram. Messages from allowed users are forwarded to the manager, and agent replies are sent back to Telegram.

## Setup steps

1. Create a bot with [@BotFather](https://t.me/BotFather) on Telegram and copy the bot token.
2. Open **Settings > Integrations**.
3. Select your configuration scope (shared or per-profile).
4. Toggle **Enable Telegram integration** on.
5. Paste the bot token.
6. Add allowed Telegram user IDs (comma-separated). Leave empty to allow all users.
7. Click **Save**, then **Test connection** to verify.

## Key settings

- **Bot token** — the token from BotFather. Once saved, enter a new value to rotate it.
- **Allowed users** — restrict which Telegram user IDs can interact with the bot. Empty means anyone can use it.
- **Drop pending updates on start** — skip any backlogged messages and start fresh.
- **Disable link previews** — send outbound messages without link preview cards.
- **Reply to inbound message** — reply directly to the triggering Telegram message.

## Attachments

Control which file types Telegram passes to Forge:

- **Image attachments** — photos sent to the bot
- **Text attachments** — text-like documents (e.g. .txt, .csv)
- **Binary attachments** — other document types, encoded as base64

Set the **max attachment size** in bytes (default 10 MB).

## Polling settings

Forge uses long polling to receive messages. The **poll timeout** (default 25 seconds) and **poll limit** (default 100) control how the bot checks for new messages. The defaults work well for most setups.
