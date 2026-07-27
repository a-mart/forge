# Swarm backend context

## Ownership boundaries

`SwarmManager` is the facade and orchestration root for this directory. It coordinates the extracted services below and owns the public API that other backend modules call into. Service code should stay behind that facade unless a consumer is explicitly updated with it.

The tracked post-decomposition architecture backlog is
[`docs/SWARM_MANAGER_ARCHITECTURE_FOLLOW_UPS.md`](../../../../docs/SWARM_MANAGER_ARCHITECTURE_FOLLOW_UPS.md).
Treat those items as separate follow-up changes, not reasons to broaden unrelated work.

## Service inventory

- `agent-directory.ts` - read-only live registry projections, deterministic ordering, manager/worker visibility, session lookups, archive guards, and collision-free agent identity allocation.
- `agents/descriptor-store/live-map-adapter.ts` - transactional and live-map-only descriptor/profile mutations bound to the durable descriptor store, including rollback and best-effort save policy.
- `profile-session-bookkeeping-coordinator.ts` - profile naming/order persistence and append-only session rename history.
- `manager-bootstrap-coordinator.ts` - manager project onboarding, Agent Architect seed-context injection, and operational prompt fallback policy.
- `swarm-configuration-coordinator.ts` - application-level model, skill, secret, directory, prompt-resource, and prompt-preview configuration; composes the focused settings and prompt owners and retains generated model-projection/cache state.
- `swarm-settings-service.ts` - manager model and CWD updates, plus related runtime recycle policy.
- `swarm-choice-service.ts` - pending choice requests, resolution, cancellation, and user-choice events.
- `session-interaction-coordinator.ts` - interactive manager command policy and cross-service ordering for working plans, choice continuations, agent spawn/kill, user publication, and conversation reset.
- `swarm-manager-facade.ts` / `swarm-manager-facade-services.ts` - the single stateless inherited application API and its explicit typed capability map; delegates to focused owners while `SwarmManager` remains the composition root. Runtime-controller host callbacks, mutable worker-health maps, and test-only seams stay on their owners rather than becoming facade API.
- `swarm-manager-delegation-facade.ts` - posture and delegation-roster settings surface layered into the public manager facade without widening the composition root.
- `swarm-session-meta-service.ts` - session manifest/meta hydration, boot backfill, and initial meta writes.
- `conversation-attachment-service.ts` - inbound attachment normalization, persistence, runtime projection, and binary artifact writes.
- `user-message-coordinator.ts` - inbound user-message target/reply resolution, canonical conversation append, route short-circuits, and manager/worker runtime dispatch transaction ordering.
- `agent-message-dispatcher.ts` - manager/peer delivery validation, asynchronous worker assignment/result queueing, observability roots, message receipts, and runtime send rollback.
- `assistant-output-router.ts` - manager final-output routing, explicit user publication, and typed internal-result suppression.
- `worker-result-coordinator.ts` - terminal worker-result extraction and automatic delivery to the owning manager.
- `turn-context-coordinator.ts` - queued inbound-turn identity, runtime activation, Codex delegation gates, observability turn roots, and rollback cleanup.
- `swarm-event-coordinator.ts` - server-event projection, snapshot versioning, activity bookkeeping, and conversation/status publication.
- `restart-recovery-coordinator.ts` - boot recovery snapshot creation, single-claim resume delivery, and dismissal.
- `swarm-observability-coordinator.ts` - runtime/input/tool/lifecycle trace coordination with bounded fail-open projection.
- `swarm-compaction-coordinator.ts` - runtime compaction orchestration, retry/recovery state, and capture/plan lifecycle hooks.
- `prompt-resource-coordinator.ts` - prompt, specialist, reference, skill, extension, and executable-resource resolution for runtime creation.
- `collaboration-storage-provisioner.ts` - Collaboration-specific profile/session storage provisioning and system prompt persistence.
- `session-pin-coordinator.ts` - message-pin indexes, persistence/runtime synchronization, fork filtering, disposal, and sidebar pin mutations.
- `project-executable-trust-coordinator.ts` - executable-resource trust prompts, deferred activation, propagation, and runtime-boundary refresh policy.
- `codex-app-server/codex-plugin-delegation-coordinator.ts` - selector-scoped Codex Plugin delegation, retry authorization, worker scope, catalog/tool access, export, and cleanup lifecycle.
- `codex-app-server/codex-plugin-artifact-files.ts` - collision-safe artifact and manifest file writes for scoped Codex Plugin exports.
- `swarm-memory-merge-service.ts` - session memory merge flow, audit logging, and profile memory writes.
- `swarm-prompt-service.ts` - prompt preview and runtime prompt assembly for managers, workers, and specialists.
- `swarm-cortex-service.ts` - Cortex review/run lifecycle, closeout reminders, and Cortex-specific session handling.
- `session-provisioner.ts` - session creation/disposal plumbing, file setup, rollback, and runtime bootstrap/teardown.
- `session-descriptor-factory.ts` - reserved identity checks, numeric and slug collision policy, and new manager-session descriptor construction.
- `agents/descriptor-store/profile-boot-reconciler.ts` - boot-time profile/manager relationship repair, disabled-Cortex pruning, and system-profile type normalization.
- `agents/descriptor-store/worker-boot-recovery.ts` - persisted worker-cache sidecar pruning and terminated worker reconstruction from canonical transcript headers.
- `swarm-boot-coordinator.ts` - ordered boot transaction across persisted reconciliation, recovery, session metadata, runtime restoration, publication, and health startup.
- `session-lifecycle-coordinator.ts` - application-level create, archive, restore, stop, delete, clear, rename, and fork sequencing across focused session services and cleanup/notification hooks.
- `project-agent-coordinator.ts` - Project Agent promotion/activation, configuration and references, sharing-directory projection, recommendation analysis, repository-source preflight, runtime recycling, and notification fan-out across the storage and sharing services.
- `swarm-session-service.ts` - session create/delete/clear/fork orchestration and session-level lifecycle events.
- `swarm-project-agent-service.ts` - project-agent promotion, persistence, and project-agent lifecycle updates.
- `swarm-agent-lifecycle-service.ts` - manager/worker stop, resume, spawn, rename, pin, and runtime lifecycle coordination.
- `swarm-runtime-controller.ts` - runtime event handling, message/tool/status routing, and shutdown/recovery coordination.
- `swarm-runtime-controller-host-adapter.ts` - compiler-checked, lazy-safe adapter between the manager facade and runtime controller.
- `swarm-manager-runtime-composition.ts` - explicit three-phase runtime composition root for controller/health/fallback, planning/compaction, and turn/lifecycle/trust/session/boot completion; preserves the constructor's late-bound callback order.
- `swarm-specialist-fallback-manager.ts` - specialist fallback selection, replay, and handoff recovery.
- `swarm-worker-health-service.ts` - worker stall detection and transient runtime-error grace handling.
- `planning/session-plan-coordinator.ts` - live plan state, persistence, usage accounting, summary projection, and runtime context.
- `capture-cascade-coordinator.ts` - Cortex capture cadence, watermarks, judge decisions, and temporary capture-fork lifecycle.
- `knowledge-memory-coordinator.ts` - application-level knowledge, Cortex, capture, session-memory, session-meta boot, and compaction-settings policy; composes the focused state owners without reimplementing them.
- `swarm-manager-utils.ts` - shared helpers, normalizers, formatters, and invariant-preserving utility code.

