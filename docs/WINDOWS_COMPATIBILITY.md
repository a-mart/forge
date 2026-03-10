# Windows Compatibility Report

> **Date:** 2026-03-10
> **Scope:** Full codebase — backend, frontend, protocol, scripts, build tooling, tests, CI
> **Sources:** Backend/core audit + build-tooling/UI/scripts audit, deduplicated and merged

---

## Executive Summary

A comprehensive audit of the Middleman codebase identified **26 unique issues** affecting Windows compatibility:

| Severity | Count | Description |
|----------|------:|-------------|
| 🔴 Critical | 10 | App will not start or core features are completely broken |
| 🟠 High | 6 | Likely to cause runtime failures or data corruption |
| 🟡 Medium | 5 | May cause test failures, UX problems, or maintenance burden |
| 🔵 Low | 5 | Cosmetic, convention, or documentation-only items |

The issues cluster into four themes:

1. **POSIX signals & process management** — `SIGUSR1` restart, `SIGTERM` shutdown, process-group killing, PID-based liveness checks (7 issues)
2. **Hardcoded Unix paths** — `/tmp` literals, `/`-prefix absolute path detection (3 issues)
3. **Shell syntax in npm scripts** — Bash parameter expansion, inline env vars (3 issues)
4. **Playwright subsystem** — Entirely built on Unix domain sockets (1 compound issue, 6 files)

The remaining issues span file-locking semantics, test fixtures, spawn behavior, and platform conventions.

---

## What's Already Windows-Ready

The project is **not starting from zero**. Significant parts of the codebase are already cross-platform:

