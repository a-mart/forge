# Forge Extensions

Forge Extensions are a Forge-native hook system for local automation and policy enforcement.

They are **separate from Pi extensions/packages**:
- **Forge Extensions** use Forge hook events like session lifecycle, tool interception, runtime errors, and versioning commits.
- **Pi extensions/packages** use Pi's own runtime extension/package system.

## Discovery directories

Forge discovers extensions from these locations:
- Global: `${FORGE_DATA_DIR}/extensions/`
- Profile: `${FORGE_DATA_DIR}/profiles/<profileId>/extensions/`
- Project-local: `<cwd>/.forge/extensions/`

Forge auto-creates the global and profile directories. It does **not** auto-create project-local directories.

## Security warning

Forge extensions run local code inside your Forge backend process. Only install or author extensions you trust.

## Status

This document is a Phase 1 stub so the Settings page can link somewhere valid.

Full authoring and hook documentation lands in Phase 4.
