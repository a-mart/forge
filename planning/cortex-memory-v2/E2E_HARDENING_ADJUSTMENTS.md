# Cortex Memory v2 — Hardening Adjustments

**Date:** 2026-03-16  
**Worktree:** `/Users/adam/repos/middleman-worktrees/cortex-memory-v2`

## Goal
Review the new Cortex prompt/policy surfaces and make low-churn adjustments that improve:
1. clean promotion decisions,
2. concise completion/closeout,
3. avoidance of noisy backup churn.

Inputs reviewed:
- `planning/cortex-memory-v2/E2E_CORTEX_LEARNING_EVAL.md`
- `planning/cortex-memory-v2/E2E_FEATURE_MANAGER_CURATION.md`
- `planning/cortex-memory-v2/E2E_WATERMARK_PRECISION.md`
- `planning/cortex-memory-v2/E2E_EXEC_SUMMARY.md`
- `apps/backend/src/swarm/archetypes/builtins/cortex.md`
- `apps/backend/src/swarm/operational/builtins/cortex-worker-prompts.md`

---

## What the evaluation evidence said

### 1) Promotion quality was promising but still too permissive/noisy
The copied-env learning eval showed good instincts, but inconsistent closeout:
- Scenario 2 was strong: Cortex created a bounded reference doc instead of bloating injected memory.
- Scenario 3 showed that useful extracted signal could still fail to convert into a clean promotion/closeout path.
- The feature-manager curation analysis reinforced that injected memory still needs a stronger bias toward lean summaries and reference-doc spillover.

### 2) Completion signaling was too weak
The learning eval explicitly called out a missing user-facing completion message even when real work happened. That is a prompt/policy problem as much as an implementation problem: Cortex needs a stronger “always close the loop” instruction, and worker artifacts should make concise completion easier.

### 3) Backup churn needed a policy refinement
The current Cortex archetype said “snapshot before every write,” but it did not distinguish:
- actual content change vs no-op,
- first write vs repeated same-pass edits to the same file.

That wording makes `.bak` churn too easy, especially during reference index updates and other low-value edit sequences.

---

## Chosen adjustments

I kept this lane deliberately low-churn: prompt/policy tightening plus a very small upgrade-path change so existing v2 worker prompt files actually receive the refined template.

### A. Cortex archetype prompt tightened
Updated `apps/backend/src/swarm/archetypes/builtins/cortex.md` to do three things:

1. **Refine backup policy**
   - Old: snapshot before every write.
   - New: snapshot immediately before the **first actual content change** to a file in a pass.
   - Explicitly says to skip backup churn for no-op/unchanged writes and not create repeated backups for the same file in one pass.

2. **Sharpen promotion discipline**
   - Explicit bias toward **reference** over **inject** for narrow procedures, command catalogs, and troubleshooting flows.
   - Explicit statement that **clean no-op reviews are success**, not failure.
   - Inject entries must justify permanent prompt budget.
   - Reference docs should be distilled notes, not transcript-shaped dumps.

3. **Require concise completion on direct reviews**
   - Added an explicit hard requirement that direct/on-demand reviews must end with a concise `speak_to_user` closeout.
   - Added interactive-mode guidance for what that closeout should contain.

### B. Worker prompt templates upgraded to v3
Updated `apps/backend/src/swarm/operational/builtins/cortex-worker-prompts.md` from v2 -> v3.

Main changes:

1. **New top-level Promotion Discipline section**
   - precision over coverage
   - prefer discard over weak promotion
   - prefer reference over inject for procedural/runbook material
   - cap retained findings to the strongest few
   - prioritize explicit user statements / durable decisions

2. **Transcript + session-memory worker outputs are more promotion-ready**
   Each retained finding now includes:
   - `Why it matters`
   - `Distilled entry`
   - bounded max-findings guidance
   - explicit `Outcome: promote | no-op | follow-up-needed`
   - `Discarded candidates`
   - `Concise completion summary`

   This should make it easier for Cortex to:
   - decide whether to promote at all,
   - promote cleaner wording,
   - close the loop without rambling.

