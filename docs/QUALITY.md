# Local Quality Checks

Forge uses an explicit, manual quality workflow. Quality checks are not run automatically by git hooks and the GitHub workflow only runs when manually dispatched.

## Commands

```bash
pnpm quality:quick [-- --json] [-- --no-write]
pnpm quality:changed [-- --base origin/main]
pnpm quality:full
pnpm quality:report
```

- `quality:quick` lints changed JS/TS files, runs routed typechecks, and runs changed Vitest files when they can be mapped to a workspace.
- `quality:changed` runs conservative workspace-level lint, typecheck, and tests for affected areas.
- `quality:full` runs the repo gate: lint, knip, tests, all workspace typechecks (including Electron), and build.
- `quality:report` prints the latest `.forge/quality/latest.json` report.

By default reports are written to `.forge/quality/latest.json`, which is ignored by git. Use `--no-write` for smoke checks that should not create artifacts, or `--output <path>` to write somewhere else.

## Git hooks

The repository includes optional safety hooks in `.githooks/`. They are only active if you opt in with:

```bash
git config core.hooksPath .githooks
```

When enabled, `pre-push` and `pre-merge-commit` run `pnpm quality:changed` only for protected-branch push/merge paths. Set `FORGE_SKIP_LOCAL_QUALITY=1` to bypass with an explicit warning.

## GitHub workflow

`.github/workflows/quality.yml` is `workflow_dispatch` only. Pick `quick`, `changed`, or `full` in the Actions UI and optionally provide a base ref for changed-file routing.
