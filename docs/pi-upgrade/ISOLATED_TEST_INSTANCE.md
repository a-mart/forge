# Isolated Pi upgrade test instance

**Purpose:** Reproducible, fail-closed launcher for Pi 0.80.6 upgrade work without touching the production Forge instance or `~/.forge`.

## This worktree

| Item | Value |
|------|-------|
| Branch | `pi-upgrade-0.80.6-safety` |
| Worktree | `~/worktrees/pi-upgrade-0.80.6-safety` |
| Data copy | `~/.forge-worktree-pi-upgrade-0.80.6-safety` (outside git) |
| Backend | `127.0.0.1:47687` |
| UI | `127.0.0.1:47688` |
| WS | `ws://127.0.0.1:47687` via `VITE_FORGE_WS_URL` |

Production Electron remains on `47287`. Default worktree ports `47387/47388` were avoided because Docker already listens on `47387`.

## Guardrails

`scripts/pi-upgrade/assert-isolation.mjs` refuses to proceed when:

- `FORGE_DATA_DIR` resolves to production `~/.forge` (or a symlink to it)
- `FORGE_PORT` is `47187`, `47287`, or `47387`
- UI port is `47188`, `47189`, or `47388`
- `VITE_FORGE_WS_URL` does not exactly match the isolated backend port
- Isolated `shared/config/auth/auth.json` is missing or world-readable

Secrets are never printed. Auth presence/mode only.

## Setup

1. Create the worktree/branch (already done for this milestone).
2. Copy production data **outside** the repo:

```bash
rsync -a \
  --exclude 'shared/cache/' \
  --exclude 'uploads/' \
  --exclude '**/terminals/*/delta.ndjson' \
  --exclude '**/terminals/*/snapshot.vt' \
  "$HOME/.forge/" "$HOME/.forge-worktree-pi-upgrade-0.80.6-safety/"
```

Preserve permissions (`rsync -a`). Verify `auth.json` remains mode `600`.

**After copy, delete the production runtime lock from the isolated tree** so the worktree backend can start:

```bash
rm -f "$HOME/.forge-worktree-pi-upgrade-0.80.6-safety/runtime.lock"
```

Never delete `~/.forge/runtime.lock` while production is running.

3. Worktree `.env` (gitignored):

```bash
FORGE_HOST=127.0.0.1
FORGE_PORT=47687
FORGE_DATA_DIR=$HOME/.forge-worktree-pi-upgrade-0.80.6-safety
VITE_FORGE_WS_URL=ws://127.0.0.1:47687
FORGE_PLAYWRIGHT_DASHBOARD_ENABLED=false
```

4. Prove isolation:

```bash
cd ~/worktrees/pi-upgrade-0.80.6-safety
set -a && source .env && set +a
node scripts/pi-upgrade/assert-isolation.mjs
```

**Proxy note:** If the host injects Socket Firewall `HTTP(S)_PROXY`, clear those vars before live provider E2E (the launcher does this). Health checks use `curl --noproxy '*'`.

## Start / stop

```bash
chmod +x scripts/pi-upgrade/*.sh
./scripts/pi-upgrade/start-isolated-instance.sh
# UI: http://127.0.0.1:47688
./scripts/pi-upgrade/stop-isolated-instance.sh
```

**Never** use `vite preview` or a production UI build for worktree testing — only `vite dev` honors `VITE_FORGE_WS_URL`. UI ports above `47188` otherwise silently target production backend `47287`.

## Ignore safety

- `.env` is gitignored.
- Copied data lives under `~/.forge-worktree-*`, outside the worktree/repo.
- `.internal/` evidence logs are gitignored; committed docs under `docs/pi-upgrade/` contain no secrets.
