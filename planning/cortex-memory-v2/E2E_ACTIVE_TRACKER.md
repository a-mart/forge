# Cortex Memory v2 — Active E2E Execution Tracker

**Purpose:** working tracker for the final isolated E2E package before synthesis. This is the execution ledger for what must be proven, where the evidence should land, and what is still missing.

> **Note:** This tracker reflects the pre-closeout planning state. For the latest overnight package status, use `E2E_EXEC_SUMMARY.md`, `E2E_TEST_INDEX.md`, and `E2E_BACKEND_GATES.md` as the current source of truth.

**Last updated:** 2026-03-15 20:23 CDT  
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
| `ENV-MIGRATE` | Existing-data migration/runtime validation | `/Users/adam/.middleman-cortex-memory-v2-migrate` | backend `47387`, UI `47389`; rerun backend `47487` | Booted successfully; scan works; live chat succeeded for `cortex` and non-Cortex codex/default; Anthropic dispatch failed on at least one non-Cortex path | `E2E_MIGRATE_RUNTIME.md`, `E2E_MIGRATE_AUTH_DIFF.md`, `E2E_COPIED_DIAGNOSIS_R2.md`, `VALIDATION_PHASE3_REPORT.md` |
| `ENV-FRESH` | Net-new empty-dir validation | `/Users/adam/.middleman-cortex-memory-v2-fresh` | backend `47487`, UI `47489` | Booted successfully; manager/session provisioning works; scan surfaces v2 files for new profiles; live model dispatch blocked by auth/provider validity issues | `E2E_FRESH_RUNTIME.md`, `E2E_FRESH_AUTH_DIFF.md`, `E2E_FRESH_DIAGNOSIS_R2.md`, `E2E_AUTH_RUNTIME_AUDIT.md`, `VALIDATION_PHASE3_REPORT.md` |
| `ENV-PROD-GUARD` | Safety boundary only | `/Users/adam/.middleman` | n/a | Must not be mutated by this validation program; only approved single-file auth copy into fresh was used in prior runtime testing | `STATUS.md`, `VALIDATION_PHASE3_REPORT.md`, `E2E_FRESH_RUNTIME.md` |

### Environment-specific constraints already observed
- `ENV-FRESH` used one explicitly approved auth copy workaround: `~/.middleman/shared/auth/auth.json` -> `~/.middleman-cortex-memory-v2-fresh/shared/auth/auth.json`.
- Fresh runtime still failed to produce assistant replies after that copy; diagnosis points to expired/unusable OAuth and fallback behavior rather than missing backend/UI plumbing.
- `ENV-MIGRATE` proved runtime chat on codex/default, but did **not** prove all provider/model combinations.

---

## 3. Existing evidence inventory

| Artifact ID | Path | Role in package | Current value |
|---|---|---|---|
| `ART-RUBRIC` | `planning/cortex-memory-v2/E2E_GOALS_RUBRIC.md` | Final scoring rubric | Defines the required acceptance surface |
| `ART-MIGRATE-RUNTIME` | `planning/cortex-memory-v2/E2E_MIGRATE_RUNTIME.md` | Existing-data runtime narrative | Strong for boot/chat/scan snapshots; incomplete for rubric-wide coverage |
| `ART-FRESH-RUNTIME` | `planning/cortex-memory-v2/E2E_FRESH_RUNTIME.md` | Net-new runtime narrative | Strong for provisioning/scan; blocked for live assistant dispatch |
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
| `CRT-01` | Migrate boot + health + existing-data scan availability | `ENV-MIGRATE` | `1.5`, `2.1`, `6.3`, `6.4` (boot/isolation portions) | `E2E_MIGRATE_RUNTIME.md`, `.tmp/e2e-health.json`, `.tmp/e2e-scan-snapshot.json` | `PARTIAL` | Boot + scan are evidenced. Existing session history rendering in the UI is **not** explicitly captured. Production non-touch is stated, not byte-diff proven. |
| `CRT-02` | Migrate live chat round-trip on copied data | `ENV-MIGRATE` | `1.2` | `E2E_MIGRATE_RUNTIME.md`, `.tmp/e2e-migrate-runtime-result.json`, `.tmp/e2e-migrate-runtime-rerun-ortho-codex-default-result.json`, backend log excerpts | `LIVE-PASS` | Two live successes are documented: `cortex` reply path and non-Cortex codex/default rerun. This proves WS/runtime plumbing for at least one copied-data non-Cortex path. |
| `CRT-03` | Fresh first-manager creation + first session provisioning | `ENV-FRESH` | `1.1`, `2.5`, `4.4`, `6.4` | `E2E_FRESH_RUNTIME.md`, `VALIDATION_PHASE3_REPORT.md`, `.tmp/e2e-fresh-scan-final.json` | `LIVE-PASS` | Manager creation and file provisioning are captured. New profiles surface `profileMemory` and `profileReference` without legacy profile knowledge. |
| `CRT-04` | Fresh live chat round-trip | `ENV-FRESH` | `1.2` | `E2E_FRESH_RUNTIME.md`, `.tmp/e2e-fresh-runtime-result-attempt*.json`, `.tmp/e2e-fresh-rerun-pi-codex-result.json`, backend logs | `BLOCKED` | User/system messages persisted, but no assistant reply token was observed. Failures point to auth/provider validity, not missing transport boot. |
| `CRT-05` | Worker spawn + callback completion | `ENV-MIGRATE`, `ENV-FRESH` | `1.3` | new runtime narrative section plus raw WS transcript/log showing worker appears in agent list and sends callback | `MISSING` | No current E2E artifact demonstrates a worker spawned from a runtime task and completed with manager callback. |
| `CRT-06` | Reload/reconnect with session memory persistence | `ENV-MIGRATE`, `ENV-FRESH` | `1.4` | new runtime narrative section, WS reconnect trace, filesystem snapshots of session `memory.md` before/after reload | `MISSING` | No current artifact proves reconnect persistence of working memory in either env. |
| `CRT-07` | Existing session history renders in copied UI | `ENV-MIGRATE` | `1.5` | UI-focused runtime notes/screenshots/logs in `E2E_MIGRATE_RUNTIME.md` or companion doc | `MISSING` | Current migrate runtime evidence creates/uses sessions but does not document loading a pre-existing session transcript in the UI. |

