# Remote Projects

## 1. Overview and terminology

**Remote Projects** lets a Forge Builder client open and operate normal Builder projects that live on a collaboration server. Remote projects appear alongside local projects in the unified Builder sidebar. They are not a third application mode, and they are not Collaboration channels.

The user-facing name is **Remote Projects**. Some implementation and persistence names still use `remote-build` or `remoteBuild` for compatibility; do not expose **Remote Build** as the product name.

A remote project is authoritative on the selected server:

- its profile, sessions, files, Git repository, terminals, attachments, and agent execution stay on that server
- the client does not clone or synchronize the project into the local Builder data directory
- selecting a remote row changes the active origin for supported project surfaces
- leaving the server disconnected does not create a local fallback copy

Collaboration channels remain session-backed channels under the server's hidden `_collaboration` profile and use the Collaboration surface. Remote Projects use the server's normal Builder profiles and sessions.

## 2. Topology and the two controls

Remote Projects requires both a server policy and a client preference.

### Server policy

The collaboration server persists instance policy at:

```text
${FORGE_DATA_DIR}/shared/config/remote-build-settings.json
```

Defaults are:

```json
{
  "enabled": false,
  "terminalsEnabled": true,
  "instanceName": null
}
```

- `enabled` is the member-facing Remote Projects kill switch.
- `terminalsEnabled` controls whether members can create/manage remote terminals and obtain new terminal tickets. It is independent of `enabled` and defaults to `true`, so operators should choose it explicitly before or when enabling Remote Projects.
- `instanceName` is the display name advertised in the public instance handshake. `null` falls back to the server host name.

The admin-only `GET` and partial `PUT` endpoint is:

```text
/api/settings/remote-build
```

A partial `PUT` leaves omitted fields unchanged. There is currently no server admin UI. Collaboration-server deployments may optionally set Forge-only environment overrides:

- `FORGE_REMOTE_PROJECTS_ENABLED`
- `FORGE_REMOTE_PROJECTS_TERMINALS_ENABLED`
- `FORGE_REMOTE_PROJECTS_INSTANCE_NAME`

Unset or whitespace-only values are absent. Boolean forms are `1`/`true`/`yes`/`on` and `0`/`false`/`no`/`off` (trim, case-insensitive). Invalid nonblank booleans and trimmed instance names longer than 120 characters fail collaboration startup. There are no `MIDDLEMAN_*` aliases. Per field, a valid env value wins over the persisted JSON and defaults, and env values are never written into `remote-build-settings.json`. Removing an env override and restarting reveals latent persisted values. `GET /api/settings/remote-build` returns effective `settings`, `persistedSettings`, and per-field `sources` (`environment` or `settings`). A `PUT` that includes any env-controlled field is rejected with HTTP 409 and code `REMOTE_BUILD_SETTINGS_ENV_OVERRIDE` (no file change). Env changes require a restart. Prefer the authenticated admin API for day-to-day changes when env overrides are absent; do not edit the JSON file while the server is running.

Treat `instanceName` (including the env override) as public handshake metadata. `terminalsEnabled: false` denies subsequent member terminal lifecycle mutations and ticket issuance but does not close an already attached terminal WebSocket.

### Client preference

Each configured remote collaboration connection has a browser-local `remoteProjectsEnabled` preference in the collaboration connection registry. When it is on, the client probes that connection and, if the server supports it, creates a remote origin for the unified Builder sidebar.

This preference is presentation and connection state only. It is **not** an authorization or security control. Turning it off removes that origin from this browser; it does not change server policy, revoke sessions, stop agents, or affect another browser. A newly added connection is opted in automatically only when its successful **Test** response advertised Remote Projects support; adding an untested/unsupported connection or updating an existing connection does not silently enable it.

### Activation flow

```text
server enabled policy
        +
client connection remoteProjectsEnabled
        +
authenticated compatible client
        ↓
remote origin in unified Builder sidebar
```

The client first probes `/api/collaboration/status`, checks the Builder protocol version and `remoteBuild` capability, probes `/api/collaboration/me`, and then opens the origin WebSocket.

## 3. Operator enablement with the admin API

Before enabling Remote Projects:

