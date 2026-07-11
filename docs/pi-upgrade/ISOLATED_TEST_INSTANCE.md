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
2. Prepare the isolated data root with disk-space + overlap checks (preferred):

```bash
chmod +x scripts/pi-upgrade/prepare-isolated-data.sh
./scripts/pi-upgrade/prepare-isolated-data.sh pi-upgrade-0.80.6-safety
# optional full byte-faithful copy:
# FORGE_ISOLATED_COPY_FULL=1 ./scripts/pi-upgrade/prepare-isolated-data.sh pi-upgrade-0.80.6-safety
```

The prepare script:

- refuses destinations that resolve to, sit inside, or symlink-alias `~/.forge`
- checks free disk (`source size + 20 GiB` headroom by default)
- copies with `rsync -a` (permissions preserved; no hardlinks into production)
- sanitizes destination `runtime.lock` / root `*.pid` / `*.sock` so live PID/socket semantics are not reused
- verifies `auth.json` exists and is not world-readable / not the same inode as production

Never delete `~/.forge/runtime.lock` while production is running. `stop-isolated-instance.sh` only removes the lock under the isolated `FORGE_DATA_DIR`.

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

Start records the **actual TCP listener PID** (not the `pnpm` wrapper), validates wrapper ancestry + nonce + `FORGE_DATA_DIR`, and refuses occupied ports. Stop kills only that verified owned wrapper/listener tree.

**Never** use `vite preview` or a production UI build for worktree testing — only `vite dev` honors `VITE_FORGE_WS_URL`. UI ports above `47188` otherwise silently target production backend `47287`.

## Ignore safety

- `.env` is gitignored.
- Copied data lives under `~/.forge-worktree-*`, outside the worktree/repo.
- `.internal/` evidence logs are gitignored; committed docs under `docs/pi-upgrade/` contain no secrets.

## Frozen 0.71.1 rollback runner

Bidirectional session/downgrade proof needs an exact old SessionManager outside shipped deps:

```bash
./scripts/pi-upgrade/provision-pi-0711-rollback-runner.sh
# or:
pnpm pi-upgrade:provision-0711-runner
# optional override:
# export FORGE_PI_0711_SESSION_MANAGER_JS=/absolute/path/to/session-manager.js
```

The provisioner copies committed `scripts/pi-upgrade/pi-0711-rollback-runner/{package.json,package-lock.json}` and runs `npm ci` into `<worktree>/.forge/pi-upgrade-runners/0.71.1/...` (gitignored). The characterization gate hard-fails when the runner is absent or not `@mariozechner/pi-coding-agent@0.71.1`; it does not silently skip.

`pnpm quality:full` and the manual GitHub `quality` workflow (changed/full tiers) provision this runner before tests so the hermetic WP-8 gate is reproducible outside Adam-local machines.

Default rollback for release incidents remains **pre-upgrade data snapshot + old binary**. If in-place downgrade cannot be proven, fail the gate closed and retain snapshot + old binary. See [`BETA_RELEASE_RUNBOOK.md`](./BETA_RELEASE_RUNBOOK.md).