### 4.2 Scan / review freshness scenarios

| Scenario ID | Scenario | Env(s) | Rubric mapping | Expected evidence files | Current status | Current factual notes |
|---|---|---|---|---|---|---|
| `SCAN-01` | Enriched `GET /api/cortex/scan` payload, including v2 file maps | `ENV-MIGRATE`, `ENV-FRESH` | `2.1`, `2.5`, `7.5` | `E2E_MIGRATE_RUNTIME.md`, `E2E_FRESH_RUNTIME.md`, `VALIDATION_PHASE3_REPORT.md`, `.tmp/...scan...json` | `LIVE-PASS` | Both envs show `profileMemory` and `profileReference`; Phase 5 notes cover `profileMergeAudit`; back-compat field retention is asserted but not fully diffed in a dedicated artifact. |
| `SCAN-02` | Transcript delta detection after transcript growth | `ENV-MIGRATE` or `ENV-FRESH` | `2.2` | new delta probe section/doc + before/after scan JSON + touched transcript evidence | `MISSING` | No isolated runtime artifact explicitly grows a transcript beyond watermark and re-scans. |
| `SCAN-03` | Session-memory delta detection after `memory.md` edit | `ENV-MIGRATE` or `ENV-FRESH` | `2.3` | new delta probe section/doc + before/after scan JSON + edited memory file snapshot | `MISSING` | Implemented/tested in code path, but no current runtime proof artifact. |
| `SCAN-04` | Feedback delta detection after `feedback.jsonl` append | `ENV-MIGRATE` | `2.4` | new delta probe section/doc + before/after scan JSON + feedback append evidence | `MISSING` | No current isolated E2E artifact for feedback-byte drift. |
| `SCAN-05` | Cortex profile excluded from scan file maps | `ENV-MIGRATE` | `2.6` | dedicated scan snapshot with explicit assertion about absent `cortex` key | `MISSING` | `E2E_MIGRATE_RUNTIME.md` notes that `cortex` existed in WS snapshots but did not appear in one scan file map, but this is not tracked as a deliberate rubric proof. |
| `SCAN-06` | Lazy reference index provisioning on scan | `ENV-MIGRATE`, `ENV-FRESH` | `2.7` | `VALIDATION_PHASE3_REPORT.md`, `TESTING.md`, runtime/file snapshots | `LIVE-PASS` | Scan-time reference index provisioning is evidenced in runtime docs and focused tests. |

### 4.3 Ownership / runtime memory scenarios

