# Trusted pilot collaboration deployment handoff

This handoff is for a separate Forge instance deploying one trusted-pilot Forge Collaboration server from the main Forge repository. It is self-contained and assumes no prior conversation context.

## Scope

Deploy a single `forge-collaboration-server` container for a trusted pilot. This is not a public or broad self-host rollout. Keep the server behind HTTPS plus network controls, or behind a trusted VPN/Tailscale boundary, and invite only trusted users.

The pilot readiness decision is conditional GO only when all of these are true:

- the deployment uses a fresh, dedicated collaboration data directory or Docker volume;
- non-local browser access goes through HTTPS;
- reverse proxy and network controls restrict exposure;
- users are trusted, because collaboration members can prompt AI/worker execution.

## Source repo

Use the main Forge repo:

```bash
git clone https://github.com/a-mart/forge.git
cd forge
```

If the checkout already exists:

```bash
cd /path/to/forge
git fetch origin
git checkout main
git pull --ff-only origin main
```

For Adam's local development machine, the current source of truth is `/Users/adam/repos/middleman`. Do not use `/Users/adam/repos/forge-collab`; that repo is stale historical reference and is not the current collaboration Docker/backend source.

## Compose service details

The primary Docker Compose service is `forge-collaboration-server` in `docker-compose.yml`.

Verified compose/runtime details:

- service name: `forge-collaboration-server`
- Dockerfile: `Dockerfile`
- container port: `47287`
- default host port: `${FORGE_PUBLIC_PORT:-47387}:47287`, so the default local URL is `http://127.0.0.1:47387`
- data bind mount: `./.forge-collaboration-data:/var/lib/forge`
- restart policy: `unless-stopped`
- build args:
  - `VITE_FORGE_WEB_BASE=same-origin`
  - `VITE_FORGE_DEFAULT_SURFACE=collab`
  - `VITE_FORGE_DISABLE_TANSTACK_DEVTOOLS=true`
- runtime environment set by compose:
  - `NODE_ENV=production`
  - `FORGE_HOST=0.0.0.0`
  - `FORGE_PORT=47287`
  - `FORGE_RUNTIME_TARGET=collaboration-server`
  - `FORGE_DATA_DIR=/var/lib/forge`
  - `FORGE_ADMIN_EMAIL=${FORGE_ADMIN_EMAIL:?set FORGE_ADMIN_EMAIL in your shell or .env}`
  - `FORGE_ADMIN_PASSWORD=${FORGE_ADMIN_PASSWORD:?set FORGE_ADMIN_PASSWORD in your shell or .env}`
  - `FORGE_COLLABORATION_BASE_URL=${FORGE_COLLABORATION_BASE_URL:-http://127.0.0.1:47387}`
  - `FORGE_COLLABORATION_AUTH_COOKIE_NAME=${FORGE_COLLABORATION_AUTH_COOKIE_NAME:-forge_collab_session}`
  - `FORGE_COLLABORATION_TRUSTED_ORIGINS=${FORGE_COLLABORATION_TRUSTED_ORIGINS:-http://127.0.0.1:47188,http://127.0.0.1:47189}`

The compose file also contains `forge-collaboration-server-secondary`, but it is under the `multi-backend-test` profile for local multi-backend UI validation only. Do not deploy or start the secondary service for a single-server trusted pilot.

## Required environment variables

Create a `.env` file in the repo root on the server. Use placeholders like these and replace them with deployment-specific values. Do not commit `.env`.

```dotenv
# Required for first boot only when no admin exists yet.
FORGE_ADMIN_EMAIL=admin@example.com
FORGE_ADMIN_PASSWORD='replace-with-a-long-random-password'

# Public browser URL for this collaboration server. Use https for non-local access.
FORGE_COLLABORATION_BASE_URL=https://collab.example.com

# Optional if serving the collab UI from the same origin only.
# Required when a separate Builder/UI origin will call this collaboration backend.
FORGE_COLLABORATION_TRUSTED_ORIGINS=https://forge.example.com

# Optional. Either set and back this up, or leave unset and back up
# .forge-collaboration-data/shared/config/collaboration/auth-secret.key.
FORGE_COLLABORATION_AUTH_SECRET='replace-with-at-least-32-random-bytes-or-a-long-random-string'

# Optional. Default is 47387 on the host.
FORGE_PUBLIC_PORT=47387
```

