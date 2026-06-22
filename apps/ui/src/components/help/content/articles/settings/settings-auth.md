The Authentication pane lists each provider on its own row. Every row shows the provider label and an auth-mode badge so you can see at a glance whether Forge is using OAuth or an API key.

## Supported providers

- **Anthropic** — Claude-based workers and managers. Supports either OAuth or API key auth.
- **OpenAI** — Codex runtime sessions and voice transcription. Supports OAuth, API key auth, or Forge Auth broker mode for OpenAI/Codex in v1.
- **Claude SDK** — Native Claude Code CLI OAuth path for Claude models. OAuth only.
- **Cursor SDK** — Native Cursor SDK runtime for Composer 2.5 specialist sessions. API key only via `CURSOR_API_KEY`. Background auth/transport failures stay inside the worker runtime and surface as worker failures, not app crashes.
- **xAI** — Grok-based workers.

## Configuring a provider

1. Open **Settings > Authentication**.
2. Find the provider row you want.
3. Use the auth control shown on that row to connect with OAuth or enter an API key, depending on the provider and your setup.
4. Click **Save** if prompted.

Each row also shows whether that provider is configured. Saved credentials are masked and stored on disk at `~/.forge/shared/config/auth/auth.json`. Pooled OAuth credentials refresh through the shared auth path before runtime selection and save refreshed tokens back under the pooled key; missing or clearly expired pooled creds surface as `auth_error`. Use the eye icon to toggle visibility of any entered secret. Click **Remove** to delete saved credentials.

OpenAI also has a Forge Auth broker mode. It is v1-scoped to OpenAI/Codex and uses a separate broker to issue short-lived leases. In v1, the normal setup path is a one-time setup link created by the broker admin UI for your name/email. Paste that link into the Forge Auth broker panel and click **Redeem invite**. The link contains only an invite id and secret, not an OpenAI token, runtime token, admin token, or provisioning token. Forge redeems it server-to-server, stores the broker runtime token only in Forge secrets, and shows status with masked values. Reusing the same setup link fails after redemption.

Manual broker URL/token setup remains available under **Advanced manual setup** for older deployments and backcompat. Broker URLs must use HTTPS, except local `http://localhost`, `http://127.0.0.1`, and other localhost/dev broker URLs used for development.

While broker mode is active, local OpenAI OAuth/API-key and pool credentials below it remain visible for reference but cannot be edited. Runtime status reflects the broker connection where available; Forge acquires, renews, reports, and releases OpenAI/Codex leases while runtimes are active.

If `FORGE_OPENAI_CODEX_AUTH_MODE` is set in the environment, it overrides the Settings value and disables invite paste and manual broker edits in the UI. In `central_broker` mode, saved broker URL/token values are ignored and Forge uses `FORGE_OPENAI_AUTH_BROKER_URL`, `FORGE_OPENAI_AUTH_BROKER_TOKEN`, `FORGE_OPENAI_AUTH_BROKER_INSTANCE_ID`, and `FORGE_OPENAI_AUTH_BROKER_INSTANCE_LABEL` from the environment instead.

Each provider row includes a **Get key** link when API key auth is supported, which opens the provider's key management page in your browser.

Provider auth changes propagate by recycling matching idle manager runtimes or deferring the recycle until busy runtimes are idle. This includes collaboration channel sessions, direct OAuth login changes, and credential pool strategy changes, so the common case does not require recreating sessions or restarting the backend.

## OAuth login

Anthropic and OpenAI support OAuth as an alternative to API keys. Click **Login with OAuth**, follow the browser authorization flow, then paste the authorization code back into Forge. OAuth tokens are stored and refreshed automatically. OpenAI OAuth is unavailable for edits while Forge Auth broker mode is active.

Claude SDK uses Claude Code CLI OAuth instead of an API key. Run `claude login` first so Forge can read the local Claude credentials. If the SDK is unavailable, Forge falls back to the Pi-proxied Anthropic path automatically.

If the OAuth flow gets stuck, click **Clear** to reset it and try again.

## Which credential do I need?

You need at least one provider credential to run agents. Most setups use Anthropic for Claude-based workers. Add OpenAI or enable Forge Auth broker mode if you want Codex runtime sessions; local OpenAI credentials are still the path for voice transcription. Add xAI if you want to use Grok models. Use Claude SDK if you want the native Claude Code CLI OAuth path instead of an API key. Use Cursor SDK if you want Composer 2.5 access through `CURSOR_API_KEY` in specialist selectors.
