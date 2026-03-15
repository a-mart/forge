# Cortex Memory v2 — Implementation Notes

## Phase 2a checklist — Legacy profile-knowledge migration plumbing
- [x] Add low-churn migration helper that mirrors legacy `shared/knowledge/profiles/<profileId>.md` into `profiles/<profileId>/reference/legacy-profile-knowledge.md`
- [x] Link migrated legacy snapshots from `profiles/<profileId>/reference/index.md`
- [x] Wire migration helper into live scan path (`GET /api/cortex/scan`)
- [x] Wire migration helper into manager boot/create flows so migrated reference docs appear without waiting for scan traffic
- [x] Add backend coverage for migration helper behavior, boot integration, scan integration, and no-auto-injection of reference docs

## Phase 2b checklist — Prompt/Classification Updates
- [x] Add inject/reference/discard classification model to `cortex.md` archetype (replaces binary common/profile triage)
- [x] Update review protocol to explicit scan→spawn→collect→classify→promote→watermark pipeline
- [x] Add 3-signal review awareness (transcript + memory + feedback drift) to review protocol
- [x] Add reference-doc promotion paths and profile reference doc structure to archetype
- [x] Add concise callback requirements to delegation section (STATUS/FINDINGS/ARTIFACT/BLOCKER)
- [x] Update profile knowledge structure to profile memory structure (curated summary + reference pointers)
- [x] Mark legacy `shared/knowledge/profiles/<profileId>.md` as migration-pending in data layout
- [x] Draft worker prompts v2 with 9 templates:
  1. Session transcript extraction (updated with Classification field + callback)
  2. Session-memory extraction (NEW)
  3. Knowledge synthesis (updated with classification validation + callback)
  4. Scan/triage (updated with 3-signal table + callback)
  5. Feedback telemetry (updated with classification + callback)
  6. Orchestration kickoff (NEW)
  7. Deep audit (NEW)
  8. Prune/retirement (NEW)
  9. Migration/reclassification (NEW)
- [x] Backend + UI typecheck pass

## Phase 1 checklist
- [x] Add session-memory review watermark fields to session metadata/protocol and preserve them through rebuild/update flows.
- [x] Teach `cortex-scan` to detect session-memory freshness deltas alongside transcript + feedback review state.
- [x] Add focused tests for memory freshness scan behavior and meta backfill defaults.
- [x] Add minimal reference-doc plumbing helpers for lazy `profiles/<profileId>/reference/` provisioning.
- [x] Update project tracking docs (`STATUS.md`, `TASKS.md`, `TESTING.md`) as concrete milestones land.

## Review remediation folded in
- [x] Harden reference-doc provisioning with exclusive-create semantics (`flag: 'wx'`) and concurrent-call coverage.
- [x] Add session-manifest coverage proving stats refresh does not overwrite existing memory review watermarks.
- [x] Add cortex-scan coverage for memory-compaction formatting.
- [x] Add reference-doc path-traversal coverage.
- [x] Extend scan summary semantics to surface transcript/memory/feedback drift counts and pending attention bytes.
- [x] Update review UI so memory-only / feedback-only drift renders as actionable review work.
- [x] Wire lazy reference index provisioning into a live Cortex scan runtime path with integration coverage.
- [x] Document migration intent for legacy memory-watermark backfill.

## Phase 2 execution plan
- Add low-churn legacy profile-knowledge migration helpers that seed `profiles/<profileId>/reference/` without touching production data or overwriting curated docs.
- Wire migration/provisioning into live Cortex scan/boot paths and expose enough metadata for validation/tests.
- Update Cortex prompt assets/templates to the `inject | reference | discard` model, including session-memory-aware review guidance.
- Run focused backend/UI tests as each slice lands, then finish with protocol build + backend/UI typecheck and update planning artifacts.

## Phase 2 review-remediation notes
- Runtime worker-prompt seeding is now aligned to v2 semantics in both the operational prompt asset and the embedded fallback template.
- Existing auto-seeded `.cortex-worker-prompts.md` files are upgraded in place only when they match the legacy v1 signature; the prior file is preserved as `.v1.bak`.
- `cortex.md` ownership guidance now explicitly allows Cortex to curate `profiles/<profileId>/memory.md` while still forbidding edits to other managers' swarm-memory files.
- Worker prompt offset guidance was corrected to match the `read` tool's line-based offsets.
- `/api/cortex/scan` now isolates per-profile migration/index failures and also includes manager profiles that have not yet accumulated transcript-byte stats.

