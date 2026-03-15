# Cortex Memory v2 — Task List

## Phase 0 — Setup
- [x] Create dedicated worktree
- [x] Create existing-data test copy
- [x] Create net-new test dir
- [x] Create project tracking files

## Phase 1 — Foundations
- [ ] Add session-memory freshness/review bookkeeping design to code plan
- [ ] Implement session-memory freshness signal in scan/review flow
- [ ] Add reference-doc path/provisioning helpers where needed
- [ ] Define migration path from legacy profile knowledge blobs to profile reference docs
- [ ] Update/organize Cortex worker prompt assets for deterministic kickoff + classification

## Phase 2 — Injection / Reference Model
- [ ] Remove remaining assumptions around auto-injected profile knowledge blobs
- [ ] Add lazy `profiles/<profileId>/reference/` creation flow
- [ ] Implement reference-doc write/update helpers
- [ ] Add tests for no auto-loading of reference docs

## Phase 3 — Ownership Model
- [ ] Separate root-session working memory from profile canonical memory
- [ ] Update memory path resolution and runtime composition
- [ ] Add migration logic preserving existing root profile memory content
- [ ] Add ownership-path tests for root/non-root/worker cases

## Phase 4 — Merge / Promotion Hardening
- [ ] Replace raw-append fallback semantics for profile summary memory
- [ ] Add safer summary-promotion behavior + audit trail
- [ ] Add idempotency/merge-attempt tracking
- [ ] Add tests for safe failure behavior

## Phase 5 — Metadata / Audit Hardening
- [ ] Add additional session meta review/merge fields as needed
- [ ] Keep back-compat during transition
- [ ] Decide whether profile-level review-state/audit files are needed in v1 or later

## Validation
- [ ] Existing-data migrate scenario E2E
- [ ] Net-new scenario E2E
- [ ] Basic session interactions E2E
- [ ] Regression checks around memory injection/composition
- [ ] Backend typecheck
- [ ] UI typecheck

## Review Lanes
- [ ] Cycle A implementation review (Codex)
- [ ] Cycle A implementation review (Opus)
- [ ] Cycle A remediation
- [ ] Cycle B follow-up review (Codex)
- [ ] Cycle B follow-up review (Opus)
- [ ] Cycle B remediation
