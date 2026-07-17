# Forge Resource Smoke Reference

This is a safe, test-only reference document for validating repo-root `.forge/reference/` discovery and loading.

## Validation facts

- Validation token: `FRSR-2026-05-20`
- Skill expected phrase: `forge-resource-smoke-skill called`
- Pi extension tool name: `forge_resource_smoke_pi_tool`
- Pi extension expected tool result: `forge-resource-smoke-pi-extension tool called; token FRSR-2026-05-20`
- Forge extension probe command: `echo forge-resource-smoke-extension-probe`
- Forge extension expected output: `forge-resource-smoke-extension observed; token FRSR-2026-05-20`

## Expected behavior

These fixtures are deliberately harmless and easy to delete. They should only be used for smoke tests of repo-root `.forge` resource discovery, trust, loading, and invocation.
