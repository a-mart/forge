# Cortex Memory v2 — E2E Evaluation Rubric

**Purpose:** Score runtime behavior against the stated design goals after live E2E testing.  
**Scoring:** Each criterion is **PASS / PARTIAL / FAIL** with notes.  
**Environments:** Migrate (existing data → v2) and Fresh (empty data dir).

---

## 1. Core Chat / Session Behavior

| # | Criterion | How to verify | Pass condition |
|---|---|---|---|
| 1.1 | Manager creation works | Create a new manager in both Migrate and Fresh envs | Manager appears in sidebar, session dir + `meta.json` created |
| 1.2 | Chat round-trip works | Send a user message and receive a streamed response | Response streams back; transcript file grows; no errors in backend log |
| 1.3 | Worker spawning works | Trigger a task that delegates to a worker (e.g., Cortex review) | Worker agent appears in agent list, completes, and sends callback |
| 1.4 | Session memory persists across reconnects | Send messages, reload UI, verify memory section | Session working memory file exists and content survives reload |
| 1.5 | Existing sessions load in Migrate env | Open a pre-existing session from the copied data dir | Transcript history renders; no crash or blank screen |

## 2. Cortex Scan / Review Behavior

| # | Criterion | How to verify | Pass condition |
|---|---|---|---|
| 2.1 | `GET /api/cortex/scan` returns enriched payload | `curl` the scan endpoint | Response includes `files.profileMemory`, `files.profileReference`, `files.profileMergeAudit` keyed by profileId |
| 2.2 | Scan detects transcript freshness deltas | Grow a session transcript beyond its watermark, re-scan | Session appears in attention queue with `transcriptDelta > 0` |
| 2.3 | Scan detects memory freshness deltas | Edit a session's `memory.md` beyond its watermark, re-scan | Session shows `memoryDelta > 0` |
| 2.4 | Scan detects feedback freshness deltas | Append to a session's `feedback.jsonl` beyond watermark, re-scan | Session shows `feedbackDelta > 0` |
| 2.5 | Scan surfaces profile-only managers | Create a manager with no session transcripts yet, scan | Profile appears in `profileMemory` / `profileReference` maps despite zero transcript bytes |
| 2.6 | Cortex profile is excluded from scan | Verify `cortex` profile ID does not appear in scan output | No `cortex` key in any `files.*` map |
| 2.7 | Reference-doc index is lazily provisioned on scan | Scan a profile that has no `reference/index.md` yet | File created at `profiles/<pid>/reference/index.md` after scan |

## 3. Ownership / Memory Behavior

| # | Criterion | How to verify | Pass condition |
|---|---|---|---|
| 3.1 | Root-session working memory is separate from profile memory | Inspect `profiles/<pid>/sessions/<pid>/memory.md` vs `profiles/<pid>/memory.md` | Two distinct files; runtime workers write to session path, not profile path |
| 3.2 | Profile memory is injected read-only | Check runtime memory composition for a root manager/worker | Profile `memory.md` content appears in injected context but is not the writable target |
| 3.3 | Non-root sessions get their own memory path | Create a sub-session (`--s2`), inspect memory path | Uses `profiles/<pid>/sessions/<pid>--s2/memory.md`, not the root or profile path |
| 3.4 | Memory skill writes to correct target | Use the memory skill in a root session and a sub-session | Each writes to its own session `memory.md`; profile `memory.md` is untouched by direct writes |

## 4. Reference-Doc Behavior

| # | Criterion | How to verify | Pass condition |
|---|---|---|---|
| 4.1 | Legacy profile knowledge migrates on boot (Migrate env) | Boot against copied data, check `profiles/<pid>/reference/` | `legacy-profile-knowledge.md` exists with migrated content; `index.md` links to it |
| 4.2 | Migration is non-destructive | Check original `shared/knowledge/profiles/<pid>.md` | Original file still exists unchanged |
| 4.3 | Migration does not overwrite curated docs | Pre-place a `legacy-profile-knowledge.md`, boot | Existing file is preserved, not overwritten |
| 4.4 | Fresh env has no legacy knowledge artifacts | Boot fresh env, inspect `shared/knowledge/profiles/` | Directory is empty or absent |
| 4.5 | Reference docs are NOT auto-injected into runtime | Check runtime memory resources for a session | No reference-doc content in auto-injected memory; reference docs are pull-only |

## 5. Merge / Promotion Behavior

