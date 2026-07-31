# Local Quality Checks

Forge uses an explicit, manual quality workflow. Quality tiers are not run automatically by git hooks, and `.github/workflows/quality.yml` runs only when manually dispatched. The mandatory Secure Sessions gate is separate.

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
- Help-content edits are routed to `pnpm help:validate`; `pnpm help:validate:migration` is reserved for one-time migration baseline fidelity checks, not normal authoring.

## Required Secure Sessions gate

`.github/workflows/secure-sessions.yml` runs the mandatory `secure-container-e2e` job on a Linux runner. It validates the shared Linux-guest container security path used by supported macOS and Windows Docker Desktop hosts; it is not Linux Desktop packaging or Linux Desktop support coverage. Keep this security gate distinct from the supported macOS/Windows Desktop packaging and release gates.

By default reports are written to `.forge/quality/latest.json`, which is ignored by git. Use `--no-write` for smoke checks that should not create artifacts, or `--output <path>` to write somewhere else.

## Git hooks

The repository includes optional safety hooks in `.githooks/`. They are only active if you opt in with:

```bash
git config core.hooksPath .githooks
```

When enabled, `pre-push` and `pre-merge-commit` run `pnpm quality:changed` only for protected-branch push/merge paths. Set `FORGE_SKIP_LOCAL_QUALITY=1` to bypass with an explicit warning.

## GitHub workflow

`.github/workflows/quality.yml` is `workflow_dispatch` only. Pick `quick`, `changed`, or `full` in the Actions UI and optionally provide a base ref for changed-file routing.
