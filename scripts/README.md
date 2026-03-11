# Scripts

Helper scripts for running and managing Middleman.

## Cross-Platform (Windows, macOS, Linux)

These Node.js scripts work on all platforms:

| Script | Used by | Description |
|--------|---------|-------------|
| `prod-daemon.mjs` | `pnpm prod:daemon` | Start Middleman as a background daemon |
| `prod-daemon-restart.mjs` | `pnpm prod:restart` | Restart a running daemon |
| `prod-daemon-ipc.mjs` | (internal) | IPC helper for daemon lifecycle |

## POSIX-Only (macOS, Linux, WSL)

These shell scripts require `bash` and are **not required** to run the app:

| Script | Description |
|--------|-------------|
| `cutover-to-main.sh` | Merge workflow helper for cutting a branch to main |
| `test-instance.sh` | Spin up an isolated test instance |
| `test-rebuild.sh` | Rebuild and restart a test instance |
| `test-reset.sh` | Reset test instance data |
| `test-run.sh` | Run a test instance |

On Windows, run these from **WSL2** or **Git Bash**.

## Development Helpers

| Script | Description |
|--------|-------------|
| `validate-migration.ts` | Validate data directory migration (developer tool) |

Override the source data directory with `MIDDLEMAN_TEST_DATA_DIR` if needed.
