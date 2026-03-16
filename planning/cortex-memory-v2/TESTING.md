# Cortex Memory v2 — Testing Matrix (Execution Ready)

## Isolated Harness Targets
- **Worktree:** `/Users/adam/repos/middleman-worktrees/cortex-memory-v2`
- **Migrate data dir:** `/Users/adam/.middleman-cortex-memory-v2-migrate`
- **Fresh data dir:** `/Users/adam/.middleman-cortex-memory-v2-fresh`
- **Production dir (do not touch):** `/Users/adam/.middleman`

## Port Plan
- **Migrate:** backend `47387`, UI `47389`, baked WS `ws://127.0.0.1:47387`
- **Fresh:** backend `47487`, UI `47489`, baked WS `ws://127.0.0.1:47487`

## Preflight
```bash
cd /Users/adam/repos/middleman-worktrees/cortex-memory-v2
pnpm install
for p in 47387 47389 47487 47489; do lsof -ti :$p | xargs kill -9 2>/dev/null || true; done
mkdir -p /Users/adam/.middleman-cortex-memory-v2-migrate
mkdir -p /Users/adam/.middleman-cortex-memory-v2-fresh
```

## Execution Matrix

| ID | Scenario | Exact commands | Validate | Evidence to capture |
|---|---|---|---|---|
| M1 | Migrate build | `cd /Users/adam/repos/middleman-worktrees/cortex-memory-v2 && VITE_MIDDLEMAN_WS_URL=ws://127.0.0.1:47387 pnpm build` | Build passes with migrate WS baked | Build exit code + timestamp |
| M2 | Migrate backend start | `MIDDLEMAN_HOST=127.0.0.1 MIDDLEMAN_PORT=47387 MIDDLEMAN_DATA_DIR=/Users/adam/.middleman-cortex-memory-v2-migrate NODE_ENV=production pnpm --filter @middleman/backend start` | Backend boots on 47387 using migrate dir | Startup log line showing port + data dir |
| M3 | Migrate UI start | `cd /Users/adam/repos/middleman-worktrees/cortex-memory-v2/apps/ui && MIDDLEMAN_HOST=127.0.0.1 pnpm exec vite preview --host 127.0.0.1 --port 47389 --strictPort` | UI serves on 47389 and points to ws://127.0.0.1:47387 | Preview startup output + successful page load |
| M4 | Migrate runtime smoke | (Manual in UI at `http://127.0.0.1:47389`) create/open manager, load existing sessions, send message, verify response, run scan path as needed | Existing-data behavior intact; no obvious memory-regression | Notes + screenshot/log snippets |
| F1 | Fresh reset | `rm -rf /Users/adam/.middleman-cortex-memory-v2-fresh && mkdir -p /Users/adam/.middleman-cortex-memory-v2-fresh` | Fresh dir is empty before boot | `find` output showing no pre-existing app data |
| F2 | Fresh build | `cd /Users/adam/repos/middleman-worktrees/cortex-memory-v2 && VITE_MIDDLEMAN_WS_URL=ws://127.0.0.1:47487 pnpm build` | Build passes with fresh WS baked | Build exit code + timestamp |
| F3 | Fresh backend start | `MIDDLEMAN_HOST=127.0.0.1 MIDDLEMAN_PORT=47487 MIDDLEMAN_DATA_DIR=/Users/adam/.middleman-cortex-memory-v2-fresh NODE_ENV=production pnpm --filter @middleman/backend start` | Backend boots on 47487 using fresh dir | Startup log line showing port + data dir |
| F4 | Fresh UI start | `cd /Users/adam/repos/middleman-worktrees/cortex-memory-v2/apps/ui && MIDDLEMAN_HOST=127.0.0.1 pnpm exec vite preview --host 127.0.0.1 --port 47489 --strictPort` | UI serves on 47489 and points to ws://127.0.0.1:47487 | Preview startup output + successful page load |
| F5 | Fresh runtime smoke | (Manual in UI at `http://127.0.0.1:47489`) create first manager/session, send message, verify response, confirm expected files created under fresh dir | Net-new boot path works without legacy dependency | Notes + file-tree snapshot |
| R1 | Typecheck backend | `cd /Users/adam/repos/middleman-worktrees/cortex-memory-v2/apps/backend && pnpm exec tsc -p tsconfig.build.json --noEmit` | No TS errors | Command output |
| R2 | Typecheck UI | `cd /Users/adam/repos/middleman-worktrees/cortex-memory-v2/apps/ui && pnpm exec tsc --noEmit` | No TS errors | Command output |

