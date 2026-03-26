# Integrated Terminals Test Environment (Isolated Worktree)

This worktree is configured to run a fully isolated Forge instance for terminal testing.
**Never use this setup with production data in `~/.forge` or production ports.**

## 1) Configuration files reviewed
- Backend config reads:
  - `apps/backend/src/index.ts` + `apps/backend/src/config.ts`
  - `FORGE_HOST` default `127.0.0.1`
  - `FORGE_PORT` default `47187` (dev), overridable via env
  - `FORGE_DATA_DIR` default `~/.forge`, overridable via env
- UI dev server config:
  - `apps/ui/vite.config.ts` (port is hard-coded in npm script unless overridden from CLI)
- Env reference:
  - `.env.example`

## 2) Isolated data directory
Created:
- `FORGE_DATA_DIR=/Users/adam/.forge-terminal-test`

This is a fresh, empty directory:
```bash
mkdir -p /Users/adam/.forge-terminal-test
```

## 3) Test environment file
Use this file in the worktree root:

- `/.env.test`
```bash
FORGE_HOST=127.0.0.1
FORGE_PORT=47387
FORGE_DATA_DIR=/Users/adam/.forge-terminal-test
VITE_FORGE_WS_URL=ws://127.0.0.1:47387
FORGE_TERMINAL_ENABLED=true
```

## 4) Build
Already built in this worktree:
```bash
cd /Users/adam/repos/middleman-integrated-terminals
pnpm build
```

## 5) Startup commands (non-conflicting ports)
Use a backend on **47387** and UI on **47388**.

### Option A (recommended, one command)
```bash
cd /Users/adam/repos/middleman-integrated-terminals
source .env.test
concurrently --names backend,ui --kill-others-on-fail \
  "FORGE_HOST=$FORGE_HOST FORGE_PORT=$FORGE_PORT FORGE_DATA_DIR=$FORGE_DATA_DIR pnpm --filter @forge/backend dev" \
  "VITE_FORGE_WS_URL=$VITE_FORGE_WS_URL pnpm --filter @forge/ui dev -- --host $FORGE_HOST --port 47388 --strictPort"
```

### Option B (script)
```bash
cd /Users/adam/repos/middleman-integrated-terminals
./scripts/start-terminal-test-env.sh
```

### Option C (manual, two terminals)
**Terminal 1 (backend):**
```bash
cd /Users/adam/repos/middleman-integrated-terminals
source .env.test
FORGE_HOST=127.0.0.1 FORGE_PORT=47387 FORGE_DATA_DIR=/Users/adam/.forge-terminal-test pnpm --filter @forge/backend dev
```

**Terminal 2 (UI):**
```bash
cd /Users/adam/repos/middleman-integrated-terminals
source .env.test
pnpm --filter @forge/ui dev -- --host 127.0.0.1 --port 47388 --strictPort
```

Then open:
- `http://127.0.0.1:47388`

## 6) Stop commands
- If started manually: `Ctrl+C` each terminal.
- If using script: `Ctrl+C` in the script terminal (kills both).

## 7) Port conflict check
Use this before starting:
```bash
lsof -iTCP -sTCP:LISTEN -nP | rg ":(47187|47188|47287|47189|47387|47388) "
```

Verified at setup time:
- `47187` / `47188` / `47287` / `47189` may be used by other running Forge instances.
- `47387` and `47388` were free.

## 8) Terminal smoke test checklist
Run this against the isolated UI on `http://127.0.0.1:47388`:
1. Create a new manager session.
2. Open terminal panel (`Ctrl/Cmd + \``).
3. Verify terminal auto-creates and shows a shell prompt.
4. Type shell commands and verify output.
5. Create a second terminal tab.
6. Switch between tabs.
7. Rename a terminal (double-click tab).
8. Close a terminal.
9. Resize the panel via drag handle.
10. Maximize/minimize the terminal panel.
11. Verify keyboard shortcuts (e.g. focus toggles, copy/paste, tab navigation).
12. Stop backend, restart backend, reload UI, and verify terminal state restores (scrollback + fresh shell prompt).
13. Validate terminal works with a long-running command:
   - `ping localhost`
   - or `top` (exit cleanly after verifying output)

## 9) Sanity reminders
- This uses isolated storage only: `/Users/adam/.forge-terminal-test`.
- Backend and UI are intentionally not running on prod/dev defaults.
- Do **not** run this against production ports or read/write `~/.forge` data.
