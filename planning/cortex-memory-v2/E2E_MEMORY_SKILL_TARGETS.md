# Cortex Memory v2 — E2E Memory Skill Targets

Date: 2026-03-15/16  
Worktree: `/Users/adam/repos/middleman-worktrees/cortex-memory-v2`  
Isolated data dir: `/Users/adam/.middleman-cortex-memory-v2-migrate`  
Production data touched for writes: **No** (`~/.middleman` untouched)  
Backend port used: `47787`

## Goal
Produce isolated-runtime proof for `OWN-04` / rubric `3.4`:
- root manager memory-skill write lands in `profiles/<profile>/sessions/<profile>/memory.md`
- sub-session memory-skill write lands in `profiles/<profile>/sessions/<session>/memory.md`
- canonical profile memory `profiles/<profile>/memory.md` is **not** directly mutated by either write

## Verdict
**PASS with one harness-capture caveat**

The runtime proof is real and isolated:
- root-session token was written only to the root session memory file,
- sub-session token was written only to the sub-session memory file,
- canonical profile memory stayed unchanged,
- runtime metadata/logs show the resolved writable memory targets were the session-local files.

Minor caveat:
- the first root prompt hit a transient runtime delivery error (`no active turn to steer`) and the initial JSON harness missed the later assistant acknowledgement,
- but the root session conversation log clearly shows the later successful assistant confirmation after the file write, so this is a **harness observation issue**, not a target-path failure.

## Exact commands executed

```bash
# 1) Start isolated backend only
mkdir -p .tmp
BACKEND_LOG=.tmp/e2e-memory-skill-targets-backend.log
BACKEND_PID_FILE=.tmp/e2e-memory-skill-targets-backend.pid
: > "$BACKEND_LOG"
MIDDLEMAN_HOST=127.0.0.1 \
MIDDLEMAN_PORT=47787 \
MIDDLEMAN_DATA_DIR=/Users/adam/.middleman-cortex-memory-v2-migrate \
pnpm --filter @middleman/backend exec tsx src/index.ts >>"$BACKEND_LOG" 2>&1 &
PID=$!
echo "$PID" > "$BACKEND_PID_FILE"
for i in {1..45}; do
  code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:47787/api/health || true)
  if [ "$code" = "200" ]; then break; fi
  sleep 1
done

# 2) Run dedicated runtime probe
WS_URL=ws://127.0.0.1:47787 \
DATA_DIR=/Users/adam/.middleman-cortex-memory-v2-migrate \
node .tmp/e2e-memory-skill-targets.mjs > .tmp/e2e-memory-skill-targets-result.json

# 3) Required typechecks
cd apps/backend && pnpm exec tsc -p tsconfig.build.json --noEmit
cd apps/ui && pnpm exec tsc --noEmit
```

## Runtime scenario performed
Harness: `.tmp/e2e-memory-skill-targets.mjs`

The script:
1. connected to WS on the isolated backend,
2. created a fresh manager/profile `own04-memory-targets-1773629656817`,
3. created a sub-session `own04-memory-targets-1773629656817-s2`,
4. sent an explicit root remember request,
5. sent an explicit sub-session remember request,
6. inspected the three relevant memory files,
7. compared before/after hashes and token placement.

### Tokens used
- Root token: `OWN04_ROOT_TOKEN=1773629657313`
- Sub token: `OWN04_SUB_TOKEN=1773629657313`

## Primary evidence files

### Raw harness output
- `.tmp/e2e-memory-skill-targets-result.json`
- `.tmp/e2e-memory-skill-targets-backend.log`

### Isolated runtime files created/updated
- `/Users/adam/.middleman-cortex-memory-v2-migrate/profiles/own04-memory-targets-1773629656817/memory.md`
- `/Users/adam/.middleman-cortex-memory-v2-migrate/profiles/own04-memory-targets-1773629656817/sessions/own04-memory-targets-1773629656817/memory.md`
- `/Users/adam/.middleman-cortex-memory-v2-migrate/profiles/own04-memory-targets-1773629656817/sessions/own04-memory-targets-1773629656817-s2/memory.md`
- `/Users/adam/.middleman-cortex-memory-v2-migrate/profiles/own04-memory-targets-1773629656817/sessions/own04-memory-targets-1773629656817/session.conversation.jsonl`
- `/Users/adam/.middleman-cortex-memory-v2-migrate/profiles/own04-memory-targets-1773629656817/sessions/own04-memory-targets-1773629656817/meta.json`
- `/Users/adam/.middleman-cortex-memory-v2-migrate/profiles/own04-memory-targets-1773629656817/sessions/own04-memory-targets-1773629656817-s2/session.conversation.jsonl`
- `/Users/adam/.middleman-cortex-memory-v2-migrate/profiles/own04-memory-targets-1773629656817/sessions/own04-memory-targets-1773629656817-s2/meta.json`

## A) Root manager write target proof

### Runtime-resolved writable file
Root session meta shows the runtime memory owner and profile reference separately:
- `promptComponents.memoryFile`:
  - `/Users/adam/.middleman-cortex-memory-v2-migrate/profiles/own04-memory-targets-1773629656817/sessions/own04-memory-targets-1773629656817/memory.md`
- `promptComponents.profileMemoryFile`:
  - `/Users/adam/.middleman-cortex-memory-v2-migrate/profiles/own04-memory-targets-1773629656817/memory.md`

Root conversation log also captured the runtime printing `$SWARM_MEMORY_FILE` and resolving it to the root session path:
- `/Users/adam/.middleman-cortex-memory-v2-migrate/profiles/own04-memory-targets-1773629656817/sessions/own04-memory-targets-1773629656817/memory.md`

