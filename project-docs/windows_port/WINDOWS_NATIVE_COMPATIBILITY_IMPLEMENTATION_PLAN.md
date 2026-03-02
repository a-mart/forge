# Middleman Windows Native Compatibility Implementation Plan

## 1) Objective

Make the `middleman` monorepo run correctly on native Windows (`cmd.exe` and PowerShell), without requiring WSL, for core workflows:

1. `pnpm dev`
2. `pnpm build`
3. `pnpm test`
4. `pnpm prod:start` (non-daemon mode)

This plan is scoped to app/runtime code and package scripts. It explicitly excludes Bash-only shell scripts (`/scripts/*.sh`) per request.

## 2) Scope and Non-Goals

### In Scope

1. Root/package scripts needed for standard dev/prod startup.
2. Backend runtime behavior that currently assumes Unix signals.
3. Codex runtime process launch compatibility on Windows.
4. UI artifact link/path handling for Windows file paths.
5. File-read allowlist portability (`tmpdir` handling).
6. Tests and CI coverage additions required to enforce Windows compatibility.
7. Documentation updates for Windows-native run instructions.

### Out of Scope

1. `scripts/*.sh` migration to PowerShell or `.cmd`.
2. Daemon orchestration parity for every Unix signal behavior in `scripts/*.mjs`.
3. Any UI redesign unrelated to compatibility.
4. Any broad architectural refactor outside the blockers below.

## 3) Current Blockers (Concrete)

## Blocker A: POSIX shell syntax in root scripts

`package.json` currently uses:

1. `${VAR:-default}`
2. `$(...)`
3. `2>/dev/null`
4. inline env assignment (`NODE_ENV=production ...`)

These are not portable to `cmd.exe` and are fragile in PowerShell.

Primary references:

1. `package.json` scripts `dev`, `dev:ui`, `prod:start`

## Blocker B: Unix-only reboot signal

Backend hardcodes `SIGUSR1` for `/api/reboot`; this is unsupported on Windows.

Primary references:

1. `apps/backend/src/ws/routes/health-routes.ts`
2. `apps/backend/src/test/ws-server.test.ts` (asserts `SIGUSR1`)

## Blocker C: Codex process spawn portability

Codex runtime uses raw `spawn(command, args)` with `command` defaulting to `codex`. On Windows, executable resolution may map to `.cmd` wrappers that need platform-safe launch behavior.

Primary references:

1. `apps/backend/src/swarm/codex-jsonrpc-client.ts`
2. `apps/backend/src/swarm/codex-agent-runtime.ts`

## Blocker D: VS Code URI generation for Windows absolute paths

`toVscodeInsidersHref` currently generates malformed links for `C:\...` style paths.

Primary references:

1. `apps/ui/src/lib/artifacts.ts`
2. `apps/ui/src/lib/artifacts.test.ts`

## Blocker E: POSIX temp directory assumption in allowlist

Read-file route adds hardcoded `"/tmp"` instead of using `os.tmpdir()`.

Primary reference:

1. `apps/backend/src/ws/routes/file-routes.ts`

## Blocker F: Minor UI path truncation assumes `/` separators

Path truncation logic splits only on `'/'`; Windows path display can degrade.

Primary reference:

1. `apps/ui/src/components/chat/ArtifactsSidebar.tsx`

## 4) Design Principles for the Port

1. Keep behavior parity for macOS/Linux where already working.
2. Remove shell-specific behavior from primary npm scripts.
3. Prefer platform-aware Node logic over shell tricks.
4. Keep changes small and local; avoid broad rewrites.
5. Add tests before or alongside fixes for each blocker.
6. Make CI enforce compatibility so regressions are caught quickly.

## 5) Implementation Workstreams

## Workstream 1: Make root startup scripts shell-agnostic

### Goal

Ensure root workflows execute in `cmd.exe`, PowerShell, and Unix shells.

### Planned changes

1. Update root `package.json` scripts:
   1. Remove command substitution and POSIX parameter expansion from `dev`, `dev:ui`, `prod:start`.
   2. Replace inline env assignment with `cross-env` for `prod:start`.
