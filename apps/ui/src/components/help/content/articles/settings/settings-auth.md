The Authentication pane lists each provider on its own row. Every row shows the provider label and an auth-mode badge so you can see at a glance whether Forge is using OAuth or an API key.

## Supported providers

- **Anthropic** — Claude-based workers and managers. Supports either OAuth or API key auth.
- **OpenAI** — Codex runtime sessions and voice transcription. Supports either OAuth or API key auth.
- **Claude SDK** — Native Claude Code CLI OAuth path for Claude models. OAuth only.
- **Cursor SDK** — Native Cursor SDK runtime for Composer 2.5. API key only via `CURSOR_API_KEY` for both manager and specialist sessions. Background auth/transport failures stay inside the worker runtime and surface as worker failures, not app crashes.
- **xAI** — Grok-based workers.

## Configuring a provider

1. Open **Settings > Authentication**.
2. Find the provider row you want.
3. Use the auth control shown on that row to connect with OAuth or enter an API key, depending on the provider and your setup.
4. Click **Save** if prompted.

Each row also shows whether that provider is configured. Saved credentials are masked and stored on disk at `~/.forge/shared/config/auth/auth.json`. Pooled OAuth credentials refresh through the shared auth path before runtime selection and save refreshed tokens back under the pooled key; missing or clearly expired pooled creds surface as `auth_error`. Use the eye icon to toggle visibility of any entered secret. Click **Remove** to delete saved credentials.


Each provider row includes a **Get key** link when API key auth is supported, which opens the provider's key management page in your browser.

## OAuth login

Anthropic and OpenAI support OAuth as an alternative to API keys. Click **Login with OAuth**, follow the browser authorization flow, then paste the authorization code back into Forge. OAuth tokens are stored and refreshed automatically.

Claude SDK uses Claude Code CLI OAuth instead of an API key. Run `claude login` first so Forge can read the local Claude credentials. If the SDK is unavailable, Forge falls back to the Pi-proxied Anthropic path automatically.

If the OAuth flow gets stuck, click **Clear** to reset it and try again.

## Which credential do I need?

You need at least one provider credential to run agents. Most setups use Anthropic for Claude-based workers. Add OpenAI if you want Codex runtime sessions or voice transcription. Add xAI if you want to use Grok models. Use Claude SDK if you want the native Claude Code CLI OAuth path instead of an API key. Use Cursor SDK if you want Composer 2.5 access through `CURSOR_API_KEY` in manager and specialist selectors.