1. Deploy the collaboration server behind HTTPS or a trusted private network boundary.
2. Mount the intended workspaces and set `FORGE_CWD_ALLOWLIST_ROOTS`; remote directory selection fails closed when the allowlist is empty.
3. Review every member as a trusted operator. There are no per-project ACLs.
4. Decide whether members need terminal access. Prefer `terminalsEnabled: false` initially and enable it only after reviewing the trust boundary.
5. Choose a non-sensitive `instanceName`, because status metadata is public to clients that can reach the server.

The following example signs in as an existing collaboration admin, verifies the current policy, and enables Remote Projects with terminals explicitly disabled. Replace the URL and credentials; protect and remove the temporary cookie jar.

```bash
REMOTE_BASE_URL="https://forge.example.com"
COOKIE_JAR="$(mktemp)"
trap 'rm -f "$COOKIE_JAR"' EXIT

curl --fail-with-body --silent --show-error \
  --cookie-jar "$COOKIE_JAR" \
  --header 'content-type: application/json' \
  --data '{"email":"admin@example.com","password":"REPLACE_ME","rememberMe":true}' \
  "$REMOTE_BASE_URL/api/auth/sign-in/email" >/dev/null

curl --fail-with-body --silent --show-error \
  --cookie "$COOKIE_JAR" \
  "$REMOTE_BASE_URL/api/settings/remote-build"

curl --fail-with-body --silent --show-error \
  --cookie "$COOKIE_JAR" \
  --request PUT \
  --header 'content-type: application/json' \
  --data '{"enabled":true,"terminalsEnabled":false,"instanceName":"Engineering Forge"}' \
  "$REMOTE_BASE_URL/api/settings/remote-build"
```

Avoid putting a real password in shared shell history. An operator may instead use an already authenticated admin session or an API client that reads credentials from a protected source.

Re-run the `GET` after the update and confirm `enabled`, `terminalsEnabled`, and `instanceName`. The public `/api/collaboration/status` response should then advertise `capabilities.remoteBuild: true`.

## 4. Client setup, sign-in, and selection

On each Builder client:

1. Open **Settings → Collaboration** and select **Add connection**.
2. Enter the remote server URL, select **Test**, and then select **Add**.
3. Sign in to that connection with a collaboration account.
4. When the server advertises Remote Projects support, confirm **Remote projects** is on for that connection. A new successfully tested connection may already be opted in automatically.
5. Return to Builder and select a nested remote session row to make that server the active origin. The blue, globe-marked project header expands or collapses its sessions; nested session rows use status dots.

Remote Projects remain in the unified Builder sidebar; the Builder/Collaboration switch still means Builder projects versus Collaboration channels. Remote project rows do not create another mode. Clicking a project header expands or collapses it rather than selecting a conversation. Header actions are limited: **Change Working Directory** opens the server directory browser, while local rename, archive, delete, fork, and model actions remain absent.

An enabled connection can render these origin states even when it has no project row:

- connecting
- sign-in required
- unreachable
- update Forge to connect (server protocol is newer than the client supports)
- Remote Projects disabled on the server
- connected with no remote projects yet

Selecting a remote session row makes that server the active origin for the supported project surfaces. Selecting a local session row switches those surfaces back to the local origin.

The unified project order is owned by the local Builder backend in:

```text
${LOCAL_FORGE_DATA_DIR}/shared/config/builder-sidebar-order.json
```

It records local and remote `(originId, profileId)` anchors. Offline or browser-hidden remote anchors are retained so reconnecting or re-enabling a connection restores its position rather than silently deleting it from the order.

## 5. Supported and local-only surfaces

The active origin determines the backend for these project-scoped surfaces:

| Active-origin surface | Remote behavior |
|---|---|
| Chat and agent execution | Messages, choices, workers, session lifecycle, and execution use the remote server. |
| Files | Reads and permitted file mutations use the remote project CWD. |
| Git / Source Control | Status, history, diffs, branches, fetch/pull, and other allowed operations run on the remote repository. |
| Terminals | Terminal state and PTYs run remotely; member lifecycle/ticket access also depends on `terminalsEnabled`. |
| Attachments | Upload/download requests and stored attachment data use the remote server. |
| Session Audit | Audit reads target the active remote session. |
| Model availability | Project/session model pickers read availability from the active remote server. |

Remote New Project and Change Working Directory use the server directory browser and only allow paths under `FORGE_CWD_ALLOWLIST_ROOTS`. There is no local native directory picker for a remote origin.

