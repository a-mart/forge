# Cortex Memory v2 — E2E Executive Summary

**Date:** 2026-03-16  
**Worktree:** `/Users/adam/repos/middleman-worktrees/cortex-memory-v2`  
**Summary lane:** final synthesis / closeout

## 1) Headline verdict

- **Headline:** Both copied-production and fresh isolated evidence are now strong. Fresh live dispatch is proved after isolated auth repair, and the failure mode was auth-state drift rather than demonstrated Cortex Memory v2 product plumbing.
- **Strict merge gate verdict:** **GO** with one explicit documentation caveat: AUTH-03 remains an evidence-backed waiver note rather than byte-identical before/after proof.
- **Product-evidence verdict:** **GO / strong confidence** on the Cortex Memory v2 feature set for copied-data migration, fresh isolated runtime, scan/bookkeeping, ownership split, worker callback, reconnect persistence, merge/audit behavior, and copied-history learning quality.
- **Practical recommendation:** merge is reasonable now; the major runtime blocker was resolved in the isolated fresh env by repairing auth state.

## 2) Decision framing

This package now supports two different conclusions depending on which gate is being applied:

| Decision lens | Verdict | Why |
|---|---|---|
| **Strict rubric / merge call** | **GO** | Copied-prod and fresh isolated runtime evidence are both now live-pass. Backend full-suite and typecheck gates are clean. The only remaining caveat is the documented AUTH-03 waiver posture rather than byte-diff proof. |
| **Feature-specific product assessment** | **GO / strong** | Copied-prod runtime, fresh isolated runtime, scan deltas, worker callback, reconnect persistence, ownership split, merge/audit evidence, and backend test gates all align with the intended Cortex Memory v2 design. |

## 3) Evidence inputs used for this synthesis

Primary artifacts reviewed:
- `planning/cortex-memory-v2/E2E_ACTIVE_TRACKER.md`
- `planning/cortex-memory-v2/E2E_GOALS_RUBRIC.md`
- `planning/cortex-memory-v2/E2E_MIGRATE_RUNTIME.md`
- `planning/cortex-memory-v2/E2E_FRESH_RUNTIME.md`
- `planning/cortex-memory-v2/E2E_SCAN_AUDIT.md`
- `planning/cortex-memory-v2/E2E_SCAN_DELTAS.md`
- `planning/cortex-memory-v2/E2E_RECONNECT_PERSISTENCE.md`
- `planning/cortex-memory-v2/E2E_MEMORY_MERGE_RUNTIME.md`
- `planning/cortex-memory-v2/E2E_WORKER_CALLBACK_RUNTIME.md`
- `planning/cortex-memory-v2/E2E_CORTEX_LEARNING_EVAL.md`
- `planning/cortex-memory-v2/E2E_UI_HISTORY_LOAD.md`
- `planning/cortex-memory-v2/E2E_MEMORY_SKILL_TARGETS.md`
- `planning/cortex-memory-v2/E2E_PRODUCTION_NON_TOUCH.md`
- `planning/cortex-memory-v2/VALIDATION_PHASE3_REPORT.md`
- `planning/cortex-memory-v2/TESTING.md`
- `planning/cortex-memory-v2/CLOSEOUT_READINESS.md`
- `planning/cortex-memory-v2/E2E_AUTH_RUNTIME_AUDIT.md`
- `planning/cortex-memory-v2/E2E_COPIED_DIAGNOSIS_R2.md`
- `planning/cortex-memory-v2/E2E_FRESH_DIAGNOSIS_R2.md`
- Raw suite log: `.tmp/e2e-full-backend-vitest.log`

## 4) Outcome snapshot

