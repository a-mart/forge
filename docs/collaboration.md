# Collaboration

Forge collaboration mode adds multi-user access on top of the public Forge repo. This repository ships the collaboration server/runtime target, the full UI, protocol types, and the Docker/self-host path, so collaboration can be deployed from this repo end to end. Collaboration uses a dedicated auth database, a hidden system profile, and session-backed channel actors.

## Storage model

| Item | Path | Notes |
|------|------|-------|
| System profile | `~/.forge/profiles/_collaboration/` | Hidden from Builder UI via `profileType: 'system'`. |
| Channel sessions | `~/.forge/profiles/_collaboration/sessions/` | Each channel is backed by one manager session under the `_collaboration` profile. |
| Auth database | `~/.forge/shared/config/collaboration/auth.db` | SQLite store for users, sessions, workspaces, channels, categories, and per-user read state. |
| Auth secret | `~/.forge/shared/config/collaboration/auth-secret.key` | Used when `FORGE_COLLABORATION_AUTH_SECRET` is not set. |
| Additional instructions | `~/.forge/profiles/_collaboration/sessions/<sessionId>/context/prompt.md` | Channel-level guidance remains in the backing session context directory. |
| Reference docs | `~/.forge/profiles/_collaboration/sessions/<sessionId>/reference/` | Channel reference docs live at the session root. Legacy `context/reference/` docs are read only when the root `reference/` directory is missing or empty, and are copied forward non-destructively on prompt access. |
| Global/shared specialists | `~/.forge/shared/specialists/<handle>.md` | Shared specialist definitions for both Builder and Collaboration. Built-ins are seeded here on startup. |
| Channel specialists | `~/.forge/profiles/_collaboration/sessions/<sessionId>/specialists/<handle>.md` | Channel-local specialist definitions are markdown files at the session root. Selected global specialist handles are stored in SQLite, not in this directory. |

The collaboration profile is system-managed. Builder snapshots and profile lists exclude it, but the backing sessions still live in the normal session tree under `_collaboration`.

## Specialist target spaces and selection state

Collaboration specialist definitions stay file-backed, while selection state is structured SQLite data. Specialist markdown uses the exact `TargetSpace` frontmatter key (`builder`, `collaboration`, or both). The key is case-sensitive when Forge writes files; legacy lowercase `targetSpace` is still accepted on read for compatibility, but new files should use `TargetSpace`.

`TargetSpace` controls where a specialist can appear:

- `TargetSpace: builder` means the specialist is available to normal Builder managers.
- `TargetSpace: collaboration` means the specialist is available to collaboration channel managers.
- `TargetSpace: [builder, collaboration]` makes one shared definition available in both surfaces.
- If `TargetSpace` is missing, Forge treats the file as Builder-only for legacy compatibility.

Forge ships two built-in specialist groups. Builder built-ins keep their normal handles and default to `TargetSpace: builder`. Collaboration built-ins use `collab-` prefixed handles, such as `collab-planner` and `collab-reviewer`, and default to `TargetSpace: collaboration`. Collaboration servers seed the union of Builder and Collaboration built-ins into `~/.forge/shared/specialists/`, but both the UI and runtime rosters filter by `TargetSpace`. A collaboration channel should only see specialists whose target space includes `collaboration`; Builder managers should only see specialists whose target space includes `builder`.

Global/shared specialist markdown lives in `~/.forge/shared/specialists/`. Channel-local specialist markdown lives in `~/.forge/profiles/_collaboration/sessions/<sessionId>/specialists/` and is always treated as collaboration-scoped. Category and channel selection state is stored in SQLite: category rows store default selected global specialist handles for newly created channels, and channel rows store active selected global specialist handles. Category defaults are templates only; changing a category's defaults does not rewrite existing channels. A `NULL` legacy value means Forge should fall back to/backfill the default collaboration specialist set. An explicit empty array (`[]`) means no global specialists are selected and must not fall back to defaults. Missing selected handles are surfaced as invalid/missing configuration, ignored by runtime roster resolution, and never silently deleted by migrations.

Collaboration skill selection is also structured state, but the skill definitions themselves stay file-backed. Category rows store the default skill selection copied into newly created channels, and channel rows store the active skill selection. V1 does not support channel-local skill authoring. For skills, `NULL` means load all available optional skills, while `[]` means an intentional custom empty selection. Always-on skills like `memory` remain loaded in both modes.

