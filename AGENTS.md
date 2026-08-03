# Forge — Repository Instructions

> This file is auto-loaded for work in this repository. Keep it limited to durable, repository-wide
> rules and routing. Detailed behavior belongs in the nearest tracked `AGENTS.md` or subsystem doc.

## Product and repository

Forge is a local-first multi-agent orchestration platform with a Node.js backend, a React SPA, an
Electron desktop app, shared protocol packages, and real-time WebSocket updates.

The built-in manager experience is concise and outcome-first. Product copy and documentation should
not promise constant progress narration.

Use the Node.js and pnpm versions declared by the repository. `package.json` is authoritative for the
package manager version.

## Workspace and path discipline

- Work in the repository and worktree the user selected. Treat an exact user-provided path literally;
  do not silently substitute another clone or worktree.
- Always pass an explicit `cwd` before reading, editing, generating, or validating repository files.
- Before editing, confirm the repository root and inspect `git status`. Preserve unrelated user changes.
- Read the nearest nested `AGENTS.md` before changing files in that subtree. Its local rules supplement
  this file.
- Keep local plans, reviews, and investigation notes under `.internal/`. It is gitignored and must not
  be committed.

## Repository map

- `apps/backend/` — orchestration, persistence, HTTP/WebSocket APIs, integrations, and terminals.
- `apps/ui/` — TanStack Start/Vite React application.
- `apps/electron/` — desktop packaging, runtime staging, updates, releases, and the local Automatic Browser Host.
- `apps/stream-deck/` — optional local Forge Desktop Stream Deck plugin and packaging assets.
- `apps/chrome-extension/` and `apps/native-messaging-host/` — optional Chrome adapter extension and bounded native relay.
- `packages/protocol/` — shared wire types, API contracts, and event definitions.
- `packages/cli/` — first-party Forge CLI.
- `docs/collaboration/` — Collaboration architecture, development, operations, and project tracking.

## Sources of truth

| Topic | Authoritative source |
|---|---|
| Setup, common commands, ports, project layout | [`README.md`](README.md) |
| Configuration, environment variables, data layout | [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) and `.env.example` |
| Local validation tiers and reports | [`docs/QUALITY.md`](docs/QUALITY.md) |
| Collaboration | [`docs/collaboration/`](docs/collaboration/) |
| Remote Projects | [`docs/collaboration/REMOTE_PROJECTS.md`](docs/collaboration/REMOTE_PROJECTS.md) |
| Automatic Browser Host | [`docs/BROWSER_AUTOMATION.md`](docs/BROWSER_AUTOMATION.md) |
| Model catalog and model additions | [`docs/MODEL_CATALOG.md`](docs/MODEL_CATALOG.md) and [`docs/ADDING_MODELS.md`](docs/ADDING_MODELS.md) |
| Specialists | [`docs/SPECIALISTS.md`](docs/SPECIALISTS.md) |
| Project resources | [`docs/PROJECT_RESOURCES.md`](docs/PROJECT_RESOURCES.md) |
| Forge and Pi extensions | [`docs/FORGE_EXTENSIONS.md`](docs/FORGE_EXTENSIONS.md) and [`docs/PI_EXTENSIONS.md`](docs/PI_EXTENSIONS.md) |
| Electron build and release workflow | [`apps/electron/README.md`](apps/electron/README.md) |
| Stream Deck plugin setup and validation | [`apps/stream-deck/README.md`](apps/stream-deck/README.md) |

Do not copy changing feature inventories, recent protocol changes, full storage trees, environment
variable catalogs, or release runbooks back into this file. Link to their maintained source instead.

## Cross-repository invariants

- Preserve existing behavior unless the task explicitly changes it.
- Shared messages and transport types belong in `packages/protocol/`. Do not duplicate DTOs across
  backend and UI packages.
- For a protocol change, update the shared contract first, then every producer, parser, consumer,
  persistence/replay path, and relevant test in the same change.
- Conversation behavior must remain correct for both live WebSocket events and replayed JSONL history.
- Treat public facades and exported contracts as stable. When changing one, audit and update all
  downstream consumers; use a narrow compatibility seam only when the migration actually requires it.
- If a task explicitly calls for complete replacement, remove obsolete code, routes, prompts, docs,
  settings, and compatibility artifacts rather than leaving two competing systems.
- Use `apps/backend/src/swarm/storage/data-paths.ts` for Forge data-path resolution. Do not recreate
  storage paths ad hoc.
- Structured Collaboration state belongs in SQLite. User-authored specialist markdown, prompts,
  reference docs, and skill definitions remain file-backed.