## Phase 3 execution notes
- `resolveMemoryFilePath()` now routes root managers/workers to `profiles/<profileId>/sessions/<profileId>/memory.md` so root-session working memory is physically separated from `profiles/<profileId>/memory.md`.
- Runtime composition now always layers canonical profile memory as read-only reference over the owning session's working memory, including the root session.
- Manager/session creation plus Cortex auto-profile provisioning now eagerly ensure both the canonical profile memory file and the working-memory file exist before runtime creation.
- Existing `profiles/<profileId>/memory.md` content is intentionally preserved in place as canonical profile memory during the Phase 3 split; boot simply provisions the new root-session working-memory file alongside it.
- Added `apps/backend/src/swarm/auth-storage-paths.ts` to centralize canonical-auth resolution (`shared/auth/auth.json` first, legacy copy-forward fallback only when needed).
- Runtime-critical auth consumers updated to canonical shared-auth routing: runtime factory, session-memory merge, OAuth login flow, and transcription route.
- Exported `buildSessionMemoryRuntimeView()` with a testing annotation and added direct composition coverage so formatting/ordering regressions are caught explicitly.
- Strengthened the root-session `getMemoryRuntimeResources` integration test to assert ordering, single-occurrence composition, and the root-session writable path.
- Added Codex-requested legacy-auth fallback coverage for runtime-critical paths:
  - `/api/transcribe` now has an explicit legacy-only `auth/auth.json` copy-forward test.
  - OAuth login now has an explicit legacy-only auth preservation test proving canonical `shared/auth/auth.json` materialization keeps prior credentials while adding the new provider.
  - `mergeSessionMemory()` now has a legacy-only auth copy-forward test that exercises the runtime/model path through `ensureCanonicalAuthFilePath()` before mocked LLM merge execution.

## Phase 4 execution notes
- `mergeSessionMemory()` now returns structured merge results (`applied` vs `skipped`, strategy, audit path) and no longer raw-appends session working memory into canonical profile memory when the curated merge path fails.
- Safe skip semantics are explicit and auditable:
  - `template_noop` for untouched default session memory
  - `idempotent_noop` for repeated requests against unchanged session memory
  - `no_change` when the curated merge produces no canonical summary delta
- Failed non-empty profile-summary merges now fail closed: profile memory is preserved verbatim, session meta records the failed attempt, and `profiles/<profileId>/merge-audit.log` captures the attempt/error without mutating canonical summary state.
- Session meta now tracks merge attempts directly (`memoryMergeAttemptCount`, last attempt/applied timestamps, status/strategy, source hash, error) so retries and idempotency survive restarts.
- WebSocket/UI flow now waits for the final merge outcome instead of resolving on `session_memory_merge_started`, allowing skipped/applied/failure states to surface accurately to callers.
- Opus review remediation removed the dead raw-append helper and added explicit coverage for the direct `seed` strategy (empty profile summary), `no_change` LLM merges, and retry-after-failure behavior.
- Codex review remediation made audit durability explicit: audit append is no longer swallowed behind debug logging, and any audit-write failure now surfaces as a terminal merge failure with stage/audit-path diagnostics.
- Phase 4 failure handling is now outer-stage aware. Non-LLM failures (for example `record_attempt`, `write_audit`, `save_store`) are captured into session meta with failure-stage metadata, and fallback direct-meta persistence is used when the normal failed-attempt recording path itself throws.
- `session_memory_merge_failed` now carries stable recovery diagnostics when available (`strategy`, `stage`, `auditPath`), matching actual emitted backend behavior instead of speculative optional fields.

## Phase 5 execution notes
- Session merge-attempt metadata now records `lastMemoryMergeAttemptId`, `lastMemoryMergeProfileHashBefore`, and `lastMemoryMergeProfileHashAfter` so the last `meta.json` state can be correlated directly with `profiles/<profileId>/merge-audit.log` and can detect canonical-profile drift between retries.
- Idempotent skip logic is now profile-aware: unchanged session working memory only skips when the current canonical profile-memory hash still matches the last recorded post-attempt hash. If the canonical profile summary changed since the prior merge, Cortex reruns the curated merge instead of skipping.
- Codex Phase 5 blocker remediation: failed merge attempts now always bypass the idempotent-skip fast path. For post-apply failures whose session source/profile hash still match (`save_store`, `write_audit`, `refresh_session_meta_stats`, `record_attempt`), a retry replays the downstream repair path and can finish as an `applied` attempt even when the canonical profile summary content is already up to date.
- `GET /api/cortex/scan` now reports `files.profileMergeAudit[profileId].exists` from file presence (`stat`) rather than `sizeBytes > 0`, so zero-byte-but-existing audit logs are distinguishable from missing files.
- Back-compat is preserved for pre-Phase-5 `meta.json` files that lack the new profile-hash fields: unchanged-session re-merges still use the legacy idempotent path until a new attempt repopulates the richer metadata.
- No new profile-level review-state file was added for v1. Instead, `GET /api/cortex/scan` now exposes `files.profileMergeAudit[profileId]` so validators/UI/Cortex can discover the existing `profiles/<profileId>/merge-audit.log` path and presence without adding another persisted artifact.
