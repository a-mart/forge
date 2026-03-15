# Cortex Memory v2 — Phase 4 Status

## Landed
- Replaced raw-append fallback semantics for canonical profile summary memory.
  - Non-empty profile-memory merges now either:
    - apply a curated merge,
    - skip safely (`template_noop`, `idempotent_noop`, `no_change`), or
    - fail closed without mutating `profiles/<profileId>/memory.md`.
- Folded in both Phase 4 review remediations:
  - Opus: explicit `seed` coverage, `no_change` coverage, retry-after-failure coverage, dead raw-append helper removal, and tighter emitted failure contract.
  - Codex: audit-write failures are now explicit (not best-effort/silent), non-LLM failure stages now record failed-attempt metadata, and websocket failure events include recovery diagnostics when available.
- Added merge-attempt tracking in session meta:
  - `memoryMergeAttemptCount`
  - `lastMemoryMergeAttemptAt`
  - `lastMemoryMergeAppliedAt`
  - `lastMemoryMergeStatus`
  - `lastMemoryMergeStrategy`
  - `lastMemoryMergeSourceHash`
  - `lastMemoryMergeError`
- Added richer profile audit entries in `profiles/<profileId>/merge-audit.log`:
  - `attemptId`, status/strategy, source/profile hashes, appliedChange, model, optional error/stage.
- Hardened websocket/UI flow so merge requests resolve on final outcome instead of the initial started event.
  - `session_memory_merged` now carries `status`, `strategy`, `mergedAt`, and `auditPath`.
  - `session_memory_merge_failed` now rejects the pending client request and includes `strategy` / `stage` / `auditPath` when available.
- Added explicit failure-stage tracking in session meta:
  - `lastMemoryMergeFailureStage`
  - `lastMemoryMergeAppliedSourceHash`

## Remaining
- Re-run the remaining isolated migrate/fresh runtime validation pass to close the outstanding Phase 3 evidence lane with the Phase 4 patch stack included.
- Extend reference-doc provisioning/write helpers into actual Cortex promotion/write-back flows.
- Decide whether any additional Phase 5 profile-level audit/review files are still needed beyond session meta + profile merge audit logs.

## Files changed
- `apps/backend/src/swarm/swarm-manager.ts`
- `apps/backend/src/swarm/session-manifest.ts`
- `apps/backend/src/ws/routes/session-routes.ts`
- `apps/backend/src/test/swarm-manager.test.ts`
- `apps/backend/src/test/ws-server.test.ts`
- `packages/protocol/src/shared-types.ts`
- `packages/protocol/src/server-events.ts`
- `apps/ui/src/lib/ws-client.ts`
- `apps/ui/src/routes/index.tsx`
- `planning/cortex-memory-v2/{STATUS,TASKS,TESTING,DECISIONS,IMPLEMENTATION_NOTES}.md`

## Focused tests run
- `cd apps/backend && pnpm exec vitest run src/test/swarm-manager.test.ts -t "mergeSessionMemory"`
- `cd apps/backend && pnpm exec vitest run src/test/ws-server.test.ts -t "session lifecycle websocket commands|session_memory_merge_failed"`
- `cd apps/backend && pnpm exec vitest run src/swarm/__tests__/session-manifest.test.ts`
- `pnpm --filter @middleman/protocol build`
- `cd apps/backend && pnpm exec tsc -p tsconfig.build.json --noEmit`
- `cd apps/ui && pnpm exec tsc --noEmit`

Key newly covered cases:
- direct `seed` strategy
- `no_change` skip semantics
- retry-after-failure idempotency exemption
- explicit `write_audit` failure surfacing
- explicit `record_attempt` failure fallback/meta persistence
- explicit `save_store` failure recording + audit entry
- websocket failure diagnostics (`strategy`, `stage`, `auditPath`)

## Notes
- A broader `ws-server.test.ts` run hit an unrelated pre-existing/flaky control-pid-file test (`writes and removes its control pid file across start/stop`). The Phase 4-targeted websocket coverage passed.
