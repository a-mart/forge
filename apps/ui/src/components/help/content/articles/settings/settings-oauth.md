Forge supports OAuth through the Anthropic and OpenAI credential-pool cards and through xAI's single direct, non-pooled credential row.

## Anthropic and OpenAI pools

1. Open **Settings > Authentication**.
2. Open the Anthropic or OpenAI card and select **Add Account**.
3. Follow the authorization URL and approve access on the provider's site.
4. Paste the requested authorization code or callback URL into Forge and select **Submit**.

Once connected, the pool card lists the account and Forge refreshes its tokens automatically. Missing or clearly expired OpenAI or Anthropic pooled credentials surface as `auth_error`. OpenAI/Codex may instead be managed by Forge Auth broker mode, which makes the local OpenAI card read-only.

## xAI browser login

1. On the xAI row, select **Login with OAuth**, then choose the browser path when prompted.
2. Select **Open authorization URL**, or use **Copy URL** and open it in another browser.
3. Approve access on xAI's site.
4. If the local callback cannot reach Forge, copy and paste the full callback URL from that attempt—not only its code—and select **Submit**.

An invalid or mismatched callback can prompt again so you can retry the current login. Completing xAI OAuth replaces any xAI API key stored in the same Settings slot. Saving a new xAI API key replaces stored OAuth.

## xAI device login

For a remote or headless backend, choose the device path when prompted. Open the displayed verification URL on another device, enter the displayed code, and leave Forge running while it waits for completion.

Forge refreshes stored xAI OAuth tokens when needed. If refresh or a retry no longer succeeds, start a new login to reauthorize.

## Cancel, Clear, and Remove

- **Cancel** aborts an active OAuth attempt. It does not remove an existing credential.
- **Clear** dismisses a completed or failed OAuth flow so you can start again. It does not clear saved auth.
- **Remove** deletes the credential stored on that Forge backend. It does not revoke access at the provider.

## Troubleshooting

- **Authorization URL does not open** — use **Copy URL**, or select and copy it manually if clipboard access is unavailable.
- **Callback submission fails** — paste the complete callback URL from the current attempt. Retry if Forge prompts again.
- **Device login expires** — start a new login to get a new code.
- **Authentication later fails** — retry, then reauthorize if automatic refresh cannot recover.
