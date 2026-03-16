# Cortex Memory v2 — E2E Scan/API Bookkeeping Audit

Date: 2026-03-15
Auditor lane: `cortex-memv2-e2e-scan-audit`
Worktree: `/Users/adam/repos/middleman-worktrees/cortex-memory-v2`

## Scope requested
Validated non-chat Cortex Memory v2 runtime behaviors (API + file bookkeeping) in isolated environments only:
- Copied-prod dir: `/Users/adam/.middleman-cortex-memory-v2-migrate`
- Fresh dir: `/Users/adam/.middleman-cortex-memory-v2-fresh`

No production writes were performed.

Read inputs before auditing:
- `planning/cortex-memory-v2/E2E_GOALS_RUBRIC.md`
- `planning/cortex-memory-v2/IMPLEMENTATION_NOTES.md`
- `planning/cortex-memory-v2/VALIDATION_PHASE3_REPORT.md`
- Runtime docs: `planning/cortex-memory-v2/E2E_MIGRATE_RUNTIME.md`, `planning/cortex-memory-v2/E2E_FRESH_RUNTIME.md`, `planning/cortex-memory-v2/TESTING.md`, `planning/cortex-memory-v2/CLOSEOUT_READINESS.md`

---

## Method (bounded)
Used only bounded HTTP + filesystem/script checks:
- Started backend against migrate on `:47587` and fresh on `:47687`
- Pulled `/api/cortex/scan` snapshots
- Created one manager in each env via WS (`create_manager`) without chat dispatch
- Re-scanned and inspected `files.*` maps + selected `meta.json` files

Artifacts generated:
- `.tmp/e2e-scan-audit-migrate-scan.json`
- `.tmp/e2e-scan-audit-migrate-create-manager.json`
- `.tmp/e2e-scan-audit-migrate-scan-after.json`
- `.tmp/e2e-scan-audit-fresh-scan-before.json`
- `.tmp/e2e-scan-audit-fresh-create-manager.json`
- `.tmp/e2e-scan-audit-fresh-scan-after.json`
- backend logs: `.tmp/e2e-scan-audit-migrate-backend.log`, `.tmp/e2e-scan-audit-fresh-backend.log`

---

## Findings by requested area

### 1) `/api/cortex/scan` profile union + file surfaces
**Verdict: PASS**

Evidence:
- Migrate scan includes additive v2 surfaces: `files.profileMemory`, `files.profileReference`, `files.profileMergeAudit` (and compat `profileKnowledge`).
- Fresh scan before manager create had profile maps populated even with `scan.sessions.length = 0`.
- After creating `scan-audit-fresh-323119` (no chat/session transcript activity), scan returned:
  - `files.profileMemory[scan-audit-fresh-323119].exists === true`
  - `files.profileReference[scan-audit-fresh-323119].exists === true`
  - `scan.sessions.length === 0`
  -> demonstrates manager-profile union beyond transcript-byte session rows.
- Same union behavior confirmed in migrate by creating `scan-audit-migrate-371065`; profile appeared in file maps immediately.
- `cortex` profile remains excluded in migrate scan maps (`profileMemory/profileReference/profileKnowledge/profileMergeAudit` all lacked `cortex` key).

### 2) `profileMemory` / `profileReference` exposure
**Verdict: PASS**

Evidence:
- Fresh created profile scan entries point to canonical paths under `profiles/<profileId>/memory.md` and `profiles/<profileId>/reference/index.md` with `exists: true`.
- Migrate scan maps populated for existing profiles (`amd-migration`, `feature-manager`, `middleman-project`, `ortho-invoice`) and newly created audit profile.

### 3) Absence of legacy `profileKnowledge` dependence
**Verdict: PASS (with intentional back-compat present)**

Evidence:
- `files.profileKnowledge` is still present in scan payload (back-compat), but not required for v2 behavior.
- For newly created profiles in both environments, `files.profileKnowledge[profileId].exists === false` while `profileMemory/profileReference` were present and valid.
- This demonstrates v2 surfaces do not depend on legacy `shared/knowledge/profiles/<profileId>.md` existence.

### 4) Session-memory review/bookkeeping fields
**Verdict: PASS (API contract), PARTIAL (legacy on-disk meta normalization)

Evidence (PASS):
- All migrate scan session rows (`95/95`) contained memory + feedback review drift fields:
  - `memoryDeltaBytes`, `memoryTotalBytes`, `memoryReviewedBytes`, `memoryReviewedAt`
  - `feedbackDeltaBytes`, `feedbackTotalBytes`, `feedbackReviewedBytes`, `feedbackReviewedAt`
