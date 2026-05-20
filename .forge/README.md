# Forge project resources

This directory contains shared, agent-facing resources for this repository.

- `skills/`: project skills that agents can use as workflow instructions.
- `specialists/`: project-specific specialist definitions.
- `reference/`: passive markdown context and repository notes.
- `extensions/`: Forge extensions. These are executable and require trust. If they rewrite shell commands, quote or escape injected output before it reaches `bash`.
- `pi/extensions/` and `pi/settings.json`: Pi extensions and package config. These are executable and require trust. For smoke tests and custom tools, list repo Pi extensions explicitly in `pi/settings.json` so loading stays deterministic.
- Keep test tools deterministic and harmless.

Keep secrets, credentials, build outputs, and runtime state out of this directory. Passive resources are readable as context; executable resources are loaded only after the repo-root `.forge` directory is trusted in Forge.
