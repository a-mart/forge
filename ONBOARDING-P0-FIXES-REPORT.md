# Onboarding P0 Fixes Report

## Scope
Fixed two P0 onboarding issues in the backend:
1. Character encoding corruption in Cortex onboarding copy
2. `save_onboarding_facts` / `set_onboarding_status` cycleId/baseRevision retry thrash

## Findings
1. The backend serialization path is already Unicode-safe:
   - `publishToUser()` emits plain JS strings into `conversation_message` payloads.
   - session JSONL persistence uses `JSON.stringify(...)+"\n"` with explicit `utf8` writes.
   - WebSocket delivery also uses `JSON.stringify(event)` and sends the serialized string directly.
2. The most likely source of the visible onboarding corruption was the onboarding copy itself containing em dashes / smart punctuation that were being rendered or copied badly in the affected path.
3. The onboarding save/status tools required `cycleId` and `baseRevision`, forcing the model to guess CAS state and hit avoidable `stale_cycle` / `stale_revision` failures.
4. Existing onboarding greeting tests were asserting runtime dispatch behavior that no longer matches the static-greeting implementation. I updated them to assert the actual persisted/broadcast user-visible greeting instead.

## Changes

### 1) Encoding-safe onboarding copy
Updated onboarding-facing prompt/content to ASCII punctuation for the affected surfaces:
- `apps/backend/src/swarm/swarm-manager.ts`
- `apps/backend/src/swarm/operational/builtins/bootstrap.md`
- `apps/backend/src/swarm/operational/cortex-onboarding.md`

Key changes:
- replaced em dashes with `-`
- replaced curly quotes/apostrophes in onboarding examples with plain ASCII quotes/apostrophes
- updated the static Cortex onboarding greeting to use ASCII punctuation

### 2) Auto-resolved onboarding CAS state
Updated onboarding tool plumbing so the model no longer has to guess CAS inputs:
- `apps/backend/src/swarm/swarm-tools.ts`
- `apps/backend/src/swarm/swarm-manager.ts`

Behavior now:
- `cycleId` and `baseRevision` are optional in tool schemas
- if omitted, backend resolves the current onboarding snapshot automatically
- manager-side tool host retries once when CAS was auto-resolved and a concurrent stale result occurs
- stale tool responses now include the current `cycleId` and `revision` in the tool text for easier recovery when callers do pass explicit stale CAS inputs

## Test Coverage Added/Updated
- `apps/backend/src/test/swarm-tools.test.ts`
  - verifies onboarding tools can omit `cycleId` / `baseRevision`
- `apps/backend/src/test/swarm-manager.test.ts`
  - verifies manager-side onboarding saves auto-resolve CAS inputs
  - verifies Unicode `speak_to_user` text survives JSONL persistence/reload
  - updates auto-greeting test to assert the real persisted greeting behavior
- `apps/backend/src/test/ws-server.test.ts`
  - verifies Unicode text survives WebSocket delivery
  - updates onboarding subscribe test to assert the real broadcast greeting behavior

## Validation Run
### Tests
```bash
cd apps/backend && pnpm exec vitest run src/test/swarm-tools.test.ts src/test/swarm-manager.test.ts src/test/ws-server.test.ts src/test/onboarding-state.test.ts
```
Passed.

### Typechecks
```bash
cd apps/backend && pnpm exec tsc -p tsconfig.build.json --noEmit
cd apps/ui && pnpm exec tsc --noEmit
```
Passed.

## Files Changed
- `apps/backend/src/swarm/swarm-manager.ts`
- `apps/backend/src/swarm/swarm-tools.ts`
- `apps/backend/src/swarm/operational/builtins/bootstrap.md`
- `apps/backend/src/swarm/operational/cortex-onboarding.md`
- `apps/backend/src/test/swarm-manager.test.ts`
- `apps/backend/src/test/swarm-tools.test.ts`
- `apps/backend/src/test/ws-server.test.ts`

## Notes
- I did not touch unrelated untracked onboarding report artifacts already present in the repo root.
- The underlying serialization path appears healthy; the P0 user-visible fix is the onboarding-copy sanitization plus CAS auto-resolution.
