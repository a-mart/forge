# Collaboration

Forge collaboration mode adds multi-user access on top of the existing backend. It uses one shared backend, a dedicated auth database, and a hidden system profile for channel-backed sessions.

## Storage model

| Item | Path | Notes |
|------|------|-------|
| System profile | `~/.forge/profiles/_collaboration/` | Hidden from Builder UI via `profileType: 'system'`. |
| Channel sessions | `~/.forge/profiles/_collaboration/sessions/` | Each channel is backed by one manager session under the `_collaboration` profile. |
| Auth database | `~/.forge/shared/config/collaboration/auth.db` | SQLite store for users, sessions, workspaces, channels, categories, and per-user read state. |
| Auth secret | `~/.forge/shared/config/collaboration/auth-secret.key` | Used when `FORGE_COLLABORATION_AUTH_SECRET` is not set. |
| Prompt overlays | `~/.forge/profiles/_collaboration/sessions/<sessionId>/context/prompt.md` | Channel prompt overlays live in the backing session context directory. |

The collaboration profile is system-managed. Builder snapshots and profile lists exclude it, but the backing sessions still live in the normal session tree under `_collaboration`.

## Authentication

Collaboration auth uses local accounts only. OAuth is deferred.

There are two roles:

- `admin` for full Builder access plus collaboration admin actions
- `member` for collaboration access only

The first admin is bootstrapped from environment variables. If collaboration is enabled and no admin exists yet, both `FORGE_ADMIN_EMAIL` and `FORGE_ADMIN_PASSWORD` must be present.

If `FORGE_COLLABORATION_AUTH_SECRET` is not set, Forge generates a 32-byte secret, writes it to `auth-secret.key`, and reuses that file on later starts.

## Endpoint model

Forge supports two deployment shapes:

### Same-origin

Builder and Collaboration share one backend. This is the simplest setup and works with local development defaults.

### Split deployment

Builder stays local, for example in Electron, while Collaboration runs on a remote origin.

Split deployment requires:

- `FORGE_COLLABORATION_BASE_URL` to use `https://`
- `FORGE_COLLABORATION_TRUSTED_ORIGINS` to list the Builder origins that may talk to the collaboration backend
- collaboration auth cookies to use `SameSite=None; Secure`

The collaboration auth routes are still served by the same backend. The base URL only changes the canonical browser origin used for redirects, invite links, and cookie handling.

## Architecture

- Each channel maps to one backing manager session under `_collaboration`.
- Collaboration uses a single workspace model.
- The collab surface reuses the Builder `MessageList` and `MessageInput` components.
- Worker visibility uses the shared `WorkerPillBar` and `WorkerQuickLook` pattern.
- Collaboration uses the same WebSocket transport layer as Builder, but the collab client connects separately and can point at a configured collaboration origin.

## Environment variables

| Variable | Purpose |
|----------|---------|
| `FORGE_COLLABORATION_ENABLED` | Enables collaboration mode. |
| `FORGE_ADMIN_EMAIL` / `FORGE_ADMIN_PASSWORD` | Bootstrap credentials for the first admin account. |
| `FORGE_COLLABORATION_BASE_URL` | Canonical collaboration UI base URL for login redirects and invite links. |
| `FORGE_COLLABORATION_AUTH_SECRET` | Auth secret. Generated automatically if omitted. |
| `FORGE_COLLABORATION_TRUSTED_ORIGINS` | Comma-separated Builder origins allowed in split deployment. |

See [docs/CONFIGURATION.md](CONFIGURATION.md) for the broader environment variable reference.