Variable notes:

| Variable | Required | Description |
| --- | --- | --- |
| `FORGE_ADMIN_EMAIL` | first boot | Email for the first admin account when the database has no admin yet. Changing it later does not change an existing admin. |
| `FORGE_ADMIN_PASSWORD` | first boot | Password for the first admin account when the database has no admin yet. Use a long generated password. Quote carefully if it contains `$`, `:`, `#`, spaces, or shell metacharacters. |
| `FORGE_COLLABORATION_BASE_URL` | yes for hosted pilot | Canonical browser URL used for login redirects, auth cookies, and invite links. Use the externally visible HTTPS URL behind the proxy. |
| `FORGE_COLLABORATION_TRUSTED_ORIGINS` | split UI only | Comma-separated Builder/UI origins allowed to talk to the collaboration server. Same-origin collab UI does not normally need a custom value. |
| `FORGE_COLLABORATION_AUTH_SECRET` | recommended or backup generated file | Auth secret. If omitted, Forge generates one at `shared/config/collaboration/auth-secret.key` inside the data directory. Back up whichever source is used. |
| `FORGE_COLLABORATION_AUTH_COOKIE_NAME` | no | Defaults to `forge_collab_session`. Only change it when multiple collaboration servers share one browser cookie scope. |
| `FORGE_PUBLIC_PORT` | no | Host port published to the server. Defaults to `47387`. |

Provider auth is not required in `.env` for first boot. After signing in as admin, configure OpenAI, Anthropic, xAI, Cursor SDK, or other provider credentials in remote Collab Settings. Those credentials are stored in the collaboration server data directory, not copied from local Builder settings. If the deployment intentionally uses environment-level provider keys, use the standard Forge provider variables such as `OPENAI_API_KEY`, `BRAVE_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`, or `CURSOR_API_KEY`, but prefer Collab Settings for the pilot unless there is an operational reason to keep them in server env.

## Data directory and isolation requirements

Use a fresh dedicated data mount for the collaboration server. With the shipped compose file this is:

```text
./.forge-collaboration-data -> /var/lib/forge
```

Do not use, copy, or bind-mount a Builder data directory such as `~/.forge` into the collaboration server. Do not seed the server from Adam's local Builder data. Data-dir fail-closed enforcement is not yet implemented, so the operator must ensure the mount is dedicated before first boot.

Back up at least these paths from `./.forge-collaboration-data`:

```text
shared/config/collaboration/auth.db
shared/config/collaboration/auth.db-shm
shared/config/collaboration/auth.db-wal
shared/config/collaboration/auth-secret.key   # if FORGE_COLLABORATION_AUTH_SECRET is unset
profiles/_collaboration/
shared/config/auth/
shared/config/secrets.json
shared/specialists/
swarm/agents.json
uploads/
```

If `FORGE_COLLABORATION_AUTH_SECRET` is supplied through deployment secrets instead of generated on disk, back up the deployment secret with the same care as the data directory. Losing or changing the auth secret can invalidate sessions and break cookie/session verification.

## Deployment sequence

1. Clone or update the main repo.

   ```bash
   git clone https://github.com/a-mart/forge.git
   cd forge
   # or, for an existing checkout:
   git pull --ff-only origin main
   ```

2. Create `.env` in the repo root.

   ```bash
   cp .env.example .env
   $EDITOR .env
   ```

   At minimum set `FORGE_ADMIN_EMAIL`, `FORGE_ADMIN_PASSWORD`, and hosted `FORGE_COLLABORATION_BASE_URL`.

3. Choose host port and reverse proxy shape.

   - Default local container publishing is host `47387` to container `47287`.
   - For a proxy on the same server, either proxy to `http://127.0.0.1:47387` or set `FORGE_PUBLIC_PORT` to another local port and keep the proxy upstream aligned.
   - Set `FORGE_COLLABORATION_BASE_URL` to the final browser URL, for example `https://collab.example.com`.

