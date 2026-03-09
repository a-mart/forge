# Playwright Session Discovery — Feasibility Research Report

**Date:** 2026-03-09  
**Researcher:** pw-discovery-researcher (automated analysis)  
**Target:** `/Users/adam/repos/newco/agent_stack` and all worktrees

---

## Executive Summary

Discovery is **fully feasible** using filesystem scanning. All session metadata is in plain JSON `.session` files with predictable paths. Socket-based liveness detection works but requires careful handling of stale files. The main complexity is: (1) two generations of session file layout coexist, (2) the worktree registry has stale entries, and (3) multiple `.playwright-cli` roots exist (repo root AND `backend/` subdirectory). A comprehensive scanner must handle all these cases.

---

## 1. Worktree Registry

**File:** `/Users/adam/repos/newco/agent_stack/.git/worktree-runtime/registry.tsv`

### Format
Tab-separated, **no header row**. Five columns:

| Column | Name (inferred) | Example |
|--------|-----------------|---------|
| 1 | `stackId` | `fix-file-duplicates-94587d4a` |
| 2 | `worktreePath` | `/Users/adam/repos/newco/worktrees/fix-file-duplicates` |
| 3 | `composeProjectName` | `wt_fix_file_duplicates_94587d4a` |
| 4 | `runtimeEnvPath` | `/Users/adam/repos/newco/agent_stack/.git/worktree-runtime/fix-file-duplicates-94587d4a.env` |
| 5 | `createdAt` | `2026-03-09T02:54:50Z` |

### Entries (5 total)

| Stack ID | Path | Status |
|----------|------|--------|
| `codex-user-test-1772202207-077bdfa3` | `.../worktrees/codex-user-test-1772202207` | **MISSING** (directory deleted) |
| `test-clean-d4ba73a8` | `.../worktrees/test-clean` | **MISSING** (directory deleted) |
| `improve-search-f51a06f4` | `.../worktrees/improve-search` | **MISSING** (directory deleted) |
| `fix-stop-button-f99ec71d` | `.../worktrees/fix-stop-button` | EXISTS |
| `fix-file-duplicates-94587d4a` | `.../worktrees/fix-file-duplicates` | EXISTS |

### Discrepancies
- **Registry is stale.** 3 of 5 entries point to deleted directories. The registry is append-only and never cleaned up.
- **Additional worktrees exist** that are NOT in the registry: `code-simplification`, `context-window-usage-accuracy`, `session-summaries`. These were likely created by a different mechanism or the registry wasn't updated.
- **Git worktree list** shows only 2 active worktrees (`agent_stack` main + `fix-file-duplicates`), while the filesystem has 5 worktree directories. `fix-stop-button` exists on disk but is NOT in `git worktree list` — it may be a pruned/orphaned worktree.

### ⚠️ Key Finding
**Do NOT rely solely on registry.tsv for discovery.** Must also scan the actual `worktrees/` directory and check for `.playwright-cli/` presence. The registry is useful for port allocation lookups but unreliable for enumerating live worktrees.

---

## 2. Session File Locations & Inventory

### Discovery Paths

There are **three kinds of `.playwright-cli` roots** found:

1. **Repo root:** `/Users/adam/repos/newco/agent_stack/.playwright-cli/`
2. **Backend subdir:** `/Users/adam/repos/newco/agent_stack/backend/.playwright-cli/`
3. **Worktree roots:** `/Users/adam/repos/newco/worktrees/<name>/.playwright-cli/`

### Session Files Found

| Location | File | Has resolvedConfig? | Type |
|----------|------|---------------------|------|
| `agent_stack/.playwright-cli/sessions/default.session` | ✅ | ❌ (minimal) | Legacy v1 |
| `agent_stack/.playwright-cli/sessions/agent-stack-frontend2.session` | ✅ | ❌ (minimal) | Legacy v1 |
| `agent_stack/.playwright-cli/sessions/3f15aae11982f048/default.session` | ✅ | ✅ (full) | Current v2 |
| `worktrees/fix-stop-button/.playwright-cli/sessions/3f15aae11982f048/default.session` | ✅ | ✅ (full) | Current v2 |
| `worktrees/fix-file-duplicates/.playwright-cli/sessions/3f15aae11982f048/default.session` | ✅ | ✅ (full) | Current v2 |

### Hash Subdirectory: `3f15aae11982f048`

