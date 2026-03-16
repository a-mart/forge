# Cortex Memory v2 — E2E Memory Merge Runtime (Dedicated Lane)

Date: 2026-03-15/16
Worktree: `/Users/adam/repos/middleman-worktrees/cortex-memory-v2`
Isolated data dir: `/Users/adam/.middleman-cortex-memory-v2-migrate`
Production data touched for writes: **No** (`~/.middleman` untouched)
Backend port used: `47587`

## Scope requested
Validate live-path behavior for:
1. session-local root memory ownership,
2. non-root session merge/promotion into canonical profile memory,
3. merge audit/meta evidence,
4. idempotent/fail-closed semantics (as far as practical in bounded runtime).

## Pre-read docs completed
- `planning/cortex-memory-v2/E2E_GOALS_RUBRIC.md`
- `planning/cortex-memory-v2/VALIDATION_PHASE3_REPORT.md`
- `planning/cortex-memory-v2/IMPLEMENTATION_NOTES.md`
- Runtime docs:
  - `planning/cortex-memory-v2/E2E_AUTH_RUNTIME_AUDIT.md`
  - `planning/cortex-memory-v2/E2E_FRESH_RUNTIME.md`
  - `planning/cortex-memory-v2/E2E_MIGRATE_RUNTIME.md`

## Exact commands executed

```bash
# 1) Start isolated backend only
mkdir -p .tmp
BACKEND_LOG=.tmp/e2e-memory-merge-backend.log
BACKEND_PID_FILE=.tmp/e2e-memory-merge-backend.pid
: > "$BACKEND_LOG"
MIDDLEMAN_HOST=127.0.0.1 \
MIDDLEMAN_PORT=47587 \
MIDDLEMAN_DATA_DIR=/Users/adam/.middleman-cortex-memory-v2-migrate \
NODE_ENV=production \
pnpm --filter @middleman/backend start >>"$BACKEND_LOG" 2>&1 &
PID=$!
echo "$PID" > "$BACKEND_PID_FILE"
for i in {1..30}; do
  code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:47587/api/health || true)
  if [ "$code" = "200" ]; then echo "ready pid=$PID"; break; fi
  sleep 1
done

# 2) Execute bounded WS+filesystem E2E scenario
node .tmp/e2e-memory-merge-runtime.mjs > .tmp/e2e-memory-merge-runtime-result.json

# 3) Required typechecks
cd apps/backend && pnpm exec tsc -p tsconfig.build.json --noEmit
cd apps/ui && pnpm exec tsc --noEmit

# 4) Cleanup
kill "$(cat .tmp/e2e-memory-merge-backend.pid)" 2>/dev/null || true
```

## Runtime scenario performed
Script used: `.tmp/e2e-memory-merge-runtime.mjs`

### WS/runtime actions
1. `subscribe`
2. `create_manager` (model preset `codex-app`) for profile `memv2-merge-e2e-1773625013892`
3. Root-session `user_message` attempt (real work probe)
4. `create_session` -> non-root session `memv2-merge-e2e-1773625013892--s2`
5. Non-root `user_message` attempt (real work probe)
6. `merge_session_memory` on non-root session (request 1)
7. `merge_session_memory` again unchanged (request 2)
8. `merge_session_memory` on root/default session (negative guard-path check)

### Deterministic memory-change method used
Because real work probes did not reliably yield assistant memory writes in this run (runtime steer/no-response issue), I used the practical deterministic equivalent:
- write explicit durable content to root session memory file,
- write explicit durable content to non-root session memory file,
- invoke real runtime merge command over WS.

This still exercises the live merge path, audit logging, and meta persistence.

## Evidence summary
Primary artifact: `.tmp/e2e-memory-merge-runtime-result.json`

### A) Root memory remains session-local (PASS)
- Profile memory path:
  - `/Users/adam/.middleman-cortex-memory-v2-migrate/profiles/memv2-merge-e2e-1773625013892/memory.md`
- Root session memory path:
  - `/Users/adam/.middleman-cortex-memory-v2-migrate/profiles/memv2-merge-e2e-1773625013892/sessions/memv2-merge-e2e-1773625013892/memory.md`

After writing root-session memory, profile hash stayed identical:
- `profileHashBefore = 17dc6449...`
- `profileHashAfterRootMemoryWrite = 17dc6449...`
- `profileUnchanged = true`

Root file changed independently:
- `rootChanged = true`

### B) Non-root session merge promotes into canonical profile memory (PASS)
Non-root memory file:
- `/Users/adam/.middleman-cortex-memory-v2-migrate/profiles/memv2-merge-e2e-1773625013892/sessions/memv2-merge-e2e-1773625013892--s2/memory.md`

Before merge, profile memory was explicitly set empty (bounded seed-path test).

`merge_session_memory` request 1 result:
- event: `session_memory_merged`
- `status: applied`
- `strategy: seed`
- `auditPath: .../merge-audit.log`

