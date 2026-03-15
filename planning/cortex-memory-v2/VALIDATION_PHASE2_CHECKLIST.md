# Cortex Memory v2 — Phase 2 Validation Checklist (Execution-Ready)

## Scope
Validate Phase 2a + 2b behavior in **isolated** dirs only:
- Migrate: `/Users/adam/.middleman-cortex-memory-v2-migrate`
- Fresh: `/Users/adam/.middleman-cortex-memory-v2-fresh`
- Never touch: `/Users/adam/.middleman`

## 0) Preflight (both scenarios)
- [x] `cd /Users/adam/repos/middleman-worktrees/cortex-memory-v2`
- [x] Ensure harness ports are clear: `47387 47389 47487 47489`
- [x] Confirm data dirs exist (fresh reset performed before run)

## 1) Fast gating (no long-lived services)
Run before runtime checks:
- [x] `pnpm --filter @middleman/protocol build`
- [x] `cd apps/backend && pnpm exec tsc -p tsconfig.build.json --noEmit`
- [x] `cd apps/ui && pnpm exec tsc --noEmit`
- [x] `cd apps/backend && pnpm exec vitest run src/swarm/__tests__/reference-docs.test.ts`
- [x] `cd apps/backend && pnpm exec vitest run src/test/swarm-manager.test.ts -t "migrates legacy profile knowledge blobs into profile reference docs on boot|does not inject reference docs into runtime memory resources|upgrades legacy auto-seeded Cortex worker prompts to v2 on boot"`
- [x] `cd apps/backend && pnpm exec vitest run src/test/ws-server.test.ts -t "returns scan data and knowledge file paths through GET /api/cortex/scan|includes manager profiles in GET /api/cortex/scan even before transcript byte stats exist|isolates per-profile reference migration failures in GET /api/cortex/scan"`
- [x] `cd apps/ui && pnpm exec vitest run src/components/chat/cortex/ReviewStatusPanel.test.ts`

## 2) Migrate scenario runtime validation
Use migrate ports/data dir only.

- [x] Build with migrate WS baked:
  - `VITE_MIDDLEMAN_WS_URL=ws://127.0.0.1:47387 pnpm build`
- [x] Start backend:
  - `MIDDLEMAN_HOST=127.0.0.1 MIDDLEMAN_PORT=47387 MIDDLEMAN_DATA_DIR=/Users/adam/.middleman-cortex-memory-v2-migrate NODE_ENV=production pnpm --filter @middleman/backend start`
- [x] **Boot-path migration check (before UI):**
  - Verified for `middleman-project` and `feature-manager`:
    - `profiles/<profileId>/reference/legacy-profile-knowledge.md`
    - `profiles/<profileId>/reference/index.md` containing `./legacy-profile-knowledge.md`
- [x] Scan route check:
  - `GET http://127.0.0.1:47387/api/cortex/scan`
  - Verified populated `files.profileReference[profileId]` entries and `scan.summary` drift counters.
- [ ] Optional short UI smoke (not run in CLI-only lane).
- [x] Stop processes and clear ports.

## 3) Fresh scenario runtime validation
Use fresh ports/data dir only.

- [x] Reset fresh dir empty:
  - `rm -rf /Users/adam/.middleman-cortex-memory-v2-fresh && mkdir -p /Users/adam/.middleman-cortex-memory-v2-fresh`
- [x] Build with fresh WS baked:
  - `VITE_MIDDLEMAN_WS_URL=ws://127.0.0.1:47487 pnpm build`
- [x] Start backend:
  - `MIDDLEMAN_HOST=127.0.0.1 MIDDLEMAN_PORT=47487 MIDDLEMAN_DATA_DIR=/Users/adam/.middleman-cortex-memory-v2-fresh NODE_ENV=production pnpm --filter @middleman/backend start`
- [x] Create first manager/session (executed via WebSocket smoke in lieu of browser UI).
- [x] Run scan route:
  - `GET http://127.0.0.1:47487/api/cortex/scan`
  - Verified `files.profileReference.fresh-phase2-manager` index path exists for the active profile and scan returns without legacy dependency after the profile-union fix.
- [x] Verify no unintended legacy artifacts are required/created under `shared/knowledge/profiles` in fresh flow.
- [x] Stop processes and clear ports.

## 4) Immediate targeted runtime checks after Phase 2 reviews close
Run these immediately once review remediation is accepted:

1. **Boot-time migrate assurance** (migrate dir):
   - [x] Start backend only; verify legacy snapshot + index link appear without requiring prior manual scan.
2. **Scan endpoint contract assurance** (migrate + fresh):
   - [x] `/api/cortex/scan` returns `scan.summary` multi-signal fields and `files.profileReference` map for active profiles.
3. **No auto-injection regression assurance**:
   - [x] Re-ran the targeted `swarm-manager` test selector confirming reference docs are not injected into runtime memory context.
4. **UI drift rendering assurance**:
   - [ ] `ReviewStatusPanel.test.ts` was re-run successfully; no browser visual smoke was executed in this CLI-only lane.
5. **Final readiness gate**:
   - [x] Repeated backend + UI typecheck after review-driven edits.

## Evidence to capture
- Command outputs (build/typecheck/tests)
- `/api/cortex/scan` payload snippets (migrate + fresh)
- File existence/content proof for migrated legacy snapshot + index link
- Brief note of pass/fail per checklist item
