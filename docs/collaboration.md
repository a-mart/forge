# Collaboration

Forge collaboration mode adds multi-user access on top of the existing Builder UI. The public Forge repo includes the collaboration client UI and protocol types only; the collaboration server/backend is closed-source, lives in the private `a-mart/forge-collab` repo, and cannot be self-hosted from this repo. Collaboration uses a dedicated auth database and a hidden system profile for channel-backed sessions.

## Storage model

| Item | Path | Notes |
|------|------|-------|
| System profile | `~/.forge/profiles/_collaboration/` | Hidden from Builder UI via `profileType: 'system'`. |
| Channel sessions | `~/.forge/profiles/_collaboration/sessions/` | Each channel is backed by one manager session under the `_collaboration` profile. |
| Auth database | `~/.forge/shared/config/collaboration/auth.db` | SQLite store for users, sessions, workspaces, channels, categories, and per-user read state. |
| Auth secret | `~/.forge/shared/config/collaboration/auth-secret.key` | Used when `FORGE_COLLABORATION_AUTH_SECRET` is not set. |
| Additional instructions | `~/.forge/profiles/_collaboration/sessions/<sessionId>/context/prompt.md` | Channel-level additional instructions live in the backing session context directory. |

The collaboration profile is system-managed. Builder snapshots and profile lists exclude it, but the backing sessions still live in the normal session tree under `_collaboration`.

Fresh collaboration backend deployments should start from an empty `FORGE_DATA_DIR` or volume. Do not copy a local Builder `~/.forge` directory into the collaboration server.

Settings are contextual: Builder mode Settings configure the local backend, while Collab mode Settings connect to and configure the remote collaboration backend. Collab Settings are admin-only. Provider auth entered there writes directly to the remote collaboration backend; it does not copy or share the local Builder auth file. Terminal settings are hidden in remote Collab Settings v1 and remain local-only.

Remote Collab Settings also includes member and invite management, plus password controls. Admins can manage members and invites, issue temporary-password resets that require a password change on next sign-in, and users can change their own password from the collaboration UI.

Channel and category settings include **AI Role** selectors. Categories define a default AI role, and channels inherit that default when created unless a channel-specific role is selected. The former "prompt overlay" label is now **Additional instructions** for channel-level guidance.

## Authentication

Collaboration auth uses local accounts only. OAuth is deferred.

There are two roles:

- `admin` for full Builder access plus collaboration admin actions
- `member` for collaboration access only

The first admin is bootstrapped from environment variables. If collaboration is enabled and no admin exists yet, both `FORGE_ADMIN_EMAIL` and `FORGE_ADMIN_PASSWORD` must be present.

If `FORGE_COLLABORATION_AUTH_SECRET` is not set, Forge generates a 32-byte secret, writes it to `auth-secret.key`, and reuses that file on later starts.

## Endpoint model

Forge supports two deployment shapes:

### Hosted collaboration server

Settings → Collaboration connects the Builder client to a separately hosted collaboration server. Builder stays local, for example in Electron, while the collaboration service runs from the private `a-mart/forge-collab` deployment.

This is the only supported deployment shape for the public Forge repository. The public repo does not contain the collaboration backend implementation.

## Remote sign-in flow

1. Open **Settings → Collaboration**.
2. Enter the remote collaboration server URL.
3. Click **Save** and **Test** to confirm the server is reachable.
4. Sign in with the remote collaboration server admin or member email and password.
5. After sign-in succeeds, the Builder/Collab toggle becomes available in the UI.

The collaboration status panel reports the configured remote server, not the local Builder backend. It reflects the enabled state and auth status of the connected collaboration service. If a collaboration session or socket is invalidated by a lifecycle change, the public UI shows sign-in recovery instead of retrying forever or leaving the screen stuck loading.

Once connected, the main Settings surface switches context with the mode: Builder Settings continue to target the local backend, while Collab Settings target the remote collaboration backend. Only collaboration admins can access Collab Settings.

The Builder/Collab toggle lives in the sidebar header. When collaboration is enabled, the New Project action moves next to session search for quicker access.

Hosted deployment uses:

- `FORGE_COLLABORATION_BASE_URL` for the collaboration origin
- `FORGE_COLLABORATION_TRUSTED_ORIGINS` to list the Builder origins that may talk to the collaboration backend
- collaboration auth cookies with `SameSite=None; Secure`

The base URL changes the canonical browser origin used for invite links and cookie handling. In split deployments, collaboration auth pages redirect back to a trusted Builder/UI origin after login, invite redemption, password changes, and member flows. Untrusted browser origins are ignored.

## Architecture

- Each channel maps to one backing manager session under `_collaboration`.
- Collaboration uses a single workspace model.
- The collab surface reuses the Builder `MessageList` and `MessageInput` components.
- Worker visibility uses the shared `WorkerPillBar` and `WorkerQuickLook` pattern.
- Collaboration uses the same WebSocket transport layer as Builder, but the collab client connects separately to the configured collaboration origin.

## Environment variables

| Variable | Purpose |
|----------|---------|
| `FORGE_COLLABORATION_ENABLED` | Enables collaboration mode. |
| `FORGE_ADMIN_EMAIL` / `FORGE_ADMIN_PASSWORD` | Bootstrap credentials for the first admin account. |
| `FORGE_COLLABORATION_BASE_URL` | Canonical collaboration UI base URL for login redirects and invite links. |
| `FORGE_COLLABORATION_AUTH_SECRET` | Auth secret. Generated automatically if omitted. |
| `FORGE_COLLABORATION_TRUSTED_ORIGINS` | Comma-separated Builder origins allowed in split deployment. |

See [docs/CONFIGURATION.md](CONFIGURATION.md) for the broader environment variable reference.