These surfaces remain local even while a remote project is selected:

- non-chat Settings
- Stats
- Archive
- onboarding
- Cortex
- sidebar provider-usage data
- the unified sidebar-order API and persistence

Do not infer support from a mounted backend route. Remote Projects is an explicitly allowlisted subset of Builder behavior. Collaboration channels have a different protocol and feature boundary.

## 6. Access and trust model

Remote Projects is designed for a small set of trusted operators, not mutually untrusted tenants.

- Active members receive broad read and write Builder allowlists only while server `enabled` is `true`.
- Admins pass the member policy gate and retain admin-only access.
- Anything not explicitly classified for members falls back to admin-only.
- There is no per-project or per-path member ACL. An enabled member can see and operate the server's exposed normal Builder projects, subject to the route/command allowlists and CWD selection roots.
- File writes, Git mutations, agent execution, project resources, and especially terminals can become shell-equivalent powers over mounted workspaces and credentials available to the server process.

`FORGE_CWD_ALLOWLIST_ROOTS` limits directory selection; it is not a tenant sandbox or a replacement for OS/container isolation. Use separate server instances or operating-system boundaries when users should not trust one another.

`terminalsEnabled: false` denies new member terminal lifecycle mutations and ticket issuance. It does **not** terminate an already attached terminal WebSocket. Disable terminal access before granting membership where possible, and treat an already issued/attached terminal connection as live until it disconnects or is otherwise closed.

### Current live-revocation limitations

These are current limitations, not security promises:

- Changing `enabled` to `false` denies subsequent member Builder commands and HTTP requests, but it does not disconnect existing WebSockets or remove existing subscriptions. A subscribed socket may continue receiving server events until it disconnects.
- Ordinary sign-out or natural session expiry does not revalidate an already authenticated WebSocket. The socket retains its connection-time auth context until disconnect.
- Admin actions that disable or delete a user, change a user's role, or reset a user's password explicitly close that user's tracked sockets with close code `4001`; the client returns to sign-in-required state.

For urgent containment, combine policy disablement with account disablement/deletion or password reset, and close/restart the relevant network connections or server if necessary.

## 7. Authentication, sessions, and cookies

Remote Projects uses the collaboration server's Better Auth email/password session.

- Sessions use a 21-day sliding lifetime.
- Active sessions can refresh at most once per day (`updateAge` is one day).
- The Forge sign-in client sends `rememberMe: true`.
- The default cookie name is `forge_collab_session`.

HTTP cookies are scoped by host/domain and path, **not by port**. Multiple collaboration backends on the same hostname but different ports must use distinct `FORGE_COLLABORATION_AUTH_COOKIE_NAME` values, including their auxiliary cookie namespaces.

Browser requests must also satisfy the collaboration origin policy:

- Set `FORGE_COLLABORATION_BASE_URL` to the canonical browser-facing server origin.
- Add split Builder/UI origins to `FORGE_COLLABORATION_TRUSTED_ORIGINS`.
- Same-site deployments use `SameSite=Lax`; cross-site browser auth requires HTTPS and uses `SameSite=None; Secure`.
- CORS accepts only the request origin itself or configured trusted browser origins.
- For local HTTP testing, use `127.0.0.1` consistently rather than mixing it with `localhost`.

A valid cookie authorizes the initial HTTP probes and WebSocket upgrade. Remember the live-revalidation limitations above after the socket is established.

## 8. Persistence

Remote Projects spans server-owned project data and client/local presentation preferences.

| State | Location | Owner |
|---|---|---|
| Remote Projects policy | `${FORGE_DATA_DIR}/shared/config/remote-build-settings.json` | Collaboration server |
| Collaboration auth database | `${FORGE_DATA_DIR}/shared/config/collaboration/auth.db` | Collaboration server |
| Generated auth secret | `${FORGE_DATA_DIR}/shared/config/collaboration/auth-secret.key` | Collaboration server |
| Remote profile/session descriptors | `${FORGE_DATA_DIR}/swarm/agents.json` | Collaboration server |
| Remote session history and state | `${FORGE_DATA_DIR}/profiles/<profileId>/sessions/<sessionId>/` | Collaboration server |
| Remote project files/repositories | Server workspace mounts/CWDs | Collaboration server/host |
| Configured connections and `remoteProjectsEnabled` | Browser-local collaboration registry (`forge:collab:connections:v1`) | Each browser profile |
| Unified local/remote sidebar order | `${LOCAL_FORGE_DATA_DIR}/shared/config/builder-sidebar-order.json` | Local Builder backend |