| Area | Status | Notes |
|------|--------|-------|
| **Path construction** (`data-paths.ts`) | ✅ | Uses `path.join()` throughout, no hardcoded `/` separators |
| **Path segment validation** (`data-paths.ts`) | ✅ | Rejects both `/` and `\` in segments |
| **Path containment checks** (`cwd-policy.ts`) | ✅ | `isPathWithinRoot` uses `path.sep` correctly |
| **Directory picker** (`directory-picker.ts`) | ✅ | Full `win32` branch with PowerShell `FolderBrowserDialog` |
| **Frontend artifacts** (`artifacts.ts`) | ✅ | Explicit `WINDOWS_ABSOLUTE_PATH_PATTERN`, splits on `[\\/]` |
| **Protocol package** (`packages/protocol/`) | ✅ | Pure TypeScript types, zero OS-specific code |
| **Integrations** (Telegram/Slack) | ✅ | HTTP/WebSocket only, no filesystem or shell dependencies |
| **Dependencies** | ✅ | No native C++ addons (`node-gyp`, `sharp`, `better-sqlite3`, etc.) |
| **`fsevents`** | ✅ | Correctly marked `optional: true`; Vite falls back gracefully |
| **dotenv loading** | ✅ | Uses `resolve()` for `.env` path |
| **WebSocket URL resolution** (UI) | ✅ | Browser-level `window.location`, fully OS-agnostic |
| **Line ending handling** | ✅ | Splits on `/\r?\n/` where applicable; writes `\n` consistently |
| **Data migration fallback** | ✅ | `hardlinkOrCopyFileIfMissing` already falls back to `fs.copyFile()` |
| **Test file** (`ws-server.test.ts`) | ✅ | Already has `process.platform === 'win32'` path branching |

---

## Issue Catalog

### 🔴 Critical Issues

#### WIN-001 — Playwright Subsystem: `/tmp` Path + Unix Domain Sockets

| | |
|---|---|
| **Affected files** | `apps/backend/src/playwright/playwright-discovery-service.ts` (line 24, 1222–1280), `apps/backend/src/playwright/playwright-devtools-bridge.ts` (lines 1, 114, 142) |
| **Description** | The Playwright discovery service hardcodes `const SOCKETS_BASE_DIR = '/tmp/playwright-cli-sockets'` and communicates entirely via Unix domain sockets (`createConnection(socketPath)`, `lstat().isSocket()`). Windows has no `/tmp`, and the Playwright CLI may use a completely different IPC mechanism (named pipes) on Windows. |
| **Impact** | Playwright session discovery, probing, live preview, and daemon stop commands are all non-functional on Windows. |
| **Fix** | Gate the entire Playwright subsystem on Windows (see [Playwright Gating Plan](#playwright-gating-plan)). Replace `/tmp` with `os.tmpdir()` for documentation correctness. |
| **Effort** | **M** |

---

#### WIN-002 — SIGUSR1-Based Restart/Daemon Lifecycle

| | |
|---|---|
| **Affected files** | `apps/backend/src/ws/routes/health-routes.ts` (lines 12, 53, 72–82), `scripts/prod-daemon.mjs` (line 273+), `scripts/prod-daemon-restart.mjs` (line 25) |
| **Description** | The entire restart system uses `SIGUSR1`: the `/api/reboot` endpoint sends it, `prod-daemon.mjs` listens for it, and `prod-daemon-restart.mjs` dispatches it. `SIGUSR1` does not exist on Windows — `process.kill(pid, 'SIGUSR1')` throws, and `process.on('SIGUSR1', ...)` is silently ignored. The PID-file liveness check (`process.kill(pid, 0)`) also behaves differently on Windows — it doesn't raise `ESRCH` for dead processes in the same way. |
| **Impact** | The reboot endpoint crashes. The prod daemon cannot be restarted gracefully. PID-based daemon detection is unreliable. |
| **Fix** | Implement a platform-aware restart mechanism. On Windows, use a named pipe, file-based signal, or HTTP self-ping for restart signaling. Abstract PID liveness checks behind a platform utility. Guard all `SIGUSR1` usage with `process.platform !== 'win32'`. |
| **Effort** | **L** |

---

#### WIN-003 — SIGINT/SIGTERM Graceful Shutdown

| | |
|---|---|
| **Affected files** | `apps/backend/src/index.ts` (lines 153–159) |
| **Description** | `SIGTERM` sent via `process.kill()` causes unconditional termination on Windows — the Node.js handler never fires. `SIGINT` works only for Ctrl+C in a console. There is no `SIGBREAK` handler for Windows Ctrl+Break. |
| **Impact** | Graceful shutdown (resource cleanup, connection draining) does not work when the process is killed externally or managed as a service on Windows. |
| **Fix** | Keep existing handlers (they work for Ctrl+C). Add `process.on('SIGBREAK', ...)` for Windows Ctrl+Break. For daemon/service scenarios, add `process.on('message', ...)` for PM2/child-process patterns. |
| **Effort** | **S** |

---

#### WIN-004 — CWD Policy Absolute Path Detection

| | |
|---|---|
| **Affected files** | `apps/backend/src/swarm/cwd-policy.ts` (line 72) |
| **Description** | `return trimmed.startsWith("/")` only detects POSIX absolute paths. Windows absolute paths like `C:\Users\project` are treated as relative and resolved against `rootDir`, producing incorrect paths. |
| **Impact** | All CWD validation, directory listing, and file-route path resolution silently produce wrong paths on Windows. |
| **Fix** | Replace with `path.isAbsolute(trimmed)` which handles both POSIX and Windows formats. |
| **Effort** | **S** |

---

#### WIN-005 — Hardcoded `/tmp` in File Routes Allowlist

| | |
|---|---|
| **Affected files** | `apps/backend/src/ws/routes/file-routes.ts` (line 37) |
| **Description** | `/tmp` is hardcoded as an allowed root for file read/write operations. This path does not exist on Windows. |
| **Impact** | Any code or agent prompt that writes to `/tmp` will fail. The temp directory is not in the allowlist on Windows. |
| **Fix** | Replace `"/tmp"` with `tmpdir()` from `node:os`. |
| **Effort** | **S** |

---

#### WIN-006 — Codex JSON-RPC Client `child.kill()` Without Windows Handling

| | |
|---|---|
| **Affected files** | `apps/backend/src/swarm/codex-jsonrpc-client.ts` (lines 130–132) |
| **Description** | `child.kill()` sends `SIGTERM` by default, which on Windows causes unconditional termination with no cleanup opportunity for the Codex app-server process. |
| **Impact** | Codex runtime cleanup is ungraceful. Orphaned child processes are possible. |
| **Fix** | Attempt a graceful RPC shutdown request before falling back to `child.kill()`. Document Windows-specific Codex CLI installation requirements. |
| **Effort** | **M** |

---

#### WIN-007 — Root `package.json` `dev` Script: Bash Subshell + Parameter Expansion

| | |
|---|---|
| **Affected files** | `package.json` (root), lines 10–11 |
| **Description** | The `dev` and `dev:ui` scripts use `${MIDDLEMAN_HOST:-$(node ...)}` bash parameter expansion with command substitution and `2>/dev/null` stderr redirection. None of this works on `cmd.exe` or PowerShell (pnpm invokes scripts via `cmd.exe` on Windows by default). |
| **Impact** | `pnpm dev` fails to start on Windows. |
| **Fix** | Extract host resolution into a Node.js helper script (e.g., `scripts/resolve-host.mjs`) and invoke it from the npm script, or use `cross-env` with a JS wrapper. |
| **Effort** | **S** |

---

#### WIN-008 — Root `package.json` `prod:start`: Inline `VAR=value` Env Setting

| | |
|---|---|
| **Affected files** | `package.json` (root), line 14 |
| **Description** | `NODE_ENV=production MIDDLEMAN_PORT=47287 pnpm ...` uses POSIX `VAR=value command` syntax, which does not work on `cmd.exe`. |
| **Impact** | `pnpm prod:start` fails on Windows. |
| **Fix** | Use `cross-env`: `cross-env NODE_ENV=production MIDDLEMAN_PORT=47287 pnpm ...` |
| **Effort** | **S** |

---

#### WIN-009 — UI `preview` Script: Bash Parameter Expansion

| | |
|---|---|
| **Affected files** | `apps/ui/package.json` (line 8) |
| **Description** | `--host ${MIDDLEMAN_HOST:-127.0.0.1}` uses bash parameter expansion with a default value, which fails on `cmd.exe`. |
| **Impact** | `pnpm preview` in the UI package fails on Windows. Breaks the prod UI preview surface. |
| **Fix** | Use `cross-env`, a JS wrapper, or move host binding into `vite.config.ts` via `process.env.MIDDLEMAN_HOST`. |
| **Effort** | **S** |

---

#### WIN-010 — `prod-daemon.mjs` Process Group Killing

| | |
|---|---|
| **Affected files** | `scripts/prod-daemon.mjs` (line 198) |
| **Description** | `process.kill(-child.pid, signal)` uses negative PIDs to signal an entire process group — a POSIX concept that does not exist on Windows. Throws `ESRCH` or behaves unexpectedly. |
| **Impact** | Daemon stop/restart leaves orphaned child processes on Windows. |
| **Fix** | On Windows, use `spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'])` or the `tree-kill` npm package for cross-platform process-tree termination. |
| **Effort** | **S** |

