# Cortex Memory v2 — E2E Test Evidence Index

> Purpose: single evidence index for the final isolated E2E synthesis package.
>
> Status: **synthesis-ready registry** aligned to the artifact set actually produced in this worktree.

## Naming normalization

The canonical runtime narratives in this branch are:
- `planning/cortex-memory-v2/E2E_MIGRATE_RUNTIME.md`
- `planning/cortex-memory-v2/E2E_FRESH_RUNTIME.md`

Older placeholder names such as `E2E_RUNTIME_COPIED_PRODUCTION.md` and `E2E_RUNTIME_FRESH.md` are superseded scaffolding only.

---

## 1. Canonical narrative artifacts

| ID | Artifact | Path | Type | Scenario coverage | Current status | Notes |
|---|---|---|---|---|---|---|
| `IDX-TRACKER` | Active execution tracker | `planning/cortex-memory-v2/E2E_ACTIVE_TRACKER.md` | tracker | all | Present | Master ledger for scenario-level progress, gaps, and risks |
| `IDX-RUBRIC` | Goals rubric | `planning/cortex-memory-v2/E2E_GOALS_RUBRIC.md` | acceptance rubric | all rubric IDs | Present | Final scoring target |
| `IDX-MIGRATE` | Copied-data runtime narrative | `planning/cortex-memory-v2/E2E_MIGRATE_RUNTIME.md` | runtime narrative | `CRT-01`, `CRT-02`, `SCAN-01`, `SCAN-05`, merge/ownership live proof | Present | Strong copied-prod lane; includes comprehensive rerun block |
| `IDX-FRESH` | Fresh runtime narrative | `planning/cortex-memory-v2/E2E_FRESH_RUNTIME.md` | runtime narrative | `CRT-03`, `CRT-04`, `SCAN-01`, `AUTH-04` | Present | Fresh boot/provisioning pass; live dispatch blocked by env/auth |
| `IDX-SCAN-AUDIT` | Scan/API bookkeeping audit | `planning/cortex-memory-v2/E2E_SCAN_AUDIT.md` | focused audit | `SCAN-01`, `SCAN-05`, `SCAN-06`, `OWN-01` | Present | Confirms profile-union, v2 file maps, Cortex exclusion, merge-audit visibility |
| `IDX-SCAN-DELTAS` | Scan delta evidence | `planning/cortex-memory-v2/E2E_SCAN_DELTAS.md` | focused runtime note | `SCAN-02`, `SCAN-03`, `SCAN-04` | Present | Real before/after drift evidence with restore snapshots |
| `IDX-RECONNECT` | Reconnect + memory persistence | `planning/cortex-memory-v2/E2E_RECONNECT_PERSISTENCE.md` | focused runtime note | `CRT-06`, partial `OWN-04` root-only | Present | Reconnect replay + memory persistence proved in migrate env |
| `IDX-MERGE` | Memory merge runtime lane | `planning/cortex-memory-v2/E2E_MEMORY_MERGE_RUNTIME.md` | focused runtime note | `MRG-01`, `MRG-02`, `MRG-05`, parts of `MRG-04`, `OWN-01` | Present | Live WS merge/audit/meta evidence |
| `IDX-WORKER` | Worker callback runtime lane | `planning/cortex-memory-v2/E2E_WORKER_CALLBACK_RUNTIME.md` | focused runtime note | `CRT-05` | Present | Raw WS callback proof captured |
| `IDX-LEARNING` | Copied-instance Cortex learning evaluation | `planning/cortex-memory-v2/E2E_CORTEX_LEARNING_EVAL.md` | focused evaluation note | quality/readback assessment | Present | Evaluates whether Cortex learns useful durable signals without bloating memory |
| `IDX-WATERMARK` | Scan watermark precision fix note | `planning/cortex-memory-v2/E2E_WATERMARK_PRECISION.md` | focused bugfix note | scan bookkeeping precision | Present | Documents low-churn fix for stale meta size fields vs live file sizes |
| `IDX-FM-CURATION` | Feature-manager curation plan | `planning/cortex-memory-v2/E2E_FEATURE_MANAGER_CURATION.md` | focused curation note | profile-memory slimming plan | Present | Concrete keep/compress/move plan for de-bloating feature-manager memory |
| `IDX-PHASE3` | Phase 3 ownership/auth validation report | `planning/cortex-memory-v2/VALIDATION_PHASE3_REPORT.md` | validation report | `OWN-01`, `AUTH-01`, `AUTH-04` | Present | Strong file-layout + auth-path evidence |
| `IDX-TESTING` | Testing matrix / command log | `planning/cortex-memory-v2/TESTING.md` | command log / test evidence | `OWN-*`, `REF-*`, `MRG-*`, `AUTH-*`, `OPS-*` | Present | Focused test coverage source of truth |
| `IDX-AUTH-AUDIT` | Cross-env auth runtime audit | `planning/cortex-memory-v2/E2E_AUTH_RUNTIME_AUDIT.md` | diagnosis | `AUTH-07` | Present | Explains configured-vs-valid auth gap + fallback behavior |
| `IDX-MIGRATE-DIAG` | Copied-runtime diagnosis | `planning/cortex-memory-v2/E2E_COPIED_DIAGNOSIS_R2.md` | diagnosis | `CRT-02`, `AUTH-07` | Present | Narrows copied-env failures to provider-specific auth |
| `IDX-FRESH-DIAG` | Fresh-runtime diagnosis | `planning/cortex-memory-v2/E2E_FRESH_DIAGNOSIS_R2.md` | diagnosis | `CRT-04`, `AUTH-07` | Present | Narrows fresh-env live-dispatch blocker to auth/model-path issues |
| `IDX-MIGRATE-AUTH` | Copied-vs-production auth/state diff | `planning/cortex-memory-v2/E2E_MIGRATE_AUTH_DIFF.md` | supporting analysis | `AUTH-07` | Present | Supporting copied-env auth context |
| `IDX-FRESH-AUTH` | Fresh-vs-production auth/state diff | `planning/cortex-memory-v2/E2E_FRESH_AUTH_DIFF.md` | supporting analysis | `AUTH-07` | Present | Supporting fresh-env auth context |
| `IDX-CLOSEOUT` | Closeout readiness memo | `planning/cortex-memory-v2/CLOSEOUT_READINESS.md` | review memo | supporting | Present | Useful code/readiness context; superseded by final E2E verdict for strict merge call |
| `IDX-SUMMARY` | Final exec summary | `planning/cortex-memory-v2/E2E_EXEC_SUMMARY.md` | final synthesis | final verdict | Present | Canonical merge/no-go synthesis |