## Import directions

- Leaf policies, repositories, and state owners may import shared types and lower-level helpers.
- Application coordinators may depend on leaf capabilities through explicit, narrow interfaces.
- Sibling state owners must not reach into one another's mutable state, and service imports must not create cycles.
- Mutation ports must say whether they update live maps only or durable state; preserve the adapter's `...InLiveMaps` naming when extracting or consolidating these interfaces.
- `SwarmManager` composes the graph and preserves the public facade; it should not broker ordinary internal calls that belong in a cohesive coordinator.
- `swarm-manager-foundation.ts` owns acyclic low-level construction; `swarm-manager-session-composition.ts` owns session/archive/Project Agent service construction. Keep their inputs as explicit capability groups and preserve their documented initialization order.
- Do not add feature-specific mutable collections or multi-step workflows directly to `SwarmManager`. Add them to one explicit owner behind the facade.

## Subdirectory layout

- `runtime/` - runtime integrations, including `pi/`, `claude/`, and `codex/`.
- `agents/` - agent definitions and specialist-related helpers, including `specialists/`.
- `storage/` - disk-backed persistence helpers.
- `catalog/` - model catalog and projection helpers.
- `skills/` - skill metadata, discovery, and file access helpers.
- `prompts/` - prompt assets and prompt-resolution helpers.
- `session/` - session/file-manifest helpers and session-scoped persistence logic.

## Stable facades

Treat the explicit `SwarmManagerFacade` application API as stable. Any signature or behavior change must be reflected in all consumers in backend routes, websocket handlers, services, and tests before it lands. Do not infer a supported facade contract from incidental default-public members on the composition root: controller-host callbacks, mutable owner state, and test diagnostics are internal and must remain behind narrow capabilities.

## Dangerous invariants

- The runtime callback quartet must stay together: `onStatusChange`, `onSessionEvent`, `onAgentEnd`, and `onRuntimeError`.
- Boot ordering matters. Session/meta hydration, prompt/runtime setup, and lifecycle recovery are intentionally sequenced; do not reorder casually.
- Specialist fallback replay must preserve buffered callbacks and prepared replay snapshots so the replacement runtime sees the same work stream.
- The `SwarmManager` file and constructor ESLint budgets are ratchets. Lower them after extractions; do not raise them to land a feature.

## Tests to update

When changing this area, check the related coverage in:

- `apps/backend/src/swarm/__tests__/runtime-factory.test.ts`
- `apps/backend/src/swarm/__tests__/session-plan-coordinator.test.ts`
- `apps/backend/src/swarm/__tests__/capture-cascade-coordinator.test.ts`
- `apps/backend/src/swarm/__tests__/codex-plugin-delegation-coordinator.test.ts`
- `apps/backend/src/swarm/__tests__/user-message-coordinator.test.ts`
- `apps/backend/src/swarm/__tests__/swarm-manager-restart-recovery.characterization.test.ts`
- `apps/backend/src/swarm/__tests__/swarm-runtime-controller-host-adapter.test.ts`
- `apps/backend/src/swarm/__tests__/swarm-manager-model-registry.test.ts`
- `apps/backend/src/swarm/__tests__/swarm-manager-project-agent-regressions.test.ts`
- `apps/backend/src/swarm/__tests__/claude-session-lifecycle.test.ts`
- `apps/backend/src/swarm/__tests__/project-agents-send-message.test.ts`
- `apps/backend/src/swarm/__tests__/project-agent-coordinator.test.ts`
- `apps/backend/src/swarm/__tests__/session-manifest.test.ts`
- `apps/backend/src/swarm/__tests__/worker-stall-detector.test.ts`
