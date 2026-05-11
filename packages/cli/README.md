# @forge/cli

First-party Forge command-line interface for headless automation.

P7 provides the publishable package skeleton, local config, authenticated read client, and read-only commands. Mutation, run/wait, and desktop shim behavior land in later phases.

The built CLI entrypoint is bundled to `dist/cli.js`. `@forge/protocol` is used as a workspace type source during development but is intentionally not a published/runtime dependency.

## Install

```bash
npm install -g @forge/cli
```

Requires Node.js 22 or newer.

## Configure

Prefer environment variables for automation:

```bash
export FORGE_URL=http://127.0.0.1:47287
export FORGE_CLI_API_KEY=...
forge status
```

Local config is stored in the user Forge config directory and may contain a plaintext API key. Treat it as restricted local data.