Then the same root session performed a `file_change` on that exact path.

### Filesystem result
Canonical profile memory after both runtime writes:
```md
# Swarm Memory

## User Preferences
- (none yet)

## Project Facts
- (none yet)
```

Root session memory after root remember request:
```md
# Swarm Memory

## User Preferences
- (none yet)

## Project Facts
- OWN04_ROOT_TOKEN=1773629657313
```

### Hash / isolation checks
From `.tmp/e2e-memory-skill-targets-result.json`:
- `profileHashBefore = 17dc6449...`
- `profileHashAfter(root) = 17dc6449...`
- `profileUnchanged = true`
- `rootHashBefore = 17dc6449...`
- `rootHashAfter = 01360e77...`
- `rootChanged = true`
- `subUnchangedDuringRootWrite = true`
- `rootContainsToken = true`
- `profileContainsToken = false`
- `subContainsToken = false`

### Root acknowledgement note
The dedicated harness JSON recorded the root probe as timed out because the first prompt encountered a transient runtime delivery error:
- backend log: `no active turn to steer`

But the actual root session conversation log shows the successful later acknowledgement after the memory write:
```text
OWN04_ROOT_SAVED OWN04_ROOT_TOKEN=1773629657313
```

So the live runtime outcome is:
- **memory write happened to the root session file**,
- **assistant acknowledgement happened in the root session conversation**, and
- **profile memory did not change**.

## B) Sub-session write target proof

### Runtime-resolved writable file
Sub-session meta shows a distinct writable session memory path and the same canonical profile reference:
- `promptComponents.memoryFile`:
  - `/Users/adam/.middleman-cortex-memory-v2-migrate/profiles/own04-memory-targets-1773629656817/sessions/own04-memory-targets-1773629656817-s2/memory.md`
- `promptComponents.profileMemoryFile`:
  - `/Users/adam/.middleman-cortex-memory-v2-migrate/profiles/own04-memory-targets-1773629656817/memory.md`

Sub-session conversation log shows a real runtime path, not a synthetic file edit:
- the manager spawned `memory-worker`,
- the worker read `apps/backend/src/swarm/skills/builtins/memory/SKILL.md`,
- then edited the sub-session memory file,
- then the manager replied:
  - `OWN04_SUB_SAVED OWN04_SUB_TOKEN=1773629657313`

### Filesystem result
Sub-session memory after remember request:
```md
# Swarm Memory

## User Preferences
- (none yet)

## Project Facts
- OWN04_SUB_TOKEN=1773629657313
```

Canonical profile memory remained:
```md
# Swarm Memory

## User Preferences
- (none yet)

## Project Facts
- (none yet)
```

Root session memory remained the root-only token:
```md
# Swarm Memory

## User Preferences
- (none yet)

## Project Facts
- OWN04_ROOT_TOKEN=1773629657313
```

### Hash / isolation checks
From `.tmp/e2e-memory-skill-targets-result.json`:
- `profileHashBefore(sub) = 17dc6449...`
- `profileHashAfter(sub) = 17dc6449...`
- `profileUnchanged = true`
- `rootHashBefore = 01360e77...`
- `rootHashAfter = 01360e77...`
- `rootUnchanged = true`
- `subHashBefore = 17dc6449...`
- `subHashAfter = d1398c39...`
- `subChanged = true`
- `subContainsToken = true`
- `profileContainsToken = false`
- `rootContainsToken = false`

## Concise proof matrix

| Check | Result | Evidence |
|---|---|---|
| Root manager writable target is `profiles/<pid>/sessions/<pid>/memory.md` | PASS | root `meta.json` `promptComponents.memoryFile`; root conversation `$SWARM_MEMORY_FILE`; root file content |
| Root remember write stays out of canonical profile memory | PASS | profile hash unchanged; profile file still scaffold; root token only in root file |
| Sub-session writable target is `profiles/<pid>/sessions/<sid>/memory.md` | PASS | sub `meta.json` `promptComponents.memoryFile`; sub conversation worker edit path; sub file content |
| Sub remember write stays out of canonical profile memory | PASS | profile hash unchanged; profile file still scaffold; sub token only in sub file |
| Sub remember write stays out of root session memory | PASS | root hash unchanged during sub write; root file contains only root token |

## Code-path corroboration
The live proof above matches the intended implementation:
- `apps/backend/src/swarm/data-paths.ts`
  - `resolveMemoryFilePath()` routes root managers to `getRootSessionMemoryPath(dataDir, profileId)`
  - non-root sessions route to `getSessionMemoryPath(dataDir, profileId, descriptor.agentId)`
- `apps/backend/src/swarm/swarm-manager.ts`
  - `getMemoryRuntimeResources()` sets `memoryContextFile.path` to the resolved session-local path
  - `buildSessionMemoryRuntimeView()` injects profile memory as read-only reference above writable session memory
- `apps/backend/src/swarm/skills/builtins/memory/SKILL.md`
  - instructs agents to use `${SWARM_MEMORY_FILE}` as the source of truth rather than deriving paths manually

## Final conclusion
`OWN-04` is now backed by isolated runtime evidence.

Direct memory-skill writes target the correct per-session file:
- root manager write -> `profiles/<profile>/sessions/<profile>/memory.md`
- sub-session write -> `profiles/<profile>/sessions/<session>/memory.md`

And both writes leave canonical profile memory untouched:
- `profiles/<profile>/memory.md` remained unchanged throughout this lane.
