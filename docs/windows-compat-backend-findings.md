# Windows Compatibility — Backend & Core Infrastructure Findings

> Audit date: 2026-03-10  
> Scope: `apps/backend/src/`, `packages/protocol/`  
> Auditor: win-compat-backend worker

---

## Executive Summary

| Severity | Count |
|----------|-------|
| **Critical** (will definitely break) | 7 |
| **High** (likely to break) | 8 |
| **Medium** (may cause problems) | 6 |
| **Low / Informational** | 5 |
| **Playwright gating items** | 6 files |

The project uses `path.join()` and `node:path` consistently for data-path construction, which is good. The main blockers are: (1) the entire Playwright subsystem depends on Unix domain sockets and hardcoded `/tmp` paths, (2) process signal handling uses POSIX-only signals, (3) the directory picker and path validation assume POSIX absolute-path semantics, (4) the Codex child-process spawning uses `child.kill()` without Windows considerations, and (5) hardlink-based data migration may fail on some Windows configurations.

---

## Critical Issues

### C1. Playwright Discovery Service — Hardcoded `/tmp` Socket Path

**File:** `apps/backend/src/playwright/playwright-discovery-service.ts`, line 24  
**Code:** `const SOCKETS_BASE_DIR = '/tmp/playwright-cli-sockets'`

**Description:** The Playwright discovery service hardcodes a POSIX `/tmp` path for discovering daemon sockets. This path does not exist on Windows. Additionally, the entire discovery mechanism relies on Unix domain sockets (`createConnection(socketPath)`, `lstat().isSocket()`), which behave differently or may not exist on Windows.

**Impact:** The Playwright discovery service will fail to start or will find zero sessions on Windows.

**Recommended fix:** Gate the entire Playwright subsystem on Windows (see Playwright Gating Plan below). On Windows, the discovery service should be disabled by default and return empty snapshots.

---

### C2. Process Signal Handling — SIGUSR1 for Reboot

**File:** `apps/backend/src/ws/routes/health-routes.ts`, lines 12, 53  
**Code:**
```typescript
const RESTART_SIGNAL: NodeJS.Signals = "SIGUSR1";
process.kill(targetPid, RESTART_SIGNAL);
```

**Description:** `SIGUSR1` is a POSIX-only signal and does not exist on Windows. `process.kill(pid, 'SIGUSR1')` will throw an error on Windows. Additionally, the `process.kill(pid, 0)` liveness check on line 72 works differently on Windows — it does not raise `ESRCH` for dead processes in the same way.

**Impact:** The `/api/reboot` endpoint will crash on Windows. PID file-based daemon detection (`resolveProdDaemonPid`) will also misbehave.

**Recommended fix:**
- On Windows, use a different IPC mechanism for reboot signaling (e.g., named pipe, file-based signal, or HTTP endpoint to self).
- Guard `SIGUSR1` usage behind a platform check: `process.platform !== 'win32'`.
- For PID liveness checks, catch more broadly or use a Windows-compatible approach.

---

### C3. Graceful Shutdown Signal Handlers — SIGINT/SIGTERM Behavior

**File:** `apps/backend/src/index.ts`, lines 153–159  
**Code:**
```typescript
process.on("SIGINT", () => { void shutdown("SIGINT"); });
process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
```

**Description:** `SIGTERM` is not reliably delivered on Windows. Node.js on Windows emulates `SIGINT` for Ctrl+C, but `SIGTERM` sent via `process.kill()` causes unconditional process termination — the handler never fires. There is no `SIGHUP` handler, but that signal is also absent on Windows.

**Impact:** Graceful shutdown may not work when the process is killed externally on Windows. The `SIGINT` handler will work for Ctrl+C in a terminal, but automated/service shutdown paths will not trigger cleanup.

**Recommended fix:**
- Keep existing signal handlers (they work for Ctrl+C).
- Add `process.on('SIGBREAK', ...)` for Windows Ctrl+Break.
- For daemon/service scenarios, consider using a Windows-compatible shutdown mechanism (named pipe listener, or `process.on('message', ...)` for PM2/child-process patterns).

---

### C4. CWD Policy — Absolute Path Detection Assumes POSIX

**File:** `apps/backend/src/swarm/cwd-policy.ts`, line 72  
**Code:** `return trimmed.startsWith("/") ? resolve(trimmed) : resolve(rootDir, trimmed);`