| Track | Status | Key finding | Main caveat | Primary artifacts |
|---|---|---|---|---|
| Copied-production runtime | **PASS / strong** | Real assistant replies, enriched scan surfaces, ownership split, merge telemetry, transcript/memory drift, and Cortex exclusion all evidenced in isolated copied data | Not every provider/model combo was healthy; Anthropic failures were provider-auth specific | `E2E_MIGRATE_RUNTIME.md`, `E2E_SCAN_AUDIT.md`, `E2E_SCAN_DELTAS.md` |
| Fresh runtime structure/provisioning | **PASS** | Fresh boot, manager creation, session provisioning, canonical auth path, and v2 file surfaces all worked in empty isolated dir | Earlier auth-state failure was repaired later in the same isolated env | `E2E_FRESH_RUNTIME.md`, `VALIDATION_PHASE3_REPORT.md` |
| Fresh live dispatch | **PASS after auth repair** | A bounded rerun returned `PI_CODEX_FRESH_OK` after syncing fresh isolated auth from the valid production legacy auth source into both fresh canonical and legacy auth paths | Resolution depends on repairing isolated auth state when canonical auth is stale | `E2E_FRESH_RUNTIME.md`, `E2E_AUTH_RUNTIME_AUDIT.md`, `planning/cortex-memory-v2/raw/crt04-fresh-auth-fix-rerun.json` |
| Scan/bookkeeping | **PASS** | `profileMemory`, `profileReference`, `profileMergeAudit`, manager-only profile union, transcript/memory/feedback deltas all evidenced | Minor legacy meta normalization gaps only; scan precision was also hardened to prefer live on-disk sizes over stale meta byte fields | `E2E_SCAN_AUDIT.md`, `E2E_SCAN_DELTAS.md`, `E2E_WATERMARK_PRECISION.md` |
| Worker callback | **PASS** | Worker creation, callback token, and post-callback idle states captured with raw WS evidence | Captured in migrate env only | `E2E_WORKER_CALLBACK_RUNTIME.md` |
| Copied-instance learning quality | **PASS with narrowed polish caveat** | Cortex extracted useful durable findings from old copied-instance conversations without bloating profile memory, and later hardening reruns cleaned up the earlier closeout/path-reporting failures | Broader scenario diversity is still worth stress-testing; the strongest later proof is concentrated in the postfix rerun set rather than every historical shape | `E2E_CORTEX_LEARNING_EVAL.md`, `E2E_HARDENING_POSTFIX_RERUN.md`, `E2E_SCHEDULE_INTERFERENCE.md` |
| Reconnect persistence | **PASS** | Session-local memory token survived disconnect/reconnect and was recalled after reconnect | Captured in migrate env only | `E2E_RECONNECT_PERSISTENCE.md` |
| Existing copied-session UI history load | **PASS** | A preexisting copied session was selected from the sidebar and its persisted transcript rendered in the chat pane with text matching the on-disk copied session file | Bounded to one real copied session in the migrate env | `E2E_UI_HISTORY_LOAD.md` |
| Memory-skill target routing | **PASS** | Root remember write landed in `profiles/<pid>/sessions/<pid>/memory.md`; sub-session remember write landed in `profiles/<pid>/sessions/<sid>/memory.md`; canonical profile memory stayed unchanged | Root assistant ack had a harness-capture caveat, but session logs and file writes proved the target path | `E2E_MEMORY_SKILL_TARGETS.md` |
| Merge/promotion runtime | **PASS with bounded caveat** | Root memory stayed local; non-root merge applied/seeded; audit + meta persisted; idempotent skip verified | Full injected failure matrix remains partly test-backed rather than all live-runtime | `E2E_MEMORY_MERGE_RUNTIME.md`, `E2E_MIGRATE_RUNTIME.md`, `TESTING.md` |
| Full backend Vitest | **PASS** | Full backend suite rerun is now clean after low-churn env-sensitive test hardening | `435 passed / 0 failed` | `.tmp/e2e-full-backend-vitest.log`, `E2E_BACKEND_GATES.md` |

## 5) Product evidence vs environment/auth issues

### Product evidence that is now strong
The following behaviors are well-supported by live isolated evidence and/or focused tests:
- copied-data boot and live chat path
- enriched `/api/cortex/scan` payloads for v2 surfaces
- manager-only profile visibility in scan
- transcript, memory, and feedback delta detection
- root-session vs canonical profile-memory ownership split
- lazy reference index provisioning and legacy knowledge migration behavior
- worker spawn/callback completion path
- reconnect/session-memory persistence
- existing copied-session transcript load/render in the UI
- direct memory-skill writes route to the correct session-local memory targets without mutating canonical profile memory
- runtime merge behavior with audit/meta recording and idempotent skip
- copied-instance historical-review extraction quality is good; later hardening reruns substantially improved the earlier promotion/closeout/path-reporting rough edges, though broader historical-shape stress is still worthwhile

### Environment-specific auth issues that should not be misclassified as product regressions
The earlier fresh-lane dispatch failure was an auth-state problem, not a Memory v2 plumbing problem:
- copied `shared/auth/auth.json` made providers appear **configured**, but runtime diagnosis showed configured != valid/unexpired
- production **shared** auth had stale OAuth state while production **legacy** auth held valid current OAuth state
- syncing the isolated fresh env from the valid production legacy auth source into both fresh canonical and legacy auth paths restored successful dispatch
- runtime model resolution can fall back in a way that surfaces a different provider's auth error than the originally requested model, which is why the earlier failure looked more product-like than it was
- fresh lane always persisted user/system messages and created expected files, reinforcing that the failure lived at provider credential resolution rather than at session creation, WebSocket transport, or file-layout layers

