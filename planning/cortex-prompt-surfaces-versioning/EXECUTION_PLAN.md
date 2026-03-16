# Cortex Prompt Surfaces + Embedded Git Versioning Execution Plan

## Scope
Two coordinated features in the main repo on branch `feat/cortex-prompt-surfaces-versioning`:
1. Cortex prompt-surface expansion in Settings
2. Embedded Git versioning for durable data-dir memory/knowledge/prompt files

Version-history UI is explicitly deferred to a later Phase 3.

## Delivery Strategy
Because both efforts touch prompt/file plumbing in the same checkout, implementation runs sequentially in one branch, while review/remediation lanes run in parallel around each phase.

## Phase 1 — Cortex Prompt Surfaces
### Goal
Expose Cortex live + seed prompt/context surfaces in Settings without changing the core prompt-registry model.

### Primary implementation lane
- Implement additive backend surface model and routes
- Implement UI grouping/rendering for Cortex surfaces
- Keep non-Cortex Settings flow stable
- Reuse a shared tracked Cortex file write path for live-file edits

### Expected file targets
- `apps/backend/src/ws/routes/prompt-routes.ts`
- `apps/backend/src/ws/routes/file-routes.ts`
- `apps/backend/src/swarm/cortex-prompt-surfaces.ts` (new)
- `packages/protocol/src/shared-types.ts`
- `packages/protocol/src/server-events.ts`
- `apps/ui/src/components/settings/SettingsPrompts.tsx`
- `apps/ui/src/components/settings/prompts/PromptEditor.tsx`
- `apps/ui/src/components/settings/prompts/prompt-api.ts`
- tests for backend routes + UI behavior

### Review process
- Reviewer A: Codex high
- Reviewer B: Opus high
- Remediation returns to primary implementation lane
- Validation: targeted prompt-route/UI tests, backend typecheck, UI typecheck

## Phase 2 — Embedded Git Versioning (backend only)
### Goal
Add automatic Git-backed versioning for durable data-dir memory/knowledge/prompt files.

### Primary implementation lane
- Add dedicated versioning service
- Add tracked-path allowlist + `.git/info/exclude` defense-in-depth
- Hook domain writers, generic file route, and agent write/edit tool path
- Add reconcile safety net
- Keep write flows fail-open

### Expected file targets
- `apps/backend/src/index.ts`
- `apps/backend/src/versioning/*` (new)
- `apps/backend/src/ws/routes/file-routes.ts`
- `apps/backend/src/swarm/prompt-registry.ts`
- `apps/backend/src/swarm/reference-docs.ts`
- `apps/backend/src/swarm/swarm-manager.ts`
- `apps/backend/src/swarm/agent-runtime.ts`
- backend tests for service + hook coverage

### Review process
- Reviewer A: Codex high
- Reviewer B: Opus high
- Remediation returns to primary implementation lane
- Validation: targeted versioning tests, backend typecheck, UI typecheck, then full backend `vitest run`

## Phase 3 — Deferred
- Version-history UI / diff / restore
- Broader knowledge-surface browser expansion beyond Cortex prompt surfaces

## Operating Rules
- Do not touch or stage unrelated untracked files like `RENAME-INVESTIGATION.md`
- Keep commits phase-scoped and reviewable
- Prefer additive APIs and low-churn changes over prompt-registry redesigns
- End each phase with review artifacts + clean validation evidence