**Description:** Absolute path detection checks for leading `/` only. On Windows, absolute paths start with a drive letter (e.g., `C:\` or `C:/`). A Windows absolute path like `C:\Users\user\projects` would be treated as relative and resolved against `rootDir`, producing an incorrect path.

**Impact:** All CWD validation, directory listing, and file-route path resolution will silently produce wrong paths on Windows.

**Recommended fix:** Use `path.isAbsolute()` from Node.js, which handles both POSIX and Windows path formats:
```typescript
return path.isAbsolute(trimmed) ? resolve(trimmed) : resolve(rootDir, trimmed);
```

---

### C5. File Routes — Hardcoded `/tmp` in Allowed Roots

**File:** `apps/backend/src/ws/routes/file-routes.ts`, line 37  
**Code:**
```typescript
const allowedRoots = normalizeAllowlistRoots([
  ...config.cwdAllowlistRoots,
  config.paths.rootDir,
  homedir(),
  "/tmp"
]);
```

**Description:** `/tmp` is hardcoded as an allowed root for file read/write operations. This path does not exist on Windows.

**Impact:** The `/tmp` root will be silently ignored (it won't exist), but any code or prompts that write to `/tmp` will fail. This is a minor functional gap, but the hardcoded path is a code smell.

**Recommended fix:** Replace `/tmp` with `os.tmpdir()` which returns the platform-appropriate temp directory:
```typescript
import { tmpdir } from "node:os";
// ...
tmpdir()
```

---

### C6. Health Routes — PID File in tmpdir() with POSIX Signal Assumptions

**File:** `apps/backend/src/ws/routes/health-routes.ts`, lines 79–82  
**Code:**
```typescript
function getProdDaemonPidFile(repoRoot: string): string {
  const repoHash = createHash("sha1").update(repoRoot).digest("hex").slice(0, 10);
  return join(tmpdir(), `swarm-prod-daemon-${repoHash}.pid`);
}
```

**Description:** While `tmpdir()` is cross-platform, the PID file + `process.kill(pid, 0)` + `SIGUSR1` pattern is fundamentally POSIX-oriented. On Windows:
- `process.kill(pid, 0)` does not reliably detect process liveness
- `rmSync(pidFile)` after `ESRCH` detection won't work the same way
- The whole daemon PID lifecycle assumes Unix process semantics

**Impact:** Daemon PID management will be unreliable on Windows.

**Recommended fix:** Abstract the daemon liveness check behind a platform-aware utility. On Windows, consider named pipes or HTTP health-check pings instead of PID/signal checks.

---

### C7. Codex JSON-RPC Client — `child.kill()` Without Windows Handling

**File:** `apps/backend/src/swarm/codex-jsonrpc-client.ts`, lines 130–132  
**Code:**
```typescript
if (!this.child.killed) {
  this.child.kill();
}
```

**Description:** `child.kill()` sends `SIGTERM` by default, which on Windows causes unconditional termination without any chance for the child to clean up. The Codex app-server process will be forcefully terminated rather than gracefully shut down.

Additionally, the `spawn()` call on line 62 uses `stdio: "pipe"` which is fine on Windows, but the assumption that `codex` is available as a command depends on it being on `PATH`, which requires Windows-specific installation guidance.

**Impact:** Codex runtime cleanup will be less graceful on Windows. The `codex` CLI must be installed and on PATH.

**Recommended fix:**
- For `dispose()`, attempt a graceful RPC shutdown request before falling back to `child.kill()`.
- Document Windows-specific Codex CLI installation in setup guides.

---

## High-Risk Issues

### H1. Playwright Discovery — Unix Domain Socket Probing

**Files:**
- `apps/backend/src/playwright/playwright-discovery-service.ts`, lines 1222–1280 (`probeSession`, `probeSocket`)
- `apps/backend/src/playwright/playwright-devtools-bridge.ts`, lines 1, 114, 142 (`createConnection`)

**Description:** The Playwright subsystem uses `createConnection(socketPath)` to probe Unix domain sockets, `lstat().isSocket()` to detect socket files, and the `sendDaemonStopCommand` function communicates over Unix sockets. None of this works on Windows in the expected way.

**Impact:** All Playwright session discovery, probing, closing, and live preview will fail on Windows.

**Recommended fix:** Gate entirely (see Playwright Gating Plan).

---

### H2. Data Migration — Hard Links May Fail

**File:** `apps/backend/src/swarm/data-migration.ts`, lines 37, 629–660  
**Code:**
```typescript
link: (existingPath, newPath) => fs.link(existingPath, newPath),
// ...
async function hardlinkOrCopyFileIfMissing(...) {
  try {
    await fileOps.link(sourcePath, targetPath);
    return;
  } catch (error) { ... }
  // Falls back to copy
}
```

**Description:** `fs.link()` (hard links) may fail on Windows depending on:
- The filesystem (FAT32 doesn't support hard links)
- User permissions (requires SeCreateSymbolicLinkPrivilege on some configs)
- Cross-volume links (always fail)

The code already has a fallback to `fs.copyFile()`, which is good. However, the error handling checks for `EEXIST` and `ENOENT` — it should also handle `EPERM` and `EXDEV` gracefully.

**Impact:** Migration will likely work due to the copy fallback, but may log confusing errors on Windows. Edge cases could cause migration to fail if error codes differ.

**Recommended fix:** The fallback is already good. Ensure the catch block in `hardlinkOrCopyFileIfMissing` treats all non-`EEXIST`/`ENOENT` errors as "try copy fallback" rather than re-throwing.

---

### H3. Handoff File Path — `ls -lt` in Agent Prompts

**File:** `apps/backend/src/swarm/agent-runtime.ts`, lines 1239, 1254  
**Code:**
```typescript
"2. Check your working directory for recent file modifications (`ls -lt` or `git status`)"
"3. Verify the workspace is consistent — run `git status` or ..."
```

**Description:** The resume prompt after context compaction tells the agent to run `ls -lt`, which is a Unix command. On Windows, the equivalent would be `dir /O-D`. Since agents execute these commands via tool calls (bash/shell), this will fail if the agent's shell is cmd.exe or PowerShell.

**Impact:** Context recovery prompts will produce tool errors on Windows if the agent tries to run `ls -lt`.

**Recommended fix:** Use cross-platform alternatives in prompts: `git status` (works everywhere) and `dir` or advise checking recent files. Better: detect platform and adjust prompt text.

---

### H4. Session File Guard — Sync FS Operations

**File:** `apps/backend/src/swarm/session-file-guard.ts`, lines 2, 75  
**Code:**
```typescript
import { renameSync, statSync, writeFileSync } from "node:fs";
renameSync(sessionFile, backupFile);
```

**Description:** `renameSync` on Windows can fail if the file is open by another process (file locking semantics differ from POSIX). Windows has mandatory file locking — if the session file is being read/written by another part of the system, `renameSync` will throw `EBUSY` or `EPERM`.

**Impact:** Session file rotation for oversized files may fail sporadically on Windows.

**Recommended fix:** Use retry logic with backoff for rename operations on Windows. Consider using async versions with error handling.

---

### H5. Atomic File Writes via rename() — Cross-Device Issues

**Files:**
- `apps/backend/src/swarm/persistence-service.ts`, line 156
- `apps/backend/src/swarm/secrets-env-service.ts`, line 240
- `apps/backend/src/swarm/session-manifest.ts`, line 45
- `apps/backend/src/swarm/data-migration.ts`, lines 712, 719
- `apps/backend/src/scheduler/cron-scheduler-service.ts`

**Code pattern:**
```typescript
const tmp = `${target}.tmp`;
await writeFile(tmp, content, "utf8");
await rename(tmp, target);
```

**Description:** The `rename()` pattern for atomic writes is correct on POSIX (rename is atomic within the same filesystem). On Windows:
- `rename()` can fail with `EPERM` if the target file is open by another process
- `rename()` is not atomic on all Windows filesystems
- The tmp file is in the same directory (same volume), so cross-device issues shouldn't occur

Since the tmp file uses the same directory prefix, this should generally work, but Windows file-locking semantics mean conflicts are more likely.

**Impact:** Rare write failures under concurrent access on Windows.

**Recommended fix:** Add retry logic for `EPERM`/`EBUSY` errors on rename. Consider using `graceful-fs` or a write-with-retry utility.

---

### H6. `fs.watch()` Behavior Differences on Windows

**Files:**
- `apps/backend/src/scheduler/cron-scheduler-service.ts` (watches schedule files)
- `apps/backend/src/playwright/playwright-discovery-service.ts` (watches session directories)

**Description:** `fs.watch()` behavior varies significantly by platform:
- On macOS: uses FSEvents (reliable)
- On Linux: uses inotify (reliable)
- On Windows: uses ReadDirectoryChangesW (can be unreliable, may fire duplicate events, misses some renames)

**Impact:** File watchers may fire too often or miss changes on Windows. The cron scheduler and Playwright discovery may have delayed or missed reactions to file changes.

**Recommended fix:** The existing poll-based fallback timers mitigate this. Ensure watchers have error handlers (they do). Consider using `chokidar` for more reliable cross-platform watching if issues arise.

---

### H7. Codex Runtime — Environment and Shell Assumptions

**File:** `apps/backend/src/swarm/codex-agent-runtime.ts`, lines 130–145  
**Code:**
```typescript
const command = process.env.CODEX_BIN?.trim() || "codex";
// ...
this.rpc = new CodexJsonRpcClient({
  command,
  args: codexArgs,
  spawnOptions: { cwd: options.descriptor.cwd, env: runtimeEnv }
});
```

**Description:** The Codex runtime spawns `codex` as a child process. On Windows:
- The `codex` binary may need `.exe` or `.cmd` extension to be found
- `spawn()` without `shell: true` may not find commands that are batch files or scripts
- The `PATH` separator is `;` on Windows vs `:` on Unix

**Impact:** Codex agent spawning may fail with `ENOENT` if `codex` is installed as a batch script or not directly on PATH.

**Recommended fix:** Use `cross-spawn` or add `shell: true` option for the spawn call. Alternatively, detect `.cmd`/`.bat` extensions.

---

### H8. Directory Picker — Platform Handling

**File:** `apps/backend/src/swarm/directory-picker.ts`, lines 29–100

**Description:** The directory picker already has `win32` case handling with PowerShell. This is good! However:
- The `ensureTrailingSlash()` function uses `/` as the appended separator (line: `return \`\${pathValue}/\``), which is fine for PowerShell but inconsistent
- The Linux fallback (`zenity`/`kdialog`) won't be available on Windows Subsystem for Linux if running natively

