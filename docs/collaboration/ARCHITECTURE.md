# Collaboration Architecture

## Overview and invariants

Collaboration mode is a current Forge runtime target in this repo. It reuses the Builder session/runtime stack where possible, but isolates users, auth, settings, channels, and persistence behind collaboration-specific services.

Core invariants:

- Runtime target is `collaboration-server` for the deployable collaboration backend.
- Channels are manager sessions under the hidden `_collaboration` system profile.
- Remote Projects are normal Builder profiles/sessions on the collaboration server; they are not channels, a third mode, or local clones.
- Collaboration auth uses local Better Auth accounts and roles.
- Collaboration HTTP admin routes are allowed only in the collaboration runtime.
- Collaboration WebSocket commands require an authenticated collaboration member.
- Builder settings target the local Builder backend. Collaboration settings target the selected collaboration backend.
- Provider auth configured in Collaboration settings belongs to that backend only.
- Structured collaboration state is SQLite-backed. User-authored prompts, references, specialists, and skills stay file-backed.
- The Collaboration UI keeps metadata for all configured backends but subscribes to detail for exactly one active channel/backend at a time.
- Remote origins are managed independently for browser connections with `remoteProjectsEnabled`; the selected origin owns supported project-scoped surfaces.
- Builder-only surfaces stay out of Collaboration channels unless explicitly designed for them. Remote Projects expose only their reviewed Builder allowlists.

## Local Builder, Remote Projects, and Collaboration channels

| Area | Local Builder | Remote Projects | Collaboration channels |
|------|---------------|-----------------|------------------------|
| Runtime/data origin | Local `builder` backend and data dir | Selected `collaboration-server` and its dedicated data/workspace mounts | Selected `collaboration-server` |
| Profile/session model | Normal visible Builder profiles/sessions | Normal visible Builder profiles/sessions on the server | Hidden `_collaboration` profile with session-backed channels |
| Navigation | Unified Builder sidebar | Blue/globe rows in the same Builder sidebar | Collaboration surface and channel sidebar |
| Auth | Local app/provider credentials | Collaboration Better Auth member/admin session | Same collaboration session |
| Protocol | Builder HTTP/WS | Reviewed Builder HTTP/WS allowlists plus builder protocol handshake | `collab_*` protocol and collaboration routes |
| Files/Git/terminals | Local active origin | Selected remote active origin, subject to policy | Not inferred from route presence |
| Non-chat Settings/Stats/Archive/onboarding/Cortex | Local | Still local | Separate Collaboration settings where designed |
| Specialists/skills | Builder target space and normal loading | Builder target space on the remote server | Collaboration target space and selected global state |
| Data movement | Local | No clone or sync; state and execution remain remote | Channel history/content remain remote |

Remote Projects has a dedicated canonical guide: [REMOTE_PROJECTS.md](REMOTE_PROJECTS.md).

## Runtime target and boot shape

| Concern | Code path |
|---------|-----------|
| Runtime target/config selection | `apps/backend/src/runtime-target.ts`, `apps/backend/src/config.ts` |
| Runtime/profile utilities | `apps/backend/src/swarm/swarm-manager-utils.ts` |
| Collaboration services | `apps/backend/src/collaboration/*` |
| Remote Projects policy | `apps/backend/src/collaboration/remote-build-settings-service.ts`, `apps/backend/src/ws/http/routes/remote-build-settings-routes.ts` |
| Collaboration auth | `apps/backend/src/collaboration/auth/*` |
| Remote member access | `apps/backend/src/ws/builder-command-access.ts`, `apps/backend/src/collaboration/auth/collaboration-auth-middleware.ts` |
| HTTP route registration | `apps/backend/src/ws/http/routes/collaboration-routes.ts` |
| Collaboration route modules | `apps/backend/src/ws/http/routes/collaboration/*` |
| WebSocket command parsing | `apps/backend/src/ws/commands/parse-collab-command.ts` |
| WebSocket handler/command handling | `apps/backend/src/ws/ws-handler.ts`, `apps/backend/src/ws/commands/collab-command-handler.ts` |
| Subscription fanout | `apps/backend/src/ws/collab-subscription-manager.ts` |
| Shared protocol | `packages/protocol/src/collaboration.ts`, `builder-protocol.ts`, `presence.ts`, `builder-sidebar-order.ts` |

The Docker collaboration server sets:

```text
FORGE_RUNTIME_TARGET=collaboration-server
FORGE_HOST=0.0.0.0
FORGE_PORT=47287
FORGE_DATA_DIR=/var/lib/forge
```

## Backend service map