2. Add root dev dependency:
   1. `"cross-env": "^7.x"` (or latest stable compatible with current Node target).
3. Move host default behavior into UI Vite config:
   1. In `apps/ui/vite.config.ts`, set `server.host` and `preview.host` from `process.env.MIDDLEMAN_HOST ?? "127.0.0.1"`.
   2. Keep CLI flags limited to port/strictPort where needed.
4. Keep backend port override in `prod:start` via `cross-env MIDDLEMAN_PORT=47287`.

### Files

1. `package.json`
2. `apps/ui/vite.config.ts`
3. Optional: `apps/ui/package.json` if script simplification is needed

### Acceptance criteria

1. `pnpm dev` starts backend+UI on Windows without shell syntax errors.
2. `pnpm prod:start` runs on Windows with correct backend port override.
3. Existing macOS/Linux behavior remains unchanged.

## Workstream 2: Platform-aware reboot route

### Goal

Make `/api/reboot` safe and functional on Windows without Unix-only signal assumptions.

### Planned behavior

1. Keep Unix behavior:
   1. For non-Windows platforms, continue using `SIGUSR1` (compatibility with existing daemon semantics).
2. Add Windows behavior:
   1. Use a Windows-safe signal strategy (default `SIGTERM`).
   2. If signaling self-process on Windows, allow graceful shutdown path rather than unsupported signal throw.
3. Centralize signal selection:
   1. Introduce helper function (`resolveRestartSignal(platform)` or equivalent) to avoid duplicated platform checks.

### Files

1. `apps/backend/src/ws/routes/health-routes.ts`
2. `apps/backend/src/ws/server.ts` (only if dependency injection of platform/restart strategy is needed)
3. `apps/backend/src/test/ws-server.test.ts`

### Test plan

1. Update existing reboot test not to hardcode only `SIGUSR1`.
2. Add Windows-specific route test by injecting/stubbing platform and asserting Windows signal strategy.
3. Preserve existing success-path assertion (`200` + async signal dispatch).

### Acceptance criteria

1. No runtime exception when reboot endpoint is called on Windows.
2. Existing Linux/macOS test still passes with `SIGUSR1`.

## Workstream 3: Codex child-process launch portability

### Goal

Ensure Codex runtime can launch on Windows when executable resolution involves `.cmd` wrappers.

### Planned changes

1. Introduce a platform-safe spawn strategy:
   1. Preferred: use `cross-spawn` in `CodexJsonRpcClient`.
   2. Alternative: explicit Windows command resolution wrapper (`cmd.exe /d /s /c` for `.cmd/.bat`).
2. Keep API surface stable:
   1. `CodexJsonRpcClientOptions` remains unchanged unless tests require explicit platform injection for deterministic coverage.
3. Maintain stderr/stdout JSON-RPC behavior unchanged.

### Files

1. `apps/backend/src/swarm/codex-jsonrpc-client.ts`
2. `apps/backend/src/swarm/codex-agent-runtime.ts` (only if command normalization is added here)
3. `apps/backend/package.json` (if adding dependency)
4. `apps/backend/src/test/codex-jsonrpc-client.test.ts`
5. Optional new test file: `apps/backend/src/test/codex-spawn-platform.test.ts`

### Test plan

1. Add unit tests around spawn strategy selection (platform-aware path).
2. Preserve existing JSON-RPC functional tests unchanged.
3. Add regression test for missing binary startup error clarity.

### Acceptance criteria

1. Codex runtime starts on Windows with default `CODEX_BIN=codex` installation pattern.
2. Existing Unix behavior and tests remain green.

## Workstream 4: Windows-safe VS Code artifact URI + path rendering

### Goal

Fix invalid VS Code links and improve Windows path rendering in UI.

### Planned changes

1. In `toVscodeInsidersHref`:
   1. Normalize backslashes to forward slashes.
   2. Convert `C:\path\file` to URI path form `/C:/path/file`.
   3. Keep URL encoding.
