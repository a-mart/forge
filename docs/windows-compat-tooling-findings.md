# Windows Compatibility — Build Tooling, Scripts, UI & Config Findings

**Date:** 2026-03-10  
**Scope:** package.json scripts, shell scripts, vite/build config, Node.js startup, frontend code, dependencies, dev tooling, test config, environment files

---

## Executive Summary

| Severity | Count |
|----------|-------|
| 🔴 Critical (will break) | 8 |
| 🟠 High (likely to break) | 7 |
| 🟡 Medium (may cause problems) | 9 |
| 🔵 Low / Informational | 6 |

The project has significant Windows compatibility gaps concentrated in two areas: **package.json scripts** (POSIX shell syntax) and **bash-only shell scripts**. The Node.js application code itself is reasonably cross-platform thanks to consistent use of `node:path` and `node:os`, but several backend modules use Unix-specific features (Unix domain sockets, POSIX signals, process groups). The UI/frontend layer is well-abstracted and largely OS-agnostic.

---

## 🔴 Critical Issues (Will Definitely Break on Windows)

### C1. Root `package.json` — `dev` script uses bash subshell + parameter expansion

**File:** `package.json` (root), lines 10–11  
**Code:**
```json
"dev": "concurrently --kill-others-on-fail --names backend,ui \"pnpm --filter @middleman/backend dev\" \"pnpm --filter @middleman/ui dev -- --host ${MIDDLEMAN_HOST:-$(node --env-file-if-exists=.env -p 'process.env.MIDDLEMAN_HOST || \"127.0.0.1\"' 2>/dev/null)}\"",
"dev:ui": "pnpm --filter @middleman/ui dev -- --host ${MIDDLEMAN_HOST:-$(node --env-file-if-exists=.env -p 'process.env.MIDDLEMAN_HOST || \"127.0.0.1\"' 2>/dev/null)}"
```
**Issue:** `${VAR:-$(command)}` bash parameter expansion with command substitution, plus `2>/dev/null` stderr redirection. None of this works on `cmd.exe` or PowerShell (npm/pnpm invoke scripts via `cmd.exe` on Windows by default).  
**Fix:** Extract host resolution into a small Node.js helper script (e.g., `scripts/resolve-host.mjs`) and call it:
```json
"dev:ui": "node scripts/resolve-host.mjs | xargs pnpm --filter @middleman/ui dev -- --host"
```
Or better: use `cross-env` plus a JS wrapper that sets the host and spawns vite.

---

### C2. Root `package.json` — `prod:start` uses inline `NODE_ENV=` and `MIDDLEMAN_PORT=` env setting

**File:** `package.json` (root), line 14  
**Code:**
```json
"prod:start": "concurrently --kill-others-on-fail --names backend,ui \"NODE_ENV=production MIDDLEMAN_PORT=47287 pnpm --filter @middleman/backend start\" \"pnpm --filter @middleman/ui preview\""
```
**Issue:** `VAR=value command` syntax is POSIX sh/bash only. Does not work on `cmd.exe`.  
**Fix:** Use `cross-env`:
```json
"prod:start": "concurrently --kill-others-on-fail --names backend,ui \"cross-env NODE_ENV=production MIDDLEMAN_PORT=47287 pnpm --filter @middleman/backend start\" \"pnpm --filter @middleman/ui preview\""
```

---

### C3. UI `package.json` — `preview` script uses `${MIDDLEMAN_HOST:-127.0.0.1}` shell expansion

**File:** `apps/ui/package.json`, line 8  
**Code:**
```json
"preview": "vite preview --port 47189 --strictPort --host ${MIDDLEMAN_HOST:-127.0.0.1}"
```
**Issue:** Bash parameter expansion with default value. Fails on `cmd.exe`.  
**Fix:** Use `cross-env` or a small wrapper script. Alternatively, handle host binding in `vite.config.ts` via `process.env.MIDDLEMAN_HOST`.

---

### C4. All shell scripts (`scripts/*.sh`) are bash-only

**Files:**
- `scripts/cutover-to-main.sh` (~450 lines)
- `scripts/test-instance.sh` (~200 lines)
- `scripts/test-rebuild.sh` (~80 lines)
- `scripts/test-reset.sh` (~100 lines)
- `scripts/test-run.sh` (~30 lines)