**Impact:** Low — the Windows path is already implemented. Minor edge cases.

**Recommended fix:** Already mostly handled. Consider using `path.sep` for `ensureTrailingSlash` consistency.

---

## Medium-Risk Issues

### M1. Home Directory and Data Dir — `~/.middleman` Convention

**File:** `apps/backend/src/config.ts`, line 29  
**Code:**
```typescript
const dataDir = process.env.MIDDLEMAN_DATA_DIR ?? resolve(homedir(), ".middleman");
```

**Description:** `homedir()` returns `C:\Users\<username>` on Windows. The `.middleman` directory will be created there as `C:\Users\<username>\.middleman`. While this works technically, it's unconventional for Windows where app data typically goes to `%APPDATA%` or `%LOCALAPPDATA%`.

The dotfile convention (`.middleman`) is also unusual on Windows — Windows Explorer hides files starting with `.` inconsistently.

**Impact:** Functional but unconventional. Users may have trouble finding the data directory.

**Recommended fix:** On Windows, consider defaulting to `%LOCALAPPDATA%\middleman` instead. This can be done with a platform check:
```typescript
const dataDir = process.env.MIDDLEMAN_DATA_DIR ?? 
  (process.platform === 'win32' 
    ? resolve(process.env.LOCALAPPDATA || homedir(), 'middleman')
    : resolve(homedir(), '.middleman'));
```

