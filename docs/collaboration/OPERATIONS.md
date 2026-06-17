# Collaboration Operations

This is the canonical operator runbook for the current Forge collaboration server.

## Supported topology and security posture

The supported deployment is a dedicated collaboration server built from this repo and run with `FORGE_RUNTIME_TARGET=collaboration-server`. Use a dedicated data directory or volume. Do not point a collaboration server at a normal Builder `~/.forge` directory.

For any internet-facing deployment, put the server behind managed HTTPS and strong network controls. A raw public container port is not the intended security boundary. Trusted pilot deployments should use HTTPS plus access controls, or a trusted VPN/Tailscale boundary.

## Docker/Compose contract

`docker-compose.yml` defines the primary service:

| Item | Value |
|------|-------|
| Service | `forge-collaboration-server` |
| Runtime target | `FORGE_RUNTIME_TARGET=collaboration-server` |
| Container bind | `FORGE_HOST=0.0.0.0`, `FORGE_PORT=47287` |
| Host port | `${FORGE_PUBLIC_PORT:-47387}:47287` |
| Data mount | `./.forge-collaboration-data:/var/lib/forge` |
| Container data dir | `FORGE_DATA_DIR=/var/lib/forge` |
| UI | Built UI served from the same origin |

A secondary local-only service, `forge-collaboration-server-secondary`, is behind the `multi-backend-test` compose profile. It publishes `47388` by default and mounts `./.forge-collaboration-data-secondary`. Use it only for multi-backend UI validation.

## Environment variables

Required for first boot of a fresh collaboration deployment:

| Variable | Purpose |
|----------|---------|
| `FORGE_ADMIN_EMAIL` | Email for the initial admin account. |
| `FORGE_ADMIN_PASSWORD` | Password for the initial admin account. |

Common collaboration variables:

| Variable | Purpose |
|----------|---------|
| `FORGE_RUNTIME_TARGET` | Use `collaboration-server` for the collaboration backend. |
| `FORGE_DATA_DIR` | Dedicated server data directory. Compose sets `/var/lib/forge`. |
| `FORGE_COLLABORATION_BASE_URL` | Canonical browser URL used for login redirects and invite links. |
| `FORGE_COLLABORATION_TRUSTED_ORIGINS` | Comma-separated Builder/UI origins allowed in split deployments. |
| `FORGE_COLLABORATION_AUTH_SECRET` | Optional auth secret. If omitted, the server generates and persists one. |
| `FORGE_COLLABORATION_AUTH_COOKIE_NAME` | Optional cookie name. Defaults to `forge_collab_session`; use a different value for same-host multi-backend testing. |
| `FORGE_PUBLIC_PORT` | Optional compose host port for the primary server. Defaults to `47387`. |

See [../CONFIGURATION.md](../CONFIGURATION.md) for the broader environment reference.

## Data directory and backup inventory

Back up the whole dedicated collaboration data directory. That is the authoritative procedure because collaboration state spans SQLite, the Forge agent registry, and file-backed session/content directories.

High-value paths to verify in the backup include:

```text
${FORGE_DATA_DIR}/shared/config/collaboration/auth.db
${FORGE_DATA_DIR}/shared/config/collaboration/auth-secret.key
${FORGE_DATA_DIR}/shared/config/auth/
${FORGE_DATA_DIR}/shared/config/secrets.json
${FORGE_DATA_DIR}/swarm/agents.json
${FORGE_DATA_DIR}/shared/specialists/
${FORGE_DATA_DIR}/profiles/_collaboration/
${FORGE_DATA_DIR}/skills/
${FORGE_DATA_DIR}/profiles/*/pi/skills/
${FORGE_DATA_DIR}/agent/skills/
${FORGE_DATA_DIR}/agent/manager/skills/
```

`${FORGE_DATA_DIR}/swarm/agents.json` stores Forge profile/session descriptors, including the `_collaboration` profile/root descriptors and channel backing manager descriptors. Losing it can orphan SQLite channel rows because `backingSessionAgentId` must resolve to a valid collaboration manager descriptor.

`${FORGE_DATA_DIR}/skills/` stores user-created global Forge skills. `${FORGE_DATA_DIR}/profiles/*/pi/skills/` stores profile/project-scoped Pi skills. `${FORGE_DATA_DIR}/agent/skills/` and `${FORGE_DATA_DIR}/agent/manager/skills/` store Pi-discovered global worker/manager skills. Collaboration v1 selected-skill state stores global handles plus always-on `memory`; these paths are backup inventory for file-backed definitions, not evidence of channel-local skill authoring.

If `FORGE_COLLABORATION_AUTH_SECRET` is supplied outside the data directory, back up the external secret source too.

## First deployment sequence

