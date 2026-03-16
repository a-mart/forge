# Cortex Memory v2 — Active E2E Execution Tracker

**Purpose:** working tracker for the final isolated E2E package before synthesis. This is the execution ledger for what must be proven, where the evidence should land, and what is still missing.

> **Note:** This tracker began as the pre-closeout planning ledger. The package is now decision-ready, and the latest hardening state should be read alongside `E2E_EXEC_SUMMARY.md`, `E2E_TEST_INDEX.md`, `E2E_BACKEND_GATES.md`, `E2E_HARDENING_POSTFIX_RERUN.md`, and `E2E_SCHEDULE_INTERFERENCE.md`.

**Last updated:** 2026-03-15/16 overnight hardening follow-through  
**Scope:** isolated `migrate` + `fresh` validation only; no long-lived services in this lane  
**Primary synthesis inputs:** `E2E_GOALS_RUBRIC.md`, `E2E_MIGRATE_RUNTIME.md`, `E2E_FRESH_RUNTIME.md`, `VALIDATION_PHASE3_REPORT.md`, `TESTING.md`, diagnosis/auth docs

---

## 1. Status vocabulary

| Status | Meaning |
|---|---|
| `LIVE-PASS` | Captured in isolated runtime/API/filesystem evidence in a planning doc or raw artifact set |
| `TEST-PASS` | Covered by focused automated tests or validation notes, but not yet demonstrated in isolated live runtime |
| `PARTIAL` | Some environments or sub-cases are evidenced, but rubric proof is incomplete |
| `BLOCKED` | Explicit attempt made; current evidence shows a blocker rather than success |
| `MISSING` | No usable evidence captured yet |

---

## 2. Canonical isolated environments

| Env ID | Purpose | Data dir | Ports | Current factual state | Source docs |
|---|---|---|---|---|---|
| `ENV-MIGRATE` | Existing-data migration/runtime validation | `/Users/adam/.middleman-cortex-memory-v2-migrate` | backend `47387`, UI `47389` | Booted successfully; scan works; live chat succeeded; latest hardening reruns against copied-history scenarios are clean, including Cortex closeouts and relative changed-file reporting | `E2E_MIGRATE_RUNTIME.md`, `E2E_COPIED_DIAGNOSIS_R2.md`, `E2E_HARDENING_POSTFIX_RERUN.md`, `E2E_SCHEDULE_INTERFERENCE.md`, `VALIDATION_PHASE3_REPORT.md` |
| `ENV-FRESH` | Net-new empty-dir validation | `/Users/adam/.middleman-cortex-memory-v2-fresh` | backend `47487`, UI `47489` | Booted successfully; manager/session provisioning works; scan surfaces v2 files for new profiles; fresh live dispatch is now a documented pass after isolated auth repair | `E2E_FRESH_RUNTIME.md`, `E2E_FRESH_AUTH_DIFF.md`, `E2E_FRESH_DIAGNOSIS_R2.md`, `E2E_AUTH_RUNTIME_AUDIT.md`, `VALIDATION_PHASE3_REPORT.md` |
| `ENV-PROD-GUARD` | Safety boundary only | `/Users/adam/.middleman` | n/a | Must not be mutated by this validation program; only approved single-file auth copy into fresh was used in prior runtime testing | `STATUS.md`, `VALIDATION_PHASE3_REPORT.md`, `E2E_FRESH_RUNTIME.md` |

### Environment-specific constraints already observed
- `ENV-FRESH` required an explicitly approved auth repair path because production shared auth had drifted stale while the legacy auth source still held valid current OAuth state.
- Fresh runtime is now treated as **proved after isolated auth repair**, not as an unresolved product blocker.
- `ENV-MIGRATE` proved runtime chat and subsequent copied-history hardening behavior, but did **not** prove every provider/model combination.
- Later hardening evidence has now been partially folded back into the formal executive summary so the package no longer overstates the old copied-history closeout roughness.

---

## 3. Existing evidence inventory