- Keep durable Collaboration project tracking in `docs/collaboration/project/`, not in local scratch
  files or transient chat context.
- Model-specific instructions are optional, user-authored per-model additions. Forge does not provide
  built-in model-specific instruction defaults.
- Forge Desktop's Automatic Browser is a local Builder capability, not a Skill. An enabled and
  authenticated Forge extension grants profile-wide access to eligible ordinary Chrome tabs;
  `browser_status` exposes a bounded inventory transiently to the manager/model path, not Browser
  workspace UI or canonical renderer state, and `browser_open` can select an inventory tab ID or the
  active/most-recent eligible tab without OS focus. Non-open operations remain sticky, and possibly
  mutating operations are never replayed during fallback. The capability is not forwarded to
  Remote Projects or Collaboration. Browser recording and saved browser artifacts remain embedded-only.

## Safety

- Never run destructive Git operations such as `git reset --hard`, `git push --force`, or rebase of a
  protected branch without first verifying local and remote state. If unpushed work exists, preserve it
  on a branch or worktree. Do not push unless the user requests it.
- For Collaboration SQLite schema or migration work, follow the
  [migration policy](docs/collaboration/DEVELOPMENT.md#sqlite-migration-policy). Migrations must not
  delete, overwrite, or normalize user-authored file-backed content.
- Treat authentication data, credential-pool files, exported connector artifacts, and session data as
  sensitive. Do not print secrets or copy sensitive payloads into chat, fixtures, or committed docs.
- Desktop release work must follow `apps/electron/README.md`. Build and validate before publishing,
  use the draft-first beta-first workflow, and never treat validation branches as published releases. Forge
  Desktop supports published releases on macOS and Windows only; Linux `dir` packaging is experimental,
  local-only, and non-publishable.
- Keep source/server, development, CLI, and configuration portability intact on macOS, Linux, and Windows.
  Use Node path APIs, `os.tmpdir()`, guarded signal handling, and graceful `ENOENT`/permission-error
  handling instead of platform assumptions.

## Validation

Validation must match the changed surface and its downstream consumers. Follow `docs/QUALITY.md` for
the current command definitions.

- Start with explicit targeted Vitest files for changed behavior. Avoid loose filters that accidentally
  launch broad suites.
- Use `pnpm quality:quick` for small focused changes, `pnpm quality:changed` for normal pre-merge
  validation, and `pnpm quality:full` for broad, structural, release, or cross-package work.
- Protocol/API changes require targeted protocol, backend handler, and UI client/consumer tests.
- Persistence changes require write/read/restart or migration coverage, not only unit checks of the
  serializer.
- UI event changes require both live-event and replay/bootstrap coverage when both paths consume the
  behavior.
- Platform-specific changes require validation of the affected platform path; state any platform that
  could not be exercised.
- In-app help changes require `pnpm help:validate` plus the routed UI quality check described by the
  local help instructions.
- Run `git diff --check` before handoff. Report every validation command run, any failure, and anything
  not run with the reason.

Focused Vitest examples:

```bash
cd apps/backend && pnpm exec vitest run src/path/to/test.ts
cd apps/ui && pnpm exec vitest run src/path/to/test.ts
cd packages/protocol && pnpm exec vitest run src/path/to/test.ts
```

## Local instruction index

- [`apps/backend/src/swarm/AGENTS.md`](apps/backend/src/swarm/AGENTS.md) — orchestration boundaries and runtime invariants.
- [`apps/backend/src/ws/AGENTS.md`](apps/backend/src/ws/AGENTS.md) — HTTP/WebSocket composition and import rules.
- [`apps/backend/src/terminal/AGENTS.md`](apps/backend/src/terminal/AGENTS.md) — terminal persistence, lifecycle, and access rules.
- [`apps/ui/AGENTS.md`](apps/ui/AGENTS.md) — shared UI conventions.
- [`apps/ui/src/components/chat/AGENTS.md`](apps/ui/src/components/chat/AGENTS.md) — chat component boundaries.
- [`apps/ui/src/components/settings/AGENTS.md`](apps/ui/src/components/settings/AGENTS.md) — settings component boundaries.
- [`apps/ui/src/components/help/AGENTS.md`](apps/ui/src/components/help/AGENTS.md) — in-app help authoring and validation.
- [`apps/ui/src/lib/AGENTS.md`](apps/ui/src/lib/AGENTS.md) — client infrastructure and WebSocket state.
- [`packages/protocol/AGENTS.md`](packages/protocol/AGENTS.md) — shared contract compatibility and consumer validation.