This hex hash appears in **every** `.playwright-cli/sessions/` directory (even those without `.session` files). It is a **Playwright CLI installation/daemon identifier** — likely derived from the `npx` package hash or a machine-level identifier. It is **shared across all worktrees and the main repo**. The same hash appears in:
- All session file paths
- All socket paths
- All userDataDir paths

The hash `961e5c5225ee1a0f` is an **older/previous** installation ID (only contains empty `.err` files, no `.session` files — leftover from a previous Playwright CLI version).

### Directories with `.playwright-cli` but NO Session Files

| Location | Contents |
|----------|----------|
| `agent_stack/backend/.playwright-cli/sessions/3f15aae.../` | Only `.err` files (2 empty) |
| `worktrees/code-simplification/.playwright-cli/sessions/3f15aae.../` | Only `ud-default-chrome/` data dir (no `.session`) |
| `worktrees/session-summaries/.playwright-cli/sessions/3f15aae.../` | Only `ud-default-chrome/` data dir (no `.session`) |

These represent **sessions that ran and exited** — the Chrome user data persists but the session metadata file was removed on clean shutdown (or was never written for transient sessions).

---

## 3. Session File Schemas

### Legacy v1 Format (pre-hash-subdirectory)

```json
{
  "version": "0.0.63",
  "socketPath": "/tmp/playwright-cli-sockets/3f15aae11982f048/default.sock",
  "cli": {
    "headed": true
  },
  "userDataDirPrefix": "/Users/adam/repos/newco/agent_stack/.playwright-cli/sessions/ud-default"
}
```

**Fields:**
- `version`: Short semver string (e.g., `"0.0.62"`, `"0.0.63"`)
- `socketPath`: Points to socket in `/tmp/`
- `cli.headed`: boolean — whether browser was headed
- `userDataDirPrefix`: Path prefix for Chrome user data dir
- ❌ No `name`, `timestamp`, `resolvedConfig`, `cli.persistent`

### Current v2 Format (inside hash subdirectory)

```json
{
  "name": "default",
  "version": "1.59.0-alpha-1771104257000",
  "timestamp": 1773068539146,
  "socketPath": "/tmp/playwright-cli-sockets/3f15aae11982f048/default.sock",
  "cli": {
    "persistent": true
  },
  "userDataDirPrefix": ".../.playwright-cli/sessions/3f15aae11982f048/ud-default",
  "resolvedConfig": {
    "browser": {
      "browserName": "chromium",
      "launchOptions": {
        "channel": "chrome",
        "headless": true,
        "assistantMode": true,
        "chromiumSandbox": true,
        "cdpPort": 62123
      },
      "contextOptions": {
        "viewport": { "width": 1280, "height": 720 }
      },
      "isolated": false,
      "cdpHeaders": {},
      "userDataDir": ".../.playwright-cli/sessions/3f15aae11982f048/ud-default-chrome"
    },
    "console": { "level": "info" },
    "network": {},
    "server": {},
    "saveTrace": false,
    "snapshot": { "mode": "full", "output": "stdout" },
    "timeouts": { "action": 5000, "navigation": 60000 },
    "outputMode": "file",
    "sessionConfig": {
      "name": "default",
      "version": "1.59.0-alpha-1771104257000",
      "timestamp": 1773068537586,
      "socketPath": "/tmp/playwright-cli-sockets/3f15aae11982f048/default.sock",
      "cli": { "persistent": true },
      "userDataDirPrefix": ".../.playwright-cli/sessions/3f15aae11982f048/ud-default"
    },
    "skillMode": true
  }
}
```