| Artifact ID | Path | Role in package | Current value |
|---|---|---|---|
| `ART-RUBRIC` | `planning/cortex-memory-v2/E2E_GOALS_RUBRIC.md` | Final scoring rubric | Defines the required acceptance surface |
| `ART-MIGRATE-RUNTIME` | `planning/cortex-memory-v2/E2E_MIGRATE_RUNTIME.md` | Existing-data runtime narrative | Strong for boot/chat/scan snapshots; incomplete for rubric-wide coverage |
| `ART-FRESH-RUNTIME` | `planning/cortex-memory-v2/E2E_FRESH_RUNTIME.md` | Net-new runtime narrative | Strong for provisioning/scan and now live-pass for bounded assistant dispatch after isolated auth repair |
| `ART-PHASE3` | `planning/cortex-memory-v2/VALIDATION_PHASE3_REPORT.md` | Ownership/auth validation summary | Strong file-layout/auth-path evidence |
| `ART-TESTING` | `planning/cortex-memory-v2/TESTING.md` | Command log + focused test matrix | Good static/test evidence; not a substitute for live rubric coverage |
| `ART-AUTH-AUDIT` | `planning/cortex-memory-v2/E2E_AUTH_RUNTIME_AUDIT.md` | Cross-env auth diagnosis | Explains configured-vs-valid auth gap and fallback confusion |
| `ART-MIGRATE-DIAG` | `planning/cortex-memory-v2/E2E_COPIED_DIAGNOSIS_R2.md` | Copied-runtime blocker diagnosis | Narrows non-Cortex failure to provider-specific auth |
| `ART-FRESH-DIAG` | `planning/cortex-memory-v2/E2E_FRESH_DIAGNOSIS_R2.md` | Fresh-runtime blocker diagnosis | Narrows fresh failure to auth/model-path issues |
| `ART-MIGRATE-AUTH` | `planning/cortex-memory-v2/E2E_MIGRATE_AUTH_DIFF.md` | Auth/config comparison | Documents copied-instance divergence and auth ambiguity |
| `ART-FRESH-AUTH` | `planning/cortex-memory-v2/E2E_FRESH_AUTH_DIFF.md` | Auth/config comparison | Documents fresh credential state differences |
| `ART-CLOSEOUT` | `planning/cortex-memory-v2/CLOSEOUT_READINESS.md` | Code/review closeout memo | Useful context, but not sufficient as final E2E proof |
| `ART-TRACKER` | `planning/cortex-memory-v2/E2E_ACTIVE_TRACKER.md` | This file | Master tracking ledger for remaining E2E package work |

---

## 4. Required execution scenarios

Each scenario below is the unit of evidence collection. The rubric references are the acceptance targets that the scenario must satisfy.

### 4.1 Core runtime / chat scenarios