| Scenario ID | Scenario | Env(s) | Rubric mapping | Expected evidence files | Current status | Current factual notes |
|---|---|---|---|---|---|---|
| `OWN-01` | Root-session working memory separated from canonical profile memory | `ENV-MIGRATE`, `ENV-FRESH` | `3.1` | `VALIDATION_PHASE3_REPORT.md`, filesystem path snapshots | `LIVE-PASS` | Both envs show root session `profiles/<pid>/sessions/<pid>/memory.md` alongside canonical `profiles/<pid>/memory.md`. |
| `OWN-02` | Runtime composition injects profile memory read-only above writable session memory | automated + optionally live | `3.2` | `TESTING.md` test references; optional dedicated runtime composition note | `TEST-PASS` | Explicit swarm-manager tests are logged; no isolated live runtime capture of composed resource stack. |
| `OWN-03` | Non-root sessions use their own writable memory path | automated + optionally live | `3.3` | `TESTING.md`; optional filesystem snapshot from a `--s2` case | `TEST-PASS` | Covered by path-resolution/runtime tests; not yet documented as a direct isolated filesystem probe in a planning artifact. |
| `OWN-04` | Memory skill writes to the correct session target | `ENV-MIGRATE`, `ENV-FRESH` | `3.4` | new runtime probe + file diffs for root and sub-session memory files | `MISSING` | No current E2E artifact uses the memory skill and verifies file-target behavior. |

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
| `AUTH-03` | Migrate validation does not touch production data | `ENV-PROD-GUARD` | `6.3` | explicit before/after guard artifact if desired; otherwise status note | `PARTIAL` | Isolation intent is documented, but there is no byte-identical before/after proof artifact for `~/.middleman`. |
| `AUTH-04` | Fresh env boots cleanly with empty data dir | `ENV-FRESH` | `6.4` | `E2E_FRESH_RUNTIME.md`, `VALIDATION_PHASE3_REPORT.md` | `LIVE-PASS` | Fresh reset/boot/provisioning are documented. |
| `AUTH-05` | `/api/transcribe` uses canonical shared auth | automated | `6.5` | `TESTING.md` | `TEST-PASS` | Test-covered, not isolated live-called in the E2E package. |
| `AUTH-06` | OAuth login writes canonical shared auth | automated | `6.6` | `TESTING.md` | `TEST-PASS` | Test-covered, not live-exercised in isolated runtime docs. |
| `AUTH-07` | Provider-specific runtime auth failures are characterized, not conflated with transport regressions | `ENV-MIGRATE`, `ENV-FRESH` | supports `1.2`, `6.1` | `E2E_AUTH_RUNTIME_AUDIT.md`, `E2E_COPIED_DIAGNOSIS_R2.md`, `E2E_FRESH_DIAGNOSIS_R2.md` | `LIVE-PASS` | Current diagnosis package is strong and should be retained as supporting context for blocked live-chat scenarios. |

### 4.7 Operational safety / compatibility scenarios

| Scenario ID | Scenario | Env(s) | Rubric mapping | Expected evidence files | Current status | Current factual notes |
|---|---|---|---|---|---|---|
| `OPS-01` | Backend typecheck clean | repo | `7.1` | `TESTING.md`, `CLOSEOUT_READINESS.md` | `LIVE-PASS` | Repeatedly logged as passing. |
| `OPS-02` | UI typecheck clean | repo | `7.2` | `TESTING.md`, `CLOSEOUT_READINESS.md` | `LIVE-PASS` | Repeatedly logged as passing. |
| `OPS-03` | Full unit/integration suite clean (`vitest run`) | repo | `7.3` | full-suite command output artifact | `MISSING` | Current docs show focused test slices, not a full backend `vitest run` as written in the rubric. |
| `OPS-04` | Build succeeds | repo | `7.4` | `TESTING.md`, runtime docs | `LIVE-PASS` | Build steps are documented in both migrate and fresh runs. |
| `OPS-05` | Scan/UI contract remains additive with `profileKnowledge` back-compat | repo + runtime snapshots | `7.5` | `TESTING.md`, scan snapshots, optional contract-diff note | `PARTIAL` | Compatibility is described and UI was updated to prefer `profileMemory`, but there is no dedicated before/after contract proof artifact. |
| `OPS-06` | Worker prompt v2 deployed with `.v1.bak` rollback path | repo | `7.6` | code/path inspection note, optionally `TESTING.md` or targeted artifact | `PARTIAL` | Status/closeout docs assert this landed, but the E2E package lacks a dedicated evidence line for deployed prompt + backup coexistence. |

---

## 5. Rubric coverage snapshot by category

