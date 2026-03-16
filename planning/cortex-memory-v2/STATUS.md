# Cortex Memory v2 — Status

## Project Summary
Implement the full Cortex memory redesign with:
- Option A end-state
- lean injected summary memory
- pull-based reference docs
- session-memory review/bookkeeping
- migration-safe rollout for existing environments
- correct behavior for net-new environments

## Environment Isolation
- Worktree: `/Users/adam/repos/middleman-worktrees/cortex-memory-v2`
- Branch: `feat/cortex-memory-v2`
- Existing-data test dir: `/Users/adam/.middleman-cortex-memory-v2-migrate`
- Net-new test dir: `/Users/adam/.middleman-cortex-memory-v2-fresh`
- Production data dir to avoid touching: `/Users/adam/.middleman`

## Execution Model
- Primary implementation: GPT-5.4 high
- Code reviews: Codex 5.3 high + Opus 4.6 high
- Remediation returns to primary implementation lane
- E2E validation: separate medium-reasoning workers

## Current Phase
- Phase 1 foundation + review remediation implemented in code/tests
- Phase 2a legacy profile-knowledge → reference-doc migration plumbing implemented in code/tests
- Phase 2b prompt/classification updates implemented in `cortex.md` + deployed to runtime worker-prompt seeding
- Phase 2 review remediation implemented in code/tests, including prompt upgrade path, ownership/offset guidance fixes, scan-route hardening, and isolated migrate/fresh validation
- Phase 3 ownership/auth hardening is functionally landed and awaiting final isolated validation confirmation
- Phase 4 merge/promotion hardening has now landed in code/tests: profile-summary promotion fails closed, merge attempts are tracked/idempotent, and audit/result metadata is emitted end-to-end
- Phase 5 metadata/audit hardening has now landed in code/tests: session meta records merge attempt/profile hashes for safer idempotency, legacy meta stays compatible during transition, and scan payloads expose per-profile merge-audit paths without adding a new persisted v1 review-state file