| Scenario ID | Scenario | Env(s) | Rubric mapping | Expected evidence files | Current status | Current factual notes |
|---|---|---|---|---|---|---|
| `CRT-01` | Migrate boot + health + existing-data scan availability | `ENV-MIGRATE` | `1.5`, `2.1`, `6.3`, `6.4` (boot/isolation portions) | `E2E_MIGRATE_RUNTIME.md`, `.tmp/e2e-health.json`, `.tmp/e2e-scan-snapshot.json`, `E2E_UI_HISTORY_LOAD.md` | `LIVE-PASS` | Boot + scan are evidenced. Existing copied-session UI history rendering is now explicitly captured. Production non-touch remains an evidence-backed waiver rather than byte-diff proof. |
| `CRT-02` | Migrate live chat round-trip on copied data | `ENV-MIGRATE` | `1.2` | `E2E_MIGRATE_RUNTIME.md`, `.tmp/e2e-migrate-runtime-result.json`, `.tmp/e2e-migrate-runtime-rerun-ortho-codex-default-result.json`, backend log excerpts | `LIVE-PASS` | Two live successes are documented: `cortex` reply path and non-Cortex codex/default rerun. This proves WS/runtime plumbing for at least one copied-data non-Cortex path. |
| `CRT-03` | Fresh first-manager creation + first session provisioning | `ENV-FRESH` | `1.1`, `2.5`, `4.4`, `6.4` | `E2E_FRESH_RUNTIME.md`, `VALIDATION_PHASE3_REPORT.md`, `.tmp/e2e-fresh-scan-final.json` | `LIVE-PASS` | Manager creation and file provisioning are captured. New profiles surface `profileMemory` and `profileReference` without legacy profile knowledge. |
| `CRT-04` | Fresh live chat round-trip | `ENV-FRESH` | `1.2` | `E2E_FRESH_RUNTIME.md`, `.tmp/e2e-fresh-runtime-result-attempt*.json`, `.tmp/e2e-fresh-rerun-pi-codex-result.json`, `.tmp/e2e-fresh-auth-fix-rerun.json`, `planning/cortex-memory-v2/raw/crt04-fresh-auth-fix-rerun.json`, backend logs | `LIVE-PASS` | Earlier auth/provider failure was resolved by syncing the isolated fresh env from the valid production legacy auth source into both fresh canonical and legacy auth paths; bounded rerun returned `PI_CODEX_FRESH_OK`. |
| `CRT-05` | Worker spawn + callback completion | `ENV-MIGRATE`, `ENV-FRESH` | `1.3` | `E2E_WORKER_CALLBACK_RUNTIME.md` plus raw WS transcript/log showing worker appears in agent list and sends callback | `LIVE-PASS` | Dedicated runtime artifact now demonstrates worker spawn, callback token delivery, and manager callback completion in the migrate env. |
| `CRT-06` | Reload/reconnect with session memory persistence | `ENV-MIGRATE`, `ENV-FRESH` | `1.4` | `E2E_RECONNECT_PERSISTENCE.md`, WS reconnect trace, filesystem snapshots of session `memory.md` before/after reload | `LIVE-PASS` | Dedicated migrate-env artifact proves reconnect persistence of session-local memory. |
| `CRT-07` | Existing session history renders in copied UI | `ENV-MIGRATE` | `1.5` | `E2E_UI_HISTORY_LOAD.md` plus UI-focused screenshot/snapshot/session-file evidence | `LIVE-PASS` | Dedicated copied-UI artifact proves a preexisting copied session can be selected from the sidebar and its transcript rendered in the chat pane. |

### 4.2 Scan / review freshness scenarios

| Scenario ID | Scenario | Env(s) | Rubric mapping | Expected evidence files | Current status | Current factual notes |
|---|---|---|---|---|---|---|
| `SCAN-01` | Enriched `GET /api/cortex/scan` payload, including v2 file maps | `ENV-MIGRATE`, `ENV-FRESH` | `2.1`, `2.5`, `7.5` | `E2E_MIGRATE_RUNTIME.md`, `E2E_FRESH_RUNTIME.md`, `VALIDATION_PHASE3_REPORT.md`, `.tmp/...scan...json` | `LIVE-PASS` | Both envs show `profileMemory` and `profileReference`; Phase 5 notes cover `profileMergeAudit`; back-compat field retention is asserted but not fully diffed in a dedicated artifact. |
| `SCAN-02` | Transcript delta detection after transcript growth | `ENV-MIGRATE` or `ENV-FRESH` | `2.2` | `E2E_SCAN_DELTAS.md` + before/after scan JSON + touched transcript evidence | `LIVE-PASS` | Dedicated delta artifact proves transcript-byte growth is surfaced in scan output. |
| `SCAN-03` | Session-memory delta detection after `memory.md` edit | `ENV-MIGRATE` or `ENV-FRESH` | `2.3` | `E2E_SCAN_DELTAS.md` + before/after scan JSON + edited memory file snapshot | `LIVE-PASS` | Dedicated delta artifact proves session-memory drift is surfaced in scan output. |
| `SCAN-04` | Feedback delta detection after `feedback.jsonl` append | `ENV-MIGRATE` | `2.4` | `E2E_SCAN_DELTAS.md` + before/after scan JSON + feedback append evidence | `LIVE-PASS` | Dedicated delta artifact proves feedback-byte drift is surfaced in scan output. |
| `SCAN-05` | Cortex profile excluded from scan file maps | `ENV-MIGRATE` | `2.6` | `E2E_MIGRATE_RUNTIME.md`, `E2E_SCAN_AUDIT.md`, dedicated scan snapshot with explicit assertion about absent `cortex` key | `LIVE-PASS` | Scan audit and runtime notes now explicitly cover manager-only profile union and Cortex exclusion from file maps. |
| `SCAN-06` | Lazy reference index provisioning on scan | `ENV-MIGRATE`, `ENV-FRESH` | `2.7` | `VALIDATION_PHASE3_REPORT.md`, `TESTING.md`, runtime/file snapshots | `LIVE-PASS` | Scan-time reference index provisioning is evidenced in runtime docs and focused tests. |

