# Cortex Memory v2 — Safe Isolated Harness Plan

## Scope
Build an execution-safe harness for two scenarios without touching production data (`~/.middleman`):
- **migrate**: `/Users/adam/.middleman-cortex-memory-v2-migrate`
- **fresh**: `/Users/adam/.middleman-cortex-memory-v2-fresh`

## Safety Rules (hard requirements)
1. Run only from worktree: `/Users/adam/repos/middleman-worktrees/cortex-memory-v2`.
2. Always set `MIDDLEMAN_DATA_DIR` explicitly to one of the two isolated dirs.
3. Never run scripts that read/copy `~/.middleman` in this lane.
4. Use dedicated non-default ports so no accidental cross-connection.
5. Bake UI WS URL per scenario using `VITE_MIDDLEMAN_WS_URL` during `pnpm build`.

## Canonical Harness Config

| Scenario | Backend | UI | WS URL baked into UI build | Data dir |
|---|---:|---:|---|---|
| migrate | 47387 | 47389 | `ws://127.0.0.1:47387` | `/Users/adam/.middleman-cortex-memory-v2-migrate` |
| fresh | 47487 | 47489 | `ws://127.0.0.1:47487` | `/Users/adam/.middleman-cortex-memory-v2-fresh` |

## Preflight (both scenarios)
```bash
cd /Users/adam/repos/middleman-worktrees/cortex-memory-v2
pnpm install

# kill only harness ports if occupied
for p in 47387 47389 47487 47489; do lsof -ti :$p | xargs kill -9 2>/dev/null || true; done

# verify target dirs exist (fresh may be emptied later)
mkdir -p /Users/adam/.middleman-cortex-memory-v2-migrate
mkdir -p /Users/adam/.middleman-cortex-memory-v2-fresh
```

## Scenario A — Existing-data migrate harness

### A1) Data-dir guard
```bash
test -d /Users/adam/.middleman-cortex-memory-v2-migrate
# optional sanity: ensure this is not empty for migration coverage
find /Users/adam/.middleman-cortex-memory-v2-migrate -mindepth 1 -maxdepth 2 | head
```

### A2) Build UI pinned to migrate backend
```bash
cd /Users/adam/repos/middleman-worktrees/cortex-memory-v2
VITE_MIDDLEMAN_WS_URL=ws://127.0.0.1:47387 pnpm build
```

### A3) Start backend (isolated)
```bash
cd /Users/adam/repos/middleman-worktrees/cortex-memory-v2
MIDDLEMAN_HOST=127.0.0.1 \
MIDDLEMAN_PORT=47387 \
MIDDLEMAN_DATA_DIR=/Users/adam/.middleman-cortex-memory-v2-migrate \
NODE_ENV=production \
pnpm --filter @middleman/backend start
```

### A4) Start UI preview (isolated)
```bash
cd /Users/adam/repos/middleman-worktrees/cortex-memory-v2/apps/ui
MIDDLEMAN_HOST=127.0.0.1 pnpm exec vite preview --host 127.0.0.1 --port 47389 --strictPort
```

### A5) Smoke checks
- Open `http://127.0.0.1:47389`
- Confirm backend reachable on `ws://127.0.0.1:47387`
- Confirm existing sessions load
- Exercise Cortex scan + memory behavior checks

### A6) Stop
Ctrl+C in both terminals, then verify ports cleared:
```bash
for p in 47387 47389; do lsof -iTCP:$p -sTCP:LISTEN || true; done
```

## Scenario B — Net-new fresh harness

### B1) Reset to empty
```bash
rm -rf /Users/adam/.middleman-cortex-memory-v2-fresh
mkdir -p /Users/adam/.middleman-cortex-memory-v2-fresh
```

### B2) Build UI pinned to fresh backend
```bash
cd /Users/adam/repos/middleman-worktrees/cortex-memory-v2
VITE_MIDDLEMAN_WS_URL=ws://127.0.0.1:47487 pnpm build
```

### B3) Start backend (isolated)
```bash
cd /Users/adam/repos/middleman-worktrees/cortex-memory-v2
MIDDLEMAN_HOST=127.0.0.1 \
MIDDLEMAN_PORT=47487 \
MIDDLEMAN_DATA_DIR=/Users/adam/.middleman-cortex-memory-v2-fresh \
NODE_ENV=production \
pnpm --filter @middleman/backend start
```

### B4) Start UI preview (isolated)
```bash
cd /Users/adam/repos/middleman-worktrees/cortex-memory-v2/apps/ui
MIDDLEMAN_HOST=127.0.0.1 pnpm exec vite preview --host 127.0.0.1 --port 47489 --strictPort
```

### B5) Smoke checks
- Open `http://127.0.0.1:47489`
- Create first manager/session
- Send a message and verify response
- Confirm expected new directory/file creation under fresh dir
- Confirm no dependency on legacy profile-knowledge blobs

### B6) Stop
Ctrl+C in both terminals, then verify ports cleared:
```bash
for p in 47487 47489; do lsof -iTCP:$p -sTCP:LISTEN || true; done
```

## Script Gap Analysis (current `scripts/test-*`)

1. **Hardcoded data dir (`~/.middleman-dev`)**
   - `test-instance.sh`, `test-reset.sh`, `test-rebuild.sh` cannot target migrate/fresh dirs.
2. **Unsafe live-data coupling**
   - `test-instance.sh` and `test-reset.sh` read/copy from `~/.middleman` (forbidden in this harness lane).
3. **Single fixed port pair only (47387/47389)**
   - Cannot run/compare migrate and fresh harnesses independently without manual script edits.
4. **Shared fixed PID/log paths**
   - No scenario-specific PID/log isolation.
5. **README drift**
   - `scripts/README.md` claims `MIDDLEMAN_TEST_DATA_DIR` override, but scripts do not implement it.

## Minimal Script Improvements Needed
1. Add env overrides with safe defaults:
   - `MIDDLEMAN_TEST_DATA_DIR`
   - `MIDDLEMAN_TEST_SOURCE_DATA_DIR` (optional; default empty)
   - `MIDDLEMAN_TEST_BACKEND_PORT`
   - `MIDDLEMAN_TEST_UI_PORT`
   - `MIDDLEMAN_TEST_PID_FILE`
2. Add explicit `--no-copy-live` / `MIDDLEMAN_TEST_NO_LIVE_COPY=1` mode.
3. Update `test-reset.sh` to support `--empty` (fresh) and `--restore-from <seed-dir>` modes.
4. Update `scripts/README.md` to match actual implemented flags/env.

## Recommended Immediate Usage
Until scripts are patched, use the explicit command flows above (A/B) for safe execution in this lane.
