Use **Settings > Collaboration** to connect collaboration channels and optional Remote Projects from one or more Forge servers.

## Add and sign in to a connection

1. Select **Add connection**.
2. Enter the server URL and select **Test**.
3. After the test succeeds, select **Add**.
4. Select the connection and sign in with your collaboration email and password.

A configured connection can open its Collaboration sign-in surface before you are authenticated. Each connection keeps its own status and account view, although browser cookies are scoped by host rather than port; servers on the same host must use distinct cookie names.

If you open Builder directly on a server-hosted Forge page and its session cookie is missing or expired, Forge shows a non-dismissible email/password dialog. Successful sign-in reloads the current URL so the requested Builder route is preserved.

## Collaboration channels and Remote Projects are separate

There are two controls:

- The **Builder / Collab** switch changes between normal Builder projects and Collaboration channels.
- The per-connection **Remote projects** switch shows that server's normal Builder projects alongside local projects in Builder.

Remote Projects also requires the server operator to enable the feature. The browser switch is only a local display/connection preference, not an access control. A new connection is opted in automatically only when its successful **Test** advertised Remote Projects support. Adding without that successful capability test, or updating an existing connection that you previously turned off, does not silently opt it in.

## Sidebar and connection states

Enabled remote project headers appear with blue styling and a globe marker in the unified Builder sidebar. Nested session rows sit beneath them and use status dots. Remote actions are limited: **Change Working Directory** is available from a project header and opens the server directory browser. Local rename, archive, delete, fork, and model actions remain absent. A remote connection can show:

- connecting;
- sign-in required;
- unreachable;
- **Update Forge to connect** when the server protocol is newer;
- Remote Projects disabled on the server; or
- connected with no remote projects yet.

Drag local and remote project headers to set their shared order. That order is a preference saved by the local Builder instance. It does not grant access, change server policy, or move remote data.

## Where work runs and data stays

Selecting a remote row makes that server the active origin for supported project surfaces. Chat and agent execution, Files, Source Control, attachments, Session Audit, model availability, and terminals when permitted all target the remote instance. File paths are server paths; Git and GitHub CLI operations run against the server-hosted repository; remote PTYs run on the server host.

There is no local clone, sync, or fallback copy. Remote profiles, sessions, workspaces, credentials, terminal state, and agents stay on the selected server. Select a local project to switch supported surfaces back to the local origin.

Non-chat Settings, Stats, Archive, onboarding, Cortex, provider usage, and the mixed sidebar-order setting remain local even while a remote project is selected. Managed Browser and External Chrome are local Forge Desktop hosts, not Skills, and are excluded from remote/collaboration routing: Electron webviews/partitions and the External Chrome native relay, candidates, aliases, leases, and IPC remain with the selected local Builder manager. They are never forwarded to a Remote Project or Collaboration channel. A remote normal manager may still expose typed browser tools, but without a Desktop host connected directly to that remote backend their calls return `unavailable-host`.

Remote chat can show author chips for messages from other users. Viewer presence is only a snapshot of authenticated people subscribed to the session; it is not typing status, an edit lock, or proof that someone is actively reading.

## Trust and terminal access

Remote Projects is intended for trusted instance members. When the server enables it, members receive broad allowlisted Builder read/write access to exposed normal projects. There is no per-project ACL. File writes, Git mutations, agent execution, project resources, and terminals can affect server workspaces and credentials available to the Forge process.

The server operator can disable new member terminal management and ticket access. This is not a full sandbox and does not terminate an already attached terminal connection. Likewise, disabling Remote Projects blocks subsequent member commands and HTTP requests but does not disconnect existing sockets or subscriptions; ordinary sign-out or session expiry can leave an existing authenticated WebSocket active until it disconnects.

Only connect to a server whose operator and other members you trust, and ask the operator about workspace isolation, terminal policy, and backups before using sensitive repositories.