### 4.3 Ownership / runtime memory scenarios

| Scenario ID | Scenario | Env(s) | Rubric mapping | Expected evidence files | Current status | Current factual notes |
|---|---|---|---|---|---|---|
| `OWN-01` | Root-session working memory separated from canonical profile memory | `ENV-MIGRATE`, `ENV-FRESH` | `3.1` | `VALIDATION_PHASE3_REPORT.md`, filesystem path snapshots | `LIVE-PASS` | Both envs show root session `profiles/<pid>/sessions/<pid>/memory.md` alongside canonical `profiles/<pid>/memory.md`. |
| `OWN-02` | Runtime composition injects profile memory read-only above writable session memory | automated + optionally live | `3.2` | `TESTING.md` test references; optional dedicated runtime composition note | `TEST-PASS` | Explicit swarm-manager tests are logged; no isolated live runtime capture of composed resource stack. |
| `OWN-03` | Non-root sessions use their own writable memory path | automated + optionally live | `3.3` | `TESTING.md`; optional filesystem snapshot from a `--s2` case | `TEST-PASS` | Covered by path-resolution/runtime tests; not yet documented as a direct isolated filesystem probe in a planning artifact. |
| `OWN-04` | Memory skill writes to the correct session target | `ENV-MIGRATE`, `ENV-FRESH` | `3.4` | `E2E_MEMORY_SKILL_TARGETS.md` + runtime probe + file diffs/logs for root and sub-session memory files | `LIVE-PASS` | Dedicated isolated runtime artifact proves root and sub-session memory-skill writes land in the correct session-local files while canonical profile memory remains unchanged. |

### 4.4 Reference-doc scenarios

| Scenario ID | Scenario | Env(s) | Rubric mapping | Expected evidence files | Current status | Current factual notes |
|---|---|---|---|---|---|---|
| `REF-01` | Legacy profile-knowledge migration on copied boot | `ENV-MIGRATE` | `4.1` | `TESTING.md`, `VALIDATION_PHASE3_REPORT.md`, optionally targeted runtime file snapshots | `LIVE-PASS` | Boot/scan evidence shows migrated `reference/index.md` and `legacy-profile-knowledge.md` for copied profiles. |
| `REF-02` | Migration is non-destructive to original shared knowledge blobs | automated + copied-data filesystem spot-check | `4.2` | focused test refs in `TESTING.md`; optional direct file comparison artifact | `TEST-PASS` | Covered in reference-doc tests, but not yet spelled out in a dedicated runtime evidence file. |
| `REF-03` | Migration preserves curated docs if already present | automated | `4.3` | focused test refs in `TESTING.md` | `TEST-PASS` | Covered by tests; no isolated runtime artifact. |
| `REF-04` | Fresh env has no legacy profile-knowledge dependency | `ENV-FRESH` | `4.4` | `E2E_FRESH_RUNTIME.md`, `VALIDATION_PHASE3_REPORT.md` | `LIVE-PASS` | Fresh scan/file checks show `profileKnowledge` absent for new profiles and no `shared/knowledge/profiles/<pid>.md` dependency. |
| `REF-05` | Reference docs are not auto-injected into runtime | automated + optional runtime dump | `4.5` | focused test refs in `TESTING.md`, `VALIDATION_PHASE3_REPORT.md` | `TEST-PASS` | Explicit tests exist; no live runtime context dump artifact yet. |

### 4.5 Merge / promotion scenarios

