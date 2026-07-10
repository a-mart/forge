# Collaboration Development

## Rule of thumb

Collaboration work happens in this repo. Start with the current code, protocol, and docs here. Keep documentation focused on the current collaboration mode.

Keep Collaboration-channel changes isolated from Builder behavior unless the task explicitly requires a shared change. Remote Projects intentionally crosses that boundary through reviewed origin-aware Builder seams; verify local Builder, remote origin, and Collaboration channel contracts separately. Read [REMOTE_PROJECTS.md](REMOTE_PROJECTS.md) before changing those seams.

## Source map for coding agents

| Area | Code path |
|------|-----------|
| Runtime target/config | `apps/backend/src/runtime-target.ts`, `apps/backend/src/config.ts` |
| Runtime/profile utilities | `apps/backend/src/swarm/swarm-manager-utils.ts` |
| Collaboration services | `apps/backend/src/collaboration/*` |
| Remote Projects policy | `apps/backend/src/collaboration/remote-build-settings-service.ts`, `apps/backend/src/ws/http/routes/remote-build-settings-routes.ts` |
| Auth middleware / remote HTTP allowlist | `apps/backend/src/collaboration/auth/collaboration-auth-middleware.ts` |
| Remote Builder WS allowlist | `apps/backend/src/ws/builder-command-access.ts` |
| HTTP routes | `apps/backend/src/ws/http/routes/collaboration-routes.ts`, `apps/backend/src/ws/http/routes/collaboration/*` |
| WS handler/commands | `apps/backend/src/ws/ws-handler.ts`, `apps/backend/src/ws/commands/parse-collab-command.ts`, `collab-command-handler.ts` |
| WS fanout | `apps/backend/src/ws/collab-subscription-manager.ts` |
| Protocol | `packages/protocol/src/collaboration.ts`, `builder-protocol.ts`, `presence.ts`, `builder-sidebar-order.ts` |
| UI surface | `apps/ui/src/components/index-page/CollabSurface.tsx`, `CollabWorkspace.tsx` |
| UI Collaboration connection manager | `apps/ui/src/lib/collaboration/connection-manager.ts` |
| UI endpoint targeting / browser registry | `apps/ui/src/lib/collaboration-endpoints.ts`, `collaboration-connections.ts` |
| Remote origin lifecycle/state | `apps/ui/src/lib/origin-store/forge-origin-manager.ts`, `apps/ui/src/lib/origin-store/*` |
| Active-origin Builder shell | `apps/ui/src/components/index-page/BuilderSurface.tsx`, `apps/ui/src/hooks/index-page/use-origin-connection.ts` |
| Remote/sidebar order UI | `apps/ui/src/components/chat/agent-sidebar/RemoteOriginSections.tsx`, `AgentSidebarConnected.tsx`, `apps/ui/src/lib/builder-sidebar-order-*` |
| Sidebar-order backend | `apps/backend/src/swarm/builder-sidebar-order-service.ts`, `apps/backend/src/ws/http/routes/builder-sidebar-order-routes.ts` |
| Settings target | `apps/ui/src/components/settings/settings-target.ts`, `settings-api-client.ts` |
| Specialists | `apps/backend/src/collaboration/specialist-selection.ts`, settings specialist UI/tests |
| Skills | `apps/backend/src/collaboration/skill-selection.ts`, `skill-handle-provider.ts`, settings skills UI/tests |
| Remote terminal policy/caveat | `apps/backend/src/ws/server.ts`, `apps/backend/src/ws/http/routes/terminal-routes.ts`, `apps/backend/src/ws/builder-command-access.ts` |
| Remote project CWD browser | `apps/backend/src/swarm/cwd-policy.ts`, `FORGE_CWD_ALLOWLIST_ROOTS`, UI `ServerDirectoryBrowserDialog` |

## Local Builder, Remote Projects, and Collaboration invariants