Back up the collaboration server's entire dedicated data directory and its workspace mounts. A browser registry backup does not back up remote projects; conversely, restoring the server does not restore each browser's connection preference.

If `FORGE_COLLABORATION_AUTH_SECRET` comes from an external secret manager rather than the generated file, back up or preserve that external secret separately.

## 9. Protocol, multi-writer attribution, and presence

The public `/api/collaboration/status` handshake exposes additive Remote Projects metadata:

- `instanceName`
- `forgeVersion`
- `protocolVersion`
- `capabilities` such as `collab`, `remoteBuild`, and optional capabilities

The endpoint is public. Anyone who can reach it can read the advertised instance name, Forge version, protocol version, and capabilities. Use a non-sensitive `instanceName`; do not put customer names, internal topology, credentials, or secrets in it. When `instanceName` is unset, the host name fallback can also reveal operational metadata.

A client refuses to attach its Builder surface when the server's protocol version is newer than that client supports and shows **Update Forge to connect**. Wire changes are additive within a protocol version; removals or repurposing require a protocol bump.

Remote project chat supports multiple writers:

- persisted and broadcast user messages carry collaboration author identity
- the UI shows author chips for messages from other users; it suppresses a redundant chip for the currently signed-in user
- each optimistic send can include a `clientRequestId`, and the server echoes it so that sender can replace its optimistic entry with the persisted event

`clientRequestId` is reconciliation metadata, not an exactly-once delivery guarantee or an idempotency key. Clients and integrations must not claim that retries can never duplicate a message.

Project presence is a full snapshot of authenticated member identities currently subscribed to a session. It means **subscribed viewers only**. It is not a typing indicator, cursor, edit lock, exclusive lease, or proof that another viewer is actively reading the page.

## 10. Troubleshooting and current limitations

### The remote connection does not appear in Builder

- Confirm the connection is saved in **Settings → Collaboration**.
- Confirm the server policy `enabled` is `true` with the admin `GET /api/settings/remote-build` endpoint.
- Confirm the per-connection **Remote projects** switch is on in this browser.
- Confirm the account is signed in and not disabled or awaiting a required password change.

### The row says “Update Forge to connect”

The server advertises a Builder protocol version above this client build's supported maximum. Update the client. The client intentionally does not open the remote Builder WebSocket in this state.

### The row says “Unreachable”

Check the server URL, `/api/health`, public `/api/collaboration/status`, TLS certificate, reverse-proxy WebSocket upgrade handling, DNS/network access, and trusted-origin configuration. The client periodically re-probes unreachable enabled origins.

### The row says Remote Projects is disabled

An admin must enable the server policy through `/api/settings/remote-build`. The browser preference cannot override server policy. The client periodically re-probes so a server-side enablement can appear without removing/re-adding the connection.

### Sign-in loops or the wrong backend account is used

- Keep `FORGE_COLLABORATION_BASE_URL` aligned with the browser-facing URL.
- Configure `FORGE_COLLABORATION_TRUSTED_ORIGINS` for split deployments.
- Do not mix `localhost` and `127.0.0.1`.
- Give same-host multi-backend instances distinct cookie names; ports do not isolate cookies.

### Files, Git, or terminals target the wrong machine

Verify which project row is selected. Supported project surfaces follow the active origin. Non-chat Settings, Stats, Archive, onboarding, Cortex, provider usage, and sidebar ordering intentionally remain local.

### Terminal access remains after disabling terminals

`terminalsEnabled: false` blocks subsequent member lifecycle/ticket operations; it does not kill an already attached terminal socket. Close the terminal connection and use account/network containment if immediate revocation is required.

### A signed-out or expired user still receives WebSocket events

Existing authenticated WebSockets are not continuously session-revalidated. Sign-out/expiry takes effect for new HTTP requests and future connections, but the existing socket persists until disconnect. Admin disable/delete, role change, and password reset use the explicit `4001` disconnect path; use one of those controls for stronger immediate account revocation.
