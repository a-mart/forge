# Manager Isolation Map

This document maps current storage/runtime boundaries in the swarm backend, based on:

- `apps/backend/src/config.ts`
- `apps/backend/src/swarm/swarm-manager.ts`
- `apps/backend/src/integrations/registry.ts`
- `apps/backend/src/scheduler/cron-scheduler-service.ts`
- `apps/backend/src/scheduler/schedule-storage.ts`
- `apps/backend/src/ws/server.ts`
- `apps/backend/src/swarm/agent-runtime.ts`
- `apps/backend/src/swarm/codex-agent-runtime.ts`
- `apps/backend/src/swarm/archetypes/*`
- `apps/backend/src/swarm/skills/*`

Conventions used below:

- `dataDir` means `config.paths.dataDir` (for example `~/.middleman` in prod or `~/.middleman-dev` in dev).
- "Isolated" means scoped by manager/agent identity in code and file layout.
- "Shared" means one backing resource is used by all managers.

## 1) Per-Manager (Isolated)

| Resource | Data location | Managed by | Isolation reality |
| --- | --- | --- | --- |
| Manager-owned workers (ownership model) | `dataDir/swarm/agents.json` (`AgentDescriptor.managerId`), runtime maps in memory | `SwarmManager.createManager`, `SwarmManager.spawnAgent`, `SwarmManager.killAgent`, WS command routing in `ws/server.ts` | Worker control is manager-scoped at runtime. `kill_agent` and manager->worker messaging enforce ownership (`target.managerId === sender.agentId`). |
| Manager session history | `dataDir/sessions/<managerId>.jsonl` | `SwarmManager.createManager`, `prepareDescriptorsForBoot`, runtime creation (`SessionManager.open(descriptor.sessionFile)`) in `swarm-manager.ts`; session consumption in `agent-runtime.ts` and `codex-agent-runtime.ts` | Isolated by manager `agentId` file name. |
| Worker session history | `dataDir/sessions/<workerId>.jsonl` | `SwarmManager.spawnAgent`, runtime creation in `swarm-manager.ts`; session consumption in `agent-runtime.ts` and `codex-agent-runtime.ts` | Isolated by worker `agentId` file name (worker carries owning `managerId` in descriptor). |
| Per-manager persistent memory | `dataDir/memory/<managerId>.md` | `SwarmManager.ensureMemoryFilesForBoot/getMemoryRuntimeResources`; built-in memory skill | Managers load their own memory file. Workers load their owning manager's memory file. |
| Per-manager cron schedules | `dataDir/schedules/<managerId>.json` | Pathing/migration in `schedule-storage.ts`; execution in `CronSchedulerService` (`managerId` option, dispatches to `handleUserMessage(... targetAgentId: managerId)`); scheduler fan-out in `index.ts` | File and execution target are manager-scoped. |
| Per-manager Slack profile | `dataDir/integrations/managers/<managerId>/slack.json` | `integrations/registry.ts` + `integrations/slack/slack-config.ts` + `SlackIntegrationService` | Scoped per manager by directory and profile ID (`slack:<managerId>`). |
| Per-manager Telegram profile | `dataDir/integrations/managers/<managerId>/telegram.json` | `integrations/registry.ts` + `integrations/telegram/telegram-config.ts` + `TelegramIntegrationService` | Scoped per manager by directory and profile ID (`telegram:<managerId>`). |
| Manager-targeted API views (schedules/integrations) | `/api/managers/:managerId/schedules`, `/api/managers/:managerId/integrations/slack`, `/api/managers/:managerId/integrations/telegram` | Route resolution and manager existence checks in `ws/server.ts` | Request surface is manager-scoped when using manager-specific endpoints. |

## 2) Shared (Global)