| Concern | Local Builder | Remote Projects | Collaboration channels |
|---------|---------------|-----------------|------------------------|
| Runtime/data | Local default target/data | `collaboration-server` normal profiles/sessions | Same server, hidden `_collaboration` profile |
| Navigation | Unified Builder sidebar | Same sidebar; blue/globe rows keyed by origin | Collaboration surface/channel sidebar |
| HTTP authorization | Normal Builder policy | Member allowlist behind `enabled`; unclassified is admin-only | Collaboration route classification |
| WS authorization | Normal commands | Builder command tier allowlist; admins pass policy | Authenticated `collab_*` commands |
| State | Local origin store | Per-connection origin store | Collaboration connection/session state |
| Project CWD selection | Local/native picker | Allowlisted server roots and server browser | Channel-configured CWD |
| Project surfaces | Local | Active-origin chat, Files, Git, terminals, attachments, audit/model availability | Only explicitly designed channel surfaces |
| Local-only surfaces | N/A | Non-chat Settings, Stats, Archive, onboarding, Cortex, usage/order API | Not projected into channels |
| Persistence | Local data dir | Server data/workspaces; no clone/sync | Server SQLite plus `_collaboration` files |
| Subscription model | Selected local session | Enabled origins may connect; one route-selected active origin | Metadata-first; one active channel detail subscription |

Keep the two Remote Projects controls independent: server `enabled` is authorization policy, while browser `remoteProjectsEnabled` only decides whether that connection is managed/rendered. Never treat the client preference as security.

Do not treat mounted backend routes as product support. Collaboration channels and Remote Projects have separate allowlists. A route hidden from channel UX may be deliberately supported for a remote active origin, while an unclassified member route must remain admin-only.

## Protocol and API change workflow

1. Update the owning protocol module first: `collaboration.ts` for channels, or `builder-protocol.ts`/`presence.ts`/`builder-sidebar-order.ts` for Remote Projects.
2. Update backend HTTP route DTOs and WebSocket command/event handling.
3. Update UI API clients, connection/origin state, and components.
4. Add or update tests on both sides of the boundary.
5. Check replay/bootstrap and reconnect behavior, not just live events.
6. Update docs when behavior, fields, defaults, access classes, or operational contracts change.

Builder remote wire changes are additive within `BUILDER_PROTOCOL_VERSION`. Removing or repurposing an existing field/command/event requires a protocol bump. A client must continue blocking attachment when the server protocol is newer than its supported ceiling.

Never duplicate shared DTOs in app-local files when they belong in protocol.

## Remote Projects access and state invariants

- The user-facing name is Remote Projects even though compatibility identifiers use `remote-build`/`remoteBuild`.
- The server policy defaults to off and is admin-only at `/api/settings/remote-build`; do not add an undocumented UI or environment override.
- Member HTTP and WS access remains allowlist-only. New commands/routes must be deliberately classified and tested with policy on and off; default is admin-only.
- Admins pass the member policy gate. Active members receive both read and write tiers only while `enabled` is on.
- `terminalsEnabled` gates member terminal lifecycle mutations/tickets. It must not be described as killing already attached terminal sockets.
- Disabling policy does not disconnect sockets/subscriptions. Ordinary sign-out/expiry does not continuously revalidate a connected WS. Do not “fix” documentation by promising stronger revocation than the code provides.
- Admin disable/delete, role change, and password reset must retain the `4001` socket invalidation path.
- The public status handshake exposes instance name/version/protocol/capabilities; never put sensitive server metadata in an example `instanceName`.
- `clientRequestId` correlates optimistic sends with echoed persisted events; it is not an exactly-once or idempotency contract.
- Project presence means subscribed viewer identities only—never typing, editing, cursors, or locks.
- Origin-scoped events must mutate only their `(originId, id)` store. Non-chat local-only surfaces must not silently derive endpoints from the active remote origin.
- Unified order is local-instance-owned and retains offline/hidden remote anchors.

## SQLite migration policy