**All Fields in v2:**

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Session name (e.g., `"default"`) |
| `version` | string | Playwright CLI version (e.g., `"1.59.0-alpha-1771104257000"`) |
| `timestamp` | number | Unix epoch ms when session was created/updated |
| `socketPath` | string | Unix socket path for daemon communication |
| `cli.persistent` | boolean | Whether this is a persistent (reusable) session |
| `userDataDirPrefix` | string | Chrome user data dir prefix (append `-chrome` for actual dir) |
| `resolvedConfig.browser.browserName` | string | Always `"chromium"` |
| `resolvedConfig.browser.launchOptions.channel` | string | `"chrome"` (uses system Chrome) |
| `resolvedConfig.browser.launchOptions.headless` | boolean | `true` in all current sessions |
| `resolvedConfig.browser.launchOptions.assistantMode` | boolean | Always `true` |
| `resolvedConfig.browser.launchOptions.chromiumSandbox` | boolean | Always `true` |
| `resolvedConfig.browser.launchOptions.cdpPort` | number | **Chrome DevTools Protocol port** (dynamic, unique per session) |
| `resolvedConfig.browser.contextOptions.viewport` | object | `{width: 1280, height: 720}` |
| `resolvedConfig.browser.isolated` | boolean | `false` — sessions share Chrome profile |
| `resolvedConfig.browser.cdpHeaders` | object | Empty `{}` |
| `resolvedConfig.browser.userDataDir` | string | Full path to Chrome user data dir |
| `resolvedConfig.console.level` | string | `"info"` |
| `resolvedConfig.snapshot.mode` | string | `"full"` |
| `resolvedConfig.snapshot.output` | string | `"stdout"` |
| `resolvedConfig.timeouts.action` | number | `5000` ms |
| `resolvedConfig.timeouts.navigation` | number | `60000` ms |
| `resolvedConfig.outputMode` | string | `"file"` |
| `resolvedConfig.sessionConfig` | object | **Embedded copy of top-level fields** (name, version, timestamp, socketPath, cli, userDataDirPrefix) |
| `resolvedConfig.skillMode` | boolean | `true` — Playwright in "skill mode" for AI agents |

### ⚠️ Notable: `resolvedConfig.sessionConfig` is Redundant
The `sessionConfig` nested object duplicates the top-level `name`, `version`, `timestamp`, `socketPath`, `cli`, and `userDataDirPrefix` fields. However, the `timestamp` differs slightly (sessionConfig timestamp is ~1-2 seconds earlier), suggesting `sessionConfig` captures creation time while the outer `timestamp` captures when the file was last written.

---

## 4. Session File Deep Analysis

### All v2 Sessions Compared

| Property | Main Repo | fix-stop-button | fix-file-duplicates |
|----------|-----------|-----------------|---------------------|
| name | `default` | `default` | `default` |
| version | `1.59.0-alpha-1771104257000` | same | same |
| timestamp | `2026-03-09T15:02:19Z` | `2026-03-08T19:09:40Z` | `2026-03-09T15:25:40Z` |
| cdpPort | `62123` | `58489` | `64592` |
| headless | `true` | `true` | `true` |
| persistent | `true` | `true` | `true` |
| socketPath | `.../3f15aae.../default.sock` | same socket! | same socket! |
| userDataDir | Main repo path | Worktree-local path | Worktree-local path |

### 🚨 Critical Finding: Shared Socket Path

**All three session files point to the SAME socket path:** `/tmp/playwright-cli-sockets/3f15aae11982f048/default.sock`

This means all sessions with name `"default"` share a **single daemon process**. The socket is the daemon, and the `.session` files in different worktrees are just local references to it. The `cdpPort` and `userDataDirPrefix` differ per-worktree, confirming that each worktree invocation updates the daemon's state (the last session to launch wins).

**Implications for the dashboard:**
- Socket-based liveness detects the daemon, not individual worktree sessions
- The `.session` file with the **most recent timestamp** represents the currently-active session
- Stale `.session` files from other worktrees remain on disk even after their session ended
- CDP port changes with each daemon restart

### Socket ↔ Session File Cross-Reference

| Socket Path | Actual Socket File Exists? |
|-------------|--------------------------|
| `/tmp/playwright-cli-sockets/3f15aae11982f048/default.sock` | **NO** (directory exists but is empty) |
| `/tmp/playwright-cli-sockets/3f15aae11982f048/agent-stack-frontend2.sock` | **NO** |

**No socket files exist.** The socket directory `3f15aae11982f048/` is present but empty. This means **no Playwright daemon is currently running**.

### User Data Directory Verification

| userDataDirPrefix | `-chrome` dir exists? |
|-------------------|----------------------|
| Main repo `3f15aae.../ud-default` | ✅ Yes |
| fix-stop-button `3f15aae.../ud-default` | ✅ Yes (minimal — journal files only) |
| fix-file-duplicates `3f15aae.../ud-default` | ✅ Yes (full — cache, cookies, history, localStorage) |
| Main repo legacy `ud-default` | ✅ Yes (older) |
| Main repo legacy `ud-agent-stack-frontend2` | ✅ Yes (older) |

---

## 5. Socket Directory Structure

**Path:** `/tmp/playwright-cli-sockets/`