---

### 🟠 High Issues

#### WIN-011 — Data Migration Hardlink Error Handling

| | |
|---|---|
| **Affected files** | `apps/backend/src/swarm/data-migration.ts` (lines 37, 629–660) |
| **Description** | `fs.link()` may fail on Windows due to: FAT32 not supporting hard links, missing `SeCreateSymbolicLinkPrivilege`, or cross-volume links. The existing `fs.copyFile()` fallback is good, but the catch block only handles `EEXIST`/`ENOENT` — it should also handle `EPERM` and `EXDEV` gracefully rather than re-throwing. |
| **Impact** | Migration may fail on some Windows configurations if unexpected error codes propagate. Likely works in practice due to the fallback, but may log confusing errors. |
| **Fix** | Broaden the catch block in `hardlinkOrCopyFileIfMissing` to treat all non-`EEXIST` errors as "try copy fallback." |
| **Effort** | **S** |

---

#### WIN-012 — Resume Prompt Uses `ls -lt` Unix Command

| | |
|---|---|
| **Affected files** | `apps/backend/src/swarm/agent-runtime.ts` (lines 1239, 1254) |
| **Description** | The context-compaction recovery prompt tells the agent to run `ls -lt`, which is a Unix command. If the agent's shell on Windows is cmd.exe or PowerShell, the tool call will fail. |
| **Impact** | Context recovery produces tool errors on Windows agents. |
| **Fix** | Detect platform and adjust prompt text, or use cross-platform alternatives (`git status` works everywhere). |
| **Effort** | **S** |

---

#### WIN-013 — Session File Guard `renameSync` File Locking

| | |
|---|---|
| **Affected files** | `apps/backend/src/swarm/session-file-guard.ts` (lines 2, 75) |
| **Description** | `renameSync` on Windows fails with `EBUSY`/`EPERM` if the file is open by another process. Windows has mandatory file locking (unlike POSIX advisory locking). |
| **Impact** | Session file rotation for oversized files may fail sporadically. |
| **Fix** | Add retry logic with exponential backoff for rename operations. Consider async versions with error handling. |
| **Effort** | **S** |