4. Confirm compose interpolation without printing secrets into logs or tickets.

   ```bash
   docker compose config >/tmp/forge-collab-compose.rendered.yml
   grep -A40 'forge-collaboration-server:' /tmp/forge-collab-compose.rendered.yml
   rm /tmp/forge-collab-compose.rendered.yml
   ```

   Verify the service, port, base URL, trusted origins, and volume. Avoid sharing the rendered file because it can include secrets.

5. Build the primary service.

   ```bash
   docker compose build forge-collaboration-server
   ```

6. Start the primary service only.

   ```bash
   docker compose up -d forge-collaboration-server
   ```

   Do not use `--profile multi-backend-test` for this pilot.

7. Check logs and health.

   ```bash
   docker compose logs -f forge-collaboration-server
   curl --noproxy '*' -i http://127.0.0.1:47387/api/health
   curl --noproxy '*' -i http://127.0.0.1:47387/api/collaboration/status
   ```

8. First admin login.

   Open `FORGE_COLLABORATION_BASE_URL` in a browser and sign in with `FORGE_ADMIN_EMAIL` and `FORGE_ADMIN_PASSWORD`. If the base URL is remote, use HTTPS.

9. Configure provider auth in remote Collab Settings.

   In the collaboration UI, open Settings while connected to the collaboration server. The Settings context should indicate it is targeting the remote collaboration backend. Configure provider credentials there.

10. Smoke test collaboration behavior.

    - create a category/channel;
    - create an invite;
    - redeem it as a member in a separate browser profile or incognito window;
      invite URLs are hosted pages at `/collaboration/invite/<token>` and depend on the frontend route that redeems against the same-origin public invite APIs;
    - send a message in the channel;
    - confirm the member can see channel history and that admin-only settings remain admin-only.

11. Restart persistence smoke.

    ```bash
    docker compose restart forge-collaboration-server
    curl --noproxy '*' -i http://127.0.0.1:47387/api/collaboration/status
    ```

    Sign back in or refresh the browser, confirm the channel, member, invite/member state, and provider settings persisted.

## HTTPS, reverse proxy, and network controls

Use HTTPS for any non-local browser access. Same-origin HTTPS is the safest pilot shape: serve the collab UI and API from the same public origin, for example `https://collab.example.com`.

The reverse proxy must preserve:

- `Host`
- `X-Forwarded-Proto`
- `X-Forwarded-Host` if your proxy uses it
- WebSocket upgrade headers (`Upgrade` and `Connection`)

Forge collaboration clients also emit a 25s `{type:"ping"}` WebSocket heartbeat, which helps reduce long-idle tunnel closes, but the proxy still needs to pass upgrades and keep sane tunnel/read timeouts.

Apply rate limits before the container for at least:

- `/api/auth/*`
- invite redemption endpoints
- password change/reset endpoints
- broad unsafe API methods such as repeated POST/PUT/PATCH/DELETE bursts

Tailscale, VPN, private subnet firewalling, or an IP allowlist is acceptable for a trusted pilot and is recommended. Do not expose the pilot as an unauthenticated public internet service without additional hardening.

Example Nginx-style proxy sketch, adjust to your environment:

```nginx
location / {
  proxy_pass http://127.0.0.1:47387;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header X-Forwarded-Host $host;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
}
```

## Validation commands

Local checks from the Docker host should use `--noproxy '*'` so localhost proxy environment variables do not interfere.