SQLite is for structured collaboration domain state: users, auth sessions, invites, workspace/category/channel metadata, membership/read state, selected specialist handles, and selected skill handles. Forge profile/session descriptors are separate: the `_collaboration` profile/root descriptors and channel backing manager descriptors remain in `${FORGE_DATA_DIR}/swarm/agents.json`.

Migration rules:

- Run automatically at startup.
- Prefer additive schema changes.
- Wrap each migration in a transaction.
- Make migrations idempotent and safe to rerun.
- Back up the database before non-trivial migrations, and preserve `${FORGE_DATA_DIR}/swarm/agents.json` whenever channel/session identity could be affected.
- Fail cleanly without destructive partial state.
- Do not delete, overwrite, or normalize user-authored markdown/content files from a DB migration.
- Do not silently delete missing selected specialist or skill handles; surface invalid/missing config.
- Preserve semantic differences such as `NULL` versus `[]` selection state.

## Structured DB state vs file-backed content checklist

Use SQLite for:

- workspace/category/channel domain records, including `backingSessionAgentId` references
- ordering and archived state
- collaboration users, roles, auth sessions, invites
- read-state/unread counters
- selected global specialist handles
- selected global skill handles

Use files for:

- Forge profile/session descriptors in `${FORGE_DATA_DIR}/swarm/agents.json`
- channel session JSONL history
- channel additional instructions
- channel reference docs
- global/shared specialist markdown
- channel-local specialist markdown
- Forge global skill definitions under `${FORGE_DATA_DIR}/skills/`
- profile/project Pi skill definitions under `${FORGE_DATA_DIR}/profiles/<profileId>/pi/skills/`
- Pi agent global worker/manager skill definitions under `${FORGE_DATA_DIR}/agent/skills/` and `${FORGE_DATA_DIR}/agent/manager/skills/`
- provider auth/secrets through the existing Forge config/secret services

If the state is user-authored prose or reusable agent content, keep it file-backed unless a design explicitly changes that boundary. Do not confuse Forge skill storage (`${FORGE_DATA_DIR}/skills/` for user-created global Forge skills) with Pi agent skill storage (`agent/skills`, `agent/manager/skills`, and profile `pi/skills`). Collaboration v1 channel skill selection stores global handles plus always-on `memory`; it does not imply channel-local skill authoring or that every Pi/profile/workspace skill directory participates in selected-skill handles.

## Runtime and data isolation for validation

Use an isolated worktree and a copied or fresh data directory for validation. Do not run collaboration validation against production `~/.forge` data.

For local Docker validation, use the compose data mounts:

```text
./.forge-collaboration-data
./.forge-collaboration-data-secondary
```

Do not run service restarts, Docker commands, builds, or production-data mutations unless the task explicitly approves them.

## Backend implementation patterns

- Keep collaboration domain logic in `apps/backend/src/collaboration/*`.
- Keep HTTP route handlers thin and delegate to services.
- Classify collaboration HTTP routes deliberately. In the collaboration runtime, admin access is the default unless a route is intentionally public, channel-member, or Remote-Projects-member.
- Keep the Remote Projects member HTTP allowlist and Builder WS tier map explicit and total. Test policy-disabled behavior separately from admin behavior.
- Keep WebSocket command parsing strict. `collab_*` channel commands and allowlisted remote Builder commands follow separate authorization paths.
- Route channel sends through `collab_user_message` and channel services so author/read-state metadata stays consistent.
- Keep `_collaboration` system profile hidden from normal Builder lists and snapshots.
- Preserve session-backed channel behavior so history/replay and existing manager runtime infrastructure continue to work.

## UI implementation patterns