---

#### WIN-014 — Atomic Write `rename()` EPERM/EBUSY on Windows

| | |
|---|---|
| **Affected files** | `apps/backend/src/swarm/persistence-service.ts` (line 156), `apps/backend/src/swarm/secrets-env-service.ts` (line 240), `apps/backend/src/swarm/session-manifest.ts` (line 45), `apps/backend/src/swarm/data-migration.ts` (lines 712, 719), `apps/backend/src/scheduler/cron-scheduler-service.ts` |
| **Description** | The `writeFile(tmp) → rename(tmp, target)` atomic-write pattern can fail with `EPERM` if the target file is held open by another process (Windows mandatory locking). The tmp file is in the same directory, so cross-device issues don't apply, but concurrent access conflicts are more likely than on POSIX. |
| **Impact** | Rare write failures under concurrent access. |
| **Fix** | Add a retry utility for `EPERM`/`EBUSY` errors on `rename()`. Consider `graceful-fs` or a shared write-with-retry helper. |
| **Effort** | **M** |

---

#### WIN-015 — Codex Runtime Spawn Shell Assumptions

| | |
|---|---|
| **Affected files** | `apps/backend/src/swarm/codex-agent-runtime.ts` (lines 130–145) |
| **Description** | The Codex runtime spawns `codex` as a child process. On Windows: the binary may need `.exe`/`.cmd` extension, `spawn()` without `shell: true` may not find batch-script commands, and PATH uses `;` instead of `:`. |
| **Impact** | Codex agent spawning may fail with `ENOENT`. |
| **Fix** | Use `cross-spawn` or add `shell: true`. Alternatively, detect `.cmd`/`.bat` extensions on Windows. |
| **Effort** | **S** |

---

#### WIN-016 — `fs.watch()` Platform Behavior Differences

| | |
|---|---|
| **Affected files** | `apps/backend/src/scheduler/cron-scheduler-service.ts`, `apps/backend/src/playwright/playwright-discovery-service.ts` |
| **Description** | `fs.watch()` on Windows uses `ReadDirectoryChangesW`, which can fire duplicate events, miss renames, and behave unreliably compared to macOS FSEvents or Linux inotify. |
| **Impact** | File watchers may fire excessively or miss changes. Cron scheduler and Playwright discovery may have delayed or missed reactions. |
| **Fix** | Existing poll-based fallback timers mitigate the worst cases. Consider `chokidar` for more reliable cross-platform watching if issues arise in practice. |
| **Effort** | **S** (monitor) / **M** (if chokidar migration needed) |

---

### 🟡 Medium Issues

#### WIN-017 — Default Data Directory Uses `~/.middleman` Convention

| | |
|---|---|
| **Affected files** | `apps/backend/src/config.ts` (line 29) |
| **Description** | `homedir()` + `.middleman` resolves to `C:\Users\<username>\.middleman` on Windows. This is unconventional — Windows apps typically use `%LOCALAPPDATA%` or `%APPDATA%`. Windows Explorer hides dot-prefixed directories inconsistently. |
| **Impact** | Functional but hard for users to find/manage. |
| **Fix** | Default to `process.env.LOCALAPPDATA + '/middleman'` on Windows, keeping `~/.middleman` on POSIX. |
| **Effort** | **S** |

---

#### WIN-018 — `sanitizePathSegment` Missing Windows Reserved Name Validation

| | |
|---|---|
| **Affected files** | `apps/backend/src/swarm/data-paths.ts` (lines 173–186) |
| **Description** | Does not reject Windows reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`) or reserved characters (`<`, `>`, `:`, `"`, `|`, `?`, `*`). An agent with ID `CON` or `NUL` would cause filesystem errors on Windows. |
| **Impact** | Edge-case agent IDs could silently create broken directories. |
| **Fix** | Add `WINDOWS_RESERVED` regex check and reserved-character rejection. |
| **Effort** | **S** |

---

#### WIN-019 — Test Fixtures Use Hardcoded POSIX Paths