**Issue:** All use `#!/usr/bin/env bash` shebangs and rely heavily on:
- `lsof` (not available on Windows)
- `ps -axo` (macOS/Linux only)
- `kill`, `kill -0`, `kill -9`, `SIGTERM`, `SIGKILL` (POSIX signals)
- `cp -a` (preserves attributes — not Windows `copy`)
- `nohup`, `disown`, background jobs with `&`
- `set -euo pipefail`, `trap`, `BASH_SOURCE`, `pwd -P`
- Process group management (`kill -$pid`)

**Fix:** These are operational/development scripts rather than core application code. Options:
1. Accept they're POSIX-only and document this (recommended for `cutover-to-main.sh` which is one-time use)
2. For `test-instance.sh` / `test-reset.sh` — rewrite as Node.js scripts (like `prod-daemon.mjs` already is)

---

### C5. `prod-daemon.mjs` — Process group killing with negative PID

**File:** `scripts/prod-daemon.mjs`, line 198  
**Code:**
```js
process.kill(-child.pid, signal);
```
**Issue:** Negative PIDs (process group signals) are a POSIX concept. On Windows, `process.kill(-pid, signal)` throws `ESRCH` or behaves unexpectedly. Windows doesn't have process groups in the POSIX sense.  
**Fix:** On Windows, use `child.kill(signal)` or `taskkill` to kill the child and its tree:
```js
if (process.platform === 'win32') {
  spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
} else {
  process.kill(-child.pid, signal);
}
```

---

### C6. `prod-daemon.mjs` — `detached: true` + `SIGUSR1` for restart

**File:** `scripts/prod-daemon.mjs`, lines 273, and throughout  
**Code:**
```js
child = spawn(command, { ..., detached: true });
// ...
process.on(RESTART_SIGNAL, () => requestRestart(RESTART_SIGNAL));  // SIGUSR1
```
**Issue:** `SIGUSR1` does not exist on Windows. `process.on('SIGUSR1', ...)` is silently ignored. The entire daemon restart mechanism (used by `prod:restart` and the `/api/reboot` endpoint) is non-functional on Windows. `detached: true` behaves differently on Windows (creates a new console window).  
**Fix:** On Windows, use a different IPC mechanism for restart signaling — e.g., a named pipe, file-based polling, or an HTTP endpoint on the daemon itself.

---

### C7. `prod-daemon-restart.mjs` — Sends `SIGUSR1` to daemon PID

**File:** `scripts/prod-daemon-restart.mjs`, line 25  
**Code:**
```js
process.kill(pid, "SIGUSR1");
```
**Issue:** Same as C6 — `SIGUSR1` is not available on Windows.  
**Fix:** Needs platform-conditional restart mechanism.

---

### C8. Backend health routes — `SIGUSR1` for reboot signal

**File:** `apps/backend/src/ws/routes/health-routes.ts`, lines 12, 53  
**Code:**
```ts
const RESTART_SIGNAL: NodeJS.Signals = "SIGUSR1";
process.kill(targetPid, RESTART_SIGNAL);
```
**Issue:** The `/api/reboot` HTTP endpoint relies on `SIGUSR1` which doesn't exist on Windows. The reboot feature is completely broken on Windows.  
**Fix:** Add Windows-compatible restart mechanism (HTTP-based IPC, named pipe, or environment-based flag file).

---

## 🟠 High-Risk Issues (Likely to Break)

### H1. Playwright discovery service — hardcoded `/tmp/playwright-cli-sockets`

**File:** `apps/backend/src/playwright/playwright-discovery-service.ts`, line 24  
**Code:**
```ts
const SOCKETS_BASE_DIR = '/tmp/playwright-cli-sockets'
```
**Issue:** Hardcoded POSIX `/tmp/` path. Windows has no `/tmp/`. Should use `os.tmpdir()`.  
**Fix:**
```ts
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const SOCKETS_BASE_DIR = join(tmpdir(), 'playwright-cli-sockets');
```

---

### H2. Playwright discovery service — Unix domain sockets

**File:** `apps/backend/src/playwright/playwright-discovery-service.ts`, lines 1266–1280  
**Code:**
```ts
const connection = createConnection(socketPath)
```
**Issue:** The entire Playwright discovery system communicates via Unix domain sockets. While Node.js on Windows does support Unix sockets (via named pipes), the Playwright CLI itself may use `/tmp/playwright-cli-sockets` which won't exist on Windows. The socket path format needs to be Windows-compatible (named pipes use `\\.\pipe\` prefix).  
**Fix:** This is a deeper architectural issue. If Playwright CLI uses Unix sockets on macOS/Linux, the Windows Playwright CLI may use a different IPC mechanism entirely. This feature may need to be disabled or rearchitected for Windows.

