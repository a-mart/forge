# Collaboration Development

## Rule of thumb

Collaboration work happens in this repo. Start with the current code, protocol, and docs here. Keep documentation focused on the current collaboration mode.

Keep collaboration changes isolated from Builder behavior unless the task explicitly requires a shared change. When a change touches shared infrastructure, verify both Builder and Collaboration contracts.

## Source map for coding agents

| Area | Code path |
|------|-----------|
| Runtime target/config | `apps/backend/src/runtime-target.ts`, `apps/backend/src/config.ts` |
| Runtime/profile utilities | `apps/backend/src/swarm/swarm-manager-utils.ts` |
| Collaboration services | `apps/backend/src/collaboration/*` |
| Auth middleware | `apps/backend/src/collaboration/auth/collaboration-auth-middleware.ts` |
| HTTP routes | `apps/backend/src/ws/http/routes/collaboration-routes.ts`, `apps/backend/src/ws/http/routes/collaboration/*` |
| WS handler/commands | `apps/backend/src/ws/ws-handler.ts`, `apps/backend/src/ws/commands/parse-collab-command.ts`, `collab-command-handler.ts` |
| WS fanout | `apps/backend/src/ws/collab-subscription-manager.ts` |
| Protocol | `packages/protocol/src/collaboration.ts` |
| UI surface | `apps/ui/src/components/index-page/CollabSurface.tsx`, `CollabWorkspace.tsx` |
| UI connection manager | `apps/ui/src/lib/collaboration/connection-manager.ts` |
| UI endpoint targeting | `apps/ui/src/lib/collaboration-endpoints.ts`, `collaboration-connections.ts` |
| Settings target | `apps/ui/src/components/settings/settings-target.ts`, `settings-api-client.ts` |
| Specialists | `apps/backend/src/collaboration/specialist-selection.ts`, settings specialist UI/tests |
| Skills | `apps/backend/src/collaboration/skill-selection.ts`, `skill-handle-provider.ts`, settings skills UI/tests |
| Terminal caveat | `apps/backend/src/ws/server.ts`, `apps/backend/src/ws/http/routes/terminal-routes.ts` |
| Remote project CWD browser | `apps/backend/src/swarm/cwd-policy.ts`, `FORGE_CWD_ALLOWLIST_ROOTS`, UI `ServerDirectoryBrowserDialog` |

## Builder vs Collaboration invariants

| Concern | Builder | Collaboration |
|---------|---------|---------------|
| Runtime branch | Default local target | `collaboration-server` target from `runtime-target.ts`/`config.ts` |
| Profile/session | User-visible managers | System-only `_collaboration` profile |
| Session metadata | Normal Builder sessions | `sessionSurface: "collab"` plus workspace/channel metadata |
| HTTP authorization | Route-specific Builder policy | Fail-closed/admin-by-default in collab runtime unless classified otherwise |
| WS authorization | Normal app commands | Members use only `collab_*` commands |
| Settings | Mutates local Builder backend | Mutates selected remote/backend connection |
| Storage | Local Builder data | Dedicated collaboration data boundary |
| Project CWD selection | Unrestricted local paths / native picker | Allowlisted roots via `FORGE_CWD_ALLOWLIST_ROOTS` (fail closed when unset); server folder browser + single-level `create_directory` |
| Specialists | Builder target-space filtered | Collaboration target-space filtered |
| Skills | Normal skill loading | Selected global handles plus always-on `memory`; no channel-local skill authoring v1 |
| Builder-only surfaces | Project Agents, project resources, Codex, Phoenix, CLI, terminal UI | Excluded unless explicitly designed |
| Multi-backend | Not applicable | Metadata-first; exactly one active detail subscription |

Do not treat mounted backend routes as product support. For example, terminal routes may still be mounted by shared server setup, but the collaboration UX hides terminal UI/settings. Document and test this as a UX boundary, not as a security-disabled backend feature.

## Protocol and API change workflow

1. Update `packages/protocol/src/collaboration.ts` first.
2. Update backend HTTP route DTOs and WebSocket command/event handling.
3. Update UI API clients, connection manager state, and components.
4. Add or update tests on both sides of the boundary.
5. Check replay/bootstrap behavior, not just live events.
6. Update docs when behavior, fields, defaults, or operational contracts change.

Never duplicate collaboration DTOs in app-local files when they belong in protocol.

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
- Classify collaboration HTTP routes deliberately. In the collaboration runtime, admin access is the default unless a route is intentionally member/public.
- Keep WebSocket command parsing strict. Unknown or non-collaboration commands must not become collaboration actions.
- Route channel sends through `collab_user_message` and channel services so author/read-state metadata stays consistent.
- Keep `_collaboration` system profile hidden from normal Builder lists and snapshots.
- Preserve session-backed channel behavior so history/replay and existing manager runtime infrastructure continue to work.

## UI implementation patterns

- Use `CollabSurface.tsx` and `CollabWorkspace.tsx` as the top-level collaboration shell.
- Keep endpoint choice centralized in `collaboration-endpoints.ts` and connection metadata in `collaboration-connections.ts` / `collaboration/connection-manager.ts`.
- Maintain the metadata-first multi-backend model. Subscribe to detail for only the selected backend/channel.
- Route settings calls through `settings-target.ts` and `settings-api-client.ts` so Collaboration settings mutate the selected backend, not the local Builder backend.
- Reuse shared chat components only through the collaboration adapter layer when metadata, authorship, or replay semantics differ.
- Preserve sign-in recovery behavior for invalidated remote sessions rather than retrying forever.

## Specialists and skills development notes

Specialists:

- Use `TargetSpace` frontmatter for new specialist files.
- Missing target space is Builder-only compatibility.
- Collaboration built-ins use `collab-` handles.
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

For docs-only changes:

```bash
git diff --check
pnpm help:validate
pnpm quality:changed -- --base origin/main
```

For protocol/API changes, add targeted backend and UI tests around changed DTOs and route/client behavior. For storage changes, add migration tests and rerun relevant collaboration service tests. For UI behavior, add component/hook tests for backend targeting, connection state, and replay/bootstrap behavior.

Do not run full builds, Docker validation, service restarts, or live backend checks unless explicitly approved.

## Common mistakes to avoid

- Pointing agents outside the current repo/docs for collaboration implementation guidance.
- Mutating local Builder settings when the UI is in Collaboration settings.
- Treating provider auth as shared between Builder and Collaboration.
- Moving prompts, reference docs, specialist markdown, or skill definitions into SQLite.
- Silently dropping unresolved specialist/skill handles.
- Loading Builder-only surfaces into collaboration because a shared backend route exists.
- Opening detail subscriptions to every configured backend.
- Forgetting `localhost` versus `127.0.0.1` cookie/origin behavior in local split deployments.