---

## 2. Raw evidence families

| ID | Evidence family | Expected path/glob | Produced by | Current status | Notes |
|---|---|---|---|---|---|
| `RAW-MIGRATE-LOGS` | Copied-data backend/UI logs | `.tmp/e2e-backend*.log`, `.tmp/e2e-ui*.log`, `.tmp/e2e-rerun-backend.log`, `.tmp/e2e-migrate-v2-*.log` | runtime lanes | Present | Includes copied-runtime success + provider-auth failure traces |
| `RAW-MIGRATE-JSON` | Copied-data result JSON | `.tmp/e2e-migrate-runtime*.json`, `.tmp/e2e-scan-snapshot.json`, `.tmp/e2e-health.json`, `.tmp/e2e-migrate-v2-*.json` | runtime lanes | Present | Primary machine-readable migrate evidence |
| `RAW-MIGRATE-SCRIPTS` | Copied-data harness scripts | `.tmp/e2e-migrate-runtime*.mjs`, `.tmp/e2e-migrate-v2-*.mjs` | runtime lanes | Present | Useful for replayability |
| `RAW-FRESH-LOGS` | Fresh backend/UI logs | `.tmp/e2e-fresh-*.log` | runtime lanes | Present | Includes fresh auth failure traces |
| `RAW-FRESH-JSON` | Fresh result JSON | `.tmp/e2e-fresh-*.json` | runtime lanes | Present | Primary machine-readable fresh evidence |
| `RAW-FRESH-SCRIPTS` | Fresh harness scripts | `.tmp/e2e-fresh-*.mjs` | runtime lanes | Present | Useful for replayability |
| `RAW-DELTA` | Scan-delta probe artifacts | `.tmp/e2e-scan-delta-*` | focused delta lane | Present | Covers transcript/memory/feedback before/after/restored snapshots |
| `RAW-MERGE` | Merge/audit WS probe artifacts | `.tmp/e2e-memory-merge-*`, `.tmp/e2e-migrate-v2-*merge*` | merge lanes | Present | Includes runtime result JSON + audit tails |
| `RAW-RECONNECT` | Reconnect/session-memory probe artifacts | `.tmp/e2e-crt06-*` | reconnect lane | Present | Includes reconnect result JSON and backend log |
| `RAW-WORKER` | Worker spawn/callback artifacts | `.tmp/e2e-worker-callback-*`, `.tmp/e2e-crt05-*` | worker lane | Present | Includes raw WS event log + structured result |
| `RAW-VITEST` | Full backend suite log | `.tmp/e2e-full-backend-vitest.log` | validation lane | Present | Executed; latest result is `425 passed / 0 failed` after low-churn test hardening |