### Actual Structure
```
/tmp/playwright-cli-sockets/
└── 3f15aae11982f048/     # Daemon ID (empty — no active daemon)
```

### Expected Structure (when daemon is running)
```
/tmp/playwright-cli-sockets/
└── 3f15aae11982f048/
    ├── default.sock              # Unix socket for "default" session
    └── agent-stack-frontend2.sock # Unix socket for named session
```

Socket files are **created by the daemon on startup** and **removed on clean shutdown**. Their existence = daemon is running. The directory structure is `<daemon-id>/<session-name>.sock`.

---

## 6. Socket Liveness Testing

### Methodology
1. Check if socket file exists (`find /tmp/playwright-cli-sockets -type s`)
2. If exists, probe with `nc -U <socket-path> -w 1`
3. Cross-reference CDP port with `lsof -i :<port>`

### Results
- **No socket files found** — all sessions are currently stopped
- **No Chrome CDP ports listening** — ports 62123, 58489, 64592 all closed
- **No Chrome processes with `--remote-debugging-port`** — confirmed via `ps aux` grep
- **Regular Chrome is running** (user's normal browser) but no headless/automated instances

### Recommended Liveness Detection Strategy
```
1. PRIMARY: Check if socket file exists (stat, not open)
   - Fast, no side effects
   - Socket exists → daemon probably alive
   - Socket missing → daemon definitely dead

2. SECONDARY: Try connecting to socket
   - nc -U <path> -w 1 or Node net.createConnection()
   - Confirms daemon is responsive (not just file leftover)
   
3. TERTIARY: Check CDP port
   - lsof -i :<cdpPort> or HTTP GET http://localhost:<cdpPort>/json/version
   - Confirms browser is alive and accessible
   - Provides additional metadata (Chrome version, DevTools URL)
```

---

## 7. Port Allocations from Runtime Env Files

### Source Files

Runtime env files exist in **two locations** with identical content:
1. `/Users/adam/repos/newco/agent_stack/.git/worktree-runtime/<stack-id>.env` (canonical)
2. `/Users/adam/repos/newco/worktrees/<name>/backend/.env.worktree.runtime` (copied into worktree)

### Port Allocations

| Worktree | Port Base | API | DB | Sandbox | Frontend | LiteLLM |
|----------|-----------|-----|-----|---------|----------|---------|
| fix-stop-button | 38000 | 38000 | 38001 | 38002 | 38010 | 38011 |
| fix-file-duplicates | 41700 | 41700 | 41701 | 41702 | 41710 | 41711 |
| improve-search (deleted) | 24000 | 24000 | 24001 | 24002 | 24010 | N/A |
| test-clean (deleted) | 36700 | 36700 | 36701 | 36702 | 36710 | N/A |

**Note:** `codex-user-test-1772202207` has no env file in the canonical location (file not found).

### Key Variables for Dashboard

| Variable | Description |
|----------|-------------|
| `STACK_ID` | Unique worktree identifier |
| `STACK_ROOT` | Absolute path to worktree |
| `WT_FRONTEND_PORT` / `FRONTEND_HOST_PORT` | Frontend port (useful for URL resolution) |
| `WT_API_PORT` / `AGENT_BACKEND_HOST_PORT` | Backend API port |

### ⚠️ Env Format Drift
Newer env files include `COGNEE_FALKOR_*` and `LITELLM_*` ports. Older ones use `COGNEE_NEO4J_*`. The scanner should not assume a fixed set of port variables.

---

## 8. `pwcli.sh` Analysis

**Path:** `/Users/adam/repos/newco/agent_stack/scripts/pwcli.sh`

### Key Behaviors
1. **Forces `TMPDIR=/tmp`** to avoid macOS long TMPDIR paths breaking Unix sockets
2. **Sets `PLAYWRIGHT_DAEMON_SOCKETS_DIR`** to `/tmp/playwright-cli-sockets` (default)
3. **Sets `PLAYWRIGHT_DAEMON_SESSION_DIR`** to `$(pwd)/.playwright-cli/sessions`
4. **Does NOT force a session name** — allows Playwright CLI defaults unless `--session` or `PLAYWRIGHT_CLI_SESSION` is set
5. **Invokes:** `npx --yes --package @playwright/cli playwright-cli "$@"`

### Discovery Implications
- The session dir is always `<cwd>/.playwright-cli/sessions/` — so `cwd` at launch time determines where the `.session` file lands
- Socket dir is always `/tmp/playwright-cli-sockets/` (hardcoded default)
- The env vars `PLAYWRIGHT_DAEMON_SOCKETS_DIR` and `PLAYWRIGHT_DAEMON_SESSION_DIR` can be overridden but rarely are

---

## 9. `pwcli-auth-bootstrap.sh` Analysis

**Path:** `/Users/adam/repos/newco/agent_stack/scripts/pwcli-auth-bootstrap.sh`

### What It Does
1. Takes a `<target-url>` and optional `<email>` argument
2. Resolves the correct `frontend/` directory by matching `WT_FRONTEND_PORT` from `backend/.env.worktree.runtime` files
3. Runs inline Node.js to use `@clerk/testing/playwright` for automated Clerk auth
4. Saves browser storage state to temp file
5. Loads state into a Playwright CLI session via `pwcli close-all → open about:blank --persistent → state-load → goto`

### Auth Artifacts Created
- **Temp state file:** `/tmp/pwcli-clerk-state-XXXXXX` (deleted on exit)
- **Persistent cookies/storage:** Written into the Chrome user data dir (`ud-<session>-chrome/`)
- **The `.session` file is updated** with `--persistent` flag

### Discovery Implications
- Auth bootstrap creates **persistent sessions** (non-isolated Chrome profiles with saved cookies)
- The `userDataDir` in the session file contains auth state that survives daemon restarts
- Auth status could potentially be detected by checking for Clerk cookies in the Chrome user data dir

---

## 10. Output Artifacts

The `.playwright-cli/` root directory (outside `sessions/`) contains output artifacts from Playwright operations:

| Type | Count (main repo) | Pattern |
|------|-------------------|---------|
| Page snapshots (YAML) | ~387 | `page-<ISO-timestamp>.yml` |
| Screenshots (PNG) | ~18 | `page-<ISO-timestamp>.png` or `chat-page*.png` |
| Console logs | ~116 | `console-<ISO-timestamp>.log` |
| Network logs | ~12 | `network-<ISO-timestamp>.log` |

These are **per-worktree** and accumulate over time. The worktree `fix-file-duplicates` has ~15 such files, `fix-stop-button` has ~4. These could provide recent activity indicators for the dashboard.

---

## 11. Edge Cases Discovered

### 1. Two Session File Generations
Legacy v1 files (flat in `sessions/`) lack `name`, `timestamp`, and `resolvedConfig`. The scanner must handle both schemas.

### 2. Stale Session Files
All three v2 `.session` files point to the same (non-existent) socket. The session file persists after the daemon exits. **A session file existing does NOT mean the session is alive.**

### 3. Multiple `.playwright-cli` Roots Per Repo
Both `agent_stack/.playwright-cli/` and `agent_stack/backend/.playwright-cli/` exist. Sessions launched from different CWDs create different roots.

### 4. Shared Daemon / Conflicting Sessions
Multiple worktrees can reference the same socket. The last `open --persistent` call wins. Earlier worktree sessions become stale references.

### 5. Chrome User Data Without Session Files
`code-simplification` and `session-summaries` worktrees have `ud-default-chrome/` directories but NO `.session` files. These represent sessions that ran and completed, leaving browser profile data behind.

### 6. Registry-Filesystem Mismatch
3 of 5 registry entries point to deleted directories. 3 filesystem worktrees are NOT in the registry. Neither source is authoritative alone.

### 7. Non-Worktree Session File Locations
The `backend/.playwright-cli/` directory shows sessions can be created from any CWD within the repo, not just the root.

### 8. Dynamic CDP Port Allocation
CDP ports are dynamically assigned (62123, 58489, 64592 observed). They change with each daemon restart. Cannot rely on a fixed port.

---

## 12. Prototype `discoverSessions()` Implementation

```typescript
import * as fs from 'fs/promises';
import * as path from 'path';
import * as net from 'net';

// --- Types ---

interface PlaywrightSessionV1 {
  version: string;
  socketPath: string;
  cli: { headed?: boolean };
  userDataDirPrefix: string;
}

interface PlaywrightSessionV2 {
  name: string;
  version: string;
  timestamp: number;
  socketPath: string;
  cli: { persistent?: boolean };
  userDataDirPrefix: string;
  resolvedConfig: {
    browser: {
      browserName: string;
      launchOptions: {
        channel: string;
        headless: boolean;
        assistantMode: boolean;
        chromiumSandbox: boolean;
        cdpPort: number;
      };
      contextOptions: {
        viewport: { width: number; height: number };
      };
      isolated: boolean;
      userDataDir: string;
    };
    snapshot: { mode: string; output: string };
    timeouts: { action: number; navigation: number };
    outputMode: string;
    skillMode: boolean;
  };
}

type PlaywrightSession = PlaywrightSessionV1 | PlaywrightSessionV2;

function isV2Session(s: PlaywrightSession): s is PlaywrightSessionV2 {
  return 'name' in s && 'timestamp' in s && 'resolvedConfig' in s;
}

interface DiscoveredSession {
  /** Absolute path to the .session file */
  sessionFilePath: string;
  /** Which worktree or repo root this belongs to */
  worktreeRoot: string;
  /** Worktree name (or "main" for repo root) */
  worktreeName: string;
  /** Parsed session data */
  session: PlaywrightSession;
  /** Is this v2 format? */
  isV2: boolean;
  /** Session name (from v2, or inferred from filename for v1) */
  name: string;
  /** CDP port (v2 only) */
  cdpPort: number | null;
  /** Whether the daemon socket file exists on disk */
  socketExists: boolean;
  /** Whether the daemon socket is responsive (null = not checked) */
  socketAlive: boolean | null;
  /** Whether the CDP port is reachable (null = not checked) */
  cdpAlive: boolean | null;
  /** File modification time */
  sessionFileModifiedAt: Date;
  /** Whether Chrome user data dir exists */
  userDataDirExists: boolean;
  /** Frontend port from worktree env (null if unknown) */
  frontendPort: number | null;
  /** Output artifact counts */
  artifacts: {
    pageSnapshots: number;
    screenshots: number;
    consoleLogs: number;
    networkLogs: number;
  };
}

// --- Implementation ---

const AGENT_STACK_ROOT = '/Users/adam/repos/newco/agent_stack';
const WORKTREES_DIR = '/Users/adam/repos/newco/worktrees';
const SOCKET_BASE = '/tmp/playwright-cli-sockets';
const REGISTRY_PATH = `${AGENT_STACK_ROOT}/.git/worktree-runtime/registry.tsv`;
const RUNTIME_ENV_DIR = `${AGENT_STACK_ROOT}/.git/worktree-runtime`;

async function discoverSessions(): Promise<DiscoveredSession[]> {
  const results: DiscoveredSession[] = [];

  // 1. Enumerate all roots to scan
  const roots = await enumerateRoots();

  // 2. For each root, find all .session files
  for (const root of roots) {
    const sessions = await findSessionFiles(root);
    results.push(...sessions);
  }

  // 3. Deduplicate by socket path (keep most recent)
  const deduped = deduplicateSessions(results);

  // 4. Check liveness
  await Promise.all(deduped.map(checkLiveness));

  return deduped;
}

async function enumerateRoots(): Promise<{ path: string; name: string }[]> {
  const roots: { path: string; name: string }[] = [];

  // Always include main repo root
  roots.push({ path: AGENT_STACK_ROOT, name: 'main' });

  // Scan for backend/.playwright-cli as a secondary root
  const backendPwcli = path.join(AGENT_STACK_ROOT, 'backend', '.playwright-cli');
  if (await dirExists(backendPwcli)) {
    roots.push({ path: path.join(AGENT_STACK_ROOT, 'backend'), name: 'main/backend' });
  }

  // Scan worktrees directory for actual directories (not registry — it's stale)
  try {
    const entries = await fs.readdir(WORKTREES_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        const wtPath = path.join(WORKTREES_DIR, entry.name);
        roots.push({ path: wtPath, name: entry.name });
      }
    }
  } catch {
    // No worktrees directory
  }

  return roots;
}

async function findSessionFiles(
  root: { path: string; name: string }
): Promise<DiscoveredSession[]> {
  const results: DiscoveredSession[] = [];
  const sessionsDir = path.join(root.path, '.playwright-cli', 'sessions');

  if (!(await dirExists(sessionsDir))) return results;

  // Load port info
  const frontendPort = await getFrontendPort(root.name);
  const artifacts = await countArtifacts(path.join(root.path, '.playwright-cli'));

  // Scan for .session files at top level (v1) and in hash subdirectories (v2)
  const entries = await fs.readdir(sessionsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.session')) {
      // v1 session file (flat)
      const filePath = path.join(sessionsDir, entry.name);
      const session = await parseSessionFile(filePath, root, frontendPort, artifacts);
      if (session) results.push(session);
    } else if (entry.isDirectory() && /^[0-9a-f]{16}$/.test(entry.name)) {
      // Hash subdirectory — scan for v2 .session files
      const hashDir = path.join(sessionsDir, entry.name);
      const subEntries = await fs.readdir(hashDir, { withFileTypes: true });
      for (const sub of subEntries) {
        if (sub.isFile() && sub.name.endsWith('.session')) {
          const filePath = path.join(hashDir, sub.name);
          const session = await parseSessionFile(filePath, root, frontendPort, artifacts);
          if (session) results.push(session);
        }
      }
    }
  }

  return results;
}

async function parseSessionFile(
  filePath: string,
  root: { path: string; name: string },
  frontendPort: number | null,
  artifacts: DiscoveredSession['artifacts']
): Promise<DiscoveredSession | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const session: PlaywrightSession = JSON.parse(raw);
    const stat = await fs.stat(filePath);
    const v2 = isV2Session(session);

    const name = v2 ? session.name : path.basename(filePath, '.session');
    const cdpPort = v2 ? session.resolvedConfig.browser.launchOptions.cdpPort : null;

    // Check socket existence
    const socketExists = await fileExists(session.socketPath);

    // Check user data dir
    const udDir = v2
      ? session.resolvedConfig.browser.userDataDir
      : session.userDataDirPrefix + '-chrome';
    const userDataDirExists = await dirExists(udDir);

    return {
      sessionFilePath: filePath,
      worktreeRoot: root.path,
      worktreeName: root.name,
      session,
      isV2: v2,
      name,
      cdpPort,
      socketExists,
      socketAlive: null, // checked later
      cdpAlive: null,    // checked later
      sessionFileModifiedAt: stat.mtime,
      userDataDirExists,
      frontendPort,
      artifacts,
    };
  } catch {
    return null; // Corrupt or unreadable file
  }
}

async function checkLiveness(session: DiscoveredSession): Promise<void> {
  if (!session.socketExists) {
    session.socketAlive = false;
    session.cdpAlive = false;
    return;
  }

  // Try socket connection
  session.socketAlive = await probeSocket(session.session.socketPath);

  // Try CDP port
  if (session.cdpPort) {
    session.cdpAlive = await probeCdpPort(session.cdpPort);
  }
}

async function probeSocket(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const conn = net.createConnection(socketPath);
    const timeout = setTimeout(() => {
      conn.destroy();
      resolve(false);
    }, 1000);
    conn.on('connect', () => {
      clearTimeout(timeout);
      conn.destroy();
      resolve(true);
    });
    conn.on('error', () => {
      clearTimeout(timeout);
      resolve(false);
    });
  });
}

async function probeCdpPort(port: number): Promise<boolean> {
  try {
    const resp = await fetch(`http://localhost:${port}/json/version`, {
      signal: AbortSignal.timeout(2000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

function deduplicateSessions(sessions: DiscoveredSession[]): DiscoveredSession[] {
  // Group by socketPath — sessions sharing a socket are the same daemon
  const bySocket = new Map<string, DiscoveredSession[]>();
  for (const s of sessions) {
    const key = s.session.socketPath;
    if (!bySocket.has(key)) bySocket.set(key, []);
    bySocket.get(key)!.push(s);
  }

  const result: DiscoveredSession[] = [];
  for (const [, group] of bySocket) {
    if (group.length === 1) {
      result.push(group[0]);
    } else {
      // Keep the most recently modified one as "active", include others as stale references
      group.sort((a, b) => b.sessionFileModifiedAt.getTime() - a.sessionFileModifiedAt.getTime());
      // Return all but mark them — the caller can distinguish
      result.push(...group);
    }
  }
  return result;
}

// --- Helpers ---

async function dirExists(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isFile() || stat.isSocket();
  } catch {
    return false;
  }
}

async function getFrontendPort(worktreeName: string): Promise<number | null> {
  if (worktreeName === 'main' || worktreeName === 'main/backend') return null;

  // Try backend/.env.worktree.runtime in the worktree
  const envPath = path.join(WORKTREES_DIR, worktreeName, 'backend', '.env.worktree.runtime');
  try {
    const content = await fs.readFile(envPath, 'utf-8');
    const match = content.match(/^WT_FRONTEND_PORT=(\d+)/m);
    return match ? parseInt(match[1], 10) : null;
  } catch {
    // Fall back to registry env files
    try {
      const registryEnvs = await fs.readdir(RUNTIME_ENV_DIR);
      for (const f of registryEnvs) {
        if (!f.endsWith('.env')) continue;
        const content = await fs.readFile(path.join(RUNTIME_ENV_DIR, f), 'utf-8');
        const rootMatch = content.match(/^STACK_ROOT=(.+)/m);
        if (rootMatch && rootMatch[1].endsWith('/' + worktreeName)) {
          const portMatch = content.match(/^WT_FRONTEND_PORT=(\d+)/m);
          return portMatch ? parseInt(portMatch[1], 10) : null;
        }
      }
    } catch {}
  }
  return null;
}

async function countArtifacts(
  pwcliDir: string
): Promise<DiscoveredSession['artifacts']> {
  const result = { pageSnapshots: 0, screenshots: 0, consoleLogs: 0, networkLogs: 0 };
  try {
    const files = await fs.readdir(pwcliDir);
    for (const f of files) {
      if (f.startsWith('page-') && f.endsWith('.yml')) result.pageSnapshots++;
      else if (f.endsWith('.png')) result.screenshots++;
      else if (f.startsWith('console-') && f.endsWith('.log')) result.consoleLogs++;
      else if (f.startsWith('network-') && f.endsWith('.log')) result.networkLogs++;
    }
  } catch {}
  return result;
}
```

---

## 13. Recommendations

### Scanning Strategy

| Aspect | Recommendation |
|--------|---------------|
| **Discovery root** | Scan `AGENT_STACK_ROOT` + all dirs in `WORKTREES_DIR` + `backend/` subdirs |
| **Registry.tsv** | Use for port lookups only, NOT for worktree enumeration |
| **Session files** | Glob `**/*.session` within `.playwright-cli/sessions/` (both flat and hash-subdir layouts) |
| **Liveness** | Socket file existence → fast poll. Socket connection → confirm. CDP port → rich metadata. |
| **Polling interval** | 5-10 seconds for socket existence, 30-60 seconds for full CDP probe |
| **Staleness** | Compare `.session` file mtime and embedded `timestamp` field. Flag as stale if >1 hour old and no socket. |
| **Deduplication** | Group by `socketPath`. Most-recent `timestamp` wins for display. |
| **v1 sessions** | Include in inventory but mark as legacy. They lack CDP port and config. |
| **Output artifacts** | Count `page-*.yml` / `*.png` / `console-*.log` for activity indicators. Most recent file timestamp = last activity. |
| **Chrome user data** | Check for `ud-*-chrome/` dirs to know if session has persistent profile/auth. |

### What NOT to Scan
- Don't enumerate `ud-*-chrome/` directory contents (massive — hundreds of files per session)
- Don't parse output artifacts (`.yml`, `.log`) — just count and check timestamps
- Don't trust `registry.tsv` for active worktree enumeration
- Don't assume fixed CDP ports — always read from session file

### Watch Mode
For a real-time dashboard, use `fs.watch` on:
1. `<root>/.playwright-cli/sessions/` directories (new/removed `.session` files)
2. `/tmp/playwright-cli-sockets/<hash>/` (socket file creation/removal)
3. `<root>/.playwright-cli/` (new output artifacts for activity tracking)

---

## 14. Summary of Discrepancies vs Handoff Document

| Claim | Reality |
|-------|---------|
| Sessions in `<root>/.playwright-cli/sessions/<name>.session` | **Partially true.** v1 sessions are flat. v2 sessions are nested under a hex hash subdirectory. |
| Worktree registry is authoritative | **False.** Registry has stale entries and misses worktrees. Filesystem scan is required. |
| Socket files reliably indicate liveness | **True when present.** But socket files are cleaned up on daemon exit, so absence is definitive. |
| CDP port is in session config | **True for v2 only.** v1 (legacy) sessions don't have `resolvedConfig`. |
| Each worktree has independent sessions | **Partially true.** They have independent `.session` files and `userDataDir`, but share the daemon socket. Multiple `.session` files can reference the same daemon. |
| `backend/.env.worktree.runtime` has port info | **True** for worktrees that have been fully set up. Not all worktrees have this file. |
