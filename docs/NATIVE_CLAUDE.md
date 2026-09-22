# Native Claude managers

Choose **Claude native** in a local Builder manager's model selector. This uses the
Claude Agent SDK and its matched native Claude Code executable. Claude owns its
coding tools, agent loop, and context management; Forge owns the conversation UI,
workers, work graphs, task notes, history retrieval, browser tools, and Secure Sessions.
Existing Anthropic/Pi selections and the retired `claude-sdk` migration are unchanged.

## Setup

Forge bundles the runtime. Source checkouts need `pnpm install --frozen-lockfile`
with optional dependencies enabled. No global Claude CLI installation is required.

The default authentication mode is **native Claude login**, using your Claude
subscription. If you already use Claude Code on the same computer/account, its login
is reused. Otherwise, select Claude native and send a message: the setup error gives
the exact terminal command to log in using the bundled executable. An existing
global installation can also use `claude auth login`. Retry the message after login;
an application restart is unnecessary. Forge's Anthropic OAuth login is separate
and is never copied into the native runtime.

Advanced environment settings:

| Variable | Default | Purpose |
| --- | --- | --- |
| `FORGE_CLAUDE_AUTH_MODE` | `cli` | Native Claude login. Set `api_key` only when you explicitly want Anthropic API billing. |
| `ANTHROPIC_API_KEY` | unset | In `api_key` mode, takes precedence over an Anthropic API-key credential in Forge Authentication settings. OAuth credentials are not used. |
| `ANTHROPIC_BASE_URL` | Anthropic default | Optional HTTP(S) endpoint in `api_key` mode only. |
| `CLAUDE_CONFIG_DIR` | Claude default | Optional native Claude configuration/history directory. Log in with the same value; Forge does not copy credentials into it. |
| `CLAUDE_BIN` | bundled executable | Optional absolute path to a native executable, requiring Claude Code 2.1.273 or newer. On Windows use `claude.exe`, not a `.cmd`, `.bat`, or `.ps1` wrapper. Remove the override to return to the bundled runtime. |
| `CLAUDE_CODE_GIT_BASH_PATH` | Claude detection | Optional Git for Windows Bash path. Native Claude shell tools on Windows require Git for Windows. |

API billing is never selected automatically when a subscription login is absent or
fails. Changing environment settings requires restarting the Forge backend. This
integration does not rotate through Forge's Anthropic OAuth credential pool.

## Sessions and behavior

One persistent native process serves each active Forge manager. Normal restarts
resume the saved native session. Forge JSONL remains the source for UI replay, while
Claude stores its own full conversation/context in the native configuration directory.
Preserve both when moving a native session to another computer. A missing native
history is an error; Forge does not silently replace it with an empty conversation.

Forge forks can stop at an individual message, so they reconstruct context from the
bounded Forge transcript rather than resuming the parent's entire native history.
Model changes also use Forge's existing explicit continuity mechanism. Native
automatic and manual compaction are supported; Forge's Pi-only Fresh context mode
and separate Pi compaction-model selection do not apply.

Incoming messages and worker results retain their delivery identities until Claude
reports consuming them. Inputs can be coalesced by Claude. Follow-up delivery waits
for a turn boundary. Stop closes the native process and waits for cleanup before
another runtime can write the session. A cleanup failure blocks replacement and can
be retried.

Full access is enabled. Ordinary commands do not need repeated approvals. Real user
questions and Forge secret/trust grants still use Forge's existing choice UI; native
enterprise permission policies can also require a decision. Assistant text between
tools becomes progress, and the native result settles the final response once.

Claude's own prompt is preserved with a small Forge integration addition. Existing
user-authored Forge prompt replacements remain honored. Repository `AGENTS.md` and
`SWARM.md` context is included; native project/local Claude settings and `CLAUDE.md`
loading follow Forge's project executable trust decision. Native auto-memory is off;
the existing Forge memory policy remains authoritative. Forge controls delegation:
native agent/team/workflow/cron tools are disabled to avoid a second worker system.

## Secure Sessions

Use the same secret aliases and grants as native Codex. `secure_bash` resolves current
authority for each command, so granting or revoking a secret does not restart Claude.
The existing executor delivers material privately and filters output; aliases, not
values, enter the tool call. Native tool output is also passed through the active
Forge output guard before Claude's next model call. Changing a project's overall
Secure Sessions setting still refreshes its runtime guidance through normal lifecycle
policy.

SSH login and passwords needed by remote commands use the existing askpass,
SSH-agent, environment, and stdin bindings. Browser-login delivery is unsupported.
This is protection against accidental disclosure, not isolation from an adversarial
agent or a guarantee that every native cache, extension, background file, or unusual
encoding is filtered. Existing executor platform limitations still apply; adding a
Claude runtime does not make the nono executor support native Windows.

## Validation

`claude-native-runtime.acceptance.test.ts` launches the actual bundled SDK/CLI with a
deterministic local Messages API fixture and temporary data. It exercises native
tools, Forge MCP tools with original call IDs, Secure Bash binding, output canaries,
questions, concurrent inputs, compaction, restart/resume, fork ownership, process
cleanup, and native/Forge JSONL. It makes no calls to Anthropic and is not a model
quality or subscription-authentication benchmark.

Lifecycle, model selection, prompt selection, setup errors, and secret grant/revoke
tests cover the surrounding Forge contracts. Desktop staging preserves the SDK and
matching optional native package outside ASAR and validates executable presence and
version alignment. A real Windows run and an authenticated subscription session
remain separate acceptance checks.

Integration reference: [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview),
[streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode),
[sessions](https://code.claude.com/docs/en/agent-sdk/sessions), and
[hooks](https://code.claude.com/docs/en/agent-sdk/hooks).