---

## 3. Scenario intake table

| Scenario ID | Primary narrative artifact | Required raw evidence family | Result summary slot | Current state |
|---|---|---|---|---|
| `CRT-01` | `E2E_MIGRATE_RUNTIME.md` | `RAW-MIGRATE-JSON`, `RAW-MIGRATE-LOGS` | boot/scan/existing-data notes | Partial |
| `CRT-02` | `E2E_MIGRATE_RUNTIME.md` | `RAW-MIGRATE-JSON`, `RAW-MIGRATE-LOGS` | copied-data chat round-trip result | Live-pass |
| `CRT-03` | `E2E_FRESH_RUNTIME.md` | `RAW-FRESH-JSON`, `RAW-FRESH-LOGS` | fresh provisioning result | Live-pass |
| `CRT-04` | `E2E_FRESH_RUNTIME.md` | `RAW-FRESH-JSON`, `RAW-FRESH-LOGS` | fresh live-dispatch result | Blocked (env/auth) |
| `CRT-05` | `E2E_WORKER_CALLBACK_RUNTIME.md` | `RAW-WORKER` | worker spawn/callback result | Live-pass |
| `CRT-06` | `E2E_RECONNECT_PERSISTENCE.md` | `RAW-RECONNECT` | reconnect persistence result | Live-pass (migrate env) |
| `CRT-07` | `E2E_MIGRATE_RUNTIME.md` or future UI note | UI-specific raw notes/screenshots if captured | existing-session load result | Missing |
| `SCAN-01` | runtime docs + `E2E_SCAN_AUDIT.md` | `RAW-MIGRATE-JSON`, `RAW-FRESH-JSON` | enriched-scan result | Live-pass |
| `SCAN-02` | `E2E_SCAN_DELTAS.md` | `RAW-DELTA` | transcript-delta result | Live-pass |
| `SCAN-03` | `E2E_SCAN_DELTAS.md` | `RAW-DELTA` | memory-delta result | Live-pass |
| `SCAN-04` | `E2E_SCAN_DELTAS.md` | `RAW-DELTA` | feedback-delta result | Live-pass |
| `SCAN-05` | `E2E_MIGRATE_RUNTIME.md`, `E2E_SCAN_AUDIT.md` | `RAW-MIGRATE-JSON` | cortex-exclusion result | Live-pass |
| `SCAN-06` | `E2E_SCAN_AUDIT.md`, `VALIDATION_PHASE3_REPORT.md` | existing raw scan/file artifacts | lazy-index result | Live-pass |
| `OWN-01` | `VALIDATION_PHASE3_REPORT.md`, `E2E_SCAN_AUDIT.md`, `E2E_MEMORY_MERGE_RUNTIME.md` | existing file-path evidence | ownership split result | Live-pass |
| `OWN-02` | `TESTING.md` | test logs | runtime composition result | Test-pass |
| `OWN-03` | `TESTING.md` | test logs | non-root memory-path result | Test-pass |
| `OWN-04` | future focused runtime note | raw memory-file diffs | memory-skill target result | Partial (root-only signal via reconnect lane) |
| `REF-01` | `VALIDATION_PHASE3_REPORT.md`, `TESTING.md` | existing file-path evidence | migration-on-boot result | Live-pass |
| `REF-02` | `TESTING.md` | test logs | non-destructive migration result | Test-pass |
| `REF-03` | `TESTING.md` | test logs | curated-doc preservation result | Test-pass |
| `REF-04` | `E2E_FRESH_RUNTIME.md`, `VALIDATION_PHASE3_REPORT.md` | `RAW-FRESH-JSON` | fresh no-legacy-dependency result | Live-pass |
| `REF-05` | `TESTING.md` | test logs | no-auto-injection result | Test-pass |
| `MRG-01` | `E2E_MEMORY_MERGE_RUNTIME.md` | `RAW-MERGE` | merge-apply result | Live-pass |
| `MRG-02` | `E2E_MEMORY_MERGE_RUNTIME.md`, `E2E_MIGRATE_RUNTIME.md` | `RAW-MERGE` | template/idempotent no-op result | Live-pass |
| `MRG-03` | `TESTING.md` | test logs | profile-hash-aware re-merge result | Test-pass |
| `MRG-04` | `E2E_MEMORY_MERGE_RUNTIME.md`, `E2E_MIGRATE_RUNTIME.md`, `TESTING.md` | `RAW-MERGE` | fail-closed/retry result | Partial (live fail-closed, retry test-backed) |
| `MRG-05` | `E2E_MEMORY_MERGE_RUNTIME.md` | `RAW-MERGE` | seed-path result | Live-pass |
| `MRG-06` | `TESTING.md` | test logs | legacy-meta compatibility result | Test-pass |
| `AUTH-01` | `VALIDATION_PHASE3_REPORT.md`, `TESTING.md` | existing auth/path evidence | canonical-auth-path result | Live-pass |
| `AUTH-02` | `TESTING.md` | test logs | legacy-copy-forward result | Test-pass |
| `AUTH-03` | summary/guard note | explicit prod before/after artifact if ever added | production-non-touch result | Partial |
| `AUTH-04` | `E2E_FRESH_RUNTIME.md`, `VALIDATION_PHASE3_REPORT.md` | `RAW-FRESH-JSON`, `RAW-FRESH-LOGS` | fresh-empty-boot result | Live-pass |
| `AUTH-05` | `TESTING.md` | test logs | transcribe-auth-path result | Test-pass |
| `AUTH-06` | `TESTING.md` | test logs | OAuth-write-path result | Test-pass |
| `AUTH-07` | auth/diagnosis docs | existing auth raw logs | provider-validity diagnosis result | Live-pass |
| `OPS-01` | `TESTING.md`, `CLOSEOUT_READINESS.md` | command output | backend typecheck result | Live-pass |
| `OPS-02` | `TESTING.md`, `CLOSEOUT_READINESS.md` | command output | UI typecheck result | Live-pass |
| `OPS-03` | `.tmp/e2e-full-backend-vitest.log`, `E2E_EXEC_SUMMARY.md`, `E2E_BACKEND_GATES.md` | `RAW-VITEST` | full test-suite result | Live-pass (`425 passed / 0 failed`) |
| `OPS-04` | runtime docs / `TESTING.md` | build output | build result | Live-pass |
| `OPS-05` | runtime docs, `TESTING.md`, future contract note if desired | scan snapshots and/or test logs | additive contract result | Partial |
| `OPS-06` | closeout/status note or future focused proof | file inspection or test/log evidence | prompt-v2-backup result | Partial |

