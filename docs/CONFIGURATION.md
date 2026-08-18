# Configuration

Forge is configured through environment variables, a `.env` file, and the dashboard UI.

## Environment Variables

### Core

| Variable | Default | Description |
|----------|---------|-------------|
| `FORGE_HOST` | `127.0.0.1` | Backend bind address. Set to `0.0.0.0` for network/remote access. |
| `FORGE_PORT` | `47187` (dev) / `47287` (prod) | Backend HTTP + WebSocket port. |
| `FORGE_DATA_DIR` | `~/.forge` (macOS/Linux) or `%LOCALAPPDATA%\forge` (Windows) | Data directory for all persistent state. |
| `FORGE_DEBUG` | `false` | Enable debug logging. Also enables extension tool-call logging, which surfaces tool invocations from Pi extensions in the backend logs. |
| `FORGE_TELEMETRY` | `true` | Enable or disable anonymous telemetry. It sends a random install identifier, coarse environment/provider/model metadata, and aggregate usage and feature-adoption counts; never prompts, messages, files, or secrets. |
| `FORGE_CORTEX_ENABLED` | `true` | Enable or disable the entire Cortex subsystem. This is separate from the default-off Knowledge v2 mode switch. |
| `FORGE_RUNTIME_TARGET` | `builder` | Runtime surface to boot. Supported values: `builder` and `collaboration-server`. `builder` starts the local Builder backend; `collaboration-server` starts the deployable collaboration runtime used by the public Docker/self-host path. |

> **Security:** The normal local Builder runtime does not require a browser account or app session. Keep it bound to loopback or a trusted network. Before exposing it more broadly, put an authentication-enforcing proxy in front of it or use the account-gated collaboration-server topology. A network bind or reverse proxy alone does not add authentication.

### UI

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_FORGE_WS_URL` | Auto-resolved from page URL | WebSocket URL for the UI to connect to the backend. Only needed if running UI and backend on different hosts/ports. |
| `VITE_FORGE_WS_PORT` | Auto-resolved from page URL | Backend WebSocket port combined with the browser page's hostname. Used by Electron development so the Desktop renderer stays on loopback while a remote browser connects back to the station it opened. An explicit `VITE_FORGE_WS_URL` takes precedence. |

### Skills

| Variable | Default | Description |
|----------|---------|-------------|
| `BRAVE_API_KEY` | — | API key for the [Brave Search](https://brave.com/search/api/) web search skill. |
| `EXA_API_KEY` | — | API key for the [Exa Search](https://dashboard.exa.ai/api-keys) source-search skill. |
| `GEMINI_API_KEY` | — | API key for the Google Gemini image generation skill. |

Skill API keys can also be configured in the dashboard under **Settings → Skills → selected skill → Environment Variables**. `.env` values remain supported as fallback. Settings stores these values in `shared/config/secrets.json` as plaintext at rest; protect the data directory and backups.

### Browser automation

Forge Desktop provides one local Automatic Browser that can use an embedded browser or an optional Chrome-backed tab. It is not a Skill, and there is no host preference to configure.

Optional Chrome setup and repair live under **Settings → Use Chrome with Forge**. Complete setup for every Chrome profile and `FORGE_DATA_DIR` you intend to use. Browser recording remains embedded-only.

Ordinary web clients have no local browser host, and Forge does not forward the capability to Remote Projects or Collaboration channels. See [Browser automation](BROWSER_AUTOMATION.md) for setup, behavior, persistence, and security boundaries.

### Secure Sessions

Secure Sessions are configured through **Settings → Secrets** rather than environment
variables. Forge Desktop encrypts local values and Bitwarden machine credentials before
the local Builder stores them. Saved local-vault and Bitwarden-backed aliases can be
available to one selected project or all local projects. A project-specific alias
overrides an all-projects alias of the same name in that project.

Marking a secret automatic for one project creates one task lease for the manager
session when Team Secure Mode starts. Eligible local Forge Pi workers use that same
manager-owned sandbox and grant set. Use **Apply now** in the shield to apply or retry
configured defaults without restarting. This policy does not configure a host
environment variable or grant standard Bash, prompts, terminals, or unsupported
worker runtimes access. The Docker execution backend requires the pinned
`forge-secure-runner:node22-v6` image, which can be built with the command in the
[Secure Sessions guide](SECURE_SESSIONS.md#set-up-the-execution-environment). Its
effective Docker endpoint must be a local `unix://` socket on macOS/Linux or Docker
Desktop's exact local named pipe on Windows; remote Docker contexts and transports
are rejected rather than treated as a deployment target.

The feature is local-Builder-only and fail-closed: Remote Projects and Collaboration
sessions do not inherit its vault, paired-browser connection, Team Secure Mode, or execution
path. It does not inherit values from `shared/config/secrets.json` or silently fall back to host execution. A saved source
becomes available to a manager session only through an explicit lease or a configured
project default. Unsupported workers do not receive secure assignments through a
non-secure runtime. The Settings readiness panel reports fixed codes only and supports
local-value re-entry or Bitwarden credential reconnection after a data-directory
move, without replacing aliases, bindings, scopes, or defaults. See
[Secure Sessions](SECURE_SESSIONS.md) for sources, bindings, supported runtimes,
security guarantees, and limitations.

### Skill Sharing

| Variable | Default | Description |
|----------|---------|-------------|
| `FORGE_SKILL_SHARE_BASE_URL` | `https://forgeskills.radops.ai` | Skill share service origin used to generate share links and resolve import URLs. |
| `FORGE_SKILL_SHARE_DISABLED` | `false` | Disable the anonymous skill-share service. |

Legacy `MIDDLEMAN_SKILL_SHARE_BASE_URL` and `MIDDLEMAN_SKILL_SHARE_DISABLED` aliases are still accepted. See [`apps/skill-share-worker/README.md`](../apps/skill-share-worker/README.md) for the worker-side quotas and Cloudflare guardrails.