| Rubric category | Current evidence posture | Notes |
|---|---|---|
| 1. Core Chat / Session Behavior | `PARTIAL / BLOCKED` | Migrate live chat is proved; fresh live reply is blocked; worker spawning, reconnect persistence, and existing-session UI history load are still missing. |
| 2. Cortex Scan / Review Behavior | `PARTIAL` | Enriched scan payload, profile-only managers, and lazy reference indexing are proved. Explicit transcript/memory/feedback delta probes are still missing. |
| 3. Ownership / Memory Behavior | `PARTIAL` | File-layout ownership split is strong. Memory-skill target behavior lacks isolated proof. |
| 4. Reference-Doc Behavior | `MOSTLY COVERED` | Migrate/fresh structural behavior is well covered, but some criteria are test-only rather than live-runtime demonstrated. |
| 5. Merge / Promotion Behavior | `TEST-COVERED, NOT E2E-COVERED` | Focused automated coverage is strong; isolated live WS merge evidence has not been packaged yet. |
| 6. Auth / Isolation Behavior | `PARTIAL` | Canonical path behavior is covered; fresh boot is covered; production non-touch is not backed by explicit before/after artifact; transcribe/OAuth are test-only. |
| 7. Operational Safety | `PARTIAL` | Build/typecheck are covered. Full `vitest run`, explicit contract-diff evidence, and prompt-backup proof are still absent from the E2E package. |

---

## 6. Highest-priority unresolved risks

1. **Fresh live dispatch is still blocked.**  
   `E2E_FRESH_RUNTIME.md` shows successful boot/provisioning but no assistant response. This is the single biggest gap for rubric category 1.

2. **Provider validity is still confounding copied/fresh runtime interpretation.**  
   `E2E_COPIED_DIAGNOSIS_R2.md`, `E2E_FRESH_DIAGNOSIS_R2.md`, and `E2E_AUTH_RUNTIME_AUDIT.md` all indicate that “configured” auth is not equivalent to usable runtime auth. Anthropic failures and fallback behavior can look like product regressions when they are actually credential validity issues.

3. **Worker spawning has no end-to-end proof artifact.**  
   Rubric `1.3` remains uncovered.

4. **Reconnect/session-memory persistence has no proof artifact.**  
   Rubric `1.4` remains uncovered.

5. **Scan freshness deltas are not yet demonstrated with real before/after byte changes.**  
   Rubric `2.2`, `2.3`, and `2.4` remain unproven in isolated runtime docs.

6. **Merge/promotion behavior is only represented by focused automated tests.**  
   That is good engineering evidence, but it is weaker than an isolated WS/runtime narrative for final synthesis.

7. **Production isolation is policy-backed, not artifact-backed.**  
   The package says production was not touched, but there is no explicit before/after proof artifact for `~/.middleman`.

8. **The E2E document set has path/name drift.**  
   `E2E_TEST_INDEX.md` and `E2E_EXEC_SUMMARY.md` were originally scaffolded around placeholder runtime-doc names. The active package uses `E2E_MIGRATE_RUNTIME.md` and `E2E_FRESH_RUNTIME.md` instead.

9. **Closeout memo is stronger than the current E2E package.**  
   `CLOSEOUT_READINESS.md` is valuable, but it should not be treated as a substitute for missing runtime evidence in the final E2E synthesis.

---

## 7. Recommended next evidence passes before synthesis

Ordered by payoff:

1. **Resolve or clearly quarantine fresh auth, then rerun `CRT-04`.**  
   Goal: one successful fresh assistant reply token, or a final accepted blocker with owner and reason.

2. **Capture a dedicated worker-spawn run for `CRT-05`.**  
   A minimal Cortex review or delegated task is enough if it shows worker creation, callback, and completion.

3. **Run a focused scan-delta pass for `SCAN-02` / `SCAN-03` / `SCAN-04`.**  
   Use tightly scoped before/after file edits and save the before/after scan JSON.

4. **Package one isolated WS merge run for `MRG-01`.**  
   Even a single happy-path merge with `merge-audit.log` + `meta.json` evidence would materially strengthen the final package.

5. **Decide whether `OPS-03` needs a full suite run or an explicit waiver.**  
   Right now the rubric says full `vitest run`, but the package only carries focused slices.

6. **If time allows, add one reconnect/memory-persistence probe for `CRT-06`.**

---

## 8. Minimum synthesis-ready set

The package is materially stronger once the following are true:

- `CRT-04` is either `LIVE-PASS` or explicitly accepted as an auth-environment blocker.
- `CRT-05` has at least one proof artifact.
- At least one of `SCAN-02` / `SCAN-03` / `SCAN-04` is executed with real before/after evidence, ideally all three.
- `MRG-01` has one isolated WS/runtime artifact, or synthesis explicitly states that merge criteria are satisfied by automated coverage only.
- `OPS-03` is either executed or formally waived.
- The index and summary docs reference the actual runtime artifact names in use.

Until then, the branch may be code-ready, but the **E2E package is not fully synthesis-ready**.