| # | Criterion | How to verify | Pass condition |
|---|---|---|---|
| 5.1 | Session memory merges into profile summary | Trigger `merge_session_memory` WS command with non-template session memory | Profile `memory.md` updated; `session_memory_merged` event with `status: 'applied'` |
| 5.2 | Template/empty session memory is a no-op | Trigger merge on an untouched default session memory | `template_noop` status; profile memory unchanged |
| 5.3 | Repeated unchanged merge is idempotent | Trigger merge twice with no session memory change | Second attempt returns `idempotent_noop`; profile memory unchanged |
| 5.4 | Idempotent skip re-evaluates after profile change | Merge session A, then externally edit profile memory, re-merge session A | Re-merge runs (not skipped) because profile hash changed since last attempt |
| 5.5 | Merge failure is fail-closed | Simulate LLM/promotion error | Profile memory content preserved; `session_memory_merge_failed` event emitted |
| 5.6 | Retry after failure is not suppressed | Trigger merge, let it fail, retry | Retry executes merge logic instead of idempotent-skipping |
| 5.7 | Audit log is written | Check `profiles/<pid>/merge-audit.log` after merge | JSONL entries with `attemptId`, `status`, `strategy`, hashes, timestamps |
| 5.8 | Session meta records merge attempts | Check `meta.json` after merge | Fields: `memoryMergeAttemptCount`, `lastMemoryMergeStatus`, `lastMemoryMergeSourceHash`, `lastMemoryMergeProfileHashBefore/After` |
| 5.9 | Seed path works for empty profile memory | Merge into a profile with empty/absent `memory.md` | Profile memory initialized from session content; `strategy: 'seed'` |

## 6. Auth / Isolation Behavior

| # | Criterion | How to verify | Pass condition |
|---|---|---|---|
| 6.1 | Runtime uses canonical shared auth path | Inspect auth reads in logs or code path | Auth resolved from `shared/auth/auth.json`, not deprecated `auth/auth.json` |
| 6.2 | Legacy auth copy-forward works | Place auth only at legacy path, boot | Auth copied to `shared/auth/auth.json`; runtime proceeds normally |
| 6.3 | Migrate env does not touch production data | Run full migrate test, verify `~/.middleman` | Production dir byte-identical before/after |
| 6.4 | Fresh env boots without legacy dependencies | Boot fresh env with empty data dir | Backend starts, creates expected directory structure, no errors about missing legacy files |
| 6.5 | `/api/transcribe` uses shared auth | Call transcribe endpoint, check auth resolution | Uses `shared/auth/auth.json` path |
| 6.6 | OAuth login writes to canonical auth | Complete OAuth flow, check file written | Credentials written to `shared/auth/auth.json` |

## 7. Operational Safety

| # | Criterion | How to verify | Pass condition |
|---|---|---|---|
| 7.1 | Backend typecheck clean | `cd apps/backend && pnpm exec tsc -p tsconfig.build.json --noEmit` | Zero errors |
| 7.2 | UI typecheck clean | `cd apps/ui && pnpm exec tsc --noEmit` | Zero errors |
| 7.3 | All unit/integration tests pass | `cd apps/backend && pnpm exec vitest run` | Zero failures |
| 7.4 | Build succeeds | `pnpm build` | Clean exit |
| 7.5 | No regression in existing scan/UI contract | Compare scan response shape before/after | `profileKnowledge` still present for back-compat; new fields additive only |
| 7.6 | Worker prompt v2 deployed with backup | Check `builtins/cortex-worker-prompts.md` and `.v1.bak` | v2 content active; v1 backup exists for rollback |
| 7.7 | Audit write failure surfaces explicitly | Simulate audit-log write failure | Merge reports failure, does not silently succeed |
| 7.8 | Pre-Phase-5 meta files remain compatible | Load a session with old `meta.json` (no profile-hash fields) | Legacy idempotent path used; richer fields repopulated on next attempt |

---

## Summary Scoring Template

| Category | Pass | Partial | Fail | Notes |
|---|---|---|---|---|
| 1. Core Chat/Session | | | | |
| 2. Cortex Scan/Review | | | | |
| 3. Ownership/Memory | | | | |
| 4. Reference-Doc | | | | |
| 5. Merge/Promotion | | | | |
| 6. Auth/Isolation | | | | |
| 7. Operational Safety | | | | |
| **Overall** | | | | |

**Overall verdict:** PASS requires all categories PASS. Any FAIL in categories 1–6 blocks merge. Category 7 FAIL blocks merge. PARTIAL items are acceptable if documented as known follow-ups.
