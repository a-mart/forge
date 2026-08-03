# Scripts

Repository helper scripts invoked by root `pnpm` commands. Prefer those commands over running a script directly unless the script documents a standalone workflow.

## Cross-platform (Windows, macOS, Linux)

| Script | Normal command | Description |
| --- | --- | --- |
| `dev-electron.mjs` | `pnpm dev:electron` | Starts the Electron development launcher, UI, local backend, and required Stream Deck/browser preparation. |
| `prod-daemon.mjs` | `pnpm prod:daemon` | Starts Forge as a background daemon. |
| `prod-daemon-restart.mjs` | `pnpm prod:restart` | Restarts a running daemon. |
| `prod-daemon-ipc.mjs` | internal | IPC helper for daemon lifecycle. |
| `model-catalog-audit.mjs` | `pnpm model-catalog:audit` | Compares curated Forge catalog metadata with the installed Pi upstream catalog. |
| `validate-help-content.mjs` | `pnpm help:validate` | Validates in-app help imports, metadata, links, and Markdown structure. |

Use [`docs/QUALITY.md`](../docs/QUALITY.md) for the supported validation tiers. `pnpm help:validate:migration` adds migration-fidelity checks and is not the normal permanent help validation command.

## POSIX-only (macOS, Linux, WSL)

These shell scripts require `bash` and are not required to run Forge:

| Script | Description |
| --- | --- |
| `test-instance.sh` | Starts an isolated test instance. |
| `test-rebuild.sh` | Rebuilds and restarts a test instance. |
| `test-reset.sh` | Resets test-instance data. |

On Windows, run POSIX-only scripts from **WSL2** or **Git Bash**. Set `FORGE_TEST_DATA_DIR` to override the source data directory when a script supports it.