```bash
# Health
curl --noproxy '*' -i http://127.0.0.1:47387/api/health

# Collaboration readiness/status
curl --noproxy '*' -sS http://127.0.0.1:47387/api/collaboration/status | jq .

# Unauthenticated session state should be a 200 with authenticated:false
curl --noproxy '*' -sS http://127.0.0.1:47387/api/collaboration/me | jq .

# Sign-in request shape. Replace placeholders locally; do not paste real passwords into shared logs.
curl --noproxy '*' -i \
  -c /tmp/forge-collab.cookies \
  -H 'content-type: application/json' \
  -H 'origin: http://127.0.0.1:47387' \
  --data '{"email":"admin@example.com","password":"REPLACE_WITH_REAL_PASSWORD"}' \
  http://127.0.0.1:47387/api/auth/sign-in/email

# Authenticated session check with cookie jar.
curl --noproxy '*' -sS \
  -b /tmp/forge-collab.cookies \
  http://127.0.0.1:47387/api/collaboration/me | jq .
rm -f /tmp/forge-collab.cookies
```

For hosted HTTPS, use the public base URL and set the Origin header to that same origin:

```bash
BASE_URL=https://collab.example.com

curl -i "$BASE_URL/api/health"
curl -sS "$BASE_URL/api/collaboration/status" | jq .
curl -sS "$BASE_URL/api/collaboration/me" | jq .

curl -i \
  -c /tmp/forge-collab.cookies \
  -H 'content-type: application/json' \
  -H "origin: $BASE_URL" \
  --data '{"email":"admin@example.com","password":"REPLACE_WITH_REAL_PASSWORD"}' \
  "$BASE_URL/api/auth/sign-in/email"

curl -sS \
  -b /tmp/forge-collab.cookies \
  "$BASE_URL/api/collaboration/me" | jq .
rm -f /tmp/forge-collab.cookies
```

Expected status response on a ready collaboration server includes fields like:

```json
{
  "enabled": true,
  "adminExists": true,
  "ready": true,
  "bootstrapState": "ready",
  "workspaceExists": true,
  "workspaceDefaultsInitialized": true,
  "storageProfileExists": true,
  "storageRootSessionExists": true
}
```

## Accepted pilot risks and security caveats

These are accepted only for a trusted pilot:

- Admins are effectively server operators until a stricter allowlist/operator-boundary model is added. Admins can configure provider auth and manage users/invites.
- Members can prompt AI/worker execution through channels. Invite trusted users only.
- Data-dir fail-closed enforcement is not yet implemented. Operators must ensure the container uses a fresh dedicated collaboration mount and never Builder `~/.forge`.
- Missing-Origin/CSRF hardening is still pending. Keep the service behind HTTPS, trusted origins, rate limits, and trusted network controls.
- Provider credentials configured in remote Collab Settings belong to the collaboration server. Treat the collaboration data directory as sensitive.

## Troubleshooting

### Wrong or stale repo

If behavior does not match this handoff, confirm the deployment uses `https://github.com/a-mart/forge.git` and the main repo compose file. Do not use `/Users/adam/repos/forge-collab`.

```bash
git remote -v
git status --short
git rev-parse --show-toplevel
```

### Dotenv, Compose interpolation, and password special characters

Compose reads `.env` and interpolates values. Passwords with `$`, quotes, `#`, spaces, or backslashes can be misread if not quoted/escaped correctly. Prefer long generated passwords that avoid shell metacharacters for the initial pilot, or quote carefully.

Validate service rendering with:

```bash
docker compose config >/tmp/forge-collab-compose.rendered.yml
# Inspect locally only. This file may contain secrets.
rm /tmp/forge-collab-compose.rendered.yml
```

Do not paste rendered config into tickets or chat if it contains secrets.

### Localhost proxy interference

If local `curl` requests fail unexpectedly, bypass proxy env vars:

```bash
curl --noproxy '*' -i http://127.0.0.1:47387/api/health
```

### Wrong base URL, trusted origins, or cookie issues

Symptoms include login loops, cookies not sticking, failed redirects, or CORS/trusted-origin failures.

Check:

- `FORGE_COLLABORATION_BASE_URL` exactly matches the browser origin, including `https://` and port if any.
- For split UI/Builder deployments, `FORGE_COLLABORATION_TRUSTED_ORIGINS` includes the Builder/UI origin exactly.
- Do not mix `localhost` and `127.0.0.1` for local HTTP split deployments. That becomes cross-site for cookies and requires HTTPS.
- Hosted deployments should use HTTPS so collaboration cookies can use secure cross-site behavior when needed.
- Reverse proxy preserves `Host` and `X-Forwarded-Proto`.