---

### H3. File routes — hardcoded `/tmp` in allowlist

**File:** `apps/backend/src/ws/routes/file-routes.ts`, line 36  
**Code:**
```ts
const allowedRoots = normalizeAllowlistRoots([
  ...config.cwdAllowlistRoots,
  config.paths.rootDir,
  homedir(),
  "/tmp"
]);
```
**Issue:** Hardcoded `/tmp` path won't exist on Windows. Files in the system temp directory would not be accessible.  
**Fix:**
```ts
import { tmpdir } from 'node:os';
// ...
homedir(),
tmpdir()
```

---

### H4. `cwd-policy.ts` — `resolveDirectoryPath` assumes `/` prefix for absolute paths

**File:** `apps/backend/src/swarm/cwd-policy.ts`, line 72  
**Code:**
```ts
return trimmed.startsWith("/") ? resolve(trimmed) : resolve(rootDir, trimmed);
```
**Issue:** On Windows, absolute paths start with a drive letter (e.g., `C:\foo`), not `/`. A Windows absolute path like `C:\Users\bob\project` would be treated as relative and resolved against `rootDir`, producing an incorrect path.  
**Fix:**
```ts
import { isAbsolute, resolve } from 'node:path';
return isAbsolute(trimmed) ? resolve(trimmed) : resolve(rootDir, trimmed);
```

---

### H5. `test-rebuild.sh` — `xargs kill -9` / `disown`

**File:** `scripts/test-rebuild.sh`, lines 18–23  
**Code:**
```bash
pids=$(lsof -ti :"${port}" 2>/dev/null || true)
if [[ -n "${pids}" ]]; then
  echo "${pids}" | xargs kill -9 2>/dev/null || true
fi
# ...
disown "${BACKEND_PID}"
```
**Issue:** `lsof`, `xargs kill -9`, and `disown` are POSIX-only. Script is entirely non-functional on Windows.  
**Fix:** Rewrite as Node.js script or document as POSIX-only.

---

### H6. Backend `index.ts` — `SIGINT`/`SIGTERM` graceful shutdown

**File:** `apps/backend/src/index.ts`, lines 153–159  
**Code:**
```ts
process.on("SIGINT", () => { void shutdown("SIGINT"); });
process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
```
**Issue:** `SIGTERM` is not reliably delivered on Windows. `SIGINT` works for Ctrl+C in console but `SIGTERM` from `process.kill()` or `taskkill` does not trigger the handler — Node.js on Windows receives `SIGTERM` but immediately terminates without running the handler. Graceful shutdown may not work.  
**Fix:** Add Windows-compatible shutdown handling:
```ts
if (process.platform === 'win32') {
  process.on('message', (msg) => {
    if (msg === 'shutdown') void shutdown('message');
  });
}
```
Or rely on `SIGINT` (Ctrl+C) which does work on Windows console.

---

### H7. Data directory default path uses `~/.middleman` (dot-prefixed)

**File:** `apps/backend/src/config.ts`, line 29  
**Code:**
```ts
const dataDir = process.env.MIDDLEMAN_DATA_DIR ?? resolve(homedir(), ".middleman");
```
**Issue:** While technically functional on Windows (dot-prefixed directories work), `.middleman` in the user's home directory is unconventional for Windows. The Windows convention is `%APPDATA%\middleman` or `%LOCALAPPDATA%\middleman`. Users may not find or manage the directory easily since Windows Explorer hides dot-prefixed directories by default.  
**Fix (medium priority):**
```ts
const defaultDataDir = process.platform === 'win32'
  ? resolve(process.env.LOCALAPPDATA ?? homedir(), 'middleman')
  : resolve(homedir(), '.middleman');
```

---

## 🟡 Medium-Risk Issues (May Cause Problems)

### M1. Root `package.json` — `build` script uses chained `&&`

**File:** `package.json` (root), line 12  
**Code:**
```json
"build": "pnpm --filter @middleman/protocol build && pnpm --filter @middleman/backend build && pnpm --filter @middleman/ui build && pnpm --filter @middleman/site build"
```
**Issue:** `&&` works in both `cmd.exe` and PowerShell, so this technically works on Windows. However, if pnpm's script runner uses `sh` by default (which pnpm does on Windows via `cmd.exe`), `&&` is compatible. **Low actual risk** but worth noting for completeness. ✅ Actually OK.

---

### M2. Test fixtures use POSIX paths (`/tmp/...`)