| | |
|---|---|
| **Affected files** | `apps/backend/src/swarm/__tests__/data-paths.test.ts` (line 43), `apps/backend/src/swarm/__tests__/mid-turn-context-guard.test.ts` (line 113), `apps/backend/src/test/config.test.ts` (lines 108–117), `apps/ui/src/lib/ws-client.test.ts`, ~20 more test files |
| **Description** | Tests use hardcoded paths like `/tmp/middleman-data` and assert on POSIX-separator output. On Windows, `path.join` produces `\` separators, breaking assertions. Some are pure mock data that never hits the filesystem (lower impact). |
| **Impact** | Test suite failures on Windows. |
| **Fix** | Use `os.tmpdir()` + `path.join()` for tests that assert on resolved paths. Pure mock data can be lower priority. |
| **Effort** | **M** |

---

#### WIN-020 — CI Runs Linux-Only

| | |
|---|---|
| **Affected files** | `.github/workflows/ci.yml` (line 14) |
| **Description** | `runs-on: ubuntu-latest` — no Windows CI matrix. Compatibility regressions won't be caught. |
| **Impact** | No automated regression detection for Windows. |
| **Fix** | Add `strategy.matrix.os: [ubuntu-latest, windows-latest]`. |
| **Effort** | **S** |

---

#### WIN-021 — Temp File Naming MAX_PATH Risk

| | |
|---|---|
| **Affected files** | Multiple — `session-manifest.ts`, `data-migration.ts`, `persistence-service.ts`, etc. |
| **Description** | Temp files are named `${path}.tmp-${process.pid}-${Date.now()}-${randomHex}`, which adds ~40 characters. If the base path is near Windows MAX_PATH (260 chars), writes will fail. |
| **Impact** | Failures with deeply nested data directories. |
| **Fix** | Ensure data directories are not too deeply nested. Users can enable Windows long-path support via registry. Document this in setup guide. |
| **Effort** | **S** |

---

### 🔵 Low Issues

#### WIN-022 — Shell Scripts Are POSIX-Only

| | |
|---|---|
| **Affected files** | `scripts/cutover-to-main.sh`, `scripts/test-instance.sh`, `scripts/test-rebuild.sh`, `scripts/test-reset.sh`, `scripts/test-run.sh` |
| **Description** | All use bash shebangs and rely on `lsof`, `ps -axo`, `kill -9`, `nohup`, `disown`, `trap`, process groups, etc. Completely non-functional on Windows. |
| **Impact** | Developer/ops scripts unavailable on Windows. |
| **Fix** | See [Notes on Shell Scripts](#notes-on-shell-scripts). |
| **Effort** | N/A (documentation) or **L** (rewrites) |

---

#### WIN-023 — Legacy Auth Migration `.pi` Directory

| | |
|---|---|
| **Affected files** | `apps/backend/src/config.ts` (line 151) |
| **Description** | Migrates from `~/.pi/agent/auth.json`. On Windows, this resolves to `C:\Users\<username>\.pi\...`. The `.pi` directory is unlikely to exist on Windows. |
| **Impact** | None — migration silently skips when file doesn't exist. Behavior is correct. |
| **Fix** | None needed. |
| **Effort** | — |

---

#### WIN-024 — Worktrees Allowlist Root Convention

| | |
|---|---|
| **Affected files** | `apps/backend/src/config.ts` (lines 58–60) |
| **Description** | Adds `~/worktrees` to the CWD allowlist. On Windows this is `C:\Users\<username>\worktrees`, which may not match conventions but is harmless if absent. |
| **Impact** | None — path is silently ignored if it doesn't exist. |
| **Fix** | None needed for correctness. |
| **Effort** | — |

---

#### WIN-025 — `validate-migration.ts` Hardcoded macOS Path

| | |
|---|---|
| **Affected files** | `scripts/validate-migration.ts` (line 3) |
| **Description** | Default source path is `/Users/adam/repos/middleman-data-restructure/.middleman-test`. This is a developer-specific migration validation script, not production code. |
| **Impact** | Script is non-functional on any machine other than the original developer's Mac. |
| **Fix** | Already mitigated by `process.env.MIDDLEMAN_TEST_DATA_DIR` override. Add documentation. |
| **Effort** | — |

---

#### WIN-026 — Directory Picker `ensureTrailingSlash` Uses `/` Only

| | |
|---|---|
| **Affected files** | `apps/backend/src/swarm/directory-picker.ts` (line 165) |
| **Description** | Always appends `/` as trailing slash. However, this function is only called from the Linux `zenity` path — the Windows branch uses PowerShell's `FolderBrowserDialog` which doesn't need trailing slashes. |
| **Impact** | None in practice — the function is scoped to the Linux code path. |
| **Fix** | Could use `path.sep` for consistency, but not required. |
| **Effort** | — |

---

## Playwright Gating Plan

The Playwright subsystem is architecturally dependent on Unix domain sockets and cannot be trivially ported. The recommended approach is **conditional disablement on Windows** — not removal, but platform-gated no-op behavior.

### Files Requiring Gating

| # | File | Gating Strategy |
|---|------|-----------------|
| 1 | `apps/backend/src/playwright/playwright-discovery-service.ts` | Check `process.platform` in `start()`. On `win32`, immediately emit a disabled/empty snapshot and return. Also replace `/tmp` literal with `os.tmpdir()` for correctness. |
| 2 | `apps/backend/src/playwright/playwright-devtools-bridge.ts` | Check platform in `startPreviewController()`. On `win32`, throw `PlaywrightDevtoolsBridgeError('Playwright live preview is not supported on Windows', 501)`. |
| 3 | `apps/backend/src/playwright/playwright-live-preview-service.ts` | **No additional gating needed.** Wraps discovery service — naturally returns empty results when discovery is disabled. |
| 4 | `apps/backend/src/playwright/playwright-live-preview-proxy.ts` | **No additional gating needed.** `canHandleUpgrade()` returns `false` when no sessions exist. Naturally a no-op with discovery disabled. |
| 5 | `apps/backend/src/playwright/playwright-settings-service.ts` | Settings service remains active (reads/writes JSON config). Default `effectiveEnabled` to `false` on `win32`. |
| 6 | `apps/backend/src/index.ts` (startup orchestration) | Wrap Playwright initialization block (~lines 95–110) in `if (process.platform !== 'win32')`. Log `[playwright] Dashboard disabled on Windows` on skip. |

### Implementation Pattern

```typescript
// In playwright-discovery-service.ts start()
async start(): Promise<void> {
  if (process.platform === 'win32') {
    this.currentSnapshot = createEmptySnapshot(this.currentSettings, 'disabled');
    this.emitSnapshot(this.currentSnapshot, 'playwright_discovery_snapshot');
    return;
  }
  // ... existing code
}
```

```typescript
// In playwright-devtools-bridge.ts startPreviewController()
if (process.platform === 'win32') {
  throw new PlaywrightDevtoolsBridgeError(
    'Playwright live preview is not supported on Windows', 501
  );
}
```

```typescript
// In index.ts
let playwrightDiscovery: PlaywrightDiscoveryService | null = null;
if (process.platform !== 'win32') {
  try {
    playwrightDiscovery = new PlaywrightDiscoveryService({ ... });
    await playwrightDiscovery.start();
  } catch (error) { ... }
} else {
  console.log('[playwright] Playwright dashboard disabled on Windows');
}
```

### API Routes

Routes that depend on `playwrightDiscovery` already handle the `null` case — they return appropriate "not available" responses. No additional route changes needed.

---

## Implementation Roadmap

### Phase 1: Critical Path — Get the App Running on Windows

**Goal:** `pnpm install`, `pnpm build`, and `pnpm dev` succeed. The app starts and serves the UI. Core agent operations work.

| Issue ID | Title | Effort |
|----------|-------|--------|
| WIN-004 | CWD policy `path.isAbsolute()` fix | S |
| WIN-005 | File routes `/tmp` → `os.tmpdir()` | S |
| WIN-007 | `dev` script bash syntax → Node.js helper | S |
| WIN-008 | `prod:start` inline env → `cross-env` | S |
| WIN-009 | UI `preview` bash expansion → `cross-env` | S |
| WIN-001 | Playwright subsystem gating (6 files) | M |
| WIN-003 | Add `SIGBREAK` handler for graceful shutdown | S |

**Estimated total effort:** 1–2 days

### Phase 2: Robustness — Eliminate Intermittent Failures

**Goal:** All core features work reliably. Daemon lifecycle, Codex agents, data migration, and file persistence are stable on Windows.

| Issue ID | Title | Effort |
|----------|-------|--------|
| WIN-002 | SIGUSR1 restart → platform-aware mechanism | L |
| WIN-006 | Codex `child.kill()` graceful shutdown | M |
| WIN-010 | Process group kill → `tree-kill` | S |
| WIN-011 | Data migration hardlink error handling | S |
| WIN-013 | Session file guard rename retry logic | S |
| WIN-014 | Atomic write rename retry for EPERM/EBUSY | M |
| WIN-015 | Codex spawn shell assumptions | S |
| WIN-012 | Resume prompt `ls -lt` → cross-platform | S |

**Estimated total effort:** 3–5 days

### Phase 3: Polish — Conventions, Tests, CI

**Goal:** Clean test suite, CI coverage, platform-appropriate defaults, documentation.

| Issue ID | Title | Effort |
|----------|-------|--------|
| WIN-017 | Default data dir → `%LOCALAPPDATA%` on Windows | S |
| WIN-018 | `sanitizePathSegment` reserved name validation | S |
| WIN-019 | Test fixtures → cross-platform paths | M |
| WIN-020 | CI Windows matrix | S |
| WIN-021 | MAX_PATH documentation | S |
| WIN-016 | `fs.watch()` monitoring / chokidar evaluation | S–M |
| WIN-022 | Shell scripts documentation | S |

**Estimated total effort:** 2–3 days

---

## Recommended Cross-Platform Tooling

| Package | Purpose | Install |
|---------|---------|---------|
| **cross-env** | Set env vars in npm scripts cross-platform | `pnpm add -D -w cross-env` |
| **tree-kill** | Kill process trees (replaces `kill -$PID` groups) | `pnpm add tree-kill` |
| **shx** | Cross-platform shell commands (`rm`, `cp`, `mkdir`) in scripts | `pnpm add -D -w shx` |
| **rimraf** | Cross-platform `rm -rf` | `pnpm add -D -w rimraf` |
| **npm-run-all2** | Run scripts sequentially/parallel without shell syntax | `pnpm add -D -w npm-run-all2` |
| **execa** | Cross-platform subprocess execution | Available via transitive deps |
| **cross-spawn** | Cross-platform `child_process.spawn` (handles `.cmd`/`.bat`) | `pnpm add cross-spawn` |

**Minimum required for Phase 1:** `cross-env` (dev dependency at workspace root).

---

## Notes on Shell Scripts

### Scripts That Can Remain POSIX-Only

These are **developer/ops tooling** used for local development workflows, one-time migrations, or test harness orchestration. They are not part of the application runtime and do not need cross-platform rewrites:

| Script | Purpose | Recommendation |
|--------|---------|----------------|
| `scripts/cutover-to-main.sh` | One-time branch migration (~450 lines) | POSIX-only is fine. Document in README. |
| `scripts/test-instance.sh` | Spins up isolated test backend instance | POSIX-only. Windows devs can use WSL. |
| `scripts/test-rebuild.sh` | Kills ports + rebuilds test instance | POSIX-only. Heavy use of `lsof`, `kill -9`. |
| `scripts/test-reset.sh` | Resets test data directory | POSIX-only. |
| `scripts/test-run.sh` | Runs test instance | POSIX-only. |
| `scripts/validate-migration.ts` | Dev-only migration validation | Already has env var override. Document. |

**Recommendation:** Add a note to the project README or a `scripts/README.md`:

> **Note:** Scripts in `scripts/*.sh` require a POSIX-compatible shell (bash). On Windows, use [WSL](https://learn.microsoft.com/en-us/windows/wsl/), [Git Bash](https://gitforwindows.org/), or [Cygwin](https://www.cygwin.com/). These scripts are developer tooling and are not required for running the application.

### Scripts That Need Cross-Platform Rewrites

| Script | Why | Recommendation |
|--------|-----|----------------|
| `scripts/prod-daemon.mjs` | Part of the production runtime (`pnpm prod`, daemon lifecycle) | Rewrite process-group killing and SIGUSR1 handling to be platform-aware (WIN-002, WIN-010). |
| `scripts/prod-daemon-restart.mjs` | Invoked by `prod:restart` npm script | Must use the same platform-aware restart mechanism as `prod-daemon.mjs` (WIN-002). |

These two scripts are **part of the production startup path** and must work on Windows for the app to be deployable there.

---

*This report was generated from two independent audits (backend/core infrastructure + build-tooling/UI/scripts) and deduplicated into 26 unique issues.*
