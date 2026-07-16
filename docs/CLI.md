# Forge CLI

The Forge CLI is a first-party `forge` command for headless automation against a local Forge backend. It can inspect profiles and sessions, send messages, run one-shot automation, wait for quiescence, and answer pending choices.

## Install

### Desktop app

The desktop app bundles the CLI, so no separate Node.js install is required.

1. Open **Settings → CLI Access**.
2. Generate a CLI access key. Copy it immediately; the plaintext key is shown only once.
3. Click **Install CLI**. Forge installs a small user-local shim:
   - macOS/Linux: `~/.forge/bin/forge`
   - Windows: `%LOCALAPPDATA%\forge\bin\forge.cmd`
4. Add the shown bin directory to your shell `PATH` if Forge reports that it is not already present.

The desktop shim runs the packaged Forge app with `ELECTRON_RUN_AS_NODE=1` and the bundled CLI resource. It does not require ambient Node.js and does not store API keys.

### npm/dev install

For source builds or server deployments:

```bash
npm install -g @forge/cli
```

Requires Node.js 22.19.0 or newer.

Configure the backend URL and API key with environment variables or flags:

```bash
export FORGE_URL=http://127.0.0.1:47287
export FORGE_CLI_API_KEY=...
forge doctor
```

For local development, use the built workspace entrypoint directly:

```bash
pnpm --filter @forge/cli build
node packages/cli/dist/cli.js --version
```

## Authentication and safety

CLI keys are separate from provider credentials and are managed in **Settings → CLI Access**. Settings-generated keys are stored hash-only by the backend, can be revoked or rotated, and authenticate only the CLI HTTP/WebSocket surfaces.

Prefer `FORGE_CLI_API_KEY` or `--api-key` for automation. `forge config set apiKey <key>` is available for convenience, but it stores the key as plaintext local config and should be treated as restricted local data.

Desktop Forge may bind the backend for LAN/Tailscale access. Anyone who can reach the backend and has a CLI key can control the CLI API, so rotate keys if they are shared accidentally and revoke keys that are no longer needed.

## Common commands

```bash
forge status
forge doctor
forge profiles list
forge sessions list --profile <profileId>
forge sessions create --profile <profileId> --label "CLI task"
forge sessions send <agentId> --message "Summarize the current repo state"
forge sessions transcript <agentId> --limit 50
forge sessions smart-compact <agentId> --json
forge run --profile <profileId> --message "Run the requested automation" --json
forge launch --profile <profileId> --message @prompt.md
forge wait <agentId> --timeout 10m --stop-on-timeout
forge choices list --session <agentId>
forge choices answer <choiceId> --answers '[{"questionId":"q1","selectedOptionIds":["yes"]}]' --session <agentId>
```

Use `--json` for stable machine-readable output. Data commands such as `status`, `doctor`, `run`, `launch`, `wait`, and mutation commands write one final JSON object when `--json` is set; `--help` and `--version` still print plain text.

Durations accept milliseconds by default or `ms`, `s`, and `m` suffixes. Examples: `5000`, `30s`, `10m`.

## Session transcripts

`forge sessions transcript <agentId>` prints a chronological, user-facing transcript by default: user inputs plus manager-visible assistant output, including normal final replies projected as `assistant_output` and explicit routed deliveries sent through `speak_to_user`. Add `--include-worker-updates` to include worker results returned to the manager. Use `--limit <n>` and `--offset <n>` for pagination, or `--json` for the stable `CliSessionTranscriptResponse` payload.

## Session compaction

`forge sessions compact <agentId> [--instructions <text>]` triggers manual context compaction for a manager session. `forge sessions smart-compact <agentId> [--instructions <text>]` asks the runtime to compact only when useful. Both commands use first-class CLI WebSocket commands, not slash-command wrapping.

The CLI waits for the backend compaction mutation to finish or fail, then prints the normalized result. JSON output includes `action`, `sessionAgentId`, `profileId` when available, `outcome` (`compacted`, `skipped`, or `not_reduced`), `compacted`, `reason` when no compaction happened, `customInstructionsProvided`, and `completedAt`. Human output prints the same compact summary. Context before/after values are shown only if the server includes them.

Compaction is Builder-runtime-only in v1 and requires the server to advertise the `sessionCompaction` capability. Older servers, collaboration runtimes, worker sessions, and runtime providers that do not support compaction return stable unsupported or usage errors instead of falling back to slash commands. If the CLI WebSocket disconnects before the request result arrives, the CLI exits with the connection error code and does not infer whether compaction continued server-side.

## Run semantics

`forge run` sends a CLI-attributed user message and waits for strict session quiescence. The wait checks manager status, pending counts, active workers, active tools, pending choices, and a short debounce window. If a choice blocks the session, the command exits with the blocked-choice exit code instead of guessing an answer.

`forge launch` sends the message and returns after dispatch acknowledgement. Use `forge wait <agentId>` later to wait for completion.

`--stop-on-timeout` sends a stop request after a timeout and waits for the acknowledgement. When the timeout path requests a stop, the CLI includes `stoppedOnTimeout: true` in the final result. Without it, timeout leaves the session running.

## Exit codes

The CLI uses stable non-zero exit codes for automation.

| Code | Name | Meaning |
| --- | --- | --- |
| 0 | success | Command completed successfully |
| 10 | blocked | A pending choice blocked the run |
| 11 | timeout | Timeout waiting for quiescence |
| 12 | agentFailure | The session ended in an agent failure state |
| 13 | canceled | The session or command was canceled |
| 20 | usage | Invalid input, missing required config, or a destructive command missing `--yes` |
| 21 | auth | The backend rejected the supplied CLI key or bearer token |
| 22 | connection | Network or transport failure |
| 23 | unsupported | Server/capability mismatch |

A missing CLI API key is a usage/configuration error (`20`). A configured key that the backend rejects is an auth failure (`21`).

Use `forge doctor --json` to diagnose URL, key, and advertised capability issues.

## Validation notes for contributors

Before landing CLI changes, run the repository validation suite plus CLI packaging checks:

```bash
pnpm lint
pnpm exec knip
pnpm test
cd apps/backend && pnpm exec tsc -p tsconfig.build.json --noEmit
cd apps/ui && pnpm exec tsc --noEmit
cd ../../packages/protocol && pnpm exec tsc -p tsconfig.build.json --noEmit
cd ../cli && pnpm exec tsc -p tsconfig.build.json --noEmit
pnpm run test:pack-clean
cd ../../apps/electron && pnpm exec tsc --noEmit
pnpm run build:all
```

Runtime smoke must use an isolated `FORGE_DATA_DIR`; do not point validation at production `~/.forge` or `~/.middleman`. If a packaged Electron smoke is not possible in the current environment, document the exact remaining manual steps: package the app, install the CLI shim from Settings, run `forge --version`, run `forge doctor` with a test key, then run a short `forge launch` + `forge wait` flow against isolated data.