| Domain | Primary files |
|--------|---------------|
| Workspace defaults | `apps/backend/src/collaboration/workspace-service.ts` |
| Categories | `apps/backend/src/collaboration/category-service.ts` |
| Channels | `apps/backend/src/collaboration/channel-service.ts` |
| Channel messages | `apps/backend/src/collaboration/channel-message-service.ts` |
| Channel CWD | `apps/backend/src/collaboration/channel-cwd.ts` |
| Additional instructions | `apps/backend/src/collaboration/channel-prompt-overlay-service.ts` |
| Readiness | `apps/backend/src/collaboration/readiness-service.ts` |
| Users | `apps/backend/src/collaboration/user-service.ts` |
| Invites | `apps/backend/src/collaboration/invite-service.ts` |
| Settings | `apps/backend/src/collaboration/settings-service.ts` |
| Specialist selection | `apps/backend/src/collaboration/specialist-selection.ts` |
| Skill selection | `apps/backend/src/collaboration/skill-selection.ts`, `skill-handle-provider.ts` |
| Audit | `apps/backend/src/collaboration/audit-service.ts` |
| DB helpers | `apps/backend/src/collaboration/collab-db-helpers.ts` |

## Domain model and protocol map

The Collaboration-channel protocol source of truth is `packages/protocol/src/collaboration.ts`. Remote Projects adds `builder-protocol.ts`, `presence.ts`, conversation attribution/`clientRequestId`, and `builder-sidebar-order.ts` on the shared Builder surface.

| Protocol family | Examples |
|-----------------|----------|
| Auth/session | `CollaborationStatus`, `CollaborationUser`, `CollaborationSessionInfo` |
| Workspace/category/channel | `CollaborationWorkspace`, `CollaborationCategory`, `CollaborationChannel` |
| Bootstrap/read state | `CollaborationBootstrapEvent`, `CollaborationReadState` |
| Client commands | `collab_bootstrap`, `collab_subscribe_channel`, `collab_user_message`, `collab_mark_channel_read`, `collab_choice_response`, `collab_choice_cancel`, `collab_pin_message` |
| Server events | `collab_channel_message`, `collab_channel_status`, `collab_session_activity`, `collab_session_agent_status`, `collab_session_workers_snapshot`, `collab_choice_request`, category/channel reorder/update events |
| Selection state | `CollaborationSkillSelectionState`, selected global specialist handles on categories/channels |

Protocol changes start in `packages/protocol/src/collaboration.ts`, then backend route/WS handlers and UI clients are updated to match.

## Storage model

| State | Storage | Notes |
|-------|---------|-------|
| Users, sessions, invites, roles | SQLite | Better Auth/collaboration auth tables. |
| Workspace/category/channel metadata | SQLite | Collaboration domain rows, including `backingSessionAgentId` references. |
| Forge profile/session descriptors | `swarm/agents.json` | `_collaboration` profile/root descriptors and channel backing manager descriptors. `backingSessionAgentId` must resolve here. |
| Per-user read state | SQLite | Transactional user/channel state. |
| Selected global specialists | SQLite | Category defaults and channel active selections. |
| Selected global skills | SQLite | Category defaults and channel active selections. |
| Channel backing history | Files | Normal session JSONL under `_collaboration`. |
| Remote Projects policy | `shared/config/remote-build-settings.json` | Server-owned `enabled`, `terminalsEnabled`, and `instanceName` policy. |
| Remote Builder profiles/sessions | `swarm/agents.json`, `profiles/<profileId>/sessions/` | Normal server-owned Builder data; never copied into the client data dir. |
| Additional instructions | Files | `profiles/_collaboration/sessions/<sessionId>/context/prompt.md`. |
| Channel reference docs | Files | `profiles/_collaboration/sessions/<sessionId>/reference/`. |
| Specialist definitions | Files | Shared markdown in `shared/specialists/`; channel-local markdown under session `specialists/`. |
| Forge skill definitions | Files | User-created global Forge skills live under `${FORGE_DATA_DIR}/skills/`; repository project skills live under repo-root `.forge/skills/`. |
| Pi agent skill definitions | Files | Pi-discovered global worker/manager skills live under `${FORGE_DATA_DIR}/agent/skills/` and `${FORGE_DATA_DIR}/agent/manager/skills/`; profile/project Pi skills live under `${FORGE_DATA_DIR}/profiles/<profileId>/pi/skills/`. V1 channel skill selection is global-handle based with always-on `memory`; no channel-local skill authoring. |

Structured collaboration domain state is SQLite-backed, but session identity still depends on Forge's normal agent registry. Back up `swarm/agents.json` with the collaboration database and `_collaboration` profile data or channel rows can become unresolved.

The hidden collaboration profile constants live in `apps/backend/src/collaboration/constants.ts`:

```ts
COLLABORATION_PROFILE_ID = "_collaboration"
COLLABORATION_CHANNEL_ARCHETYPE_ID = "collaboration-channel"
```

## Channel-as-session lifecycle

Each channel maps to one manager session under:

```text
${FORGE_DATA_DIR}/profiles/_collaboration/sessions/<sessionId>/
```

Collaboration channels use `sessionSurface: "collab"` in session-facing metadata/projection so UI and backend logic can distinguish them from Builder sessions. Channel CWD, model defaults, additional instructions, reference docs, selected specialists, and selected skills are resolved through collaboration services before the manager runtime starts.

A channel can have:

- channel metadata in SQLite
- normal session history files
- additional instructions at `context/prompt.md`
- reference docs at session-root `reference/`
- channel-local specialist markdown under `specialists/`

## HTTP and WebSocket flow

HTTP routes are under `apps/backend/src/ws/http/routes/collaboration/*` and are mounted by `collaboration-routes.ts`. Important route families include status/readiness, current user, users, invites, categories, and channels.

| Access class | Surface |
|--------------|---------|
| Public/unauthenticated | Health/status and auth entry points that must work before sign-in. |
| Member | Channel collaboration actions and `collab_*` commands; reviewed Remote Projects read/write allowlists only when server `enabled` is on. |
| Admin | Collaboration settings, member/invite management, Remote Projects policy, and unconditionally permitted Builder commands/routes. |
| Fail-closed default | Collaboration HTTP routes in the collaboration runtime unless deliberately classified otherwise. |

Collaboration channel WebSocket flow:

1. UI connects to the selected collaboration backend.
2. Backend authenticates the socket with collaboration auth middleware.
3. UI sends `collab_bootstrap` for workspace metadata.
4. UI subscribes to one active channel with `collab_subscribe_channel`.
5. User messages are sent as `collab_user_message`.
6. `CollabSubscriptionManager` fans out transcript, status, activity, worker, choice, pin, read-state, and metadata events.

Remote origin flow is separate:

1. A browser registry connection with `remoteProjectsEnabled` probes public `/api/collaboration/status`.
2. The client records `instanceName`, Forge version, Builder protocol version, and capabilities. A newer unsupported protocol blocks attachment.
3. The client probes `/api/collaboration/me`; an unauthenticated connection stays visible as sign-in required.
4. When `capabilities.remoteBuild` is true, the client opens a Builder WebSocket and creates an origin store keyed by the connection ID.
5. Selecting a remote profile/session routes chat and supported project HTTP/WS surfaces through that origin. Non-chat local-only surfaces continue to use the local backend.

The current UI emits a 25 second `{ type: "ping" }` heartbeat on the collaboration WebSocket. Reverse proxies still need a sane tunnel timeout; HTTP health checks do not keep WebSocket tunnels alive.

## Authentication and authorization

| Area | Code path |
|------|-----------|
| Better Auth service | `apps/backend/src/collaboration/auth/better-auth-service.ts` |
| Auth middleware | `apps/backend/src/collaboration/auth/collaboration-auth-middleware.ts` |
| Origin policy | `apps/backend/src/collaboration/auth/collaboration-origin-policy.ts` |
| Admin bootstrap | `apps/backend/src/collaboration/auth/admin-bootstrap.ts` |
| Auth secret | `apps/backend/src/collaboration/auth/auth-secret-service.ts` |
| Auth DB/migrations | `apps/backend/src/collaboration/auth/collaboration-db.ts`, `migration-runner.ts`, `migrations.ts` |

Roles are `admin` and `member`. The first admin is bootstrapped from `FORGE_ADMIN_EMAIL` and `FORGE_ADMIN_PASSWORD` on a fresh deployment. Admins can use member/invite management and admin settings routes. Members can use collaboration channels but not admin settings. When Remote Projects is enabled, active members also receive broad reviewed Builder read/write allowlists; there is no per-project ACL.

Better Auth sessions use a 21-day sliding lifetime with a one-day `updateAge`; the UI signs in with `rememberMe: true`. Cookies are not port-scoped, so same-host multi-backend deployments require distinct `FORGE_COLLABORATION_AUTH_COOKIE_NAME` values. Cross-site browser auth requires HTTPS and uses the trusted-origin/CORS policy with `SameSite=None; Secure`; same-site cookies use `SameSite=Lax`.

`FORGE_COLLABORATION_BASE_URL` sets the canonical collaboration origin for login redirects and invite links. `FORGE_COLLABORATION_TRUSTED_ORIGINS` lists Builder/UI origins allowed to talk to the backend in split deployments.

## UI architecture and multi-backend model