## Stop/Cleanup
```bash
for p in 47387 47389 47487 47489; do lsof -ti :$p | xargs kill -9 2>/dev/null || true; done
for p in 47387 47389 47487 47489; do lsof -iTCP:$p -sTCP:LISTEN || true; done
```

## Script Gaps Blocking Direct `scripts/test-*` Use Here
- Hardcoded `~/.middleman-dev` data dir in `test-instance.sh`, `test-reset.sh`, `test-rebuild.sh`.
- `test-instance.sh` / `test-reset.sh` copy from `~/.middleman` (not allowed in this isolated lane).
- Fixed single port pair and shared pid/log paths prevent dual-scenario isolation.
- `scripts/README.md` documents `MIDDLEMAN_TEST_DATA_DIR`, but scripts currently do not implement that override.

## Phase 2 isolated validation notes
- **Migrate scenario:** backend boot on `47387` against `/Users/adam/.middleman-cortex-memory-v2-migrate` created/retained `profiles/{middleman-project,feature-manager}/reference/index.md` plus `legacy-profile-knowledge.md`, and `GET /api/cortex/scan` returned populated `files.profileReference` entries.
- **Fresh scenario:** reset `/Users/adam/.middleman-cortex-memory-v2-fresh`, built UI with WS `47487`, booted backend on `47487`, created `fresh-phase2-manager` + `fresh-phase2-manager--s2` over WebSocket, and verified `shared/knowledge/profiles/` stayed empty.
- Fresh validation initially exposed a gap: `/api/cortex/scan` only derived profile file maps from `scan.sessions`, so net-new profiles with no transcript byte stats returned empty `profileMemory`/`profileReference` maps.
- That fresh-only scan gap is now fixed by unioning session profile IDs with live manager profiles, and is covered by a dedicated `ws-server.test.ts` assertion.
- Live model-response smoke remains blocked in this isolated environment because backend runtime dispatch reports `No API key found for openai-codex`; structural/runtime file-path validation still completed.

## Phase 3 / auth-hardening validation notes
- Root-session ownership regression coverage now verifies: path resolution routes root sessions/workers to `profiles/<profileId>/sessions/<profileId>/memory.md`, runtime composition still injects canonical profile memory read-only, and non-root session/worker composition remains unchanged.
- Shared-auth hardening coverage now verifies runtime-adjacent HTTP flows read/write canonical `shared/auth/auth.json` (`/api/transcribe`, OAuth login SSE) instead of relying on deprecated `auth/auth.json`.
- Remaining validation step: re-run isolated migrate/fresh harnesses after the Phase 3/auth patch stack, using the approved fresh-lane auth copy workaround only if live model dispatch is needed.
- Codex Phase 3 remediation added explicit legacy-only auth fallback coverage for all required runtime-critical entry points before harness re-run: transcribe, OAuth login canonicalization/preservation, and merge/runtime model resolution.

## Phase 4 validation notes
- Focused merge/promotion coverage now verifies canonical profile memory promotion applies curated merge output, records attempt metadata in `meta.json`, and appends rich audit entries to `profiles/<profileId>/merge-audit.log`.
- Safe no-op coverage now verifies untouched default session memory (`template_noop`), repeated unchanged merge requests (`idempotent_noop`), and LLM-produced no-delta merges (`no_change`) all skip profile-summary mutation while still recording attempts.
- Explicit seed-path coverage now verifies empty canonical profile memory is initialized directly from non-template session memory with `strategy: 'seed'` and the expected audit metadata.
- Fail-closed coverage now verifies LLM/promotion errors preserve canonical profile memory content, retry-after-failure coverage verifies the same session content is retried instead of being incorrectly skipped as idempotent, and non-LLM failure coverage verifies `write_audit`, `record_attempt`, and `save_store` failures are recorded explicitly.
- WebSocket merge command coverage now verifies enriched `session_memory_merged` payloads (`status`, `strategy`, `auditPath`) plus failure diagnostics on `session_memory_merge_failed` (`status`, `strategy`, `stage`, `auditPath`).

