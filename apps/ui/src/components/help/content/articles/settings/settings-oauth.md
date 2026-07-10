The current Anthropic and OpenAI credential-pool cards use OAuth to add provider accounts without copying API keys.

## How the flow works

1. Open **Settings > Authentication**.
2. Open the Anthropic or OpenAI card and select **Add Account**.
3. Forge opens an authorization URL in your browser.
4. Log in and authorize Forge on the provider's site.
5. Copy the authorization code from the browser.
6. Paste it into the code input in Forge and click **Submit**.
7. Forge exchanges the code for tokens and stores them.

Once connected, the pool card lists the account and Forge handles token refresh automatically in the background. Missing or clearly expired pooled credentials surface as `auth_error`.

## OAuth and other authentication paths

The current Settings UI does not use one universal auth control. Anthropic and OpenAI use OAuth pool cards; xAI, OpenRouter, and Cursor SDK have separate key/token rows. Claude SDK authentication happens outside Settings through `claude login`. OpenAI/Codex may instead be managed by Forge Auth broker mode, which makes the local OpenAI card read-only.

## Troubleshooting

- **Authorization URL doesn't open** — copy the URL manually and paste it into your browser.
- **Code submission fails** — make sure you copied the full code or URL from the provider page. Some providers include a URL with the code embedded; paste the whole thing.
- **Flow gets stuck** — click **Clear** to reset, then start again.
- **Token expired** — Forge refreshes tokens automatically. If auth stops working, remove the credential and re-authorize.