---

### M2. Legacy Auth Migration — `.pi` Directory

**File:** `apps/backend/src/config.ts`, line 151  
**Code:**
```typescript
const legacyPiAuthFile = resolve(homedir(), ".pi", "agent", "auth.json");
```

**Description:** Migrates from `~/.pi/agent/auth.json`. On Windows, this path resolves to `C:\Users\<username>\.pi\agent\auth.json`. The path is valid but the `.pi` directory is unlikely to exist on Windows (pi may use a different data location there).

**Impact:** Low — migration will silently skip if the file doesn't exist, which is correct.

**Recommended fix:** None needed — behavior is safe.

---

### M3. Worktrees Allowlist Root — Home-Relative Path

**File:** `apps/backend/src/config.ts`, lines 58–60  
**Code:**
```typescript
const cwdAllowlistRoots = normalizeAllowlistRoots([
  rootDir,
  resolve(homedir(), "worktrees")
]);
```

**Description:** Adds `~/worktrees` to the CWD allowlist. On Windows this becomes `C:\Users\<username>\worktrees`. This is a reasonable path but may not match Windows user conventions.

**Impact:** Low — the path simply won't exist and will be ignored.

**Recommended fix:** None needed for correctness. Could add Windows-conventional paths to the allowlist.

---

### M4. Path Separator in `sanitizePathSegment`