## Latest Completed
- Two architecture/review cycles completed
- Initial main-branch prep commit landed earlier for memory injection path slimming
- Dedicated worktree created
- Isolated migrate + fresh data dirs created
- Project tracking files created
- Added Phase 1 implementation checklist in `planning/cortex-memory-v2/IMPLEMENTATION_NOTES.md`
- Added session-memory review watermark fields/backfill in session metadata plumbing
- Extended `cortex-scan` to detect session-memory freshness deltas alongside transcript + feedback state
- Extended scan summary semantics for the multi-signal freshness model (transcript/memory/feedback drift counts + attention bytes)
- Added minimal lazy reference-doc provisioning helpers in `apps/backend/src/swarm/reference-docs.ts`
- Wired reference-doc index provisioning into `GET /api/cortex/scan` so Cortex/UI scan traffic now creates live `profiles/<profileId>/reference/index.md` paths lazily
- Updated Cortex review UI to render memory/feedback freshness states as actionable per-session review items
- Folded in Opus/Codex review hardening: exclusive-create reference docs, watermark stability coverage, memory-compaction formatting coverage, path-traversal coverage
- Documented low-churn migration intent for legacy memory-watermark backfill in `planning/cortex-memory-v2/DECISIONS.md`
- Ran focused backend/UI tests + backend/UI typecheck in the worktree
- **Phase 2a**: Added low-churn legacy profile-knowledge migration helper in `apps/backend/src/swarm/reference-docs.ts` that seeds `profiles/<profileId>/reference/legacy-profile-knowledge.md` and links it from the reference index without overwriting curated docs
- **Phase 2a**: Wired legacy migration into manager boot/create flows plus `GET /api/cortex/scan`, and added coverage for migration + no-auto-injection of reference docs
- **Phase 2b**: Updated `cortex.md` archetype with inject/reference/discard classification model, 3-signal review pipeline (transcript + memory + feedback), reference-doc promotion paths, concise callback structure, and profile memory/reference doc structure
- **Phase 2b**: Deployed worker prompts v2 to runtime defaults (`apps/backend/src/swarm/operational/builtins/cortex-worker-prompts.md`) and added boot-time auto-upgrade + `.v1.bak` backup handling for legacy `.cortex-worker-prompts.md`
- Resolved Phase 2 review blockers around Cortex memory ownership wording, line-vs-byte offset guidance, and scan-route fail-closed behavior
- Hardened `GET /api/cortex/scan` to union session-derived profile IDs with manager profiles so net-new profiles surface `profileMemory`/`profileReference` even before transcript byte stats exist
- Updated Cortex dashboard knowledge view to prefer `profileMemory` while keeping legacy `profileKnowledge` compatibility in the scan payload
- Executed isolated migrate + fresh runtime validation against `/Users/adam/.middleman-cortex-memory-v2-{migrate,fresh}`; fresh validation exposed the profile-only scan gap, which is now fixed and covered by test
- **Phase 3**: Root-session working memory is now separated from canonical profile memory in path resolution/runtime composition. Root managers/workers read `profiles/<profileId>/sessions/<profileId>/memory.md` as the writable runtime file while still receiving `profiles/<profileId>/memory.md` as read-only injected reference.
- **Phase 3**: Manager/session creation and boot-time provisioning now ensure both canonical profile memory and root-session working memory files exist.
- **Auth hardening**: Added canonical shared-auth path helper and switched runtime-critical auth consumers (runtime factory, session-memory merge, OAuth login flow, transcription route) to `shared/auth/auth.json` with legacy copy-forward fallback.
- Added/updated ownership-path + auth-path coverage across `data-paths`, `session-manifest`, `swarm-manager`, and WS route tests.
- Closed Opus Phase 3 must-fix test gaps with a direct `buildSessionMemoryRuntimeView` composition test and a stronger root-session `getMemoryRuntimeResources` composition integration test.
- Closed Codex Phase 3 auth-regression gap with explicit legacy-auth copy-forward tests covering `/api/transcribe`, OAuth login canonicalization/preservation, and the merge/runtime model path.
- **Phase 4**: Replaced the profile-memory raw-append fallback path with fail-closed promotion semantics. Non-empty profile summary merges now either apply a curated merge, skip safely (`template_noop`, `idempotent_noop`, `no_change`), or fail without mutating canonical profile memory.
- **Phase 4**: Added per-session merge-attempt tracking in `meta.json` (`memoryMergeAttemptCount`, last attempt/applied timestamps, status/strategy, source hash, error) plus richer JSONL audit entries (`attemptId`, status/strategy, hashes, appliedChange, model/error).
- **Phase 4**: Hardened websocket/UI completion semantics so `merge_session_memory` resolves on the final `session_memory_merged` event and rejects on `session_memory_merge_failed`, with result metadata (`status`, `strategy`, `auditPath`) available to callers.
- Added focused Phase 4 backend coverage for safe promotion, template no-op tracking, idempotent re-merge skipping, fail-closed error handling, and enriched websocket merge events.
- Closed Opus Phase 4 must-fix/type gaps by tightening `session_memory_merge_failed` to actual emitted semantics, adding explicit `seed` strategy coverage, adding `no_change` + retry-after-failure coverage, and removing dead raw-append helper code.
- Closed Codex Phase 4 integrity blockers by making audit-write failure explicit (no silent best-effort audit loss), capturing failed-attempt metadata for non-LLM failure stages via outer failure handling + fallback meta persistence, and surfacing failure diagnostics (`strategy`, `stage`, `auditPath`) through websocket failure events when available.
- **Phase 5**: Added `lastMemoryMergeAttemptId`, `lastMemoryMergeProfileHashBefore`, and `lastMemoryMergeProfileHashAfter` to session `meta.json`, and use those hashes to re-run unchanged-session merges whenever canonical profile memory has changed since the last attempt.
- **Phase 5**: Preserved transition compatibility for older `meta.json` files by falling back to legacy idempotent-skip behavior when the new profile-hash metadata is absent, then repopulating the richer fields on the next merge attempt.
- **Phase 5**: Closed the Codex blocker by making all prior failed merge attempts bypass the idempotent-skip fast path; retries after post-apply failures (`save_store`, `write_audit`) now replay recovery instead of being suppressed as unchanged.
- **Phase 5**: Extended `GET /api/cortex/scan` with `files.profileMergeAudit[profileId]` so validators/UI/Cortex can discover existing `profiles/<profileId>/merge-audit.log` paths without introducing a new profile-level review-state file, and zero-byte audit logs now report `exists: true`.

## Next Up
1. Keep pushing repeated copied-history stress runs to confirm the improved closeout/review behavior holds across more scenario shapes, not just the postfix trio.
2. Keep the backend/full-suite gate clean after the low-churn env-sensitive test fixes captured in `planning/cortex-memory-v2/E2E_BACKEND_GATES.md`.
3. Keep `planning/cortex-memory-v2/OVERNIGHT_RUNBOOK.md`, `E2E_EXEC_SUMMARY.md`, `E2E_ACTIVE_TRACKER.md`, and `E2E_TEST_INDEX.md` aligned as hardening evidence expands.
4. Decide whether the newest hardening posture should also be folded into the formal package docs beyond the tracker/postfix artifacts.

## Open User Review Gates
- None currently
