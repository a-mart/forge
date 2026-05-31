OAuth lets you connect Forge to a provider account without manually copying API keys. It is supported for Anthropic and OpenAI.

## How the flow works

1. Open **Settings > Authentication**.
2. Find the provider and click **Login with OAuth**.
3. Forge opens an authorization URL in your browser.
4. Log in and authorize Forge on the provider's site.
5. Copy the authorization code from the browser.
6. Paste it into the code input in Forge and click **Submit**.
7. Forge exchanges the code for tokens and stores them.

Once connected, the provider row shows a "Connected" badge. Forge handles token refresh automatically in the background.

## When to use OAuth vs. API keys

Either approach works. OAuth is useful if you prefer not to generate long-lived API keys, or if your organization manages access through OAuth rather than API keys. API keys are simpler for personal use.

## Troubleshooting

- **Authorization URL doesn't open** — copy the URL manually and paste it into your browser.
- **Code submission fails** — make sure you copied the full code or URL from the provider page. Some providers include a URL with the code embedded; paste the whole thing.
- **Flow gets stuck** — click **Clear** to reset, then start again.
- **Token expired** — Forge refreshes tokens automatically. If auth stops working, remove the credential and re-authorize.