**File:** `apps/backend/src/swarm/data-paths.ts`, lines 174–176  
**Code:**
```typescript
if (/[\\/]/.test(trimmed)) {
  throw new Error(`Invalid path segment: "${segment}"`);
}
```

**Description:** The regex correctly rejects both `/` and `\` as path separators. This is good for Windows compatibility. However, Windows paths commonly contain `\`, so any input with backslashes will be rejected. This is the desired behavior for path *segments* (not full paths).

**Impact:** None — this is correct behavior. Noting as positive.

---

### M5. `isPathWithinRoot` Uses `path.sep`

**File:** `apps/backend/src/swarm/cwd-policy.ts`, line 115  
**Code:**
```typescript
return normalizedPath.startsWith(`${normalizedRoot}${sep}`);
```

**Description:** Uses `path.sep` correctly, which is `\` on Windows and `/` on POSIX. However, `resolve()` and `realpathSync()` normalize separators, so this should work on both platforms.

**Impact:** None — correctly uses platform separator. Noting as positive.

---

### M6. Temp File Naming with `process.pid`

**Files:** Multiple (session-manifest.ts, data-migration.ts, etc.)  
**Code pattern:** `\`${path}.tmp-${process.pid}-${Date.now()}-${randomHex}\``

**Description:** Using `process.pid` in temp file names is fine on all platforms. However, on Windows, if the parent file path is very long (approaching MAX_PATH of 260 chars), the additional suffix could exceed the limit.

**Impact:** Potential failures with deeply nested data directories on Windows.

**Recommended fix:** Consider using `os.tmpdir()` for temp files, or ensure the data directory is not too deeply nested. Windows long path support can be enabled via registry/manifest.

---

## Low-Risk / Informational

### L1. `packages/protocol/` — No OS-Specific Code

**Directory:** `packages/protocol/src/`

**Description:** The protocol package contains only TypeScript type definitions and interfaces. No file I/O, no path handling, no process management. Fully platform-independent.

**Impact:** None — safe on all platforms.

---

### L2. Integration Services (Telegram/Slack) — No OS Assumptions

**Files:** `apps/backend/src/integrations/telegram/*`, `apps/backend/src/integrations/slack/*`

**Description:** Telegram and Slack integrations use HTTP APIs and WebSocket connections (via `@slack/socket-mode`). No file system operations beyond config persistence (which uses the cross-platform data-paths system). No shell commands or POSIX-specific code.

**Impact:** None — fully platform-independent.

---

### L3. Line Ending Handling

**Various files**

**Description:** The codebase writes files with `\n` line endings. On Windows, this is fine for programmatic consumption (JSON, JSONL, markdown). Git's `core.autocrlf` setting may convert line endings in the repository, but runtime-generated files will use `\n`.