## Phase 5 validation notes
- Session meta round-trip coverage now includes the new Phase 5 merge metadata fields: `lastMemoryMergeAttemptId`, `lastMemoryMergeProfileHashBefore`, and `lastMemoryMergeProfileHashAfter`.
- Merge hardening coverage now verifies unchanged session memory is **re-merged** when canonical profile memory has changed since the last attempt, preventing false idempotent skips after later profile-summary edits.
- Retry coverage now verifies post-apply failure recovery is not suppressed as idempotent: retries after `save_store` failure and after `write_audit` failure both rerun merge recovery and complete successfully.
- Transition/back-compat coverage now verifies pre-Phase-5 `meta.json` files that lack the new profile-hash fields still take the legacy idempotent skip path, and that the richer metadata is repopulated on the next attempt.
- `GET /api/cortex/scan` coverage now verifies the new `files.profileMergeAudit[profileId]` entries so validators/UI/Cortex can discover `profiles/<profileId>/merge-audit.log` without introducing a separate profile review-state file, including zero-byte existing audit logs.

## Execution Log
- 2026-03-15: `pnpm install` (worktree bootstrap) — success.
- 2026-03-15: `cd apps/backend && pnpm exec vitest run src/test/cortex-scan.test.ts src/swarm/__tests__/session-manifest.test.ts src/swarm/__tests__/reference-docs.test.ts` — success (16 tests passed).
- 2026-03-15: `cd apps/backend && pnpm exec vitest run src/test/ws-server.test.ts -t "returns scan data and knowledge file paths through GET /api/cortex/scan"` — success.
- 2026-03-15: `pnpm --filter @middleman/protocol build` — success (required before backend typecheck in this worktree).
- 2026-03-15: `cd apps/backend && pnpm exec tsc -p tsconfig.build.json --noEmit` — success.
- 2026-03-15: `cd apps/ui && pnpm exec tsc --noEmit` — success.
- 2026-03-15: `cd apps/backend && pnpm exec vitest run src/test/cortex-scan.test.ts src/swarm/__tests__/session-manifest.test.ts src/swarm/__tests__/reference-docs.test.ts` — success (20 tests passed after review remediation).
- 2026-03-15: `cd apps/backend && pnpm exec vitest run src/test/ws-server.test.ts -t "returns scan data and knowledge file paths through GET /api/cortex/scan"` — success (reference index provisioning integration coverage).
- 2026-03-15: `cd apps/ui && pnpm exec vitest run src/components/chat/cortex/ReviewStatusPanel.test.ts` — success.
- 2026-03-15: `pnpm --filter @middleman/protocol build && cd apps/backend && pnpm exec tsc -p tsconfig.build.json --noEmit && pnpm exec vitest run src/test/cortex-scan.test.ts src/swarm/__tests__/session-manifest.test.ts src/swarm/__tests__/reference-docs.test.ts && pnpm exec vitest run src/test/ws-server.test.ts -t "returns scan data and knowledge file paths through GET /api/cortex/scan" && cd ../ui && pnpm exec vitest run src/components/chat/cortex/ReviewStatusPanel.test.ts && pnpm exec tsc --noEmit` — success.
- 2026-03-15: `cd apps/backend && pnpm exec vitest run src/swarm/__tests__/reference-docs.test.ts` — success (7 tests passed; includes legacy profile-knowledge migration coverage).
- 2026-03-15: `cd apps/backend && pnpm exec vitest run src/test/swarm-manager.test.ts -t "migrates legacy profile knowledge blobs into profile reference docs on boot|does not inject reference docs into runtime memory resources"` — success.
- 2026-03-15: `cd apps/backend && pnpm exec vitest run src/test/ws-server.test.ts -t "returns scan data and knowledge file paths through GET /api/cortex/scan"` — success (scan route now covers legacy snapshot seeding alongside reference index provisioning).
- 2026-03-15: `pnpm --filter @middleman/protocol build && cd apps/backend && pnpm exec tsc -p tsconfig.build.json --noEmit && cd ../ui && pnpm exec tsc --noEmit` — success.
- 2026-03-15: `cd /Users/adam/repos/middleman-worktrees/cortex-memory-v2 && VITE_MIDDLEMAN_WS_URL=ws://127.0.0.1:47387 pnpm build` — success (migrate build; Radix/Vite warnings only).
- 2026-03-15: `MIDDLEMAN_HOST=127.0.0.1 MIDDLEMAN_PORT=47387 MIDDLEMAN_DATA_DIR=/Users/adam/.middleman-cortex-memory-v2-migrate NODE_ENV=production pnpm --filter @middleman/backend start` — success; verified migrated legacy snapshots/index links for `middleman-project` and `feature-manager` plus populated `GET /api/cortex/scan` `files.profileReference` entries.
- 2026-03-15: `rm -rf /Users/adam/.middleman-cortex-memory-v2-fresh && mkdir -p /Users/adam/.middleman-cortex-memory-v2-fresh && VITE_MIDDLEMAN_WS_URL=ws://127.0.0.1:47487 pnpm build` — success (fresh build; Radix/Vite warnings only).
- 2026-03-15: `MIDDLEMAN_HOST=127.0.0.1 MIDDLEMAN_PORT=47487 MIDDLEMAN_DATA_DIR=/Users/adam/.middleman-cortex-memory-v2-fresh NODE_ENV=production pnpm --filter @middleman/backend start` — success; booted isolated fresh backend.
- 2026-03-15: WebSocket create-manager/create-session smoke against `ws://127.0.0.1:47487` — success for structure/provisioning; live prompt dispatch failed as expected without provider credentials (`No API key found for openai-codex`).
- 2026-03-15: `cd apps/backend && pnpm exec vitest run src/test/ws-server.test.ts -t "returns scan data and knowledge file paths through GET /api/cortex/scan|includes manager profiles in GET /api/cortex/scan even before transcript byte stats exist|isolates per-profile reference migration failures in GET /api/cortex/scan"` — success.
- 2026-03-15: `pnpm --filter @middleman/backend build` — success (rebuilt dist before fresh runtime re-check).
- 2026-03-15: `curl http://127.0.0.1:47487/api/cortex/scan` after the fresh-scan fix — success; returned `profileMemory.fresh-phase2-manager` and `profileReference.fresh-phase2-manager`, and `find /Users/adam/.middleman-cortex-memory-v2-fresh/shared/knowledge/profiles -type f` stayed empty.
- 2026-03-15: `cd apps/backend && pnpm exec vitest run src/swarm/__tests__/data-paths.test.ts src/swarm/__tests__/session-manifest.test.ts src/test/swarm-manager.test.ts src/test/ws-server-p0-endpoints.test.ts src/test/secrets-env-service.test.ts` — success after Phase 3/auth updates (root-session ownership + canonical auth path coverage).
- 2026-03-15: `cd apps/backend && pnpm exec vitest run src/test/ws-server-p0-endpoints.test.ts src/test/ws-server.test.ts -t "rejects invalid upload requests and missing auth for /api/transcribe|maps /api/transcribe upstream auth errors, upstream failures, and aborts|streams OAuth login SSE events and accepts prompt responses|returns scan data and knowledge file paths through GET /api/cortex/scan|includes manager profiles in GET /api/cortex/scan even before transcript byte stats exist|isolates per-profile reference migration failures in GET /api/cortex/scan"` — success.
- 2026-03-15: `cd apps/backend && pnpm exec vitest run src/test/swarm-manager.test.ts -t "buildSessionMemoryRuntimeView composes read-only profile memory above writable session memory|getMemoryRuntimeResources composes root-session runtime memory from canonical profile memory plus root working memory"` — success (Phase 3 Opus review remediation).
- 2026-03-15: `pnpm --filter @middleman/protocol build && cd apps/backend && pnpm exec tsc -p tsconfig.build.json --noEmit && cd ../ui && pnpm exec tsc --noEmit` — success after Phase 3 Opus review remediation.
- 2026-03-15: `cd apps/backend && pnpm exec vitest run src/test/ws-server-p0-endpoints.test.ts src/test/swarm-manager.test.ts -t "copies legacy auth forward for /api/transcribe when canonical shared auth is absent|copies legacy auth forward for OAuth login and preserves prior credentials in canonical shared auth|mergeSessionMemory copies legacy auth forward to canonical shared auth before model resolution"` — success (Phase 3 Codex review remediation).
- 2026-03-15: `cd apps/backend && pnpm exec vitest run src/test/swarm-manager.test.ts -t "mergeSessionMemory"` — success (Phase 4 merge/promotion hardening: applied/skip/idempotent/fail-closed coverage, plus Codex remediation for audit/save-store/record-attempt failure stages).
- 2026-03-15: `cd apps/backend && pnpm exec vitest run src/test/ws-server.test.ts -t "session lifecycle websocket commands|session_memory_merge_failed"` — success (Phase 4 websocket merge-result + failure-diagnostics coverage).
- 2026-03-15: `cd apps/backend && pnpm exec vitest run src/swarm/__tests__/session-manifest.test.ts` — success (session meta round-trip/build safety after merge-attempt field expansion).
- 2026-03-15: `pnpm --filter @middleman/protocol build && cd apps/backend && pnpm exec tsc -p tsconfig.build.json --noEmit && cd ../ui && pnpm exec tsc --noEmit` — success after Phase 4 Codex remediation.
- 2026-03-15: `pnpm --filter @middleman/protocol build` — success after Phase 5 shared-type/session-meta expansion.
- 2026-03-15: `cd apps/backend && pnpm exec vitest run src/swarm/__tests__/session-manifest.test.ts src/test/swarm-manager.test.ts -t "mergeSessionMemory|writes and reads meta files atomically"` — success (Phase 5 meta round-trip + profile-hash-aware merge idempotency/back-compat coverage).
- 2026-03-15: `cd apps/backend && pnpm exec vitest run src/test/ws-server.test.ts -t "returns scan data and knowledge file paths through GET /api/cortex/scan|includes manager profiles in GET /api/cortex/scan even before transcript byte stats exist|isolates per-profile reference migration failures in GET /api/cortex/scan"` — success (Phase 5 `profileMergeAudit` scan payload coverage).
- 2026-03-15: `cd apps/backend && pnpm exec tsc -p tsconfig.build.json --noEmit` — success after Phase 5 backend changes.
- 2026-03-15: `cd apps/ui && pnpm exec tsc --noEmit` — success after Phase 5 backend/scan-contract changes.
- 2026-03-15: `cd apps/backend && pnpm exec vitest run src/test/swarm-manager.test.ts -t "write_audit failure|save_store failure|retry after a write_audit failure|retry after a save_store failure|retries after a failed attempt instead of skipping idempotently"` — success (Codex Phase 5 blocker remediation: failed post-apply merges no longer idempotent-skip retries).
- 2026-03-15: `cd apps/backend && pnpm exec vitest run src/test/ws-server.test.ts -t "returns scan data and knowledge file paths through GET /api/cortex/scan|includes manager profiles in GET /api/cortex/scan even before transcript byte stats exist|isolates per-profile reference migration failures in GET /api/cortex/scan"` — success after zero-byte `profileMergeAudit.exists` tightening.
- 2026-03-15: `pnpm --filter @middleman/protocol build && cd apps/backend && pnpm exec tsc -p tsconfig.build.json --noEmit && cd ../ui && pnpm exec tsc --noEmit` — success after Codex Phase 5 remediation.
