# Collaboration

Forge collaboration mode adds multi-user access on top of the existing Builder UI. The public Forge repo includes the collaboration client UI and protocol types only; the collaboration server/backend is closed-source, lives in the private `a-mart/forge-collab` repo, and cannot be self-hosted from this repo. Collaboration uses a dedicated auth database and a hidden system profile for channel-backed sessions.

## Storage model

| Item | Path | Notes |
|------|------|-------|
| System profile | `~/.forge/profiles/_collaboration/` | Hidden from Builder UI via `profileType: 'system'`. |
| Channel sessions | `~/.forge/profiles/_collaboration/sessions/` | Each channel is backed by one manager session under the `_collaboration` profile. |
| Auth database | `~/.forge/shared/config/collaboration/auth.db` | SQLite store for users, sessions, workspaces, channels, categories, and per-user read state. |
| Auth secret | `~/.forge/shared/config/collaboration/auth-secret.key` | Used when `FORGE_COLLABORATION_AUTH_SECRET` is not set. |
| Prompt overlays | `~/.forge/profiles/_collaboration/sessions/<sessionId>/context/prompt.md` | Channel prompt overlays live in the backing session context directory. |

The collaboration profile is system-managed. Builder snapshots and profile lists exclude it, but the backing sessions still live in the normal session tree under `_collaboration`.

Fresh collaboration backend deployments should start from an empty `FORGE_DATA_DIR` or volume. Do not copy a local Builder `~/.forge` directory into the collaboration server.

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

The collaboration status panel reports the configured remote server, not the local Builder backend. It reflects the enabled state and auth status of the connected collaboration service.

Hosted deployment uses:

- `FORGE_COLLABORATION_BASE_URL` for the collaboration origin
- `FORGE_COLLABORATION_TRUSTED_ORIGINS` to list the Builder origins that may talk to the collaboration backend
- collaboration auth cookies with `SameSite=None; Secure`

The base URL changes the canonical browser origin used for redirects, invite links, and cookie handling.

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
