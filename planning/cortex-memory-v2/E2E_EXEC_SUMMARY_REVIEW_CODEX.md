# Cortex Memory v2 — Independent E2E Package Review (Codex)

Date: 2026-03-15/16  
Reviewer lane: `cortex-memv2-e2e-summary-review-codex`

## Verdict (strict)
**Current evidence does _not_ support an unconditional “merge-ready / end-to-end complete” claim.**

Recommended decision from this lane: **NO-GO for E2E merge-readiness as currently framed** unless the team explicitly converts several items to accepted waivers (with owner/date/risk).

---

## What is overclaimed today

1. **“MERGE-READY” in `CLOSEOUT_READINESS.md` overstates the package status.**
   - Fresh runtime doc (`E2E_FRESH_RUNTIME.md`) is explicitly **Blocked** for live assistant response.
   - Full backend test suite evidence (`.tmp/e2e-full-backend-vitest.log`) shows **2 failing tests**.
   - Rubric `7.3` requires zero failures for pass.

2. **“End-to-end” wording is too broad for some passing sections.**
   - `E2E_SCAN_DELTAS.md` passes rely on direct file + `meta.json` edits/restores, not user/runtime-generated deltas.
   - `E2E_MEMORY_MERGE_RUNTIME.md` merge path is live, but source memory content was injected by direct file writes after real work probes failed.
   - These are valid functional probes, but they are **not full product-path E2E** in the strict sense.

3. **Tracker/index/synthesis package coherence is weak.**
   - `E2E_ACTIVE_TRACKER.md` still marks key items (`CRT-05`, `CRT-06`, `SCAN-02/03/04`) as missing while focused runtime docs now exist.
   - `E2E_EXEC_SUMMARY.md` remains a stale shell with placeholder paths.
   - Package can be interpreted in conflicting ways depending on which doc is treated as source of truth.

---

## Missing caveats that should be explicit in the final summary

1. **Fresh-env blocker handling is not fully closed.**
   - Evidence supports “auth/provider validity issue likely,” but there is still no successful fresh live reply token.
   - Final recommendation must clearly state whether this is:
     - a hard blocker, or
     - an explicitly accepted external-env blocker (with owner, mitigation, and follow-up).

2. **Auth diagnosis docs are not fully aligned.**
   - Auth artifacts contain timestamp/state drift and partially stale hypotheses across files.
   - Final synthesis should normalize to one canonical diagnosis narrative and mark older conflicting interpretations as superseded.

3. **Isolation proof is policy-level, not artifact-level.**
   - `AUTH-03` byte-identical production before/after proof is still not present.
   - If no byte-diff artifact is provided, final report should call this out as an accepted trust/process assumption.

---

## Focus areas requested

### A) Fresh-env blocker handling
- **Status:** still blocker for strict rubric (Core Chat 1.2 in fresh lane not proven).
- **Acceptability:** only acceptable if explicitly waived as external credential validity constraint, not product regression, with named owner and follow-up date.

### B) What “end-to-end” means here
- Current package is a **hybrid**: true runtime evidence + focused synthetic probes.
- Recommend labeling as: **“runtime-backed functional validation with targeted synthetic delta/merge probes”** (not pure user-path E2E).

### C) Worker / merge evidence sufficiency
- `E2E_WORKER_CALLBACK_RUNTIME.md`: strong callback transport evidence, but criteria were explicitly simplified; should be documented as such.
- `E2E_MEMORY_MERGE_RUNTIME.md`: strong live merge command/audit/meta evidence, but source memory was file-seeded, not assistant-generated in that run.
- Net: sufficient for confidence in mechanics, but caveat required before claiming full workflow E2E.

### D) Impact of 2 failing backend tests
From `.tmp/e2e-full-backend-vitest.log`:
- `src/test/index-shutdown-signals.test.ts` (missing SIGUSR1 assertion)
- `src/test/ws-server.test.ts` (control pid file ENOENT)

**Effect on recommendation:**
- Under rubric `7.3`, this is a **FAIL**, not partial.
- Therefore final recommendation cannot be “merge-ready” unless:
  1) these are fixed and suite is green, **or**
  2) an explicit waiver is approved with rationale, issue links, and risk acceptance.

---

## Minimum changes needed before a defensible “merge-ready” E2E verdict

1. Update `E2E_EXEC_SUMMARY.md` from template to factual final summary with real artifact paths.
2. Reconcile tracker/index statuses with the new focused runtime docs.
3. Explicitly classify fresh live-dispatch as resolved vs accepted blocker (with owner/date).
4. Resolve or formally waive the two failing full-suite backend tests.
5. Replace broad “end-to-end complete” wording with scoped language where probes were synthetic.

---

## Bottom line
The implementation may be close to code-ready, but the **evidence package currently overstates merge readiness**. Without explicit waivers and rubric-aware caveats (especially fresh live dispatch + full-suite failures), this lane recommends **NO-GO** for an unconditional final E2E merge-ready claim.