2. Keep parser behavior aligned:
   1. Ensure `parseArtifactReference` supports links produced by the new formatter.
3. Improve truncation:
   1. Update `truncatePath` to split on both separators (`/[\\/]/`).

### Files

1. `apps/ui/src/lib/artifacts.ts`
2. `apps/ui/src/lib/artifacts.test.ts`
3. `apps/ui/src/components/chat/ArtifactsSidebar.tsx`
4. Optional new test file for truncation helper if extracted

### Test plan

1. Add Windows path cases in `artifacts.test.ts`:
   1. `toVscodeInsidersHref("C:\\Users\\me\\my notes.md")`
   2. Parse round-trip for produced Windows URI.
2. Add/adjust tests for path truncation with backslash-separated inputs.

### Acceptance criteria

1. “Open in VS Code” link is valid for Windows absolute paths.
2. Artifact filename extraction and truncation remain correct across path styles.

## Workstream 5: Temp directory allowlist portability

### Goal

Replace hardcoded `"/tmp"` assumption with `os.tmpdir()` logic.

### Planned changes

1. In `file-routes.ts`, include `tmpdir()` in allowed roots.
2. Remove hardcoded `"/tmp"` literal from portability-critical path list.
3. Retain normalization through existing `normalizeAllowlistRoots`.

### Files

1. `apps/backend/src/ws/routes/file-routes.ts`
2. `apps/backend/src/test/ws-server.test.ts` (new/adjusted test for temp dir read allowance)

### Acceptance criteria

1. Temp-file reads in OS temp directory pass on Windows and Unix.
2. Disallowed path checks remain enforced.

## Workstream 6: CI and documentation hardening

### Goal

Prevent regressions by validating on Windows in CI and documenting native run path.

### Planned changes

1. Update CI workflow:
   1. Convert single Ubuntu job to an OS matrix including `windows-latest` and `ubuntu-latest`.
   2. Run install/build/typecheck/tests on both where feasible.
2. Update docs:
   1. Root `README.md`: confirm Windows-native support scope and required commands.
   2. Any docs that reference only POSIX shell syntax for core startup should include Windows-native equivalent for the supported path.
3. Keep `.sh` docs unchanged if they remain explicitly out-of-scope/Unix-only.

### Files

1. `.github/workflows/ci.yml`
2. `README.md`
3. Optional: `project-docs/USER_GUIDE.md` sections that describe core startup

### Acceptance criteria

1. CI green on `windows-latest` for supported command set.
2. Docs no longer imply POSIX shell is required for core app run.

## 6) Ordered Execution Plan (Test-First)

## Phase 0: Branch safety + baseline capture

1. Create/confirm feature branch.
2. Capture current baseline failures on Windows shell syntax and reboot behavior.
3. Record unchanged baseline for Linux/macOS tests to avoid accidental regressions.

## Phase 1: Write/adjust failing tests for each blocker

1. Add/update reboot route tests for platform-aware signal handling.
2. Add Windows URI/path tests in `artifacts.test.ts`.
3. Add spawn strategy tests for codex runtime process launch.
4. Add temp-dir allowlist test.

Expected result: tests fail for known blockers prior to implementation.

## Phase 2: Implement script portability + Vite host defaults

1. Update root scripts + `cross-env`.
2. Move host defaults into UI Vite config.
3. Verify local startup commands on current platform for regression check.

## Phase 3: Implement backend/runtime platform fixes

1. Reboot signal strategy update.
2. Codex spawn strategy update.
3. Temp dir allowlist update.

## Phase 4: Implement UI path/URI fixes

1. Artifact URI generation updates.
2. Path truncation separator handling.
3. Ensure tests cover both separators and round-trips.

## Phase 5: CI + docs

1. Add Windows CI matrix leg.
2. Update run instructions.
3. Confirm documentation aligns with actual script behavior.

## Phase 6: Verification gate