**Files:** Multiple test files across backend and UI:
- `apps/backend/src/swarm/__tests__/data-paths.test.ts:43` — `const DATA_DIR = "/tmp/middleman-data"`
- `apps/backend/src/swarm/__tests__/mid-turn-context-guard.test.ts:113` — `cwd: "/tmp/project"`
- `apps/backend/src/test/config.test.ts:108-117` — Multiple `/tmp/middleman-data` assertions
- `apps/ui/src/lib/ws-client.test.ts` — Multiple `/tmp/*.jsonl` paths
- Plus ~20 more test files

**Issue:** Tests use hardcoded POSIX paths like `/tmp/project`. On Windows, these paths are syntactically invalid and tests may fail with path-related assertion errors. Many are used as mock data that never touches the filesystem, but config.test.ts actually asserts on resolved paths.  
**Fix:** Use `os.tmpdir()` + `path.join()` for tests that assert on resolved paths. For pure mock data that's never used as real filesystem paths, the impact is lower but still creates noise.

---

### M3. `config.test.ts` — Assertions on POSIX path structure

**File:** `apps/backend/src/test/config.test.ts`, lines 108–117  
**Code:**
```ts
await withEnv({ MIDDLEMAN_DATA_DIR: '/tmp/middleman-data' }, () => {
  expect(config.paths.dataDir).toBe('/tmp/middleman-data')
  expect(config.paths.swarmDir).toBe('/tmp/middleman-data/swarm')
  // ... more absolute POSIX path assertions
})
```
**Issue:** These paths use `/` separator and will fail on Windows where `path.join` produces `\` separators.  
**Fix:** Build expected paths using `path.join()`:
```ts
const base = path.join(os.tmpdir(), 'middleman-data');
expect(config.paths.swarmDir).toBe(path.join(base, 'swarm'));
```

---

### M4. `ws-server.test.ts` — Windows path awareness exists but may be incomplete

**File:** `apps/backend/src/test/ws-server.test.ts`, lines 571, 656  
**Code:**
```ts
process.platform === 'win32' ? 'C:\\Windows\\System32\\drivers\\etc\\hosts' : '/etc/hosts'
```
**Issue:** Good — this test already has Windows awareness! But it should be verified that the rest of the test file doesn't have other POSIX assumptions.

---

### M5. `validate-migration.ts` — Hardcoded macOS path

**File:** `scripts/validate-migration.ts`, line 3  
**Code:**
```ts
const DEFAULT_SOURCE_DATA_DIR = "/Users/adam/repos/middleman-data-restructure/.middleman-test";
```
**Issue:** Hardcoded macOS-specific path. Won't work on any other machine (not just Windows). This is a dev-only migration validation script, but it should at minimum use an environment variable fallback.  
**Fix:** Already uses `process.env.MIDDLEMAN_TEST_DATA_DIR` as override, so this is mitigated — just needs documentation.

---

### M6. Legacy auth migration — macOS-specific path

**File:** `apps/backend/src/config.ts`, line 151  
**Code:**
```ts
const legacyPiAuthFile = resolve(homedir(), ".pi", "agent", "auth.json");
```
**Issue:** Uses `homedir()` which works cross-platform, but the `.pi` directory layout is a POSIX convention. On Windows, Pi data may live in `%APPDATA%\pi` or similar. Minor — this is a one-time migration path.

---

### M7. `directory-picker.ts` — `ensureTrailingSlash` uses `/` only

**File:** `apps/backend/src/swarm/directory-picker.ts`, line 165  
**Code:**
```ts
function ensureTrailingSlash(pathValue: string): string {
  // ...
  return `${pathValue}/`;
}
```
**Issue:** Always appends forward slash. Used in the Linux `zenity` `--filename` arg, which is Linux-only anyway. The Windows branch uses PowerShell's `FolderBrowserDialog` which doesn't need trailing slashes. ✅ **Actually OK** — the function is only called from the Linux path. 

---

### M8. CI workflow runs only on `ubuntu-latest`

**File:** `.github/workflows/ci.yml`, line 14  
**Code:**
```yaml
runs-on: ubuntu-latest
```
**Issue:** CI only runs on Linux. Windows compatibility issues won't be caught in CI.  
**Fix:** Add a Windows CI matrix:
```yaml
strategy:
  matrix:
    os: [ubuntu-latest, windows-latest]
