# @forge/cli

First-party Forge command-line interface for headless automation.

The built CLI entrypoint is bundled to `dist/cli.js`. `@forge/protocol` is used as a workspace type source during development but is intentionally not a published/runtime dependency.

## Install

For npm/dev installs:

```bash
npm install -g @forge/cli
```

Requires Node.js 22.19.0 or newer.

Forge Desktop bundles the CLI. Desktop users should open **Settings → CLI Access**, generate a key, and click **Install CLI**. The installed shim uses the packaged app runtime and does not require a separate Node.js install.

## Configure

Prefer environment variables for automation:

```bash
export FORGE_URL=http://127.0.0.1:47287
export FORGE_CLI_API_KEY=...
forge status
```

CLI access keys are managed in **Settings → CLI Access**. They are separate from model-provider credentials, are stored hash-only by the backend, and can be revoked or rotated at any time.

Local config is stored in the user Forge config directory and may contain a plaintext API key. Treat it as restricted local data and prefer `FORGE_CLI_API_KEY` or `--api-key` in scripts.

## Commands

Read-only commands:

```bash
forge status
forge doctor
forge profiles list
forge profiles show <profileId>
forge sessions list --profile <profileId>
forge sessions show <agentId>
forge sessions transcript <agentId> [--include-worker-updates] [--limit <n>] [--offset <n>]
forge agents list [--profile <profileId>]
forge agents show <agentId>
forge project-agents list --profile <profileId>
forge project-agents show --profile <profileId> <handle>
forge choices list [--session <agentId>] [--profile <profileId>]
forge choices show <choiceId> [--session <agentId>]
```

Mutation and automation commands:

```bash
forge sessions create --profile <profileId> [--label <label>] [--name <name>]
forge sessions send <agentId> --message <text|@file>
forge sessions wait <agentId> [--timeout <duration>] [--stop-on-timeout]
forge sessions stop|resume <agentId>
forge sessions fork <agentId> [--label <label>] [--from-message-id <messageId>]
forge sessions compact <agentId> [--instructions <text>]
forge sessions smart-compact <agentId> [--instructions <text>]
forge sessions rename <agentId> --label <label>
forge sessions pin|unpin <agentId> [--pinned true|false]
forge sessions clear|delete <agentId> --yes
forge project-agents send --profile <profileId> <handle> --message <text|@file>
forge choices answer <choiceId> --answers <json> [--session <agentId>]
forge choices cancel <choiceId> [--session <agentId>]
forge launch (--session <agentId> | --profile <profileId> [--project-agent <handle>]) --message <text|@file>
forge run (--session <agentId> | --profile <profileId> [--project-agent <handle>]) --message <text|@file> [--timeout <duration>] [--stop-on-timeout]
forge wait <agentId> [--timeout <duration>] [--stop-on-timeout]
```

Durations accept milliseconds by default, or `ms`, `s`, and `m` suffixes.

Compaction commands use first-class CLI WebSocket mutations. They do not wrap slash commands. `sessions compact` waits for manual compaction to finish or fail. `sessions smart-compact` waits for the runtime smart-compaction decision and returns `outcome: "compacted"`, `"skipped"`, or `"not_reduced"`. Both commands require a Builder runtime that advertises `sessionCompaction`; old servers and runtime providers without compaction support return exit code 23, while invalid or unsupported session targets return typed usage errors.

## Automation notes

`forge run` sends a CLI-attributed message and waits for strict quiescence: idle manager, no pending count, no streaming workers, no active tools, no pending choices, and a debounce window without new session activity. `forge launch` returns after dispatch acknowledgement; use `forge wait <agentId>` later to wait for completion.

Use `--json` for stable machine-readable output. For more detail, see the repository docs at `docs/CLI.md`.