## Collaboration SQLite migration policy

Collaboration uses SQLite for structured state that needs transactional updates and startup migrations: workspace, category, and channel metadata; membership and per-user read state; and any persisted workspace, category, or channel selected-specialist handles and defaults.

User-authored content stays file-backed. Specialist markdown files, prompt bodies, and reference docs are written to disk and must not be replaced by SQLite rows or rewritten by migration code.

Migration policy for collaboration schema changes:

- Run migrations automatically at startup.
- Prefer additive schema changes whenever possible.
- Wrap each migration in a transaction.
- Make migrations idempotent and safe to rerun.
- Create a timestamped database backup before any non-trivial migration.
- Fail cleanly without leaving destructive partial state if a migration cannot complete.
- Never delete or overwrite user-authored files as part of a database migration.
- If an upgraded database references a missing specialist handle, surface that as missing or invalid config. Do not silently delete the handle or hide the problem by rewriting the record.

Fresh collaboration deployments should start from an empty `FORGE_DATA_DIR` or volume. Do not copy an existing Builder `~/.forge` directory into a collaboration server deployment.

Settings are contextual: Builder mode Settings configure the local backend, while Collab mode Settings connect to and configure the collaboration backend. Collab Settings are admin-only. A persistent banner appears when Settings is targeting a remote collaboration server so admins can tell they are editing the connected server rather than their local Builder backend. Provider auth entered there writes directly to the collaboration backend; it does not copy or share the local Builder auth file. Terminal settings are hidden in remote Collab Settings v1 and remain local-only.

Remote Collab Settings also includes member and invite management, plus password controls. Admins can manage members and invites, issue temporary-password resets that require a password change on next sign-in, and users can change their own password from the collaboration UI.

Channel and category settings expose per-channel guidance and reference docs. The former "prompt overlay" label is now **Additional instructions** for channel-level guidance.

## Authentication

Collaboration auth uses local accounts only. OAuth is deferred.

There are two roles:

- `admin` for full Builder access plus collaboration admin actions
- `member` for collaboration access only

The first admin is bootstrapped from environment variables. On a fresh deployment, if collaboration is enabled and no admin exists yet, both `FORGE_ADMIN_EMAIL` and `FORGE_ADMIN_PASSWORD` must be present.

If `FORGE_COLLABORATION_AUTH_SECRET` is not set, Forge generates a 32-byte secret, writes it to `auth-secret.key`, and reuses that file on later starts.

## Deployment shapes

Forge supports two deployment shapes:

### Public self-hosted collaboration server

The public repo ships the collaboration-server runtime and a Docker entry point. `Dockerfile` and `docker-compose.yml` build and run the collaboration server with the built UI served from the same origin. The container defaults to `FORGE_RUNTIME_TARGET=collaboration-server`, `FORGE_HOST=0.0.0.0`, `FORGE_PORT=47287`, and `FORGE_DATA_DIR=/var/lib/forge`.

The compose file bind-mounts persistent server data from `./.forge-collaboration-data` on the host to `/var/lib/forge` in the container so the files are directly visible and easy to back up. This host directory is gitignored and is not removed by `docker compose down`.

To avoid colliding with Forge's local/Electron production backend on `127.0.0.1:47287`, the default Docker host mapping is `http://127.0.0.1:47387` on the host while the container keeps listening on `47287` internally. Override the published host port with `FORGE_PUBLIC_PORT` if needed.

A first boot must provide `FORGE_ADMIN_EMAIL` and `FORGE_ADMIN_PASSWORD` so the initial admin account can be created. For local `docker compose` use, set `FORGE_COLLABORATION_BASE_URL=http://127.0.0.1:47387` by default, and update it if you change `FORGE_PUBLIC_PORT`. The shipped `docker-compose.yml` now defaults `FORGE_COLLABORATION_TRUSTED_ORIGINS` to `http://127.0.0.1:47188,http://127.0.0.1:47189` so local Forge UI/Electron dev and local preview can reach the Docker collaboration server without extra setup. Use `127.0.0.1` consistently for local HTTP split deployments; mixing `localhost` and `127.0.0.1` makes the auth cookies cross-site and therefore requires HTTPS. Hosted deployments should set `FORGE_COLLABORATION_BASE_URL` to the public browser URL for the collaboration server, and `FORGE_COLLABORATION_TRUSTED_ORIGINS` should list any Builder/UI origins that are allowed to talk to it in split deployments.