| Area | Code path |
|------|-----------|
| Surface shell | `apps/ui/src/components/index-page/CollabSurface.tsx` |
| Workspace | `apps/ui/src/components/index-page/CollabWorkspace.tsx` |
| Multi-backend connection manager | `apps/ui/src/lib/collaboration/connection-manager.ts` |
| Sidebar | `apps/ui/src/components/chat/collab-sidebar/*` |
| Header/adapter | `apps/ui/src/components/chat/collab/*` |
| Collaboration API client | `apps/ui/src/lib/collaboration-api.ts`, `apps/ui/src/lib/collaboration/*` |
| Endpoint targeting | `apps/ui/src/lib/collaboration-endpoints.ts` |
| Backend connection metadata | `apps/ui/src/lib/collaboration-connections.ts` |
| WS connection hook | `apps/ui/src/hooks/index-page/use-collab-ws-connection.ts` |
| Session hook | `apps/ui/src/hooks/use-collaboration-session.ts` |
| Backend health polling | `apps/ui/src/hooks/index-page/use-backend-health-poll.ts` |
| Settings target API | `apps/ui/src/components/settings/settings-target.ts`, `settings-api-client.ts`, `collaboration-settings-api.ts` |

Remote Projects uses the origin-aware Builder path:

| Area | Code path |
|------|-----------|
| Browser connection registry/preference | `apps/ui/src/lib/collaboration-connections.ts` |
| Remote origin lifecycle/handshake | `apps/ui/src/lib/origin-store/forge-origin-manager.ts` |
| Origin-scoped state | `apps/ui/src/lib/origin-store/*` |
| Active-origin shell and endpoint selection | `apps/ui/src/components/index-page/BuilderSurface.tsx`, `apps/ui/src/hooks/index-page/use-origin-connection.ts` |
| Remote sidebar rows/states | `apps/ui/src/components/chat/agent-sidebar/RemoteOriginSections.tsx`, `AgentSidebarConnected.tsx` |
| Local unified order | `apps/backend/src/swarm/builder-sidebar-order-service.ts`, `apps/ui/src/lib/builder-sidebar-order-*` |

All configured collaboration backends can remain visible as metadata. The UI keeps exactly one active detail subscription for the route-selected backend/channel so transcript, activity, and worker updates do not fan out across every configured backend.

## Settings target separation

Builder settings and Collaboration settings must not share a target implicitly:

- Builder mode settings call the local backend.
- Collaboration mode settings call the selected collaboration backend.
- Collaboration settings are admin-only.
- Provider credentials entered in Collaboration settings are stored by that collaboration backend.
- Remote Collaboration settings show a target banner so admins know they are editing a remote backend.
- Terminal settings are hidden in remote Collaboration settings v1.
- The per-connection **Remote projects** switch is browser-local presentation/connection state, not server authorization.
- Server Remote Projects policy is admin-only at `/api/settings/remote-build`; there is currently no server admin UI or environment-variable replacement for it.

## Specialists and skills

Specialist markdown uses `TargetSpace` frontmatter:

- `builder`
- `collaboration`
- `[builder, collaboration]`

Missing `TargetSpace` is treated as Builder-only for legacy compatibility. Collaboration uses the same global effort tiers and TargetSpace-filtered lenses as Builder; legacy `collab-*` builtin handles are accepted as compatibility rewrites rather than active builtin files. Runtime and UI rosters filter by target space.

Global selected specialist handles are structured SQLite state. Channel-local specialist definitions remain markdown files under the backing session.

Collaboration skill selection is also SQLite-backed. Forge and Pi skill definitions stay file-backed in their normal directories. Category defaults are copied into newly created channels; existing channels are not rewritten when a category default changes. `NULL` and `[]` have different meanings and must be preserved by migrations and UI code.

## Boundaries and exclusions

Treat these as excluded from **Collaboration channels** unless a task explicitly designs support:

- Project Agents
- Codex app-server sidecar and plugin routing
- Phoenix observability
- Forge CLI workflows
- repo-root project resource mutation/trust flows
- Builder terminal, archive, Source Control, and Files UI assumptions

Do not apply that channel list wholesale to Remote Projects. Remote Projects deliberately exposes active-origin chat, Files, Git/Source Control, terminals, attachments, Session Audit, and model-availability surfaces through reviewed allowlists. Non-chat Settings, Stats, Archive, onboarding, Cortex, sidebar usage, and sidebar ordering remain local.

Backend routes for Builder-only systems may still exist in a collaboration process. Route presence is not product support. Member access is allowlist-only behind server policy, while unclassified routes remain admin-only. See [REMOTE_PROJECTS.md](REMOTE_PROJECTS.md#5-supported-and-local-only-surfaces) for the product boundary and its live-revocation caveats.