### Agent Runtimes

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | — | Environment fallback for Anthropic API-key authentication. |
| `OPENAI_API_KEY` | — | Environment fallback for OpenAI/Codex API-key authentication. |
| `XAI_API_KEY` | — | Environment fallback for xAI/Grok API-key authentication when no Settings-managed xAI credential is configured. Env-only xAI requests use `api.x.ai`; the key is not a second account or failover for stored OAuth. |
| `OPENROUTER_API_KEY` | — | Environment fallback for OpenRouter API-key authentication. |
| `CURSOR_API_KEY` | — | Environment fallback for Cursor SDK API-key authentication. |
| `FORGE_OPENAI_CODEX_TRANSPORT` | `sse` | Transport override for OpenAI Codex Responses models. Supported values: `sse` (stable reliability default and rollback path), `websocket`, `websocket-cached` (explicit experimental/canary opt-in; retries a fresh full-context WebSocket before falling back to SSE on pre-output close-before-completion failures), and `auto` (safe pre-start SSE fallback). Invalid values fail safe to `sse`. |
| `FORGE_OPENAI_CODEX_AUTH_MODE` | `local` | OpenAI/Codex auth source. Use `central_broker` to make Forge use the Forge Auth broker for OpenAI/Codex in v1. |
| `FORGE_OPENAI_AUTH_BROKER_URL` | — | Forge Auth broker base URL used when `FORGE_OPENAI_CODEX_AUTH_MODE=central_broker`. |
| `FORGE_OPENAI_AUTH_BROKER_TOKEN` | — | Bearer token for the Forge Auth broker. |
| `FORGE_OPENAI_AUTH_BROKER_INSTANCE_ID` | — | Optional stable install identifier sent to the Forge Auth broker. |
| `FORGE_OPENAI_AUTH_BROKER_INSTANCE_LABEL` | — | Optional human-readable install label sent to the Forge Auth broker. |
| `FORGE_OPENAI_AUTH_BROKER_TIMEOUT_MS` | `10000` | Forge Auth broker request timeout in milliseconds, clamped to `1000`–`60000`. |
| `FORGE_CODEX_TRANSPORT_DEBUG` | — | Optional debugging flag. Set to `1` to enable the sanitized Codex transport diagnostics endpoint at `/api/debug/codex-transport` for transport selection and counter inspection; otherwise it stays disabled/404. |

The OpenAI/Codex auth-mode settings are intentionally scoped to OpenAI/Codex in v1. The primary Settings setup path is invite redemption: a broker administrator creates a one-time setup link for a user name/email, and Forge redeems that link server-to-server for a broker runtime token. The setup link contains only an invite id and secret, not runtime, OpenAI, admin, or provisioning tokens. Forge stores the returned broker runtime token in secrets and masks status in the UI. Manual broker URL/token entry and the env vars above remain available for advanced or older deployments.

If `FORGE_OPENAI_CODEX_AUTH_MODE` is set, the environment is authoritative: saved Settings mode and broker URL/token values are ignored while the env override is present, and Settings disables invite redemption and manual broker edits. In `central_broker` mode, Forge acquires short-lived OpenAI/Codex leases from the Forge Auth broker and renews, reports, and releases them during runtime use. Broker URLs must use HTTPS unless they are localhost/dev HTTP URLs.

The OpenAI Codex Responses transport settings above apply to normal Codex model runtimes. Builder web also has a separate direct sidecar route: a plain leading `@Codex` or `[@Codex]` text message starts or continues a Codex CLI app-server sidecar thread. Selector forms like `@Codex -<plugin>`, `@Codex:<plugin>`, and `[@Codex:<plugin>]` scope the turn to a plugin, reach the manager, and are delegated to the visible `Codex Plugin` specialist worker with server-owned scoped exact plugin tools. The direct sidecar path is Builder web only, text-only, excluded from Collaboration, and limited to one active direct Codex turn globally. Sidecar display cards are persisted in the parent session by default but are excluded from manager model context and from forked-session history. During an active plain `@Codex` turn, Codex MCP servers can ask for confirmation, a form, or a URL handoff. Forge keeps those requests ephemeral, shows no raw MCP `_meta`, form defaults, URL query/fragment tokens, or submitted values in history, and defaults to deny/cancel when a request is stale, unsupported, stopped, disconnected, or unanswered. URLs are never opened automatically. Any remember choice is offered only when Codex explicitly advertises its supported scope; it is not a global allow-all and does not apply to the separate Codex Plugin path. Plugin-scoped normal tool calls return only bounded previews and metadata. Full redacted connector exports are written as JSON session artifacts under `artifacts/codex-plugin/<delegationId>/` with a manifest sidecar, and only artifact path/metadata plus a bounded preview returns to chat/model context.

### Working plans

Builder managers always have access to `update_plan` for substantial multi-step work. The tool publishes the complete current checklist with optional explanation and Pending, In progress, or Completed steps; multiple steps may be In progress when work runs concurrently. There is no settings toggle or shared configuration file. Plans are session-scoped and saved in `plan.json`; outgoing revisions append to `plan-history.ndjson`. The first revision creates one conversation-timeline card, later revisions update that anchor in place, completion freezes it as a collapsed **Plan complete** card, and a later plan creates a new card.

Builder managers also expose `update_work_graph` for substantial work that benefits from dependencies, gates, retries, concurrency, or fan-in. The graph is stored as an optional richer shape inside the same `plan.json` snapshot and projected into the ordinary plan steps for compatibility. `maxConcurrency` defaults to 4 and is bounded from 1 through 8. Forge dispatches ready non-decision nodes automatically, records attempt worker and routing metadata, and changes successful attempts to `awaiting_review`. After verifying the result, the manager calls `accept_work_graph_node` with the node id and concise acceptance evidence; Forge atomically completes only that node and releases newly ready dependents. Re-submitting the complete graph with a blocked node reset to pending creates a retry. Forge attempts to stop running nodes removed, cancelled, or reset to pending before dispatching replacement work; a stop error is logged and does not block replacement dispatch. There is no graph setting or separate graph data directory.

Each checklist step receives a stable internal `id`. Managers preserve returned ids across revisions and use optional `planStepId` on `spawn_agent` or `send_message_to_agent` when an assignment belongs to one step. Legacy exact-text assignments remain readable for compatibility. Forge appends assignment, step-completion, and whole-plan token estimates to `plan-usage.ndjson` beside the plan. Receipts separate manager, assigned worker, and unassigned worker usage and include coverage plus concrete reasons such as recovered runs or completion boundaries, missing timestamps, unassigned usage, or busy-worker assignment boundaries. This accounting is file-backed and has no separate UI. Clearing a conversation clears its current plan; stop and archive preserve it; forks omit the live plan, plan history, and accounting files.

### Session goals

Builder managers also expose `create_goal`, `get_goal`, and `update_goal` for explicit sustained-pursuit requests. A session may have one unfinished goal at a time, and that goal may span multiple working plans. Active goals continue from safe settled-idle boundaries, but wait while the session is stopped or archived, a choice or runtime recovery is pending, or workers are still running. Goals do not expand the manager's authority. The manager may complete a goal only after its objective and current plan are complete, and may mark it blocked only after the same blocker persists for at least three goal turns. Resuming a blocked goal starts a fresh three-turn blocking audit.

