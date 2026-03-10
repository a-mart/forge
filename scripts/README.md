# Scripts

## Windows compatibility

Middleman's runtime-critical Node scripts are Windows-aware:

- `scripts/prod-daemon.mjs`
- `scripts/prod-daemon-restart.mjs`

These are used by:

- `pnpm prod:daemon`
- `pnpm prod:restart`

## POSIX-only scripts

The following shell scripts still require a POSIX-compatible shell (`bash`):

- `scripts/cutover-to-main.sh`
- `scripts/test-instance.sh`
- `scripts/test-rebuild.sh`
- `scripts/test-reset.sh`
- `scripts/test-run.sh`

On Windows, run them from one of:

- **WSL2**
- **Git Bash**
- another POSIX-compatible shell environment

These scripts are developer tooling only; they are not required to run the core app on Windows.

## Validation / migration helpers

`scripts/validate-migration.ts` is a developer-focused helper and may contain machine-specific defaults.

You can override its source data directory with:

- `MIDDLEMAN_TEST_DATA_DIR`