## 6) Full-suite test result

The requested full backend suite evidence now exists and is clean after low-churn test hardening for ambient daemonized-env coupling:
- **Result:** `435 passed / 0 failed`
- **Artifact:** `.tmp/e2e-full-backend-vitest.log`
- **Supporting diagnosis/fix note:** `planning/cortex-memory-v2/E2E_BACKEND_GATES.md`

The earlier failures were traced to env-sensitive test assumptions, not Memory v2 product regressions, and were fixed without changing production runtime logic.

## 7) Rubric-style synthesis

| Category | Verdict | Notes |
|---|---|---|
| 1. Core Chat / Session Behavior | **PASS** | Copied-prod live chat, fresh live chat, worker callback, reconnect persistence, and explicit pre-existing-session UI-history load are all now proved. |
| 2. Cortex Scan / Review Behavior | **PASS** | Enriched scan surfaces, manager-only profiles, Cortex exclusion, lazy reference provisioning, and transcript/memory/feedback deltas are all evidenced. |
| 3. Ownership / Memory Behavior | **PASS** | Ownership split is strong, and direct memory-skill target proof now exists for both root and sub-session writable targets. |
| 4. Reference-Doc Behavior | **PASS** | Migration, preservation, fresh no-legacy dependency, and non-injection behavior are sufficiently evidenced via runtime + focused tests. |
| 5. Merge / Promotion Behavior | **PASS (mixed live + test-backed)** | Happy-path merge, seed, idempotent skip, audit, and meta evidence are strong. Some deeper failure/retry coverage remains primarily automated-test backed. |
| 6. Auth / Isolation Behavior | **PASS with AUTH-03 caveat** | Canonical path and isolated boot behavior are proved. Fresh isolated live dispatch also passes after repairing isolated auth from the valid legacy source. Production non-touch is still carried by an evidence-backed waiver note rather than byte-diff proof. |
| 7. Operational Safety | **PASS** | Backend/UI typechecks are clean and the full backend Vitest suite now passes after low-churn env-sensitive test hardening. |

## 8) Merge assessment

### Recommended final call
- **Strict go/no-go for merge:** **GO** with the explicit note that AUTH-03 is documented as an evidence-backed waiver rather than byte-diff proof.
- **Feature-quality call:** **GO** on the Cortex Memory v2 implementation itself; copied-prod and fresh isolated evidence are both strong and backend test gates are clean.

### If the branch is merged now, the acceptance should be explicit
If the owner chooses to merge on the current package, the decision record should explicitly state:
1. the merge is based on strong feature evidence in copied-prod + fresh isolated runtime validation,
2. the earlier fresh dispatch blocker was resolved by repairing isolated auth state from the valid production legacy auth source and is **not** classified as a Memory v2 defect,
3. backend full-suite and typecheck gates are clean as of the latest overnight rerun/fix cycle.

## 9) Remaining gaps / accepted waivers to call out

Remaining non-zero gaps / accepted waivers in the package:
- production non-touch is carried as an evidence-backed waiver note, not a byte-identical before/after diff proof

## 10) Final decision record

- **Go / No-Go:** **GO, with AUTH-03 explicitly carried as a documented waiver rather than byte-diff proof**
- **Decision owner:** repo owner / user
- **Decision date:** 2026-03-16
- **Primary supporting artifacts:**
  - `planning/cortex-memory-v2/E2E_MIGRATE_RUNTIME.md`
  - `planning/cortex-memory-v2/E2E_SCAN_DELTAS.md`
  - `planning/cortex-memory-v2/E2E_RECONNECT_PERSISTENCE.md`
  - `planning/cortex-memory-v2/E2E_UI_HISTORY_LOAD.md`
  - `planning/cortex-memory-v2/E2E_MEMORY_SKILL_TARGETS.md`
  - `planning/cortex-memory-v2/E2E_MEMORY_MERGE_RUNTIME.md`
  - `planning/cortex-memory-v2/E2E_WORKER_CALLBACK_RUNTIME.md`
  - `planning/cortex-memory-v2/E2E_FRESH_RUNTIME.md`
  - `planning/cortex-memory-v2/E2E_AUTH_RUNTIME_AUDIT.md`
  - `planning/cortex-memory-v2/E2E_PRODUCTION_NON_TOUCH.md`
  - `.tmp/e2e-full-backend-vitest.log`