| Scenario ID | Scenario | Env(s) | Rubric mapping | Expected evidence files | Current status | Current factual notes |
|---|---|---|---|---|---|---|
| `MRG-01` | Happy-path merge applies session memory to profile summary | automated + ideally isolated WS probe | `5.1`, `5.7`, `5.8` | `TESTING.md`; optional new WS/runtime merge artifact with `merge-audit.log` and `meta.json` snapshots | `TEST-PASS` | Strong focused test coverage exists; no isolated live WS merge narrative yet. |
| `MRG-02` | Template no-op and unchanged idempotent skip | automated | `5.2`, `5.3` | `TESTING.md` | `TEST-PASS` | Covered in targeted merge tests only. |
| `MRG-03` | Re-merge after profile change uses profile-hash-aware retry logic | automated | `5.4` | `TESTING.md` | `TEST-PASS` | Covered in Phase 5 tests only. |
| `MRG-04` | Fail-closed behavior + retry-after-failure | automated | `5.5`, `5.6`, `7.7` | `TESTING.md` | `TEST-PASS` | Covered in targeted failure-stage tests only. |
| `MRG-05` | Seed path for empty profile memory | automated | `5.9` | `TESTING.md` | `TEST-PASS` | Covered in targeted tests; no isolated runtime artifact. |
| `MRG-06` | Legacy `meta.json` compatibility on merge retry | automated | `7.8` | `TESTING.md` | `TEST-PASS` | Covered in session-manifest/swarm-manager tests only. |

### 4.6 Auth / isolation scenarios

| Scenario ID | Scenario | Env(s) | Rubric mapping | Expected evidence files | Current status | Current factual notes |
|---|---|---|---|---|---|---|
| `AUTH-01` | Canonical shared auth path is used by runtime-critical flows | `ENV-MIGRATE`, `ENV-FRESH` + tests | `6.1` | `VALIDATION_PHASE3_REPORT.md`, `TESTING.md` | `LIVE-PASS` | Phase 3 report confirms canonical path presence in isolated dirs; tests cover runtime-critical readers/writers. |
| `AUTH-02` | Legacy auth copy-forward works | automated | `6.2` | `TESTING.md` | `TEST-PASS` | Explicit targeted tests exist for transcribe/OAuth/merge-runtime entry points. |
| `AUTH-03` | Migrate validation does not touch production data | `ENV-PROD-GUARD` | `6.3` | `E2E_PRODUCTION_NON_TOUCH.md` waiver note; explicit before/after guard artifact if ever added | `WAIVED` | Isolation intent is documented and summarized in a dedicated waiver note, but there is still no byte-identical before/after proof artifact for `~/.middleman`. |
| `AUTH-04` | Fresh env boots cleanly with empty data dir | `ENV-FRESH` | `6.4` | `E2E_FRESH_RUNTIME.md`, `VALIDATION_PHASE3_REPORT.md` | `LIVE-PASS` | Fresh reset/boot/provisioning are documented. |
| `AUTH-05` | `/api/transcribe` uses canonical shared auth | automated | `6.5` | `TESTING.md` | `TEST-PASS` | Test-covered, not isolated live-called in the E2E package. |
| `AUTH-06` | OAuth login writes canonical shared auth | automated | `6.6` | `TESTING.md` | `TEST-PASS` | Test-covered, not live-exercised in isolated runtime docs. |
| `AUTH-07` | Provider-specific runtime auth failures are characterized, not conflated with transport regressions | `ENV-MIGRATE`, `ENV-FRESH` | supports `1.2`, `6.1` | `E2E_AUTH_RUNTIME_AUDIT.md`, `E2E_COPIED_DIAGNOSIS_R2.md`, `E2E_FRESH_DIAGNOSIS_R2.md` | `LIVE-PASS` | Current diagnosis package is strong and should be retained as supporting context for future isolated auth-state drift or provider-health failures. |

### 4.7 Operational safety / compatibility scenarios