The current goal is file-backed in `goal.json`; completed and cancelled records append to `goal-history.ndjson`. The header bar lets users edit, pause, resume, or cancel an unfinished goal. An optional user-requested token budget estimates manager plus worker usage, including parallel workers, and pauses pursuit at a safe idle boundary when exhausted. Stop, archive, restart, and compaction preserve the goal. Clearing a conversation cancels and archives an unfinished goal before clearing it. Forks omit current goal state and goal history. Goals are unavailable to Collaboration and Cortex sessions and have no settings toggle.

### Integrated terminals

Terminal runtime settings use `FORGE_*` names below; the matching legacy `MIDDLEMAN_*` aliases are also accepted.

| Variable | Default | Description |
|----------|---------|-------------|
| `FORGE_TERMINAL_ENABLED` | `true` | Enable the integrated terminal subsystem. |
| `FORGE_TERMINAL_MAX_PER_SESSION` | `10` | Maximum terminals in a manager/profile terminal scope. |
| `FORGE_TERMINAL_DEFAULT_COLS` | `120` | Initial terminal column count; minimum `20`. |
| `FORGE_TERMINAL_DEFAULT_ROWS` | `30` | Initial terminal row count; minimum `5`. |
| `FORGE_TERMINAL_SCROLLBACK_LINES` | `5000` | Headless terminal scrollback lines; minimum `100`. |
| `FORGE_TERMINAL_OUTPUT_BATCH_MS` | `16` | Output batching interval in milliseconds; minimum `1`. |
| `FORGE_TERMINAL_SNAPSHOT_INTERVAL_MS` | `30000` | VT snapshot interval in milliseconds; minimum `1000`. |
| `FORGE_TERMINAL_JOURNAL_MAX_BYTES` | `1048576` | Maximum output-journal segment size; minimum `1024`. |
| `FORGE_TERMINAL_SHUTDOWN_SNAPSHOT_TIMEOUT_MS` | `8000` | Shutdown snapshot timeout in milliseconds; minimum `100`. |
| `FORGE_TERMINAL_RESTORE_STARTUP_CONCURRENCY` | `4` | Maximum concurrent terminal restores at startup; minimum `1`. |
| `FORGE_TERMINAL_WS_TICKET_TTL_MS` | `60000` | Terminal WebSocket ticket lifetime in milliseconds; minimum `1000`. |
| `FORGE_TERMINAL_WS_MAX_BUFFERED_AMOUNT_BYTES` | `1048576` | Maximum buffered terminal WebSocket output; minimum `1024`. |
| `FORGE_TERMINAL_DEFAULT_SHELL` | platform default | Fallback shell path when Settings has no saved default shell. |

Invalid boolean or below-minimum integer values are ignored in favor of the defaults. **Settings → General → Terminal → Default shell** persists `defaultShell` in `shared/config/terminal-settings.json`; a non-empty saved value takes precedence over `FORGE_TERMINAL_DEFAULT_SHELL`.

### Repositories

Settings → General → **Repositories** (Builder/local only) stores clone defaults in `shared/config/repository-settings.json`. Precedence for Clone repository is configured home → last successfully used clone base → user home. Collaboration admin surfaces do not load this route.

### Embedded data versioning

The embedded Git service versions Forge's allowlisted knowledge, profile-memory, reference, and prompt files inside the data directory. The matching legacy `MIDDLEMAN_VERSIONING_*` aliases are also accepted.

| Variable | Default | Description |
|----------|---------|-------------|
| `FORGE_VERSIONING_ENABLED` | `true` | Enable embedded Git versioning for its allowlisted Forge data paths. |
| `FORGE_VERSIONING_TRACK_SESSION_MEMORY` | `false` | Include per-session `profiles/<profileId>/sessions/<sessionId>/memory.md` files in the versioned path set. Profile memory remains part of the normal allowlist. |
| `FORGE_VERSIONING_RECONCILE_INTERVAL_MS` | `300000` | Interval for reconciling tracked files with embedded Git. Set to `0` to disable periodic reconciliation; startup reconciliation still runs. Invalid or negative values use the default. |

### Compaction

Settings → General → Compaction controls the model, reasoning level, and timeout used for automatic compaction and manual Smart compact on supported Pi-backed manager compaction runtimes. Eligible providers are OpenAI/Codex and Anthropic. Cursor SDK and xAI/Grok runtimes are not controlled by these settings.

### Cortex and Knowledge v2

`FORGE_CORTEX_ENABLED=false` disables the entire Cortex subsystem. It is not the Knowledge v2 mode switch.

Knowledge v2 is a default-off Builder preview controlled from **Settings → General** after migration. Its prompt sources differ deliberately:

| Mode | Prompt-injected knowledge and memory |
|------|--------------------------------------|
| Knowledge v2 ON | Global `shared/knowledge/INDEX.md`, the active profile's `knowledge/INDEX.md`, and the current session's `memory.md` |
| Knowledge v2 OFF | Legacy `shared/knowledge/common.md`, canonical profile `memory.md`, and current session `memory.md` |

Profile `memory.md` continues to be maintained while v2 is ON. Legacy `common.md` is preserved during normal switching, but neither is prompt-injected in that mode. Normal mode switching preserves the underlying legacy and v2 files. Turning v2 OFF restores the legacy prompt sources only while the legacy originals remain.

A normal false→true activation requires a strictly valid completed migration manifest and no active migration lock. Before migration, Settings shows migration-required guidance and first-launch v2 onboarding withholds the activation offer, so neither sends an enable request. A direct unsafe `PUT /api/settings/knowledge-v2` is rejected with HTTP 409 and `KNOWLEDGE_V2_MIGRATION_REQUIRED`. The toggle does not migrate data.

Run the guarded migration explicitly from the repository root with a deliberate data directory:

```bash
node scripts/knowledge-v2-migrate.mjs --data-dir /path/to/forge-data
```

Migration and activation share the ownership-safe cross-process lock. A successful new migration atomically writes a completed v2 manifest with truthful `authorized_pending` authorization, releases the lock, and immediately persists v2 activation. Strictly valid manifests from the earlier v1 writer remain accepted. If activation persistence fails after the manifest commit, the valid manifest remains an authorized recovery point and v2 stays OFF; an ordinary enable attempt can then recover. After a later user disable, the same valid manifest permits ordinary re-enable.

Legacy cleanup is a separate, explicit operation:

```bash
node scripts/knowledge-v2-migrate.mjs --data-dir /path/to/forge-data --cleanup-legacy --confirm
```

It archives legacy knowledge files and retired Cortex artifacts under `shared/knowledge/.archive/legacy-cleanup/<timestamp>/`, then removes the originals. After cleanup, switching v2 OFF cannot restore the prior legacy content by itself.

