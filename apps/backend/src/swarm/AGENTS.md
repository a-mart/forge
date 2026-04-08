# Swarm backend context

## Ownership boundaries

`SwarmManager` is the facade and orchestration root for this directory. It coordinates the extracted services below and owns the public API that other backend modules call into. Service code should stay behind that facade unless a consumer is explicitly updated with it.

## Service inventory

- `swarm-settings-service.ts` - manager model and CWD updates, plus related runtime recycle policy.
- `swarm-choice-service.ts` - pending choice requests, resolution, cancellation, and user-choice events.
- `swarm-session-meta-service.ts` - session manifest/meta hydration, boot backfill, and initial meta writes.
- `swarm-memory-merge-service.ts` - session memory merge flow, audit logging, and profile memory writes.
- `swarm-prompt-service.ts` - prompt preview and runtime prompt assembly for managers, workers, and specialists.
- `swarm-cortex-service.ts` - Cortex review/run lifecycle, closeout reminders, and Cortex-specific session handling.
- `session-provisioner.ts` - session creation/disposal plumbing, file setup, rollback, and runtime bootstrap/teardown.
- `swarm-session-service.ts` - session create/delete/clear/fork orchestration and session-level lifecycle events.
- `swarm-project-agent-service.ts` - project-agent promotion, persistence, and project-agent lifecycle updates.
- `swarm-agent-lifecycle-service.ts` - manager/worker stop, resume, spawn, rename, pin, and runtime lifecycle coordination.
- `swarm-runtime-controller.ts` - runtime event handling, message/tool/status routing, and shutdown/recovery coordination.
- `swarm-specialist-fallback-manager.ts` - specialist fallback selection, replay, and handoff recovery.
- `swarm-worker-health-service.ts` - worker watchdog, stall detection, idle-turn finalization, and completion reporting.
- `swarm-manager-utils.ts` - shared helpers, normalizers, formatters, and invariant-preserving utility code.

## Import directions

- Services may import from `types.ts`, `runtime-contracts.ts`, and `swarm-manager-utils.ts`, plus other non-service helpers in this directory.
- `SwarmManager` may import and compose the services.
- Services must not import from each other directly. If a service needs another service's behavior, route the call through `SwarmManager` or a shared helper instead.

## Subdirectory layout

- `runtime/` - runtime integrations, including `pi/`, `claude/`, and `codex/`.
- `agents/` - agent definitions and specialist-related helpers, including `specialists/`.
- `storage/` - disk-backed persistence helpers.
- `catalog/` - model catalog and projection helpers.
- `skills/` - skill metadata, discovery, and file access helpers.
- `prompts/` - prompt assets and prompt-resolution helpers.
- `session/` - session/file-manifest helpers and session-scoped persistence logic.

## Stable facades

Treat the `SwarmManager` public API as stable. Any signature or behavior change must be reflected in all consumers in backend routes, websocket handlers, services, and tests before it lands.

## Dangerous invariants

- The runtime callback quartet must stay together: `onStatusChange`, `onSessionEvent`, `onAgentEnd`, and `onRuntimeError`.
- Boot ordering matters. Session/meta hydration, prompt/runtime setup, and lifecycle recovery are intentionally sequenced; do not reorder casually.
- Specialist fallback replay must preserve buffered callbacks and prepared replay snapshots so the replacement runtime sees the same work stream.

## Tests to update

When changing this area, check the related coverage in:

- `apps/backend/src/swarm/__tests__/runtime-factory.test.ts`
- `apps/backend/src/swarm/__tests__/swarm-manager-model-registry.test.ts`
- `apps/backend/src/swarm/__tests__/swarm-manager-project-agent-regressions.test.ts`
- `apps/backend/src/swarm/__tests__/claude-session-lifecycle.test.ts`
- `apps/backend/src/swarm/__tests__/project-agents-send-message.test.ts`
- `apps/backend/src/swarm/__tests__/session-manifest.test.ts`
- `apps/backend/src/swarm/__tests__/worker-stall-detector.test.ts`