| Scenario ID | Scenario | Env(s) | Rubric mapping | Expected evidence files | Current status | Current factual notes |
|---|---|---|---|---|---|---|
| `OPS-01` | Backend typecheck clean | repo | `7.1` | `TESTING.md`, `CLOSEOUT_READINESS.md` | `LIVE-PASS` | Repeatedly logged as passing. |
| `OPS-02` | UI typecheck clean | repo | `7.2` | `TESTING.md`, `CLOSEOUT_READINESS.md` | `LIVE-PASS` | Repeatedly logged as passing. |
| `OPS-03` | Full unit/integration suite clean (`vitest run`) | repo | `7.3` | full-suite command output artifact | `LIVE-PASS` | Full backend `vitest run` now exists in `.tmp/e2e-full-backend-vitest.log` with `435 passed / 0 failed`. |
| `OPS-04` | Build succeeds | repo | `7.4` | `TESTING.md`, runtime docs | `LIVE-PASS` | Build steps are documented in both migrate and fresh runs. |
| `OPS-05` | Scan/UI contract remains additive with `profileKnowledge` back-compat | repo + runtime snapshots | `7.5` | `TESTING.md`, scan snapshots, optional contract-diff note | `PARTIAL` | Compatibility is described and UI was updated to prefer `profileMemory`, but there is no dedicated before/after contract proof artifact. |
| `OPS-06` | Worker prompt v2 deployed with `.v1.bak` rollback path | repo | `7.6` | code/path inspection note, optionally `TESTING.md` or targeted artifact | `PARTIAL` | Status/closeout docs assert this landed, but the E2E package lacks a dedicated evidence line for deployed prompt + backup coexistence. |

---

## 5. Rubric coverage snapshot by category

| Rubric category | Current evidence posture | Notes |
|---|---|---|
| 1. Core Chat / Session Behavior | `PASS` | Migrate live chat, fresh live chat, worker callback, reconnect persistence, and explicit existing-session UI history load are now all proved. |
| 2. Cortex Scan / Review Behavior | `PASS` | Enriched scan payload, profile-only managers, lazy reference indexing, and transcript/memory/feedback delta probes are all proved in isolated runtime artifacts. |
| 3. Ownership / Memory Behavior | `PASS` | File-layout ownership split is strong, and memory-skill target behavior now has isolated runtime proof for both root and sub-session writes. |
| 4. Reference-Doc Behavior | `MOSTLY COVERED` | Migrate/fresh structural behavior is well covered, though some criteria remain test-only rather than separately live-runtime demonstrated. |
| 5. Merge / Promotion Behavior | `MOSTLY COVERED` | Isolated live merge evidence now exists, supplemented by strong focused automated coverage for deeper failure/retry cases. |
| 6. Auth / Isolation Behavior | `PASS with AUTH-03 caveat` | Canonical path behavior, fresh boot, and fresh live dispatch after isolated auth repair are covered; production non-touch is still carried by an evidence-backed waiver note instead of byte-diff proof, and transcribe/OAuth remain test-backed rather than isolated live-called. |
| 7. Operational Safety | `PASS` | Build/typecheck are covered and the full backend `vitest run` is now present in the E2E package. |

---

## 6. Highest-priority unresolved risks

1. **Production non-touch is waived, not cryptographically proved.**  
   `E2E_PRODUCTION_NON_TOUCH.md` is an evidence-backed waiver note, not a byte-identical before/after manifest for `~/.middleman`.

2. **Auth-state drift between production canonical and legacy auth stores is an operational sharp edge.**  
   The fresh fix succeeded only after using the valid production legacy auth source because production shared auth was stale.

---

## 7. Recommended next evidence passes before synthesis

Ordered by payoff:

1. **If desired, add a byte-diff manifest for production non-touch.**  
   This is optional now because AUTH-03 has an explicit waiver note, but it is the remaining path to full proof instead of waiver.

2. **Optionally harden auth-state repair guidance.**  
   Document or automate the legacy-to-canonical auth sync path for isolated envs when production shared auth has drifted stale.

3. **Otherwise treat the package as synthesis-ready and decision-ready.**

---

## 8. Minimum synthesis-ready set

The package is now **synthesis-ready** because:

- `CRT-04` is now live-pass after isolated auth repair and is no longer a runtime blocker.
- `CRT-05`, `CRT-06`, `CRT-07`, `SCAN-02`, `SCAN-03`, `SCAN-04`, `OWN-04`, and `OPS-03` all now have dedicated evidence artifacts.
- `MRG-01` has isolated WS/runtime evidence and deeper coverage remains test-backed where appropriate.
- The index and summary docs reference the actual runtime artifact names in use.

The remaining decision is not package completeness; it is whether the decision owner is comfortable with the AUTH-03 waiver posture and the documented auth-state sharp edge.