- Use `CollabSurface.tsx` and `CollabWorkspace.tsx` as the top-level Collaboration-channel shell.
- Keep endpoint choice centralized in `collaboration-endpoints.ts` and connection metadata in `collaboration-connections.ts` / `collaboration/connection-manager.ts`.
- Maintain the channel metadata-first multi-backend model. Subscribe to detail for only the selected backend/channel.
- Manage Remote Projects through `forge-origin-manager.ts`: status/version/auth probe before transport, one origin store per opted-in remote connection, and a permanent sign-in-required state after `4001` until re-authentication.
- Route active-origin project surfaces from `BuilderSurface.tsx` through the selected origin. Explicitly keep non-chat Settings, Stats, Archive, onboarding, Cortex, sidebar usage, and order API on local endpoints.
- Preserve blue/globe remote rows and connecting/sign-in/unreachable/version-blocked/disabled/no-project states.
- Keep browser `remoteProjectsEnabled` separate from the server capability/policy. Registry removal/opt-out destroys only the client origin.
- Route settings calls through `settings-target.ts` and `settings-api-client.ts` so Collaboration settings mutate the selected backend, not the local Builder backend.
- Reuse shared chat components only through the relevant adapter/origin layer when metadata, authorship, or replay semantics differ.
- Preserve author attribution and `clientRequestId` echo reconciliation without claiming exactly-once delivery.

## Specialists and skills development notes

Specialists:

- Use `TargetSpace` frontmatter for new specialist files.
- Missing target space is Builder-only compatibility.
- Collaboration uses TargetSpace-filtered global tiers/lenses; legacy `collab-*` handles are compatibility rewrites, not the preferred source files for new built-ins.
- UI and runtime rosters must filter by target space.
- Selected global handles are SQLite state; definitions stay markdown files.
- Channel-local specialist markdown is collaboration-scoped by location.

Skills:

- Skill definitions stay file-backed.
- Collaboration stores selected global skill handles in SQLite.
- Always-on skills such as `memory` remain loaded.
- `NULL` means default/all optional behavior where supported; `[]` means intentional empty custom selection.
- V1 does not support channel-local skill authoring.

## Validation checklist

For canonical collaboration Markdown-only changes that do not touch in-app help:

```bash
git diff --check
rg -n 'REMOTE_PROJECTS|remote-build-settings|remoteProjectsEnabled' docs/collaboration
```

Read the changed link targets and verify relative paths. `pnpm help:validate` and app typechecks are not required when help/code is untouched.

For Remote Projects protocol/access/origin changes, include the relevant targeted suites:

- `apps/backend/src/test/remote-build-ws-access.test.ts`
- `apps/backend/src/test/builder-command-access.test.ts`
- `apps/backend/src/test/collaboration-http-auth.test.ts`
- `apps/backend/src/test/route-inventory-classification.test.ts`
- `packages/protocol/src/__tests__/builder-protocol-contract.test.ts`
- `apps/ui/src/lib/origin-store/*test.ts`
- `apps/ui/src/lib/ws-client/event-handlers/conversation-dedup.test.ts`
- remote sidebar and builder-sidebar-order tests

For protocol/API changes, add targeted backend and UI tests around changed DTOs and route/client behavior. For storage changes, add migration tests and rerun relevant collaboration service tests. For UI behavior, add component/hook tests for backend targeting, connection state, and replay/bootstrap behavior.

Do not run full builds, Docker validation, service restarts, or live backend checks unless explicitly approved.

## Common mistakes to avoid

- Pointing agents outside the current repo/docs for collaboration implementation guidance.
- Mutating local Builder settings when the UI is in Collaboration settings.
- Treating provider auth as shared between Builder and Collaboration.
- Moving prompts, reference docs, specialist markdown, or skill definitions into SQLite.
- Silently dropping unresolved specialist/skill handles.
- Loading Builder-only surfaces into Collaboration channels because a shared backend route exists.
- Hiding a supported Remote Projects surface merely because it is excluded from channels, or routing a local-only surface to the active remote origin.
- Treating browser `remoteProjectsEnabled` as authorization or assuming server disablement closes existing sockets.
- Describing `clientRequestId` as exactly-once delivery or project presence as typing/edit locking.
- Opening channel detail subscriptions to every configured backend.
- Dropping offline/hidden remote anchors from the local unified sidebar order.
- Forgetting that cookies are not port-scoped or mixing `localhost` and `127.0.0.1` in local split deployments.
