# Multi-Session Testing Guide (Isolated Test Instance)

## Overview

Multi-Session work must be tested without risking the live Middleman instance.

This guide uses a **fully isolated test environment**:

- **Separate source tree**: `/Users/adam/repos/middleman-multi-session`
- **Separate data directory**: `~/.middleman-dev`
- **Separate ports**: backend `47387`, UI `47389`

This keeps the live instance (`/Users/adam/repos/middleman` + `~/.middleman`) untouched.

---

## Quick Start

From `/Users/adam/repos/middleman-multi-session`:

```bash
./scripts/test-instance.sh
```

What it does:
1. Sets test env vars (`MIDDLEMAN_DATA_DIR`, `MIDDLEMAN_PORT`, `VITE_MIDDLEMAN_WS_URL`)
2. Copies `~/.middleman` to `~/.middleman-dev` if needed (prompted)
3. Runs `pnpm build`
4. Starts backend + UI preview on test ports

Access URLs:
- Backend: `http://127.0.0.1:47387`
- UI: `http://127.0.0.1:47389`

Stop the test instance:
- Press `Ctrl+C` in the terminal running `test-instance.sh`

Reset and refresh test data:

```bash
./scripts/test-reset.sh
```

---

## Test Environment Details

### Port mapping (live vs test)

| Surface | Live (main repo) | Test (worktree) |
|---|---|---|
| Backend HTTP/WS | `47187` (dev), `47287` (prod) | `47387` |
| UI | `47188` (dev), `47289` (prod preview) | `47389` (prod preview) |
| UI → Backend WS target | `ws://127.0.0.1:47187` (dev) / `ws://127.0.0.1:47287` (prod) | `ws://127.0.0.1:47387` |

### Data directory mapping

- Live data: `~/.middleman`
- Test data: `~/.middleman-dev`

### What gets copied vs isolated

- `test-instance.sh` can copy live data into `~/.middleman-dev` once for realistic testing.
- After that, all writes stay inside `~/.middleman-dev`.
- Live data in `~/.middleman` is **read-only source for cloning**, never overwritten by these scripts.

---

## Testing Workflow

1. **(Optional) Reset test data to a fresh clone**
   ```bash
   ./scripts/test-reset.sh
   ```
2. **Start isolated test instance**
   ```bash
   ./scripts/test-instance.sh
   ```
3. **Run feature tests** in the test UI (`http://127.0.0.1:47389`)
4. **Report bugs to the manager agent** with:
   - exact repro steps
   - expected vs actual behavior
   - affected session/profile IDs (if relevant)
   - screenshots/log snippets
5. Repeat as needed; use `test-reset.sh` between clean-slate test cycles.

---

## Troubleshooting

### Port conflicts

Symptom:
- Script reports port `47387` or `47389` is already in use.

Fix:
- Stop the conflicting process (the script prints listener info).
- Re-run:
  ```bash
  ./scripts/test-instance.sh
  ```

### Data directory issues

Symptom:
- `~/.middleman-dev` is stale/corrupt or missing expected state.

Fix:
- Rebuild test data from live snapshot:
  ```bash
  ./scripts/test-reset.sh
  ```

### Build failures

Symptom:
- `pnpm build` fails inside `test-instance.sh`.

Fix:
- Run build manually from the worktree for full diagnostics:
  ```bash
  pnpm build
  ```
- Resolve the reported error, then restart `test-instance.sh`.

---

## Test Instance vs Live Instance

| Aspect | Live | Test |
|--------|------|------|
| Source | `/Users/adam/repos/middleman` | `/Users/adam/repos/middleman-multi-session` |
| Data | `~/.middleman` | `~/.middleman-dev` |
| Backend port | `47187` (dev) / `47287` (prod) | `47387` |
| UI port | `47188` (dev) / `47289` (prod preview) | `47389` |

**Safety guarantee:** when using these scripts from the worktree, your live instance is not affected.