`FORGE_COLLABORATION_AUTH_SECRET` is optional. Leave it unset to let the server generate and persist a local secret in the data directory.

### Split Builder + collaboration deployment

Settings → Collaboration can also connect a local Builder client to a separately hosted collaboration server. In that setup, Builder stays local, while the collaboration service runs from this repo or from any deployment that exposes the collaboration runtime over HTTPS.

The Builder/Collab toggle lives in the sidebar header. When collaboration is enabled, the New Project action moves next to session search for quicker access.

## Remote sign-in flow

1. Open **Settings → Collaboration**.
2. Enter the collaboration server URL.
3. Click **Save** and **Test** to confirm the server is reachable.
4. Use the Builder/Collab toggle to open the collaboration surface. For configured remote servers, the toggle can open the collaboration sign-in surface before you are authenticated.
5. Sign in with the collaboration server admin or member email and password. After sign-in succeeds, the collaboration channels become available.

The collaboration status panel reports the configured collaboration server, not the local Builder backend. It reflects the enabled state and auth status of the connected collaboration service. If a collaboration session or socket is invalidated by a lifecycle change, the UI shows sign-in recovery instead of retrying forever or leaving the screen stuck loading.

Once connected, the main Settings surface switches context with the mode: Builder Settings continue to target the local backend, while Collab Settings target the collaboration backend. Only collaboration admins can access Collab Settings.

Hosted deployments use:

- `FORGE_COLLABORATION_BASE_URL` for the collaboration origin
- `FORGE_COLLABORATION_TRUSTED_ORIGINS` to list the Builder origins that may talk to the collaboration backend
- collaboration auth cookies with `SameSite=None; Secure`

The base URL changes the canonical browser origin used for invite links and cookie handling. In split deployments, collaboration auth pages redirect back to a trusted Builder/UI origin after login, invite redemption, password changes, and member flows. Untrusted browser origins are ignored.

## Architecture

- Each channel maps to one backing manager session under `_collaboration`.
- Channels are session-backed actors: the channel state and history live in the backing session, additional instructions stay at `context/prompt.md`, and injected channel reference docs live at session-root `reference/`.
- Collaboration uses a single workspace model.
- Workspace and category defaults include model/CWD plus category default selected global specialist handles for new channels.
- The collab surface reuses the Builder `MessageList` and `MessageInput` components.
- Worker visibility uses the shared `WorkerPillBar` and `WorkerQuickLook` pattern.
- Collaboration uses the same WebSocket transport layer as Builder, but the collab client connects separately to the configured collaboration origin.

## Environment variables

| Variable | Purpose |
|----------|---------|
| `FORGE_RUNTIME_TARGET` | Selects the runtime target. Use `builder` for the default local Builder backend or `collaboration-server` for the deployable collaboration runtime. |
| `FORGE_COLLABORATION_ENABLED` | Legacy compatibility flag. When `FORGE_RUNTIME_TARGET` is unset, `true` maps to `collaboration-server`. |
| `FORGE_ADMIN_EMAIL` / `FORGE_ADMIN_PASSWORD` | Bootstrap credentials for the first admin account on a fresh collaboration deployment. |
| `FORGE_COLLABORATION_BASE_URL` | Canonical collaboration UI base URL for login redirects and invite links. For local `docker compose`, use `http://127.0.0.1:47387` by default and keep it aligned with `FORGE_PUBLIC_PORT` if you override the host mapping. |
| `FORGE_COLLABORATION_AUTH_SECRET` | Auth secret. Generated automatically if omitted. |
| `FORGE_COLLABORATION_TRUSTED_ORIGINS` | Comma-separated Builder origins allowed in split deployment. Local docker-compose defaults this to `http://127.0.0.1:47188,http://127.0.0.1:47189`. |

See [docs/CONFIGURATION.md](CONFIGURATION.md) for the broader environment variable reference.
