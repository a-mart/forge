# Cortex Memory v2 — Decisions

## Locked Decisions
- Option A is the target architecture.
- Rollout should be low-churn first, but the end-state should still be complete.
- Work must happen in a separate worktree with zero production-environment risk.
- Testing must cover both:
  - migration from a copied existing `.middleman` dir
  - net-new empty-data boot
- Primary implementation model: GPT-5.4 high.
- Review models: Codex 5.3 high + Opus 4.6 high.
- E2E validation should use separate medium-reasoning workers.
- Cortex should maintain explicit project status/task artifacts to survive compaction.
- Cortex messages to the user should stay concise; detailed reasoning goes in markdown files.

## Working Implementation Order
1. Session-memory freshness/review bookkeeping
2. Reference-doc migration plumbing
3. Root-session memory separation
4. Merge/promotion hardening
5. Remaining metadata/audit hardening

## Migration Clarifications
- Legacy sessions missing `cortexReviewedMemoryBytes` are intentionally backfilled to the current `memory.md` size during meta rebuild/stats refresh. This is a low-churn migration policy: existing memory is treated as baseline-reviewed instead of forcing an immediate first-pass review across all pre-v2 sessions.
- Under that policy, `cortexReviewedMemoryAt` remains `null` until Cortex explicitly reviews session memory after rollout. Any subsequent memory growth or compaction still reopens review through the normal freshness scan.
- Legacy `shared/knowledge/profiles/<profileId>.md` files are migrated non-destructively by mirroring their current content into `profiles/<profileId>/reference/legacy-profile-knowledge.md` and linking that snapshot from `profiles/<profileId>/reference/index.md`.
- The low-churn rollout keeps the legacy source file in place for compatibility during transition; the migrated snapshot is a seed/reference artifact, not a destructive move.
- Migration provisioning should happen in live safe paths (boot/create + scan) and must never overwrite an existing curated reference doc.
- `GET /api/cortex/scan` should derive profile file maps from the union of reviewed sessions and live manager profiles (excluding `cortex`) so fresh/profile-only states still surface `profileMemory` and `profileReference` paths before transcript byte stats exist.
- Keep `files.profileKnowledge` in the scan response temporarily for compatibility during the Phase 2 transition, but treat `profileMemory` as the preferred UI/runtime-facing source.
- Phase 3 ownership split preserves existing `profiles/<profileId>/memory.md` content as canonical profile memory; the new root-session working-memory file is additive (`profiles/<profileId>/sessions/<profileId>/memory.md`), not a destructive move.
- Runtime-critical auth must use canonical `shared/auth/auth.json`. Deprecated `paths.authFile` may remain for transition compatibility/helpers, but runtime dispatch, merge, and auth-related HTTP flows should read/write through the shared-auth path (with copy-forward fallback from legacy only when needed).
- Phase 4 merge/promotion hardening uses fail-closed semantics for canonical profile summary memory: if a non-empty profile-memory merge cannot produce a curated merge result, the canonical summary is left untouched and the failure is captured in session meta + profile audit log instead of raw-appending session memory.
- Repeated merge requests for unchanged session working memory should be idempotent. Persist the last merge source hash/status in session meta so unchanged sessions skip promotion safely without duplicating canonical profile-summary content.
- Audit durability is part of Phase 4 correctness, not best-effort telemetry. If writing `profiles/<profileId>/merge-audit.log` fails, the merge must surface an explicit failure outcome; it may not silently report success/skipped while losing the audit trail.
- Phase 5 adds three per-session merge metadata fields for audit correlation and safer idempotency: `lastMemoryMergeAttemptId`, `lastMemoryMergeProfileHashBefore`, and `lastMemoryMergeProfileHashAfter`.
- Idempotent re-skip of unchanged session memory is only considered safe when the session source hash still matches and the current canonical profile-memory hash still matches the last recorded post-attempt profile hash. If those new profile-hash fields are absent (pre-Phase-5 meta), fall back to legacy idempotent behavior for transition compatibility.
- Any prior merge attempt with `lastMemoryMergeStatus === "failed"` must bypass the idempotent-skip fast path. Post-apply failures (`save_store`, `write_audit`, etc.) are recoverable work, so retries must rerun the merge/reconciliation path and replay the downstream persistence/audit steps instead of being suppressed as unchanged.
- No dedicated `profiles/<profileId>/review-state.json` file is warranted for v1. The canonical state remains session `meta.json` + `profiles/<profileId>/merge-audit.log`; `/api/cortex/scan` should expose profile merge-audit file info for discovery instead of introducing another persisted review-state artifact.