runs-on: ${{ matrix.os }}
```

---

### M9. `data-paths.ts` `sanitizePathSegment` — doesn't reject Windows reserved names

**File:** `apps/backend/src/swarm/data-paths.ts`, lines 173–186  
**Code:**
```ts
export function sanitizePathSegment(segment: string): string {
  // ... rejects /, \, .., control chars
  return trimmed;
}
```
**Issue:** Does not reject Windows reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`) or reserved characters (`<`, `>`, `:`, `"`, `|`, `?`, `*`). Creating an agent with ID "CON" or "NUL" would cause filesystem errors on Windows.  
**Fix:** Add Windows reserved name/character validation:
```ts
const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM\d|LPT\d)$/i;
if (WINDOWS_RESERVED.test(trimmed)) {
  throw new Error(`Invalid path segment (reserved name): "${segment}"`);
}
if (/[<>:"|?*]/.test(trimmed)) {
  throw new Error(`Invalid path segment (reserved characters): "${segment}"`);
}
```

---

## 🔵 Low-Risk / Informational

### L1. `directory-picker.ts` already has full Windows support ✅

**File:** `apps/backend/src/swarm/directory-picker.ts`  
**Assessment:** The directory picker has explicit `win32` case with PowerShell `FolderBrowserDialog`. Well-implemented. Handles both `powershell` and `pwsh` fallback.

---

### L2. `data-paths.ts` uses `node:path` `join()` throughout ✅

**File:** `apps/backend/src/swarm/data-paths.ts`  
**Assessment:** All path construction uses `join()` from `node:path`. This is correct and will produce platform-appropriate separators. No hardcoded `/` in path construction.

---

### L3. `artifacts.ts` handles Windows paths ✅

**File:** `apps/ui/src/lib/artifacts.ts`  
**Assessment:** Has explicit `WINDOWS_ABSOLUTE_PATH_PATTERN = /^[a-zA-Z]:[\\/]/` detection, `fileNameFromPath` splits on both `[\\/]`, and `isLocalFilePath` handles both separators. Well-implemented for cross-platform.

---

### L4. `fsevents` is properly optional ✅

**Assessment:** `fsevents` (macOS native file watching) is correctly marked as `optional: true` in `pnpm-lock.yaml`. It will not block `pnpm install` on Windows. Vite/chokidar will automatically fall back to polling or Windows native watchers.

---

### L5. No native Node.js addon dependencies ✅

**Assessment:** No dependencies on `sharp`, `better-sqlite3`, `canvas`, `node-gyp`, or other native addons that commonly cause Windows build failures. All dependencies are pure JavaScript/TypeScript.

---

### L6. UI WebSocket URL resolution is cross-platform ✅

**File:** `apps/ui/src/routes/index.tsx`, `apps/ui/src/lib/feedback-client.ts`  
**Assessment:** WebSocket URL construction uses `window.location.protocol`/`hostname`/`port` which is browser-level and OS-agnostic. The `VITE_MIDDLEMAN_WS_URL` env var approach is clean.

---

## Recommended Cross-Platform Tooling

| Tool | Purpose | Install |
|------|---------|---------|
| **cross-env** | Set env vars in npm scripts cross-platform | `pnpm add -D -w cross-env` |
| **shx** | Cross-platform shell commands (`rm`, `cp`, `mkdir`) in scripts | `pnpm add -D -w shx` |
| **rimraf** | Cross-platform `rm -rf` | `pnpm add -D -w rimraf` |
| **npm-run-all2** | Run scripts sequentially/parallel without shell syntax | `pnpm add -D -w npm-run-all2` |
| **tree-kill** | Kill process trees cross-platform (replaces `kill -9 -$PID`) | `pnpm add tree-kill` |
| **execa** | Cross-platform subprocess execution | Already available via transitive deps |

### Priority Fixes for Minimum Windows Support

1. **Install `cross-env`** and update `prod:start` and `preview` scripts (C2, C3)
2. **Extract `dev` host resolution** into a Node.js helper (C1)
3. **Fix `resolveDirectoryPath`** to use `path.isAbsolute()` (H4)
4. **Replace hardcoded `/tmp`** with `os.tmpdir()` (H1, H3)
5. **Add Windows path segment validation** to `sanitizePathSegment` (M9)
6. **Add `SIGTERM` fallback** for Windows shutdown (H6)
7. **Document bash scripts** as POSIX-only or rewrite critical ones as Node.js (C4)
8. **Add Windows CI matrix** to catch regressions (M8)
9. **Design Windows-compatible restart mechanism** for prod daemon (C5–C8)
