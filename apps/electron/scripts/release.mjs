const message = `
[electron/release] Deprecated release entrypoint

This repository-level script is intentionally disabled.
It is unsafe for official desktop releases because it can bypass the guarded build-first,
draft-first flow and publish the wrong version or an incomplete updater asset set.

Use the project-scoped electron-release skill and the workflow in apps/electron/README.md.
Official cuts update both version.json and apps/electron/package.json together, then run one
complete final-SHA preflight. Packaging requires --expected-sha and --evidence from a clean
synchronized main or release/vMAJOR.MINOR.PATCH branch, with exact-SHA Windows dispatch and
registration before local macOS packaging.
`

console.error(message.trim())
process.exit(1)