- Scan summary reports memory/feedback drift counters (`sessionsWithMemoryDrift`, `sessionsWithFeedbackDrift`).
- New session meta (fresh + migrate created managers) includes session-memory review + merge bookkeeping fields:
  - `cortexReviewedMemoryBytes`, `cortexReviewedMemoryAt`
  - `cortexReviewedFeedbackBytes`, `cortexReviewedFeedbackAt`
  - merge attempt fields (`memoryMergeAttemptCount`, `lastMemoryMergeAttemptId`, `lastMemoryMergeProfileHashBefore/After`, etc.)

Gap (PARTIAL):
- In copied-prod meta corpus, 25 legacy `meta.json` files are missing some newer feedback watermark keys (`cortexReviewedFeedbackBytes/At`) even though scan rows still normalize/expose feedback deltas.
- Merge bookkeeping keys were present across sampled copied-prod metas.

### 5) Root-session memory ownership split
**Verdict: PASS for new/runtime-provisioned sessions; PARTIAL for historical metadata presentation**

Evidence (PASS):
- New manager in fresh (`scan-audit-fresh-323119`) and migrate (`scan-audit-migrate-371065`) produced:
  - profile canonical memory: `profiles/<pid>/memory.md`
  - root working memory: `profiles/<pid>/sessions/<pid>/memory.md`
- New `meta.json` prompt components explicitly split paths:
  - `promptComponents.memoryFile` -> root session file
  - `promptComponents.profileMemoryFile` -> canonical profile memory file
- Existing copied-prod profiles also have both files physically present (`profile memory` + `sessions/<profileId>/memory.md`).

Gap (PARTIAL):
- Some historical copied-prod `meta.json` files still contain legacy prompt-component paths (e.g., `memoryFile` pointing to old profile memory path and `profileMemoryFile: null`).
- This appears to be historical metadata drift; runtime/file layout for new sessions is correct.

### 6) Merge-audit visibility
**Verdict: PASS**

Evidence:
- `/api/cortex/scan` exposes `files.profileMergeAudit[profileId]` entries with `{ path, exists, sizeBytes }`.
- Migrate snapshot: 5 profile entries, including one existing audit file:
  - `feature-manager` -> `exists: true`, `sizeBytes: 204`
- Non-created profiles without audit logs correctly reported `exists: false`.

---

## Pass/Fail summary

| Area | Verdict | Notes |
|---|---|---|
| `/api/cortex/scan` profile union + file surfaces | PASS | Manager-only profiles surfaced even with zero `scan.sessions` rows |
| `profileMemory` / `profileReference` exposure | PASS | Correct canonical paths + existence flags in fresh and migrate |
| No legacy `profileKnowledge` dependence | PASS | Legacy map remains for compat, but new profiles work with `profileKnowledge.exists=false` |
| Session-memory review/bookkeeping fields | PASS / PARTIAL | API/session rows complete; legacy copied-prod metas not fully normalized for newer feedback keys |
| Root-session memory ownership split | PASS / PARTIAL | Correct for newly provisioned sessions; some historical metas still show legacy prompt path fields |
| Merge-audit visibility | PASS | `profileMergeAudit` surfaced with real file presence |

Overall for requested audit scope: **PASS with two metadata-normalization gaps (non-blocking for current API/file-surface behavior).**

---

## Exact gaps
1. **Legacy meta feedback watermark backfill is incomplete in copied-prod corpus**
   - Symptom: subset of old `meta.json` files missing `cortexReviewedFeedbackBytes` / `cortexReviewedFeedbackAt`.
   - Impact: low for scan API (fields are normalized in scan output), but on-disk consistency is uneven.

2. **Historical promptComponents path metadata not universally rewritten**
   - Symptom: some legacy copied-prod root session metas still show old `promptComponents.memoryFile` semantics and `profileMemoryFile: null`.
   - Impact: low for new sessions and file layout; may confuse debugging/forensics if relying on old meta snapshots.

---

## Follow-up test recommendations
1. **Compatibility rewrite test for old meta files**
   - Add/extend integration coverage that loads pre-Phase-3/5 meta fixtures and asserts normalization after first runtime touch (or explicitly codifies that no rewrite is expected).

2. **Scan/API contract test for manager-only profiles**
   - Keep a dedicated test asserting profile appears in `files.profileMemory/profileReference/profileMergeAudit` even when `scan.sessions` is empty.

3. **Optional housekeeping migration (non-blocking)**
   - If desired, run a low-risk one-time metadata normalization pass for legacy `meta.json` keys/path fields to reduce forensic ambiguity.

4. **Merge-audit semantics regression test**
   - Extend existing scan test to explicitly assert both states in one run: zero-byte/missing vs existing audit log with `exists: true`.

---

## Final call
For the requested non-chat Cortex Memory v2 API/bookkeeping checks, behavior is **functionally correct** in both copied-prod and fresh isolated environments. Remaining issues are **historical metadata normalization gaps**, not current-surface functional blockers.