---

## 4. Current checklist

### Completed package items
- [x] Canonical runtime narratives are named consistently (`E2E_MIGRATE_RUNTIME.md`, `E2E_FRESH_RUNTIME.md`)
- [x] Goals rubric exists
- [x] Active tracker exists and maps scenario IDs to rubric items
- [x] Raw evidence families are identified and populated
- [x] Fresh live-dispatch blocker is explicitly classified as an environment/auth issue in synthesis
- [x] Worker spawn/callback proof exists
- [x] Scan-delta probe artifacts exist
- [x] Merge/audit live artifact exists
- [x] Full-suite backend Vitest evidence exists
- [x] `E2E_EXEC_SUMMARY.md` is filled and references the actual artifact names

### Still-open evidence gaps
- [ ] Existing copied-session UI history rendering is captured in a dedicated artifact, or explicitly waived
- [ ] Memory-skill target proof for both root and sub-session writable targets is captured in a dedicated artifact, or explicitly waived
- [ ] Production non-touch is backed by explicit before/after diff evidence, or explicitly waived
- [x] Backend full-suite failures are resolved or formally waived

---

## 5. Synthesis readiness gate

The package is now **synthesis-ready** because:
1. the rubric can be scored from the tracked artifacts,
2. remaining blockers/gaps are explicit,
3. stale placeholder paths are no longer used in the summary docs, and
4. the package distinguishes product evidence from environment-specific auth blockers.

Current synthesis headline:
- copied-prod evidence is strong,
- fresh live dispatch remains an env/auth blocker,
- full backend Vitest executed clean at `425 passed / 0 failed`.

Use `planning/cortex-memory-v2/E2E_EXEC_SUMMARY.md` as the final verdict source.
