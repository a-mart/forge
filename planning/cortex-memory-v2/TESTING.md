# Cortex Memory v2 — Testing Matrix

## Scenarios

### 1. Existing-data migration
- Data dir: `/Users/adam/.middleman-cortex-memory-v2-migrate`
- Goal: verify migration-safe rollout using a copy of the current real environment
- Must validate:
  - boot succeeds
  - existing sessions load
  - Cortex scan still works
  - profile/session memory behavior remains coherent
  - no writes hit production `~/.middleman`

### 2. Net-new environment
- Data dir: `/Users/adam/.middleman-cortex-memory-v2-fresh`
- Goal: verify clean first-boot behavior for the redesigned model
- Must validate:
  - expected dirs/files created
  - no legacy profile-knowledge dependency
  - session creation works
  - memory/reference paths behave correctly

### 3. Runtime regression
- Create session
- Send message
- Verify response
- Stop/resume behavior if impacted
- Validate scan/review state if impacted

## Required Validation Types
- Unit tests
- Focused integration tests
- Medium-reasoning E2E workers running start-to-finish flows
- Backend typecheck
- UI typecheck

## Notes
- Keep ports isolated from production
- Prefer copied data dirs + dedicated worktree only
- Record exact commands and results here as execution progresses