| Resource | Data location | Managed by | Isolation reality |
| --- | --- | --- | --- |
| Base config/env | Process env + `createConfig()` output | `config.ts` | Global process-wide settings (host/port, roots, default model, `dataDir`, etc.). |
| Agent registry metadata (all managers/workers) | `dataDir/swarm/agents.json` | `SwarmManager.loadStore/saveStore` | Single shared file for all manager + worker descriptors. |
| Auth credentials (provider tokens/OAuth) | `dataDir/auth/auth.json` (default) | `SwarmManager.listSettingsAuth/updateSettingsAuth/deleteSettingsAuth`; OAuth login flow in `ws/server.ts` | Shared across all managers. No per-manager auth file. |
| Environment secrets | `dataDir/secrets.json` + injected into `process.env` | `SwarmManager.loadSecretsStore/saveSecretsStore` | Shared across all managers/workers (single secrets map, process-global env mutation). |
| Skills (built-in + repo override) | Built-ins under `apps/backend/src/swarm/skills/builtins/*`; repo overrides at `.swarm/skills/*/SKILL.md` (resolved from repo root) | Skill path resolution and metadata loading in `SwarmManager.resolve*SkillPath/reloadSkillMetadata` | Shared skill set/metadata for all managers and workers. |
| Archetype prompts (built-in + repo override) | Built-ins under `apps/backend/src/swarm/archetypes/builtins/*.md`; repo overrides at `.swarm/archetypes/*.md` | `loadArchetypePromptRegistry` + `SwarmManager.resolveSystemPromptForDescriptor` | Shared prompt registry loaded once; all managers/workers draw from same registry. |
| Uploads directory (web attachment persistence) | `dataDir/uploads/*` | `persistConversationAttachments(...)` in `ws/server.ts` | Shared flat directory (no manager partition). |
| Binary attachment spill files (runtime-generated) | `dataDir/attachments/<agentId>/<batchId>/*` | `SwarmManager.createBinaryAttachmentDir/writeBinaryAttachmentToDisk` | Shared root; subscoped by target agent ID, not manager directory. |
| Pi runtime agent directories | `dataDir/agent` (workers), `dataDir/agent/manager` (all managers) | `SwarmManager.createPiRuntimeForDescriptor` | Shared by role class (all managers share one manager agent dir; all workers share one worker agent dir). |
| Legacy default-manager API aliases | `/api/schedules`, `/api/integrations/slack`, `/api/integrations/telegram`, `/api/settings/slack`, `/api/settings/telegram` | Route resolvers in `ws/server.ts` map these to configured default manager ID | Shared entrypoints that implicitly target one default manager. |

## 3) Ambiguous / Could Be Improved

These are current-state separation concerns (not proposals), where scope boundaries are soft or surprising.

| Concern | Current behavior | Why separation is fuzzy |
| --- | --- | --- |
| Session files survive manager/worker deletion | `deleteManager`/`killAgent` terminate runtimes and remove descriptors, but do not delete `sessions/<agentId>.jsonl` | If an ID is reused later, previous session history can be resumed from disk, crossing lifecycle boundaries. |
| Schedule and integration files survive manager deletion | Deleting manager does not remove `schedules/<managerId>.json` or `integrations/managers/<managerId>/*` | Recreating same manager ID reuses prior schedules/integration config state. |
| Integration registry bootstraps from disk manager folders | `IntegrationRegistryService.start()` discovers manager IDs from both live agents and `integrations/managers/*` directories | Orphaned manager integration profiles can remain active even when manager descriptor is gone. |
| Upload storage is global and unpartitioned | Web attachments are persisted in one shared `uploads/` directory | No manager or agent partition in file layout; ownership is contextual, not filesystem-enforced. |
| Secrets/auth are process-global | `secrets.json` populates `process.env`; auth uses single `auth.json` | Managers cannot have independent env secret sets or auth credential stores. |
| Worker memory aliases manager memory | Worker runtimes load `memory/<managerId>.md` instead of `memory/<workerId>.md` | Worker memory context is intentionally shared with the owning manager for short-lived execution. |
| Config includes a single `paths.schedulesFile` | `config.ts` sets `paths.schedulesFile` for default manager, while runtime scheduler logic uses per-manager `getScheduleFilePath(...)` | The config surface still presents a single-manager schedule file path even in multi-manager operation. |
