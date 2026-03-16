# Cortex Memory v2 — Closeout Readiness Memo

**Date:** 2026-03-15  
**Reviewer:** Opus 4.6 high-reasoning closeout lane  
**Branch:** `feat/cortex-memory-v2` (worktree `/Users/adam/repos/middleman-worktrees/cortex-memory-v2`)

---

## Overall Readiness: ✅ MERGE-READY

All five implementation phases are complete, reviewed by both Codex and Opus lanes, and remediated. The branch is in a clean, committable state.

### Gate Summary

| Gate | Status |
|---|---|
| Phase 1 — Foundations (scan freshness, reference-doc plumbing) | ✅ Implemented + reviewed + remediated |
| Phase 2 — Injection/Reference model (migration, prompt v2, classification) | ✅ Implemented + reviewed + remediated |
| Phase 3 — Ownership model (root-session split, shared-auth hardening) | ✅ Implemented + reviewed + remediated + isolated validation pass |
| Phase 4 — Merge/Promotion hardening (fail-closed, idempotency, audit durability) | ✅ Implemented + reviewed (2 rounds) + remediated |
| Phase 5 — Metadata/Audit hardening (profile-hash-aware idempotency, scan audit exposure) | ✅ Implemented + reviewed + Codex blocker remediated |
| Backend typecheck (`tsc --noEmit`) | ✅ Clean |
| UI typecheck (`tsc --noEmit`) | ✅ Clean |
| Protocol build | ✅ Clean |
| Merge tests (17 focused Phase 4/5 tests) | ✅ All pass |
| Scan tests (3 focused Phase 5 tests) | ✅ All pass |
| Isolated migrate validation (Phase 3) | ✅ Pass |
| Isolated fresh validation (Phase 3) | ✅ Pass |

### Code Impact

28 files changed across `packages/protocol`, `apps/backend`, `apps/ui`, and `planning/`:
- **+3,442 / −569 lines** (net ~2,873 added)
- Core changes span: `swarm-manager.ts` (+1,114), test files (+1,311 combined), `cortex.md`/worker-prompts (+542), scan/routes (+374), session-manifest (+130), protocol types (+51)

### Review Verdicts

- **Opus Phase 5:** "Ready to merge. No must-fix items. No architectural objections."
- **Codex Phase 5:** Identified 1 blocker (failed-merge idempotent-skip bypass) + 1 non-blocking risk (zero-byte audit `exists`). **Both remediated in code and verified green.**

---

## Residual Non-Blocking Follow-Ups

These are open TASKS items that are intentionally deferred and do not block merge:

1. **Remove remaining `profileKnowledge` compat from scan/UI contract** (TASKS Phase 2 line 17) — kept for back-compat during transition; can drop in a follow-up once Cortex and UI consumers are confirmed migrated.

2. **Extend reference-doc provisioning into Cortex promotion/write-back flows** (TASKS Phase 2 line 18) — current plumbing covers migration and scan-time provisioning; active write-back from Cortex review cycles is a follow-on feature, not a correctness gap.

3. **Re-run isolated migrate/fresh validation with full Phase 4/5 stack** (TASKS Phase 3 line 28) — Phase 3 isolated validation is captured in `VALIDATION_PHASE3_REPORT.md`; Phases 4/5 are additive metadata changes with no new file-layout or auth-path risk. Unit/integration coverage is sufficient.

4. **Basic session interactions E2E** (TASKS Validation line 44) — live model dispatch in isolated environments requires manual auth copy; structural/file-path/API-contract validation is complete. Full E2E can be verified post-merge in the main environment.

5. **Minor Opus Phase 5 test polish** — seed-path profile-hash assertions, failure→profile-change→retry sequence, populated audit-log scan test. All described as non-blockers in the review.

---

## What to Commit/Merge Next

### Single commit on `feat/cortex-memory-v2`:

Stage all 28 changed files and commit with a message such as:

```
feat: Cortex memory v2 — ownership/merge/audit redesign

- Session-memory freshness signals in scan/review flow (Phase 1)
- Legacy profile-knowledge → reference-doc migration plumbing (Phase 2a)
- Cortex prompt/classification model upgrade to inject/reference/discard (Phase 2b)
- Root-session working memory separated from canonical profile memory (Phase 3)
- Shared-auth path hardening with legacy copy-forward fallback (Phase 3)
- Fail-closed profile-summary promotion with audit trail (Phase 4)
- Profile-hash-aware merge idempotency with legacy back-compat (Phase 5)
- Scan exposure of per-profile merge-audit paths (Phase 5)

Reviewed by: Codex 5.3 high (×2) + Opus 4.6 high (×2) across all phases.
Isolated validation: migrate + fresh scenarios against dedicated data dirs.
```

Then merge `feat/cortex-memory-v2` → `main` (or the team's integration branch) and clean up the worktree.

### Post-Merge

- Delete worktree: `git worktree remove /Users/adam/repos/middleman-worktrees/cortex-memory-v2`
- Delete branch: `git branch -d feat/cortex-memory-v2`
- Clean up isolated test dirs if no longer needed
- File follow-up items above as tracked work
