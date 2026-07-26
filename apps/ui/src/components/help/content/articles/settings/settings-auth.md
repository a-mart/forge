The Authentication pane manages model-provider credentials for the selected Builder or Collaboration backend. Its controls differ by provider: status and auth-type badges appear only on applicable cards.

## Supported providers

- **Anthropic** — Claude-based workers and managers. The current card manages an OAuth account pool.
- **OpenAI** — GPT and Codex runtime sessions. The current card manages an OAuth account pool and the OpenAI/Codex-only Forge Auth broker mode.
- **xAI** — One direct, non-pooled row for either an API key or OAuth for native Grok models.
- **OpenRouter** — A masked API-key row for user-added OpenRouter models.
- **Cursor SDK** — A masked key/token row for Composer 2.5 and Cursor Grok 4.5 sessions when those catalog models are visible. Shared secrets and environment configuration are also supported. Background auth/transport failures stay inside the worker runtime and surface as worker failures, not app crashes.

## Configuring a provider

1. Open **Settings > Authentication**.
2. For OpenAI or Anthropic, use **Add Account** and complete the OAuth flow.
3. For xAI, either enter an API key and select **Save**, or select **Login with OAuth**. Completing either path replaces the previously stored xAI credential.
4. For OpenRouter or Cursor SDK, enter the requested key/token and select **Save**. These key rows include provider links where available.

Provider cards show configuration state. Generic key-row secrets are masked; use the eye control to reveal the draft value. **Remove** deletes the locally stored credential but does not revoke it at the provider. For xAI, an environment `XAI_API_KEY` can act as a fallback after local removal; it is not a second account. If stored OAuth refresh fails, Forge does not switch to the environment key—retry or reauthorize, or remove stored OAuth before using the key. OAuth pool accounts can be renamed, selected as primary, or removed from their card. Credentials are stored on the targeted backend under `~/.forge/shared/config/auth/auth.json`. OpenAI and Anthropic pooled OAuth credentials refresh through the shared auth path before runtime selection and save refreshed tokens back under the pooled key; missing or clearly expired pooled credentials surface as `auth_error`.

OpenAI also has a Forge Auth broker mode. It is v1-scoped to OpenAI/Codex and uses a separate broker to issue short-lived leases. In v1, the normal setup path is a one-time setup link created by the broker admin UI for your name/email. Paste that link into the Forge Auth broker panel and click **Redeem invite**. The link contains only an invite id and secret, not an OpenAI token, runtime token, admin token, or provisioning token. Forge redeems it server-to-server, stores the broker runtime token only in Forge secrets, and shows status with masked values. Reusing the same setup link fails after redemption.

Manual broker URL/token setup remains available under **Advanced manual setup** for older deployments and backcompat. Broker URLs must use HTTPS, except local `http://localhost`, `http://127.0.0.1`, and other localhost/dev broker URLs used for development.

While broker mode is active, local OpenAI OAuth/API-key and pool credentials below it remain visible for reference but cannot be edited. Runtime status reflects the broker connection where available; Forge acquires, renews, reports, and releases OpenAI/Codex leases while runtimes are active.

If `FORGE_OPENAI_CODEX_AUTH_MODE` is set in the environment, it overrides the Settings value and disables invite paste and manual broker edits in the UI. In `central_broker` mode, saved broker URL/token values are ignored and Forge uses `FORGE_OPENAI_AUTH_BROKER_URL`, `FORGE_OPENAI_AUTH_BROKER_TOKEN`, `FORGE_OPENAI_AUTH_BROKER_INSTANCE_ID`, and `FORGE_OPENAI_AUTH_BROKER_INSTANCE_LABEL` from the environment instead.

Provider auth changes propagate by recycling matching idle manager runtimes or deferring the recycle until busy runtimes are idle. This includes collaboration channel sessions, direct OAuth login changes, and credential pool strategy changes, so the common case does not require recreating sessions or restarting the backend.

## OAuth login

The current Anthropic and OpenAI pool cards add accounts through OAuth. Select **Add Account**, follow the browser authorization flow, then paste an authorization code or callback URL if prompted. OpenAI's local credential card is read-only while Forge Auth broker mode is active.

xAI OAuth uses its single direct credential slot rather than a pool. Select **Login with OAuth**, then choose the browser or device path when prompted. For browser login, use **Open authorization URL** or **Copy URL**. If the local callback does not complete automatically, paste the full callback URL from the current attempt. For a remote or headless backend, use the device path, open the verification URL elsewhere, and enter the displayed code. Forge stores the resulting xAI OAuth credential and refreshes it when needed. Retry a failed attempt; if refresh stops working, reauthorize.

**Cancel** aborts the active login attempt without removing an existing credential. **Clear** dismisses completed or failed flow state; it does not clear saved auth. **Remove** deletes the locally stored credential, without provider-side revocation.

Claude models use the Anthropic credentials configured in Forge. Claude Code login credentials are not imported or converted.

## Which credential do I need?

You need at least one compatible provider credential to run agents. Choose Anthropic for its Claude models; OpenAI or Forge Auth broker mode for GPT/Codex; xAI for native Grok; OpenRouter for user-added OpenRouter models; or Cursor SDK for its visible catalog models. Native Grok models can appear for specialist and spawn usage when xAI auth is configured and those models are visible, but they are excluded from normal manager create, change, and override selectors.