### Admin already exists

`FORGE_ADMIN_EMAIL` and `FORGE_ADMIN_PASSWORD` bootstrap only the first admin on a fresh database. Changing `.env` after an admin exists does not reset that account.

For a fresh pilot with no valuable data, stop the container and move/remove `./.forge-collaboration-data`, then restart to bootstrap again. Do not delete production pilot data casually. For a real pilot with data, use the app's admin/member management path instead of resetting the volume.

### Secondary service accidentally started

If `forge-collaboration-server-secondary` is running, it was started with the `multi-backend-test` profile. Stop it for a single-server pilot:

```bash
docker compose stop forge-collaboration-server-secondary
```

Confirm only the primary is running:

```bash
docker compose ps
```

## Backup, rollback, and upgrade basics

### Backup

Before upgrades or risky config changes:

```bash
docker compose stop forge-collaboration-server
STAMP=$(date +%Y%m%d-%H%M%S)
tar -czf "forge-collab-data-$STAMP.tgz" .forge-collaboration-data
# If auth secret is supplied outside the data dir, back up that deployment secret separately.
docker compose up -d forge-collaboration-server
```

For online backups, make sure SQLite WAL files (`auth.db-wal` and `auth.db-shm`) are included. A stopped-container backup is simpler and safer for the pilot.

### Rollback

To roll back code:

```bash
git checkout <known-good-commit-or-tag>
docker compose build forge-collaboration-server
docker compose up -d forge-collaboration-server
```

If a data migration ran and rollback requires data rollback, stop the container and restore the matching data tarball. Do not pair old code with a newer migrated data directory unless the migration is known to be backward compatible.

### Upgrade

```bash
git fetch origin
git checkout main
git pull --ff-only origin main
docker compose build forge-collaboration-server
docker compose up -d forge-collaboration-server
curl --noproxy '*' -sS http://127.0.0.1:47387/api/collaboration/status | jq .
```

After upgrade, run the browser smoke tests again: admin login, channel load, member access, provider settings visibility, and restart persistence if the upgrade touched persistence/auth/collaboration code.

## Final checklist for the deployment Forge instance

- [ ] Confirm repo is `https://github.com/a-mart/forge.git`, not `/Users/adam/repos/forge-collab`.
- [ ] Confirm only `forge-collaboration-server` is deployed; no `multi-backend-test` secondary service.
- [ ] Create fresh dedicated `./.forge-collaboration-data` mount and verify it is not copied from Builder `~/.forge`.
- [ ] Set `FORGE_ADMIN_EMAIL` and `FORGE_ADMIN_PASSWORD` for first boot.
- [ ] Set `FORGE_COLLABORATION_BASE_URL` to the final HTTPS browser URL.
- [ ] Set `FORGE_COLLABORATION_TRUSTED_ORIGINS` if a split Builder/UI origin will call the server.
- [ ] Decide whether to set `FORGE_COLLABORATION_AUTH_SECRET`; if not, plan to back up generated `auth-secret.key`.
- [ ] Configure reverse proxy with `Host`, `X-Forwarded-Proto`, and WebSocket upgrades.
- [ ] Add rate limits for auth, invite, password, and broad unsafe API paths.
- [ ] Restrict network exposure with VPN/Tailscale/firewall/IP allowlist for the trusted pilot.
- [ ] Run `docker compose build forge-collaboration-server`.
- [ ] Run `docker compose up -d forge-collaboration-server`.
- [ ] Validate `/api/health`, `/api/collaboration/status`, sign-in, and `/api/collaboration/me`.
- [ ] Log in as first admin.
- [ ] Configure provider auth in remote Collab Settings.
- [ ] Create channel, invite a member, redeem invite, send message, and confirm member/admin boundaries.
- [ ] Restart the container and confirm state persists.
- [ ] Take and verify an initial backup of `.forge-collaboration-data` plus any external auth secret.