Session JSONL files parse with `split(/\r?\n/)` in several places (e.g., playwright discovery's `parseEnvFile`), which correctly handles both `\n` and `\r\n`.

**Impact:** None — line ending handling is adequate.

---

### L4. `dotenv` Loading

**File:** `apps/backend/src/index.ts`, line 7  
**Code:**
```typescript
loadDotenv({ path: resolve(repoRoot, ".env") });
```

**Description:** `dotenv` handles cross-platform `.env` file loading correctly. The `resolve()` call normalizes the path.

**Impact:** None — works on all platforms.

---

### L5. Native Dependencies Assessment

**File:** `apps/backend/package.json`

**Description:** Key dependencies and their Windows compatibility:
- `ws` (WebSocket): Pure JS, no native bindings. ✅
- `@slack/web-api`, `@slack/socket-mode`: Pure JS/HTTP. ✅
- `cron-parser`: Pure JS. ✅
- `dotenv`: Pure JS. ✅
- `jsdom`: Pure JS (some optional native deps but works without). ✅
- `@mariozechner/pi-ai`, `@mariozechner/pi-coding-agent`: Need verification, but likely JS-based. ⚠️
- `@sinclair/typebox`: Pure JS. ✅
- `@mozilla/readability`: Pure JS. ✅
- `mime`, `turndown`, `slackify-markdown`: Pure JS. ✅

No native C++ addons detected in direct dependencies.

---

## Playwright Gating Plan

The entire Playwright subsystem should be **gated on Windows** — not removed, but conditionally disabled. The subsystem relies fundamentally on Unix domain sockets, `/tmp` paths, and POSIX process semantics that cannot easily be ported.

### Files Requiring Gating

#### 1. `apps/backend/src/playwright/playwright-discovery-service.ts`
- **What to gate:** The `start()` method should check `process.platform` and immediately return with a disabled/empty snapshot on Windows.
- **Specific code:** Add early return in `start()`:
  ```typescript
  async start(): Promise<void> {
    if (process.platform === 'win32') {
      this.currentSnapshot = createEmptySnapshot(this.currentSettings, 'disabled')
      this.emitSnapshot(this.currentSnapshot, 'playwright_discovery_snapshot')
      return
    }
    // ... existing code
  }
  ```
- **Also:** The `SOCKETS_BASE_DIR` constant (`/tmp/playwright-cli-sockets`) should use `os.tmpdir()` as a base even if gated, for documentation correctness.

#### 2. `apps/backend/src/playwright/playwright-devtools-bridge.ts`
- **What to gate:** `startPreviewController()` should throw a clear error on Windows.
- **Specific code:** Add platform check at the top of `startPreviewController()`:
  ```typescript
  if (process.platform === 'win32') {
    throw new PlaywrightDevtoolsBridgeError(
      'Playwright live preview is not supported on Windows', 501
    )
  }
  ```

#### 3. `apps/backend/src/playwright/playwright-live-preview-service.ts`
- **What to gate:** The service wraps discovery; it will naturally return empty results if discovery is gated. No additional gating needed.

#### 4. `apps/backend/src/playwright/playwright-live-preview-proxy.ts`
- **What to gate:** `canHandleUpgrade()` should return `false` on Windows, or the proxy should be a no-op. Since it depends on upstream discovery sessions, it will naturally have nothing to proxy if discovery is disabled.

#### 5. `apps/backend/src/playwright/playwright-settings-service.ts`
- **What to gate:** Settings service can remain active (it just reads/writes JSON config). However, `effectiveEnabled` should default to `false` on Windows.

#### 6. `apps/backend/src/index.ts` (startup orchestration)
- **What to gate:** The Playwright service initialization block (lines ~95–110) should be wrapped:
  ```typescript
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

### Gating Strategy Summary

- **Discovery service:** Platform check in `start()` → returns disabled snapshot
- **Devtools bridge:** Platform check in `startPreviewController()` → throws 501
- **Settings service:** Allow config but default `effectiveEnabled = false` on Windows
- **Live preview service/proxy:** Naturally disabled when discovery returns nothing
- **Index.ts:** Skip Playwright initialization entirely on Windows
- **API routes:** Return appropriate "not supported" responses when discovery is null (already handled)

---

## Summary of Required Changes by Priority

### Must-Fix Before Windows Release
1. **C4** — `cwd-policy.ts` absolute path detection → use `path.isAbsolute()`
2. **C5** — `file-routes.ts` `/tmp` → `os.tmpdir()`
3. **C2** — `health-routes.ts` SIGUSR1 → platform guard
4. **C6** — PID/signal-based daemon management → platform-aware abstraction
5. **C1 + H1** — Playwright gating (6 files)
6. **C7** — `codex-jsonrpc-client.ts` `child.kill()` → graceful shutdown
7. **C3** — Add `SIGBREAK` handler for Windows

### Should-Fix
8. **H2** — Data migration hardlink error handling → broader catch
9. **H3** — Resume prompt `ls -lt` → cross-platform command
10. **H4** — Session file guard `renameSync` → add retry logic
11. **H5** — Atomic write `rename()` → add retry for EPERM/EBUSY
12. **H7** — Codex spawn → handle `.cmd`/`.bat` extensions
13. **H8** — Directory picker `ensureTrailingSlash` → use `path.sep`

### Nice-to-Have
14. **M1** — Default data dir → `%LOCALAPPDATA%\middleman` on Windows
15. **M6** — Long path awareness for temp files
16. **H6** — Consider `chokidar` for more reliable file watching