Rollback uses the migration manifest's listed backups, disables v2, and reports that a restart is required:

```bash
node scripts/knowledge-v2-migrate.mjs --data-dir /path/to/forge-data --rollback
node scripts/knowledge-v2-migrate.mjs --data-dir /path/to/forge-data --rollback --manifest /path/to/manifest.json
```

### Phoenix Observability

Settings → Observability configures Builder-only Arize Phoenix tracing. Settings persist in `shared/config/phoenix-observability.json`. Export uses OTLP HTTP/protobuf to a local Phoenix traces endpoint, defaulting to `http://127.0.0.1:6006/v1/traces`.

V1 only accepts loopback `http://` endpoints: `localhost`, `127.0.0.0/8`, or `::1`, with a path ending in `/v1/traces`. Embedded credentials, query strings, and fragments are rejected. Rich capture can include runtime, prompt, LLM, tool, delivery, lifecycle, error, and feedback spans. Capture toggles, redaction, identifier/path modes, extra redaction patterns, and content/attribute caps control what is attached to spans.

Collaboration runtime is unsupported in V1. It uses the no-op/fail-closed observability facade and does not write Phoenix settings or export traces.

### Collaboration

| Variable | Default | Description |
|----------|---------|-------------|
| `FORGE_ADMIN_EMAIL` | — | Bootstrap email for the first collaboration admin account. Required on first boot if no admin exists yet. |
| `FORGE_ADMIN_PASSWORD` | — | Bootstrap password for the first collaboration admin account. Required on first boot if no admin exists yet. |
| `FORGE_PUBLIC_PORT` | `47387` | Host port that `docker-compose.yml` maps to the primary collaboration server's container port `47287`. Keep `FORGE_COLLABORATION_BASE_URL` aligned when overriding it. |
| `FORGE_COLLABORATION_BASE_URL` | — | Canonical collaboration browser URL used for login redirects and invite links. For local `docker compose`, use `http://127.0.0.1:47387` by default and keep it aligned with `FORGE_PUBLIC_PORT` if you override the host mapping. |
| `FORGE_SECONDARY_PUBLIC_PORT` / `FORGE_SECONDARY_COLLABORATION_BASE_URL` | `47388` / `http://127.0.0.1:47388` | Optional secondary local Docker Compose collaboration server settings for multi-backend UI testing. |
| `FORGE_COLLABORATION_TRUSTED_ORIGINS` | — | Comma-separated Builder/UI origins allowed to talk to the collaboration server in split deployments. Local `docker-compose.yml` defaults this to `http://127.0.0.1:47188,http://127.0.0.1:47189`. Use `127.0.0.1` consistently for local HTTP split deployments; mixing `localhost` and `127.0.0.1` becomes cross-site and requires HTTPS. |
| `FORGE_COLLABORATION_AUTH_SECRET` | generated locally if unset | Optional auth secret for the collaboration server. If omitted, the server generates and persists one in the data directory. |
| `FORGE_COLLABORATION_AUTH_COOKIE_NAME` | `forge_collab_session` | Optional session cookie name. Use a distinct value only when multiple collaboration servers share one browser cookie scope. Custom values also namespace Better Auth auxiliary cookies as `<name>_session_data` and `<name>_dont_remember`. |
| `FORGE_SECONDARY_COLLABORATION_AUTH_COOKIE_NAME` | `forge_collab_secondary_session` | Optional Docker Compose secondary-service cookie-name override for local multi-backend testing. |
| `FORGE_CWD_ALLOWLIST_ROOTS` | — (builder defaults to repo + `~/worktrees`; collaboration-server empty/fail-closed) | Absolute roots allowed for remote New Project / Change CWD / `create_directory`. Delimiters: `;` and newlines always; `:` also on non-Windows. Docker Compose sets `/workspaces` and bind-mounts `${FORGE_WORKSPACES_HOST_PATH:-./.forge-collaboration-workspaces}`. Local Builder CWD selection stays unrestricted. |
| `FORGE_WORKSPACES_HOST_PATH` | `./.forge-collaboration-workspaces` | Host directory mounted at `/workspaces` for collaboration Docker. Set explicitly to a real workspace path before enabling remote projects. |
| `FORGE_REMOTE_PROJECTS_ENABLED` | — (absent) | Collaboration-server only. Optional per-field override for Remote Projects `enabled`. Accepted: `1`/`true`/`yes`/`on` and `0`/`false`/`no`/`off` (trim, case-insensitive). Unset/blank = absent. Invalid nonblank values fail startup. Env wins over `remote-build-settings.json` and is never written into that file. Requires restart. |
| `FORGE_REMOTE_PROJECTS_TERMINALS_ENABLED` | — (absent) | Collaboration-server only. Optional override for `terminalsEnabled`. Same boolean grammar and precedence as `FORGE_REMOTE_PROJECTS_ENABLED`. Disabling denies subsequent member terminal lifecycle mutations/tickets but does not close already attached terminal WebSockets. Requires restart. |
| `FORGE_REMOTE_PROJECTS_INSTANCE_NAME` | — (absent) | Collaboration-server only. Optional override for the public handshake `instanceName` (trimmed, max 120). Unset/blank = absent. Over-length values fail startup. Treat as public metadata. Requires restart. |

