# @forge/cli

First-party Forge command-line interface for headless automation.

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

## Commands

Read-only commands:

```bash
forge status
forge doctor
forge profiles list
forge profiles show <profileId>
forge sessions list --profile <profileId>
forge sessions show <agentId>
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