1. `pnpm install`
2. `pnpm build`
3. `pnpm --filter @middleman/backend exec tsc -p tsconfig.build.json --noEmit`
4. `pnpm --filter @middleman/ui exec tsc --noEmit`
5. `pnpm --filter @middleman/backend test`
6. `pnpm --filter @middleman/ui test`
7. Startup smoke:
   1. `pnpm dev` (backend + UI startup)
   2. Open UI, create manager, send message, open artifact link
   3. Trigger `/api/reboot` via settings endpoint

## 7) Detailed Test Matrix

## Backend

1. `apps/backend/src/test/ws-server.test.ts`
   1. Reboot endpoint: Unix signal case remains.
   2. Reboot endpoint: Windows signal fallback case.
   3. Read-file endpoint: temp dir from `os.tmpdir()` is permitted.
2. `apps/backend/src/test/codex-jsonrpc-client.test.ts`
   1. Existing request/response behavior unaffected.
   2. New spawn-platform tests for Windows command strategy.

## UI

1. `apps/ui/src/lib/artifacts.test.ts`
   1. `toVscodeInsidersHref` supports Windows absolute paths.
   2. `parseArtifactReference` accepts updated generated link.
2. Path truncation tests (existing or new extracted helper test):
   1. Handles `/` and `\` path separators.

## End-to-end smoke

1. `pnpm dev` launches both servers on Windows shell.
2. Browser flow: manager creation + message send + artifact interaction.
3. Settings reboot call returns success and does not throw server-side.

## 8) Risk Register and Mitigations

## Risk 1: Reboot semantics drift across platforms

Mitigation:

1. Explicit platform-specific tests.
2. Keep Unix signal behavior untouched where currently expected.
3. Log restart path decisions for easier diagnosis.

## Risk 2: Spawn changes break Unix behavior

Mitigation:

1. Preserve existing API and IO behavior.
2. Add focused tests for process startup errors and normal lifecycle.
3. Keep fallback strategy minimal and deterministic.

## Risk 3: Script simplification changes host-binding behavior

Mitigation:

1. Move host default into Vite config with explicit `MIDDLEMAN_HOST` support.
2. Validate both default and overridden host in local smoke checks.

## Risk 4: CI runtime increase

Mitigation:

1. Keep matrix minimal (`ubuntu-latest`, `windows-latest`).
2. Reuse existing commands.
3. Split expensive checks later only if needed.

## 9) Definition of Done

The Windows port is considered complete when all conditions are met:

1. `pnpm dev` works on native Windows shell without manual script editing.
2. `pnpm build` and package typechecks pass.
3. Backend/UI test suites pass with new compatibility tests.
4. `/api/reboot` no longer depends on unsupported Windows signals.
5. Codex runtime process launch works with Windows executable resolution.
6. Artifact VS Code links are valid for Windows absolute paths.
7. Read-file temp allowlist uses OS temp root instead of hardcoded `"/tmp"`.
8. CI includes and passes a Windows job for the supported command path.
9. Docs reflect the supported Windows-native workflow and known out-of-scope areas.

## 10) Change List Checklist (for implementation PR)

1. `package.json` (root script portability + `cross-env`)
2. `apps/ui/vite.config.ts` (host defaults)
3. `apps/backend/src/ws/routes/health-routes.ts` (platform reboot strategy)
4. `apps/backend/src/swarm/codex-jsonrpc-client.ts` (spawn portability)
5. `apps/backend/src/swarm/codex-agent-runtime.ts` (if needed for command normalization)
6. `apps/backend/src/ws/routes/file-routes.ts` (`tmpdir` allowlist)
7. `apps/ui/src/lib/artifacts.ts` (Windows URI normalization)
8. `apps/ui/src/components/chat/ArtifactsSidebar.tsx` (path separator handling)
9. `apps/backend/src/test/ws-server.test.ts` (reboot + tmpdir tests)
10. `apps/backend/src/test/codex-jsonrpc-client.test.ts` (spawn portability tests)
11. `apps/ui/src/lib/artifacts.test.ts` (Windows URI tests)
12. `.github/workflows/ci.yml` (Windows matrix)
13. `README.md` (Windows-native instructions)

