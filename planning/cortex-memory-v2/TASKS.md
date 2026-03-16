# Cortex Memory v2 — Task List

## Phase 0 — Setup
- [x] Create dedicated worktree
- [x] Create existing-data test copy
- [x] Create net-new test dir
- [x] Create project tracking files

## Phase 1 — Foundations
- [x] Add session-memory freshness/review bookkeeping design to code plan
- [x] Implement session-memory freshness signal in scan/review flow
- [x] Add reference-doc path/provisioning helpers where needed
- [x] Define migration path from legacy profile knowledge blobs to profile reference docs
- [x] Update/organize Cortex worker prompt assets for deterministic kickoff + classification

## Phase 2 — Injection / Reference Model
- [ ] Remove remaining assumptions around auto-injected profile knowledge blobs
- [ ] Extend lazy `profiles/<profileId>/reference/` provisioning from the current scan path into Cortex promotion/write-back flows
- [x] Implement reference-doc write/update helpers
- [x] Add tests for no auto-loading of reference docs

## Phase 3 — Ownership Model
- [x] Separate root-session working memory from profile canonical memory
- [x] Update memory path resolution and runtime composition
- [x] Add migration logic preserving existing root profile memory content
- [x] Add ownership-path tests for root/non-root/worker cases
- [x] Harden runtime-critical auth consumers to prefer canonical `shared/auth/auth.json` with legacy copy-forward fallback
- [x] Re-run isolated migrate/fresh validation with the Phase 3 + auth-path changes

## Phase 4 — Merge / Promotion Hardening
- [x] Replace raw-append fallback semantics for profile summary memory
- [x] Add safer summary-promotion behavior + audit trail
- [x] Add idempotency/merge-attempt tracking
- [x] Add tests for safe failure behavior

## Phase 5 — Metadata / Audit Hardening
- [x] Add additional session meta review/merge fields as needed
- [x] Keep back-compat during transition
- [x] Decide whether profile-level review-state/audit files are needed in v1 or later

## Validation
- [x] Existing-data migrate scenario E2E
- [x] Net-new scenario E2E
- [x] Basic session interactions E2E
- [x] Regression checks around memory injection/composition
- [x] Backend typecheck
- [x] UI typecheck

## Overnight Validation / Follow-Through
- [x] Build a synthesis-ready E2E evidence package (`E2E_EXEC_SUMMARY.md`, `E2E_TEST_INDEX.md`, `E2E_ACTIVE_TRACKER.md`)
- [x] Add 30-minute overnight Cortex heartbeat schedules for the next ~6 hours
- [x] Continue fresh isolated live-dispatch investigation with bounded, evidence-rich runs only
- [ ] Run additional copied-prod Cortex behavior against historical conversations and evaluate memory/knowledge usefulness
- [x] Investigate or explicitly waive the 2 failing backend tests recorded in `.tmp/e2e-full-backend-vitest.log`
- [x] Keep `OVERNIGHT_RUNBOOK.md`, summary, tracker, and test index aligned as new evidence lands

## Review Lanes
- [x] Cycle A implementation review (Codex)
- [x] Cycle A implementation review (Opus)
- [x] Cycle A remediation
- [x] Cycle B follow-up review (Codex)
- [x] Cycle B follow-up review (Opus)
- [x] Cycle B remediation
