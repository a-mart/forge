# Cortex Memory v2 — Closeout Polish Hardening

**Date:** 2026-03-16  
**Worktree:** `/Users/adam/repos/middleman-worktrees/cortex-memory-v2`

## Goal
Harden the remaining weak spot in the new Cortex flow: manager-level closeout after direct historical-review requests.

The main failure mode seen in earlier copied-env learning evaluation was not bad extraction quality; it was that useful worker/synthesis work could complete without a final clean user-facing closeout.

## Problem
Earlier evaluation evidence showed two related issues:
1. Cortex sometimes produced useful worker artifacts but never emitted a decisive final `speak_to_user` completion.
2. Cortex could send an early status update, then receive later worker completions and go idle without a fresh final closeout.

That made the system feel unfinished even when the underlying review logic was good.

## Low-churn hardening implemented

### 1) Cortex prompt tightened
Updated `apps/backend/src/swarm/archetypes/builtins/cortex.md` to make the rule explicit:
- direct reviews must end with a concise closeout,
- if an earlier status update was sent and later worker/tool results arrived, Cortex must send a fresh final closeout before going idle.

### 2) Runtime safety-net added
Updated `apps/backend/src/swarm/swarm-manager.ts` to add a narrow Cortex-only closeout reminder path.

New behavior:
- when a manager transitions to `idle` with no pending workers,
- and that manager is the Cortex archetype,
- the manager inspects the latest direct user turn,
- if there has been no `speak_to_user` closeout since that turn, or if later worker progress arrived after the last user-visible update,
- the manager injects a final internal reminder:

```text
SYSTEM: Before ending this direct review, publish a concise speak_to_user closeout...
```

This is not a redesign. It is a small nudge that only fires when Cortex is about to end a direct review without a proper user-visible finish.

### 3) Detection helper added
Exported helper in `swarm-manager.ts`:
- `analyzeLatestCortexCloseoutNeed(history)`

It detects two cases:
- `missing_speak_to_user`
- `stale_after_worker_progress`

## Files changed
- `apps/backend/src/swarm/archetypes/builtins/cortex.md`
- `apps/backend/src/swarm/swarm-manager.ts`
- `apps/backend/src/swarm/__tests__/cortex-closeout.test.ts`

## Validation
Executed:

```bash
cd apps/backend && pnpm exec vitest run src/swarm/__tests__/cortex-closeout.test.ts src/test/swarm-manager.test.ts src/test/prompt-registry.test.ts
cd apps/backend && pnpm exec tsc -p tsconfig.build.json --noEmit
cd apps/ui && pnpm exec tsc --noEmit
```

Results:
- focused tests: **129 passed**
- backend typecheck: **pass**
- UI typecheck: **pass**

## Why this is the right level of change
- Cortex-specific only
- no protocol changes
- no merge-engine redesign
- no broad runtime behavior change for other managers
- directly targets the exact “useful work happened but it didn’t feel finished” problem

## Expected effect
This should make direct Cortex reviews feel more deliberate and complete:
- fewer silent endings after worker activity,
- fewer stale “started review” messages without a final wrap-up,
- better alignment between real internal work and what the user sees.

## Caveat
This is a closeout safety-net, not a substitute for good prompt discipline. The earlier prompt/policy hardening still matters. The best outcome is:
1. workers produce cleaner summary material,
2. Cortex closes cleanly on its own,
3. the runtime reminder almost never has to fire.

That said, if Cortex drifts, this change should keep the user-facing experience from ending in an unfinished state.