# Cortex Memory v2 — Phase 3 Validation Report (Ownership + Auth)

Date: 2026-03-15
Worktree: `/Users/adam/repos/middleman-worktrees/cortex-memory-v2`

## Scope
Validated Phase 3 ownership/auth behavior in isolated environments only:
- Migrate: `/Users/adam/.middleman-cortex-memory-v2-migrate`
- Fresh: `/Users/adam/.middleman-cortex-memory-v2-fresh`
- Never touched for writes: `/Users/adam/.middleman`

## Fast gates (Phase 3-focused)
- `apps/backend` targeted Phase 3 tests (ownership + auth fallback): **pass**
  - `buildSessionMemoryRuntimeView...`
  - `getMemoryRuntimeResources...root-session runtime memory...`
  - `copies legacy auth forward for /api/transcribe...`
  - `copies legacy auth forward for OAuth login...`
  - `mergeSessionMemory copies legacy auth forward...`
- Backend typecheck: `cd apps/backend && pnpm exec tsc -p tsconfig.build.json --noEmit` **pass**
- UI typecheck: `cd apps/ui && pnpm exec tsc --noEmit` **pass**

## Migrate scenario evidence
Backend booted on `127.0.0.1:47387` with:
- `MIDDLEMAN_DATA_DIR=/Users/adam/.middleman-cortex-memory-v2-migrate`

`GET /api/cortex/scan` returned populated profile memory/reference maps, e.g.:
- `profiles/feature-manager/memory.md` exists
- `profiles/feature-manager/reference/index.md` exists
- `profiles/middleman-project/memory.md` exists
- `profiles/middleman-project/reference/index.md` exists

Root-session working-memory ownership file check:
- `/Users/adam/.middleman-cortex-memory-v2-migrate/profiles/feature-manager/sessions/feature-manager/memory.md` **present**
- `/Users/adam/.middleman-cortex-memory-v2-migrate/profiles/middleman-project/sessions/middleman-project/memory.md` **present**

Auth-path state in migrate dir:
- `/Users/adam/.middleman-cortex-memory-v2-migrate/shared/auth/auth.json` **present** (canonical)

## Fresh scenario evidence
Fresh dir reset to empty, then backend booted on `127.0.0.1:47487` with:
- `MIDDLEMAN_DATA_DIR=/Users/adam/.middleman-cortex-memory-v2-fresh`

### Auth workaround used (approved)
To enable live manager dispatch in fresh, copied exactly one file:
- from: `/Users/adam/.middleman/shared/auth/auth.json`
- to: `/Users/adam/.middleman-cortex-memory-v2-fresh/shared/auth/auth.json`

No other files were copied from `~/.middleman`.

Created manager over WebSocket:
- `create_manager` (`name=fresh-phase3-manager`, model `pi-codex`) -> `manager_created` **received**

Fresh ownership files after create_manager:
- `/Users/adam/.middleman-cortex-memory-v2-fresh/profiles/fresh-phase3-manager/memory.md` **present**
- `/Users/adam/.middleman-cortex-memory-v2-fresh/profiles/fresh-phase3-manager/sessions/fresh-phase3-manager/memory.md` **present**

Fresh scan evidence (`GET /api/cortex/scan`):
- `files.profileMemory.fresh-phase3-manager.exists: true`
- `files.profileReference.fresh-phase3-manager.exists: true`
- `files.profileKnowledge.fresh-phase3-manager.exists: false` (no legacy knowledge dependency)

Auth-path state in fresh dir:
- `/Users/adam/.middleman-cortex-memory-v2-fresh/shared/auth/auth.json` **present** (canonical)
- `/Users/adam/.middleman-cortex-memory-v2-fresh/auth/auth.json` **missing** (legacy path not required)

## Result
**Phase 3 validation PASS** for both isolated migrate + fresh scenarios:
- Root-session working memory ownership split is functioning in runtime file layout.
- Canonical shared-auth path is present/usable in isolated runtime, with test coverage confirming legacy copy-forward behavior.
- No production data directory writes were performed.