1. Clone this repo on the deployment host.
2. Create a `.env` or shell environment with `FORGE_ADMIN_EMAIL`, `FORGE_ADMIN_PASSWORD`, and the public `FORGE_COLLABORATION_BASE_URL`.
3. Set `FORGE_COLLABORATION_TRUSTED_ORIGINS` if Builder/UI is served from a different origin.
4. Start the primary service:

   ```bash
   docker compose up -d forge-collaboration-server
   ```

5. Check liveness:

   ```bash
   curl -fsS http://127.0.0.1:47387/api/health
   ```

6. Check readiness:

   ```bash
   curl -fsS http://127.0.0.1:47387/api/collaboration/status
   ```

   The JSON response is ready only when `ready === true` and bootstrap is ready.

7. Sign in with the bootstrapped admin account.
8. Configure provider auth in Collaboration settings on that backend.
9. Create a test category/channel and send a message.
10. Take an initial backup of the data directory.

## Upgrade and rollback

Before upgrading:

1. Stop writes if possible.
2. Back up the dedicated collaboration data directory.
3. Record the current git SHA and image/container version.
4. Review migration changes under `apps/backend/src/collaboration/auth/migrations.ts` and related collaboration DB code.

Upgrade:

```bash
git pull --ff-only
docker compose build forge-collaboration-server
docker compose up -d forge-collaboration-server
```

Rollback uses the recorded prior code/image plus the pre-upgrade data backup when schema or data migrations changed. Do not downgrade a migrated production database without either a verified compatibility path or a restored backup.

## Health, readiness, and validation

| Check | Command | Meaning |
|-------|---------|---------|
| Liveness | `curl -fsS <base>/api/health` | Process is serving HTTP. |
| Collaboration readiness | `curl -fsS <base>/api/collaboration/status` | Collaboration services are enabled and bootstrap-ready when JSON `ready === true`. |
| Compose config | `docker compose config` | Render env/ports/mounts before deployment. |
| Logs | `docker compose logs -f forge-collaboration-server` | Startup, migration, auth, runtime errors. |

Validation after deploy:

- Sign in as admin.
- Confirm Collaboration settings target banner shows the collaboration backend.
- Confirm provider auth is configured on the collaboration backend.
- Create or open a channel.
- Send a message and watch transcript/status updates.
- Leave the channel open long enough to confirm the WebSocket stays connected through the proxy.

## Reverse proxy guidance

### HAProxy

For WebSocket reliability, set tunnel timeout in `defaults`, `listen`, or `backend`, not `frontend`:

```haproxy
defaults
  mode http
  timeout connect 10s
  timeout client  60s
  timeout server  60s
  timeout tunnel  1h
```

Forward the collaboration backend with preserved host/proto headers and WebSocket upgrade support:

```haproxy
backend forge_collaboration
  mode http
  option httpchk GET /api/health
  http-request set-header X-Forwarded-Proto https
  http-request set-header X-Forwarded-Host %[req.hdr(Host)]
  server forge_collab 127.0.0.1:47387 check
```

Preserve `Host`. Set `X-Forwarded-Proto` and `X-Forwarded-Host`. Pass `Upgrade` and `Connection` through for WebSockets. `/api/health` is liveness only. `/api/collaboration/status` is readiness only when JSON `ready === true`.

Health polling does not keep WebSocket tunnels alive. The current client sends a 25 second `{ type: "ping" }` heartbeat, but the proxy tunnel timeout still must be long enough for active collaboration sessions.

### Nginx

Keep Nginx configuration equivalent if used:

```nginx
proxy_http_version 1.1;
proxy_set_header Host $host;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-Host $host;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
proxy_read_timeout 1h;
proxy_send_timeout 1h;
```

## Troubleshooting

### Auth, cookies, and origin errors

- Keep `FORGE_COLLABORATION_BASE_URL` aligned with the browser URL users actually open.
- In split deployments, include Builder/UI origins in `FORGE_COLLABORATION_TRUSTED_ORIGINS`.
- For local HTTP testing, use `127.0.0.1` consistently. Mixing `localhost` and `127.0.0.1` makes cookies cross-site and can require HTTPS cookie semantics.
- Use a distinct `FORGE_COLLABORATION_AUTH_COOKIE_NAME` only when multiple same-host collaboration servers need independent sessions.

### Missing provider auth

Provider credentials entered in local Builder settings do not automatically apply to collaboration. Open Collaboration settings for the selected backend and configure provider auth there.

### WebSocket disconnects behind a proxy

- Confirm Upgrade/Connection headers pass through.
- Confirm `timeout tunnel 1h` or equivalent is set in the right HAProxy section.
- Confirm health polling is not being mistaken for WebSocket keepalive.
- Check browser devtools for close codes and backend logs for auth/session invalidation.

### Secondary service isolation

The secondary compose service is only for local multi-backend testing. It must use separate host port, data mount, base URL, and cookie name from the primary service. Do not deploy it for a normal single-server collaboration environment.