Profile memory after merge exactly matched promoted non-root session content.

### C) Idempotent semantics (PASS)
`merge_session_memory` request 2 (unchanged source/profile) result:
- event: `session_memory_merged`
- `status: skipped`
- `strategy: idempotent_noop`

Profile memory hash unchanged across merge 1 -> merge 2:
- `mergeProfileUnchangedOnSecondRun = true`

### D) Merge audit evidence (PASS)
Audit log path:
- `/Users/adam/.middleman-cortex-memory-v2-migrate/profiles/memv2-merge-e2e-1773625013892/merge-audit.log`

Observed JSONL entries:
1. `applied/seed` with before/after hashes
2. `skipped/idempotent_noop` with unchanged hashes

### E) Session meta merge evidence (PASS)
Session meta path:
- `/Users/adam/.middleman-cortex-memory-v2-migrate/profiles/memv2-merge-e2e-1773625013892/sessions/memv2-merge-e2e-1773625013892--s2/meta.json`

Observed fields populated/updated correctly:
- `memoryMergeAttemptCount: 2`
- `lastMemoryMergeStatus: skipped`
- `lastMemoryMergeStrategy: idempotent_noop`
- `lastMemoryMergeSourceHash`
- `lastMemoryMergeProfileHashBefore`
- `lastMemoryMergeProfileHashAfter`
- `lastMemoryMergeAttemptId`
- `lastMemoryMergeAppliedAt` persisted from applied run

### F) Fail-closed/guard behavior in live path (PARTIAL PASS)
Root/default session merge attempt:
- event: `session_memory_merge_failed`
- message: `Default session working memory merge is not supported...`
- canonical profile memory unchanged by failed root attempt (`profileChangedByRootMergeAttempt = false`)

This confirms guard-failure does not mutate profile memory.

## Before/after file state (key files)

### Before (captured via hashes)
- profile memory pre-root-write hash: `17dc6449...` (default scaffold state)
- root memory pre-write hash: `17dc6449...`

### After
- Profile memory (`profiles/<pid>/memory.md`): promoted non-root content
- Root memory (`profiles/<pid>/sessions/<pid>/memory.md`): independent root-only note
- Non-root memory (`profiles/<pid>/sessions/<pid>--s2/memory.md`): source merge content
- Session meta (`...--s2/meta.json`): merge attempt counters/hash metadata updated
- Merge audit (`profiles/<pid>/merge-audit.log`): applied + idempotent entries

## Exact files changed

### In repo/worktree
- `planning/cortex-memory-v2/E2E_MEMORY_MERGE_RUNTIME.md` (this report)
- `.tmp/e2e-memory-merge-runtime.mjs`
- `.tmp/e2e-memory-merge-runtime-result.json`
- `.tmp/e2e-memory-merge-backend.log`
- `.tmp/e2e-memory-merge-backend.pid`

### In isolated data dir (`/Users/adam/.middleman-cortex-memory-v2-migrate`)
- `profiles/memv2-merge-e2e-1773625013892/memory.md`
- `profiles/memv2-merge-e2e-1773625013892/merge-audit.log`
- `profiles/memv2-merge-e2e-1773625013892/sessions/memv2-merge-e2e-1773625013892/memory.md`
- `profiles/memv2-merge-e2e-1773625013892/sessions/memv2-merge-e2e-1773625013892--s2/memory.md`
- `profiles/memv2-merge-e2e-1773625013892/sessions/memv2-merge-e2e-1773625013892--s2/meta.json`
- related profile/session metadata and conversation files created by runtime manager/session creation

## Pass/fail conclusions

- **Root-session memory stays session-local:** **PASS**
- **Non-root session merge into canonical profile memory:** **PASS**
- **Merge audit evidence present and correct:** **PASS**
- **Merge meta evidence present and correct:** **PASS**
- **Idempotent skip behavior:** **PASS**
- **Fail-closed semantics (bounded live-path coverage):** **PARTIAL PASS**
  - Guarded failure path verified non-mutating.
  - Full induced LLM/promotion-stage failure simulation not executed in this bounded runtime run.

## Gaps / follow-up
1. Real assistant-generated memory writes were not reliable in this run due runtime steer/no-response behavior; deterministic file-write equivalent was used.
2. Did not force a non-guard merge failure at `llm`/`write_audit` stages in this live lane; that requires a controlled fault-injection harness or auth/provider sabotage scenario.
3. Did not run profile-hash-changed re-evaluation (`idempotent` invalidation after external profile edit) in this single bounded pass.

## Overall verdict for requested lane
**PASS with documented gaps**: The core Memory v2 runtime ownership + controlled non-root merge + audit/meta + idempotent behavior is validated in isolated copied-prod runtime. Fail-closed behavior is partially validated on a live guard-failure path; deeper injected-failure coverage remains follow-up work.