Collaboration keeps structured state in SQLite and user-authored specialist bodies on disk. Workspace, category, and channel metadata, membership, read state, category default selected specialist handles, channel selected specialist handles, and collaboration skill-selection state belong in the collaboration database. Specialist markdown files, prompt bodies, reference docs, and skill definitions remain file-backed. `NULL` or all-includes means every optional global skill is included; custom arrays filter both the prompt roster and runtime-loaded skills. `memory` is always-on/core. No channel-local skill authoring exists in V1. Global specialists live in `${FORGE_DATA_DIR}/shared/specialists/`; collaboration channel-local specialists live in `${FORGE_DATA_DIR}/profiles/_collaboration/sessions/<sessionId>/specialists/`. Specialist `TargetSpace` frontmatter controls whether a shared specialist appears in Builder, Collaboration, or both. Collaboration servers seed the union of Builder and `collab-` prefixed Collaboration built-ins, then UI/runtime rosters filter by `TargetSpace`. See [Collaboration development](collaboration/DEVELOPMENT.md#sqlite-migration-policy) for the migration policy and [Collaboration operations](collaboration/OPERATIONS.md) for deployment guidance.

### Remote Projects

Remote Projects exposes an allowlisted subset of normal Builder projects from a collaboration server. Some internal API and persistence names retain `remote-build` for compatibility, but the user-facing feature name is Remote Projects.

The server policy is stored at `${FORGE_DATA_DIR}/shared/config/remote-build-settings.json` with these defaults:

```json
{
  "enabled": false,
  "terminalsEnabled": true,
  "instanceName": null
}
```

Only collaboration admins can read or partially update the policy through `GET /api/settings/remote-build` and `PUT /api/settings/remote-build`. There is no server admin UI. Collaboration-server deployments may optionally overlay the same three fields with `FORGE_REMOTE_PROJECTS_ENABLED`, `FORGE_REMOTE_PROJECTS_TERMINALS_ENABLED`, and `FORGE_REMOTE_PROJECTS_INSTANCE_NAME` (Forge-only; no `MIDDLEMAN_*` aliases). Per field, a valid env value wins over the persisted JSON and current defaults; env values are never written into `remote-build-settings.json`. Removing an env var and restarting reveals any latent persisted value. `GET` returns effective `settings`, `persistedSettings`, and per-field `sources` (`environment` or `settings`). A `PUT` that includes any env-controlled field is rejected atomically with HTTP 409 and code `REMOTE_BUILD_SETTINGS_ENV_OVERRIDE`. Builder runtimes ignore these variables. Env changes require a process restart. `instanceName: null` (and absent env override) falls back to the host name. Operators should set terminal policy deliberately before enabling Remote Projects: `terminalsEnabled: false` denies subsequent member terminal lifecycle mutations and ticket issuance, but it is not a sandbox and does not close an already attached terminal WebSocket.

Each configured remote connection separately stores `remoteProjectsEnabled` in that browser's collaboration registry (`forge:collab:connections:v1`). It is a presentation/connection preference, not authorization. A newly added connection is opted in automatically only after a successful **Test** advertises Remote Projects capability; adding an untested/unsupported connection or re-adding an existing connection does not silently enable it. The server's `enabled` policy remains authoritative. The unified local/remote project order is a local Builder backend preference at `${LOCAL_FORGE_DATA_DIR}/shared/config/builder-sidebar-order.json`; it is not sent to the remote server and does not grant access.

The public `/api/collaboration/status` response advertises `instanceName`, Forge version, Builder protocol version, and capabilities such as `remoteBuild`. Treat the configured instance name and host-name fallback as public metadata. Clients refuse to attach when the server's protocol is newer than they support. Remote profiles and descriptors remain in the server's `${FORGE_DATA_DIR}/swarm/agents.json`; session history/state remains under `${FORGE_DATA_DIR}/profiles/<profileId>/sessions/<sessionId>/`; repositories and paths remain on its workspace mounts. No client-side clone or sync is created.

Remote Projects uses the collaboration Better Auth session: a 21-day sliding lifetime with `updateAge` of one day. Cookies are scoped by host/domain and path, not port, so same-host multi-backend deployments must configure distinct `FORGE_COLLABORATION_AUTH_COOKIE_NAME` values (including the derived auxiliary-cookie namespaces). Browser-local connection preferences do not isolate cookies.

Members are trusted instance operators with broad allowlisted Builder read/write access when the server policy is enabled; there is no per-project ACL. Unclassified member routes and commands default to admin-only. Setting `enabled: false` blocks subsequent member Builder HTTP requests and commands but does not disconnect existing WebSockets or remove subscriptions. Ordinary sign-out or session expiry can likewise leave an already authenticated WebSocket active until it disconnects. Account disable/delete, role change, and password reset use explicit tracked-socket closure; urgent containment may also require network or server action.

See the [Remote Projects guide](collaboration/REMOTE_PROJECTS.md) for the complete setup, topology, supported surfaces, and security model.

For compatibility, startup also accepts legacy `MIDDLEMAN_*` environment variables (for example, `MIDDLEMAN_HOST`, `MIDDLEMAN_PORT`, `MIDDLEMAN_DATA_DIR`, `MIDDLEMAN_DEBUG`, `VITE_MIDDLEMAN_WS_URL`, `MIDDLEMAN_RUNTIME_TARGET`). When `FORGE_RUNTIME_TARGET` is unset, legacy `FORGE_COLLABORATION_ENABLED=true` or `MIDDLEMAN_COLLABORATION_ENABLED=true` maps to the `collaboration-server` runtime target.

## `.env` File

Create a `.env` file in the project root. It is loaded automatically on startup.

```bash
# Example .env
FORGE_HOST=127.0.0.1
FORGE_PORT=47187
# FORGE_DATA_DIR=/custom/path
# BRAVE_API_KEY=your-brave-key
# EXA_API_KEY=your-exa-key
# GEMINI_API_KEY=your-gemini-key
```

## Provider Authentication

Provider auth for **OpenAI**, **Anthropic**, **xAI**, **OpenRouter**, and **Cursor SDK** is managed under **Settings → Authentication**. The current pane uses OAuth account-pool cards for OpenAI and Anthropic. xAI has one direct, non-pooled credential slot that accepts either an API key or OAuth. OpenRouter and Cursor SDK use masked key/token-only rows. Status and auth-type badges appear where applicable; they are not a uniform control on every provider row.

OpenAI and Anthropic currently add accounts through their OAuth pool cards. Existing local credentials can still be reflected in provider status. Environment fallbacks are `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `XAI_API_KEY`, `OPENROUTER_API_KEY`, and `CURSOR_API_KEY`; Settings/shared secrets take precedence where the provider resolver supports both. OpenAI/Codex can also use Forge Auth broker mode, which requests short-lived leases from a separate broker instead of using local OpenAI credentials. In Settings, the normal v1 broker setup path is to paste a one-time setup link from the broker admin UI and let Forge redeem it server-to-server. One-time links cannot be replayed after redemption. Manual broker URL/token entry is still available under advanced setup for older deployments. While broker mode is active, local OpenAI OAuth/API-key and pool credentials remain visible for reference but are read-only and cannot be changed from Settings. Forge Auth broker mode is v1-scoped to OpenAI/Codex only.

For xAI, saving an API key replaces any stored OAuth credential, and completing OAuth replaces any stored API key. Browser login exposes **Open authorization URL** and **Copy URL**; if the local callback does not complete automatically, paste the full callback URL from that attempt. For a remote or headless backend, choose the device path when prompted, open the verification URL on another device, and enter the displayed code. Stored xAI OAuth tokens refresh through the provider flow; retry the login or reauthorize if refresh no longer succeeds. **Remove** deletes only the locally stored xAI credential and does not revoke it at xAI. `XAI_API_KEY` remains an environment fallback when no Settings-managed xAI credential is configured, and env-only requests use `api.x.ai`. If stored OAuth refresh fails, Forge does not select or send the environment key to the OAuth proxy. Reauthorize or remove the stored OAuth credential before using the environment key; there is no seamless failover.

Native xAI defaults to `grok-4.6`, with `grok-4.5` retained as an explicit variant. When xAI auth is configured, both are eligible for normal manager creation, manager model changes, and exact per-session manager overrides. API-key auth exposes `low`, `medium`, `high`, and `xhigh` reasoning. OAuth uses a bounded `low`/`medium`/`high` fallback until authenticated discovery returns account-specific metadata, which is then authoritative for available reasoning choices. Discovery can additionally expose exactly the OAuth-only entitlement models `grok-build` and `grok-composer-2.5-fast`; these remain worker/specialist choices excluded from normal manager selectors, appear only when the active account returns valid entries, and are removed if discovery fails or the effective auth becomes an API key. xAI/Grok is not eligible for manager compaction or the Settings compaction model selector. The xAI model `grok-composer-2.5-fast` is not Cursor SDK's `composer-2.5`.

Cursor SDK auth is configured through its Settings key row, shared secrets, or the environment (including `CURSOR_API_KEY` for env-based setups). Cursor SDK Composer 2.5 and Cursor Grok 4.5 can appear in manager and specialist model selectors when credentials and model visibility allow them. Cursor SDK uses a provider-local, fail-closed Cursor/ConnectRPC/HTTP2 classifier: attributed transient transport or throttle failures can retry once before output, auth/permission/cancel/user-state failures are contained and projected without retry, and unattributed/generic/protocol/config failures remain fatal. Usage from Cursor SDK sessions is recorded into session custom entries and contributes to dashboard stats, token analytics, and telemetry provider inference.

Claude models run through native Anthropic authentication in Forge. Claude Code login credentials are not imported or converted.

For the native Cursor runtime, Forge uses the Forge-owned Cursor SDK `stateRoot` and persisted `sdkAgentId` to keep runtime state local to the app.


Model availability and behavior are managed through **Settings → Models**, which provides visibility controls and context window overrides for all supported models. Those visibility settings also control whether a model can appear in manager create-session, change-default, and per-session override selectors. Codex selector mentions are handled separately as plugin-scoped turns that delegate to the visible Codex Plugin specialist, not through the manager model selector list. See [docs/MODEL_CATALOG.md](MODEL_CATALOG.md) for details on the model catalog system.

Appearance preferences are separate from server/shared configuration. They are stored in local renderer/browser state for the active UI only, so changes to Light/Dark/System mode, templates, colors, or fonts stay local to that client instead of syncing through shared profile config.

## Retired Telegram data (operator cleanup only)

Forge no longer reads, writes, migrates, copies, or deletes Telegram credential and topic files. Existing files remain untouched for rollback and must be removed manually by an operator, without displaying their contents. Depending on the Forge version that created them, inspect these locations under `<data-dir>`:

- `shared/config/integrations/telegram.json`
- `shared/integrations/telegram.json`
- `profiles/<profileId>/integrations/telegram.json`
- `profiles/<profileId>/integrations/telegram-topics.json`
- `integrations/shared/telegram.json`
- `integrations/managers/<managerId>/telegram.json`
- `integrations/managers/<managerId>/telegram-topics.json`

Historical Telegram conversation rows can remain in canonical session JSONL for retention and rollback. Supported Web, All, audit, HTTP, and WebSocket projections hide those original rows and their content. Use filesystem-level retention procedures if canonical history also needs removal; Forge has no UI cleanup action for it.

## Data Directory

Key persistent and regenerable paths use this canonical layout (most files are created only when their feature is used):

```
<data-dir>/
├── integrations/external-chrome/          # Optional Chrome adapter deployment for this data directory
│   ├── extension/                         # Stable Chrome Load unpacked folder
│   │   ├── current.json                   # Verified selected payload
│   │   └── payloads/                      # Immutable version/hash payload directories
│   ├── native-host/                       # Deployed native relay executable
│   ├── native-host-manifests/             # Canonical Forge-owned host manifest
│   ├── auth/                              # Private local relay authentication
│   ├── run/                               # Expiring current-user rendezvous
│   ├── state/                             # Install/ownership/exact-authority recovery state
│   ├── deployment/                        # Atomic deployment journal/state
│   └── deploy.lock                        # Serialized deployment lock
├── shared/
│   ├── config/                            # Shared settings and credentials
│   │   ├── auth/
│   │   │   ├── auth.json                  # Provider auth credentials
│   │   │   ├── credential-pool.json       # OAuth pool metadata
│   │   │   ├── openai-codex-auth-source.json # Saved OpenAI/Codex auth-source settings
│   │   │   └── cli-access.json            # Forge CLI access keys
│   │   ├── collaboration/
│   │   │   ├── auth.db                    # Collaboration auth + structured domain state
│   │   │   └── auth-secret.key            # Generated collaboration auth secret
│   │   ├── secrets.json                   # Sensitive local JSON; plaintext at rest
│   ├── state/
│   │   ├── secure-sessions.db             # Secure Session metadata and OS-encrypted material
│   │   ├── builder-sidebar-order.json     # Local unified project order
│   │   ├── compaction-settings.json       # Manager compaction settings
│   │   ├── cortex-auto-review.json        # Cortex consolidation cadence
│   │   ├── knowledge-v2.json              # Knowledge v2 mode and index caps
│   │   ├── mobile-notification-prefs.json # Mobile push preferences
│   │   ├── model-cache-visualization.json # Model-cache visualization preference
│   │   ├── model-overrides.json           # Model visibility, context caps, instructions
│   │   ├── notification-settings.json     # Notification sound preferences
│   │   ├── openrouter-models.json         # User-added OpenRouter models
│   │   ├── phoenix-observability.json     # Builder Phoenix tracing settings
│   │   ├── project-resources.json         # Repo-resource trust/override settings
│   │   ├── remote-build-settings.json     # Collaboration Remote Projects policy
│   │   ├── repository-settings.json       # Builder clone-base defaults
│   │   ├── slash-commands.json            # Global slash commands
│   │   ├── telemetry.json                 # Telemetry install/config state
│   │   └── terminal-settings.json         # Saved terminal default shell
│   ├── cache/                             # Regenerable caches and usage history
│   │   ├── generated/pi-models.json       # Generated Pi model projection
│   │   ├── provider-usage-cache.json
│   │   ├── provider-usage-history.jsonl
│   │   ├── stats-cache.json
│   │   ├── token-analytics-cache.json
│   │   └── generation-throughput-cache.json # Regenerable Pi response-throughput cache; v1 entries rebuild as v2
│   ├── state/
│   │   ├── mobile-devices.json
│   │   ├── project-agent-shares.json
│   │   └── .*-done                        # One-time migration/reconciliation sentinels
│   ├── knowledge/                         # Legacy + global Knowledge v2 storage
│   │   ├── common.md                      # Legacy global knowledge (v2 OFF only)
│   │   ├── onboarding-state.json
│   │   ├── profiles/<profileId>.md        # Preserved legacy profile knowledge
│   │   ├── entries/*.md                   # Global v2 entries
│   │   ├── archive/                       # Archived global v2 entries
│   │   ├── reference/                     # Knowledge reference inputs
│   │   ├── .archive/                      # Migration/cleanup archives
│   │   ├── .cortex-*.json*                # Cortex review/consolidation records
│   │   ├── .knowledge-v2-migration-*      # Manifest and ownership lock
│   │   └── INDEX.md                       # Generated global v2 index
│   └── specialists/                       # Global specialist definitions
├── profiles/<profileId>/
│   ├── memory.md                          # Canonical profile memory (v2 OFF injection)
│   ├── merge-audit.log
│   ├── unread-state.json
│   ├── extensions/                        # Profile Forge extensions
│   ├── knowledge/{entries,archive}/       # Profile Knowledge v2 entries/archive
│   ├── knowledge/INDEX.md                 # Generated profile v2 index
│   ├── pi/{extensions,skills,prompts,themes}/ # Profile Pi resources
│   ├── project-agents/<handle>/           # Local-to-Forge definitions only
│   │   ├── config.json
│   │   ├── prompt.md
│   │   └── reference/
│   ├── project-agent-backups/             # Non-destructive reconciliation backups
│   ├── reference/                         # Profile reference documents
│   ├── schedules/schedules.json
│   ├── slash-commands.json
│   ├── specialists/                       # Profile specialist overrides
│   └── sessions/<sessionId>/
│       ├── session.jsonl                  # Canonical conversation history
│       ├── turns.jsonl                    # Rotating fail-open turn ledger
│       ├── receipts.jsonl[.1]             # Current/rotated routing receipts
│       ├── memory.md
│       ├── meta.json
│       ├── feedback.jsonl
│       ├── pinned-messages.json
│       ├── browser.json                    # Logical browser tab and action metadata
│       ├── plan.json
│       ├── plan-history.ndjson
│       ├── plan-usage.ndjson
│       ├── goal.json
│       ├── goal-history.ndjson
│       ├── artifacts/                     # Session non-repo artifacts/exports
│       │   └── browser/                    # Completed embedded-browser recordings
│       ├── context/prompt.md               # Collaboration additional instructions
│       ├── cursor-sdk-state/<sessionId>/   # Manager Cursor SDK state root
│       ├── reference/                     # Collaboration reference docs
│       ├── specialists/                    # Collaboration channel-local specialists
│       ├── terminals/<terminalId>/
│       │   ├── meta.json
│       │   ├── snapshot.vt
│       │   └── delta.ndjson
│       └── workers/
│           ├── <workerId>.jsonl
│           └── cursor-sdk-state/<workerId>/ # Worker Cursor SDK state roots
├── swarm/agents.json                      # Global profile/agent registry
├── session-attention.json                 # Server-owned session attention
├── extensions/                            # Global Forge extensions
├── agent/
│   ├── extensions/                        # Global worker Pi extensions
│   ├── manager/extensions/                # Global manager Pi extensions
│   ├── skills/                            # Global worker Pi skills
│   ├── manager/skills/                    # Global manager Pi skills
│   ├── settings.json                      # Worker Pi package config
│   └── manager/settings.json              # Manager Pi package config
├── skills/<skillName>/SKILL.md             # User-created global Forge skills
└── uploads/                                # Uploaded attachments
```

`browser.json` is per session. It stores logical browser tabs, the active/default tab, UI state, bounded action summaries, cleanup acknowledgement, and revision/timestamp metadata; it contains no selected host preference. For Chrome-backed tabs, persistence clears page URL/title and error detail and removes page-identifying URL/title fields from action summaries. Older browser state migrates conservatively rather than treating stale Chrome control hints as current authority.

Successfully stopped recordings live under the session's `artifacts/browser/` directory and are embedded-only. Embedded screenshot previews are transient; a Chrome snapshot can return a bounded PNG to the active operation, but neither path writes a standalone screenshot artifact.

Embedded-browser cookies and site storage live in a persistent, profile-scoped Electron partition shared by sessions in that Forge profile; it is not represented in the server data tree above and can outlive session deletion. There is currently no shipped clear-data control. Chrome site identity remains in Chrome's own profile; Forge does not copy Chrome credentials, profile databases, official profile names, bookmarks, history, or top sites.

### Chrome adapter local integration

The `integrations/external-chrome/` tree belongs to exactly one Forge data directory. `extension/` is the stable folder users select with Chrome's **Load unpacked**; compatible updates change the verified `current.json` and payload contents rather than asking users to select another directory. Loading that folder remains per Chrome profile, so repeat setup for every Chrome profile and every `FORGE_DATA_DIR`.

Forge Desktop registers native host `com.forge.external_chrome` for the current user. The canonical manifest remains under the data directory and points to that data directory's deployed native relay. The OS registration targets are:

- macOS: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.forge.external_chrome.json`
- Linux: `~/.config/google-chrome/NativeMessagingHosts/com.forge.external_chrome.json`
- Windows: `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.forge.external_chrome` (default value points to the canonical manifest)

These are registration and diagnostic paths, not evidence that headed Chrome or the integration has been qualified on every platform. Do not hand-edit or overwrite them. **Settings → Use Chrome with Forge** can show status, enable setup, reveal the validated extension folder, and offer **Repair** when the coordinator proves that mutation is safe. Chrome has one current-user registration target for this host name, so another active Forge data directory can conflict; quiesce the other owner before qualified repair.

`auth/`, `run/`, and `state/` contain sensitive current-user authentication, rendezvous, ownership, and exact per-tab release-recovery material. Protect them and backups like credentials. Chrome tabs remain open when Forge releases operation authority or performs session lifecycle cleanup.

Compatible connected instances can reload an authenticated payload after Desktop updates. Manually reload the unpacked extension only when **Settings → Use Chrome with Forge → Advanced diagnostics → Recovery** reports `manual-extension-reload`.

The native relay's packaged manifest records target/architecture and signature verification state. See [Browser automation](BROWSER_AUTOMATION.md#optional-chrome-setup) for setup and troubleshooting, and the [Electron guide](../apps/electron/README.md#optional-chrome-adapter-packaging-and-validation) for maintainer release and qualification gates.

`shared/config/secrets.json` stores sensitive values as ordinary JSON; Forge does not application-encrypt that file at rest. Protect the data directory and every backup with appropriate operating-system or storage access controls, and handle copied `secrets.json` files as secrets.

### Default Locations

| Platform | Default Path |
|----------|-------------|
| macOS / Linux | `~/.forge` |
| Windows | `%LOCALAPPDATA%\forge` |

Override with `FORGE_DATA_DIR` in your environment or `.env` file.

### Machine-local skills

Forge automatically scans `${FORGE_DATA_DIR}/skills` for optional machine-local skills.

Baseline global skill precedence is:
1. `${FORGE_DATA_DIR}/skills`
2. built-in skill definitions shipped with Forge

Session-specific profile skills and trusted repo-root `.forge/skills` resources are layered into sessions for the active profile/workspace. There is no repo-local `.swarm/skills` layer in the current setup.

Discovered skills are injected into all agent/runtime sessions the same way other loaded skills are.

Use this for station-specific workflows that should stay outside a shared repository. The built-in `create-skill` helper can scaffold reusable global, profile/project, or repository skills and validate the resulting structure. A local skill should live at:

```text
${FORGE_DATA_DIR}/skills/<skillName>/SKILL.md
```

`SKILL.md` uses the normal skill frontmatter format (`name`, `description`, optional `env` declarations, then markdown body).

On a default macOS/Linux install this becomes:

```text
~/.forge/skills/<skillName>/SKILL.md
```

### Project Resources

Repositories can provide project-scoped resources from a repo-root `.forge/` directory: project skills, specialists, reference docs, Project Agent definitions under `.forge/project-agents/`, Forge extensions, and Pi extensions/packages. Passive resources are available as text context; executable resources are gated by an explicit trust/block prompt.

See [PROJECT_RESOURCES.md](PROJECT_RESOURCES.md) for the layout, override rules, and security model.

### Forge Extensions

Forge exposes a Forge-native hook system for session lifecycle, runtime errors, versioning commits, and tool interception.

**Forge extension directories**:

| Path | Scope |
|------|-------|
| `${FORGE_DATA_DIR}/extensions/` | Global |
| `${FORGE_DATA_DIR}/profiles/<id>/extensions/` | Profile |
| `<repo>/.forge/extensions/` | Project-local, trust-gated |

Global and profile Forge extension directories are auto-created. Project-local directories are not. Project-local executable extensions are loaded only after the repository `.forge` directory is trusted.

See [FORGE_EXTENSIONS.md](FORGE_EXTENSIONS.md) and [PROJECT_RESOURCES.md](PROJECT_RESOURCES.md) for the full guides.

### Pi Extensions & Packages

Forge also exposes Pi's extension and package system for deeper customization — custom tools, event interception, context modification, and more.

**Extension auto-discovery directories**:

| Path | Scope |
|------|-------|
| `${FORGE_DATA_DIR}/agent/extensions/` | All workers |
| `${FORGE_DATA_DIR}/agent/manager/extensions/` | All managers |
| `<repo>/.forge/pi/extensions/` | Project-local, trust-gated |

**Skill directories**:

| Path | Scope |
|------|-------|
| `${FORGE_DATA_DIR}/agent/skills/` | All workers |
| `${FORGE_DATA_DIR}/agent/manager/skills/` | All managers |
| `<repo>/.forge/skills/` | Project-local project skills |

**Package configuration** via optional `settings.json` files:

| Path | Scope |
|------|-------|
| `${FORGE_DATA_DIR}/agent/settings.json` | Worker packages |
| `${FORGE_DATA_DIR}/agent/manager/settings.json` | Manager packages |
| `<repo>/.forge/pi/settings.json` | Project-local packages, trust-gated |

Packages can be installed from npm (`npm:@scope/name`), git (`git:github.com/user/repo`), or local paths. These files do not need to exist — create them only when you want to install packages. Trusted repo-root `.forge/pi/settings.json` replaces the old exact-CWD `.pi/settings.json` location for new projects; legacy exact-CWD surfaces remain compatibility-only and are active only when inside or identical to the selected trusted `.forge` directory.

Drop a `.ts` or `.js` file into the appropriate extensions directory and it's loaded for all sessions of that role. TypeScript works without a build step via [jiti](https://github.com/nicolo-ribaudo/jiti). Extensions load per-session, so new extensions are picked up without restarting the backend.

See [PI_EXTENSIONS.md](PI_EXTENSIONS.md) for the full guide, including writing extensions, event hooks, package filtering, and headless mode caveats.

## Ports

| Mode | Backend | UI |
|------|---------|-----|
| Development (`pnpm dev`) | `47187` | `47188` |
| Production (`pnpm prod`) | `47287` | `47189` |
| Docker collaboration compose (host -> container) | `47387 -> 47287` by default | Same origin on `47387` by default; data bind-mounted at `./.forge-collaboration-data -> /var/lib/forge` |

## Remote / Network Access

To access Forge from other devices on a trusted network, heed the local Builder authentication warning under [`FORGE_HOST`](#core), then:

1. Set `FORGE_HOST=0.0.0.0` to bind to all interfaces.
2. Use the machine's IP or hostname in your browser.
3. If using a reverse proxy or Tailscale, ensure `allowedHosts` covers your hostname (the Vite preview server has `allowedHosts: true` by default).

For Electron development with simultaneous browser access, run
`pnpm dev:electron:remote` (or `pnpm.cmd dev:electron:remote` on Windows).
This is a thin trusted-network wrapper around the normal `dev:electron`
workflow, so both commands use the same Electron-owned backend on port `47287`.
The Electron window continues to use its loopback backend bootstrap while the
remote browser derives the backend hostname from the address it opened and
connects on port `47287`. The development UI is available on port `47188`.

A normal installed Forge Desktop app exposes the same browser route while it
runs: `http://<station-address>:47188`. Its packaged UI binds on `FORGE_HOST`
(or `0.0.0.0` when unset), keeps the Electron window on `app://` with its
loopback preload bootstrap, and sends browser clients only the Electron-owned
backend port (default `47287`, including a `FORGE_PORT` override). The browser
route has no Electron preload bridge or forwarded Desktop/browser capabilities.
Keep it on loopback or a known trusted network, or put an authentication-enforcing
proxy in front of it before broader exposure.

Remote secure-browser pairing supports HTTPS and, for a known trusted private network
such as a personal VPN, the explicit **Trusted network mode** shown in the browser UI.
HTTPS keeps the browser-encrypted private-entry path. The HTTP mode sends a bounded
value only to the paired Electron vault for immediate operating-system sealing; it
never enters chat, tools, prompts, or persisted secret metadata. Do not use HTTP mode
on a public or untrusted network.