3. **Synthesis worker now emits closeout-ready structure**
   Synthesis output now explicitly includes:
   - `Outcome`
   - `Promotion-ready updates`
   - `Discarded / no-op findings`
   - `Open tensions or blockers`
   - `Concise completion summary`

   This directly targets the “useful internal work but weak completion” problem seen in the evaluation.

4. **No-op promoted to first-class result**
   The template now states clearly that no-op is valid and often preferable to noisy promotion.

### C. Existing v2 worker prompt files now auto-upgrade to v3
Prompt-only changes would have been incomplete because existing Cortex installs can already have a persisted `.cortex-worker-prompts.md` file.

So I made a small runtime hardening change in `apps/backend/src/swarm/swarm-manager.ts`:
- current worker prompt version marker is now v3
- boot now upgrades:
  - legacy pre-version files -> v3 with `.v1.bak`
  - v2 files -> v3 with `.v2.bak`

This is intentionally small:
- no redesign,
- no migration command,
- no data rewrite beyond the existing boot-time prompt-file maintenance behavior.

### D. Test coverage added for the new upgrade path
Updated `apps/backend/src/test/swarm-manager.test.ts` to cover:
- legacy prompt file -> current version upgrade
- v2 -> v3 upgrade with `.v2.bak`

---

## Why these changes are the right level of churn

These adjustments are intentionally narrow:
- no scan algorithm redesign
- no merge/promotion engine rewrite
- no knowledge-file schema changes
- no change to the basic Cortex operating model

But they directly address the main polish gaps surfaced by the E2E package:
- better inject/reference/discard discipline
- less incentive to over-promote procedural detail
- cleaner user-visible completion behavior
- less `.bak` noise
- actual rollout path for existing v2 worker prompt files

---

## Files changed

### Prompts / policy
- `apps/backend/src/swarm/archetypes/builtins/cortex.md`
- `apps/backend/src/swarm/operational/builtins/cortex-worker-prompts.md`

### Runtime support
- `apps/backend/src/swarm/swarm-manager.ts`

### Tests
- `apps/backend/src/test/swarm-manager.test.ts`

---

## Focused validation

Executed:

```bash
cd apps/backend && pnpm exec vitest run src/test/swarm-manager.test.ts src/test/prompt-registry.test.ts
cd apps/backend && pnpm exec tsc -p tsconfig.build.json --noEmit
cd apps/ui && pnpm exec tsc --noEmit
```

Results:
- focused backend tests: **pass** (`124 passed`)
- backend typecheck: **pass**
- UI typecheck: **pass**

Note:
- `prompt-registry.test.ts` still emits its expected `EISDIR` stderr during the unreadable-override fallback test; the test itself passes.

---

## Expected net effect

### Clean promotion decisions
Cortex should now be more likely to:
- keep injected memory lean,
- route narrow operational knowledge to reference,
- discard marginal procedural noise,
- prefer no-op over filler promotion.

### Concise completion
Cortex should now have much better prompt support for:
- saying what happened,
- naming changed files,
- stating “reviewed, no durable updates” cleanly,
- ending direct review flows decisively.

### Less backup churn
Cortex policy now more clearly says:
- snapshot only for real edits,
- snapshot once per file per pass,
- do not create backup noise around unchanged/no-op work.

---

## Residual caveat

These changes improve the decision/communication layer, not the full promotion engine. They should reduce a meaningful amount of noisiness and ambiguity, but they do **not** replace deeper runtime fixes if future E2E runs show remaining issues in:
- promotion application reliability,
- watermark/freshness bookkeeping beyond the already-landed precision fix,
- or manager-side completion logic outside prompt influence.

For this lane, though, the evidence strongly supported prompt/policy hardening first, and these changes fit that brief well.
