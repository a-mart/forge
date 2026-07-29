# Secure Sessions

Secure Sessions let a local Builder task use an approved secret without putting the
secret value in chat, a model prompt, tool arguments, WebSocket messages, or the
conversation transcript. The agent continues to call the ordinary Pi Bash and file
tools. Forge routes Bash through the secure execution plane and resolves approved
values only after the tool call has reached that local boundary.

This feature is designed for the practical middle ground between two unsafe extremes:
giving the model a password and building a special-purpose tool for every command that
might need one.

## What Team Secure Mode is

Team Secure Mode belongs to one local Builder manager session. That manager session
is the only authorization principal: it owns one reusable Linux container, one lease
set, one request queue, and one output-protection state. Eligible local Forge Pi
workers inherit that authority while executing work for the manager; they never
create a second secret grant or sandbox. While it is active:

- the manager and all eligible workers run Pi Bash in the same manager-owned
  container;
- idle, newly created, reassigned, and completed workers do not create or retain
  additional containers;
- the workspace is mounted directly into the container (at the same path on
  macOS/Linux and at `/workspace` on Windows);
- approved values can be delivered to a command as an environment variable, stdin,
  a protected RAM-backed file, or an askpass helper;
- a task or timed grant can be reused across many commands from the manager or any
  eligible worker in the session;
- every Bash output byte is filtered before the Pi tool accumulator, Forge events,
  persistence, extensions, UI, or the next provider request;
- host-side file-tool results pass through the same active exact-value guard before
  they can be returned to the runtime;
- stopping or revoking Team Secure Mode destroys the shared process tree and revokes
  the session's grants. A worker lifecycle event never revokes session authority.

The agent sees only catalog aliases, delivery destinations, lease status, and fixed
error codes. It cannot ask the Secure Sessions tools to return a stored value or a
provider locator.

Team Secure Mode is currently available for a supported local Pi-backed Builder
manager and eligible local Forge Pi workers in the same project. Unsupported worker
runtimes fail closed before secure work is dispatched; Forge does not silently run
that assignment without the secure boundary. Cursor SDK, Cursor ACP,
Remote Projects, Collaboration channels, Codex plugin/external-thread workers, and
ordinary integrated terminals are not Secure Sessions execution paths.

Managers mark secret-dependent delegation with
`spawn_agent(..., requiresSecureRuntime=true)`. Forge selects a compatible configured
fallback when an execution policy's primary runtime is unsupported. Before delivery,
Forge verifies that Team Secure Mode is ready, the worker uses a supported runtime,
and its working directory is within the manager workspace. It then binds that
assignment to the manager's existing sandbox. If any check fails, Forge rolls the new
worker back before delivering its initial assignment. Ordinary non-secret delegation
remains unchanged. Reassigning an existing worker uses the same
`requiresSecureRuntime=true` flag on `send_message_to_agent`; a stale assignment
binding or ineligible target is rejected before Bash or the message is delivered.

## Set up the execution environment

Secure Sessions currently use Docker as a replaceable first execution backend. Build
the pinned runner image from the repository root:

```bash
docker build \
  --tag forge-secure-runner:node22-v6 \
  --file apps/backend/src/swarm/secure-sessions/execution/Dockerfile.secure-runner \
  apps/backend/src/swarm/secure-sessions/execution
```

The image is based on the pinned Node 22 runtime and includes Bash, Git, curl, jq,
OpenSSH client, PostgreSQL client, Python 3, rsync, npm, the repository's pinned pnpm,
the `script` PTY helper, and a Debian build toolchain. Forge checks the runner contract
label before offering the environment. It does not silently fall back to host
execution if Docker or the image is unavailable.

For an SSH password saved with Forge's automatic environment delivery, use the
image-owned askpass bridge instead of creating a helper in the command:

```bash
FORGE_ASKPASS_ENV=FORGE_SECRET_EXACT_TARGET \
SSH_ASKPASS=/usr/local/bin/forge-env-askpass \
DISPLAY=forge-secure \
SSH_ASKPASS_REQUIRE=force \
setsid ssh -o BatchMode=no user@example.internal
```

`FORGE_SECRET_EXACT_TARGET` is the exact public `targetName` reported by
`secure_session_status`; the value is never put in the command. The helper has
no authority beyond the environment variables already granted to that command.
An advanced `SSH_ASKPASS` binding remains available for tools that require that
specific delivery shape.

Agents should report only fixed presence/success outcomes and command results. They
must not print, count, hash, encode, or otherwise derive metadata from a secret value.
After a worker completes a credentialed action, the manager accepts the worker's safe
evidence or performs a non-secret state check rather than repeating the action.

The container has a read-only root filesystem, dropped Linux capabilities,
`no-new-privileges`, no Docker socket, and a bounded process count. The selected
workspace is the primary host bind mount. For a linked Git worktree, Forge also mounts
that worktree's external common `.git` directory at the same path so normal Git
commands work; pointers outside Git's standard `worktrees/` layout are rejected.
Secret files live only beneath `/run/forge-secure/bindings/` on an owner-only,
`noexec` tmpfs.

Forge accepts only a local Unix-socket Docker endpoint on macOS/Linux or Docker
Desktop's exact local `npipe:////./pipe/docker_engine` endpoint on Windows. It resolves
the effective `DOCKER_HOST` or Docker context before provisioning, rejects `ssh://`,
`tcp://`, and other remote transports, and pins every later invocation to the accepted
endpoint.
Sending the execution frame to a remote Docker daemon is not an implicit deployment
mode; a future remote backend must have its own explicit trust and transport contract.

## Add a private source

Open **Settings → Secrets** in Forge Desktop or a paired browser connected to that
same running local Builder. Desktop private entry uses its direct bridge. A paired
HTTPS browser encrypts the value to a one-use Electron key before the Builder backend
relays it, so the backend receives only public-key material and ciphertext. Electron
then seals the value with operating-system secure storage.

Forge also supports a paired browser opened over plain HTTP when it is being used on a
known, trusted private network such as a personal VPN. The UI calls this **Trusted
network mode**. In that mode the bounded value reaches the Builder backend only long
enough to be sent directly to the paired Electron vault for sealing. It never enters
chat, model prompts, tools, session history, or catalog metadata. This is deliberately
less transport protection than HTTPS and is not appropriate for a public or untrusted
network.

Browser pairing starts in the remote UI and produces a six-digit verification code.
Forge Desktop lists that pending request under **Settings → Secrets → Paired
browsers**. Approval creates a revocable, browser-scoped token whose hash is persisted;
the token itself is delivered once in an HttpOnly, SameSite cookie. Pairing does not
expose the per-launch Desktop capability. HTTP browser control is allowed only through
this explicit paired trusted-network path; HTTPS remains the preferred path. Remote
Projects and Collaboration remain separate authority boundaries and do not inherit
this local Desktop vault connection.

Every saved secret has an availability scope:

- Select one or more projects to make the alias available only in those local
  projects.
- Select **All projects** to make the alias available to every local project on
  this Forge instance, including projects created later.

Adding a secret from a project context defaults to that project. If a
selected-project secret and an all-projects secret use the same alias, each selected
project uses the selected-project secret. Other projects continue to use the
all-projects secret. Scope controls where an alias can be selected; it does not grant
any task access.

For a direct route from the Builder sidebar, right-click a local project header and
choose **Project Secrets**. Forge opens **Settings → Secrets** with that project
preselected, without changing the active conversation or its draft.

### Local vault

Choose **Secrets**, enter an alias and value, and save it. The renderer immediately
sends the value to Electron's private encryption IPC and clears its input state.
Electron `safeStorage` seals it with the operating-system-backed encryption service.
Only ciphertext is stored in `shared/state/secure-sessions.db`.

Forge refuses new local-vault writes when Electron reports an unavailable backend or
Linux `basic_text` storage. A saved value is never returned by the settings API.

### Bitwarden Secrets Manager

Install the official `bws` CLI on the trusted host, then choose **Sources → Connect
Bitwarden Secrets Manager**. Enter a machine-account access token and, when applicable,
the organization, project, or self-hosted server origin. Forge Desktop encrypts the
access token before the local backend stores it.
Forge verifies the connection before saving the source, so a displayed
**Available** state means the configured credential was actually accepted.

Under **Secrets**, import a Bitwarden secret UUID, assign a Forge alias, and choose the
same selected-projects or **All projects** scope available to local-vault secrets.
Automatic-grant policy also works the same way for either source. Forge keeps the UUID
and encrypted machine credential backend-only. When an approved command needs the
value, the trusted host invokes `bws` with an isolated temporary configuration
directory, captures a bounded response in memory, and removes that directory.

Bitwarden is a long-lived source, not a permanent task grant. Reusing a task grant does
not require re-entering the value. A task still needs either an explicit lease or an
enabled automatic-grant policy.

## Configure delivery bindings

A binding describes how a command can receive a value after it has a lease. Saving a
binding does not grant access.

| Delivery | What the command receives | Typical use |
| --- | --- | --- |
| Environment | A named variable, such as `GITHUB_TOKEN` | CLIs and application processes |
| Stdin | The value on the command's standard input | `read`, installers, and password consumers |
| File | A mode `0400` or `0600` file under `/run/forge-secure/bindings/` | Certificates, config fragments, and clients requiring a path |
| Askpass | A generated helper path in a named variable | SSH, Git, and compatible password prompts |
| SSH agent | Not yet supported | Reserved for a future constrained signing broker |

Examples of normal agent commands after a grant:

```bash
curl -H "Authorization: Bearer $WORK_API_TOKEN" https://internal.example/api
ssh -o BatchMode=no server.example 'systemctl status app'
node scripts/database-maintenance.mjs
python3 scripts/rotate_credential.py "$ROTATION_TOKEN_FILE"
scp "$DEPLOY_KEY_FILE" server.example:/tmp/deploy-key
```

These are ordinary Bash commands. There is no secret interpolation syntax in the
model-originated command. The value is added only to the selected child inside the
task container. An `SSH_ASKPASS` binding automatically supplies the non-secret
`DISPLAY` and `SSH_ASKPASS_REQUIRE=force` settings needed for password authentication
without a terminal.

## Automatic grants

Under **Automatically grant in**, a saved secret can be assigned to one or more
projects. An all-projects secret can instead use **Every project**, which is a durable
rule that includes current projects and projects created later. This policy is
separate from the secret's catalog availability scope:

- a project-scoped secret can be granted automatically only in its own project;
- an all-projects secret can be granted automatically in any combination of projects
  without becoming automatic elsewhere;
- **Every project** is available only for an all-projects secret;
- each project may have at most 16 effective automatic grants;
- when Team Secure Mode starts, Forge evaluates each applicable policy once for the
  manager session;
- each applicable policy creates one **Until Secure Session stops** lease in the
  shared manager authority;
- workers that join later use the existing lease set without re-resolving or
  duplicating secret material;
- an automatic grant is never injected into standard Bash, a model prompt, the integrated
  terminal, another project, or an unsupported worker runtime.

Changing an automatic-grant policy while Team Secure Mode is active marks it
**Configured**. Choose **Apply now** in the shield to apply or retry non-active
automatic grants for the manager session without restarting. Disabling a policy
revokes only the shared lease created from that policy; it does not remove a separate
manual grant.

Forge evaluates every automatic grant independently. A locked or unavailable source
is reported as unavailable, and a delivery collision is reported as a binding
conflict. Either problem skips that grant without blocking other policies. Public
status contains only fixed states and error codes, never provider error text or
protected material.

Archiving a project preserves its project-scoped secrets and automatic-grant settings so they
remain available after restore. Permanently deleting the project removes its
project-scoped secrets and project-specific automatic-grant mappings. An all-projects
secret and its **Every project** policy are not deleted with any one project.

## Start, grant, reuse, and revoke

1. Open a local Builder manager whose current runtime is supported.
2. Select the shield beside **Send** and start Team Secure Mode. Forge prepares the
   manager's shared sandbox and recycles every eligible current worker onto that
   execution boundary. If a worker is
   actively streaming, startup fails instead of changing its execution boundary
   underneath a command.
3. Forge applies the project's configured automatic grants once and reports
   any secret it could not activate. Use **Apply now** to apply newly
   configured policies or retry recovered sources without restarting.
4. Select any additional saved aliases for the manager session. Forge gives a newly
   saved secret a stable, generated environment delivery automatically; advanced
   saved bindings remain available when a specific askpass, file, stdin, or
   environment shape is needed.
5. Choose a lease:
   - **Until Secure Session stops** is the default and remains available until the
     user revokes it or stops the Secure Session.
   - **Timed** remains available for the selected duration, up to 24 hours.
   - **One use** is atomically consumed by the next Secure Bash command, whether or
     not that command actually references the binding.
6. Continue working normally. The same task or timed lease is checked on every
   command from the manager or its eligible workers, so a 16-command workflow does
   not require 16 prompts.
7. Revoke one shared lease or stop Team Secure Mode to revoke the manager session and
   destroy its environment.

Every active task or timed grant is injected into every Secure Bash command and is
available to that command's child processes. This broad process scope is what
preserves ordinary Bash syntax; it is not a semantic promise that the value is used
only for the action the user had in mind. Grant narrowly and revoke promptly.

Secure Bash calls from one agent are serialized across their complete authorization
and execution boundary. Different eligible workers can execute concurrently in the
same manager container. Lease reservation, one-use consumption, grant changes, and
teardown remain serialized under the manager authority, so concurrent workers cannot
consume the same one-use lease twice or enter an environment after revocation.
Commands using a protected file binding are serialized because that binding promises
a stable guest path; environment, stdin, and askpass deliveries remain concurrent.

An agent can inspect safe session status and request an alias, binding, and lease
shape. If the alias does not exist, the agent can propose the missing secret by alias,
purpose, delivery, and lease only. The tool has no field for protected material.
Forge shows **Add secret and approve**, which opens a private entry dialog that saves
the value to the local vault and defaults to the current project. The requested alias,
delivery, and lease remain fixed while the prefilled display name can be edited. The
dialog can instead save it for all projects, mark it automatic for the current
project, or choose **Use for this task only** without keeping a reusable saved secret.
A browser that is not yet paired can start pairing from the request card, obtain
Desktop approval, and continue the same request without navigating to Settings.

The missing-secret dialog currently accepts local-vault material. To use Bitwarden,
first import its reference under **Settings → Secrets**; the agent can then request and
you can approve that saved catalog alias normally.

Requests and their approval cards stay outside the persisted transcript. Every
request belongs to the manager session. A worker request records the worker identity
for attribution, but approval adds the lease to the shared manager authority and does
not create worker-owned authority.

Delegation remains available in Team Secure Mode for eligible local Forge Pi workers.
Before an assignment is delivered, Forge validates the worker runtime, workspace, and
exact assignment generation, then binds its Secure Bash calls to the manager
container. Follow-up work and reassignment reuse the same session environment. A
captured runtime binding becomes invalid when its worker assignment changes, while
the manager leases and pending requests remain intact. Before later work begins,
Forge recycles only an idle worker model runtime that still holds a stale secure
binding; it does not recycle the shared container or its grants. A failed dispatch
does not change the sandbox. Stopping, deleting, or idling a worker does not affect
shared authority. Unsupported workers fail closed rather than receiving secure work
through a non-secure runtime.

Revision checks prevent a stale browser from overwriting a newer approval or
revocation. Provider failures, expired leases, missing aliases, unsupported delivery
methods, unavailable Docker, and output-guard failures all stop the operation without
falling back to plaintext or host execution.

## Security boundary

Secure Sessions make the following concrete promises for supported paths:

- model-originated input contains aliases and destinations, never secret material;
- public HTTP and WebSocket contracts contain metadata only;
- Docker CLI arguments, image configuration, and container inspect metadata do not
  contain the value;
- values enter the guest executor in a private binary frame on stdin, after the
  container has already started;
- output is matched as raw bytes across arbitrary chunk boundaries, including common
  Base64, Base64url, hexadecimal, URL, and JSON encodings;
- low-entropy values are buffered until command completion; harmless output is
  released, while an exact match is replaced by a fixed redaction marker without
  revealing its position;
- a final structured guard protects runtime events and provider context;
- successful output redaction completes the command normally and marks only that
  manager session as quarantined; the team can continue, a one-use lease is consumed
  when applicable, and task or timed leases remain available for later commands;
- the manager can stop Team Secure Mode to kill every tracked process and revoke the
  shared authority;
- stopping or failing a secure operation destroys the task container when safe
  filtering or process control cannot be guaranteed.

This is a **model-hidden execution** boundary, not a claim that arbitrary code cannot
use a value it legitimately receives. A process that receives a raw database password
can intentionally transform it, send it over the network, write it into the mounted
workspace, or install it on a remote host. Exact-value redaction is defense in depth
for accidental reflection; it cannot recognize every possible transformation.

The Docker backend also does not yet provide a destination-constrained credential
proxy or network allowlist. Broker-only profiles for HTTP signing, constrained SSH
signing, cloud request signing, and database authentication can provide a stronger
future boundary because the workload receives an operation rather than reusable
credential bytes.

This first backend is a conventional Docker container, not a microVM. It protects
host process and filesystem boundaries better than direct execution, but shares the
Docker host's kernel. The provider interface is intentionally replaceable so a
microVM backend can be added without changing vault, lease, approval, or redaction
contracts.

The workspace mount is writable by design. The manager and its workers can see and
modify the same selected workspace and run concurrently in the same container, so
their file and process changes can race. Secure Sessions protect unrelated host paths
and make hard process revocation reliable, but they do not protect team members from
one another or the selected workspace from authorized code. Give high-risk or
concurrently writing agents separate Git worktrees instead of relying on the secret
boundary for file isolation.

## Storage and lifecycle

`shared/state/secure-sessions.db` stores:

- provider and secret metadata;
- Electron-encrypted local values and provider credentials;
- backend-only provider locators;
- delivery bindings;
- project availability scopes and automatic-grant policies;
- revisioned session state, requests, leases, reservations, and fixed-field audit
  entries.

Plaintext values are resolved into bounded host memory only while an operation is
being prepared. Forge makes a best-effort zeroization of owned buffers after use.
JavaScript, operating-system, vault client, Docker daemon, and same-user process
boundaries remain part of the trusted computing base.

Secure Sessions assume a trusted, single-user local machine. Desktop mutations use a
random per-launch capability shared only between the Electron renderer and its backend
child. Approved browsers receive a separate revocable token with only Secure Sessions
control, secure-secret write, and private-entry write scope. The Desktop capability is
not persisted, logged, included in agent runtime state, or given to the browser.
Browser tokens are stored only as hashes, carried in HttpOnly SameSite cookies, and are
rejected for Desktop-only pairing administration. On HTTPS, that cookie is marked
`Secure`; the explicit trusted-network HTTP path instead relies on the user's private
network.

Remote private entry on HTTPS uses a process-lifetime P-256 Electron key and a
two-minute, context-bound, one-use challenge. The browser derives an ephemeral shared
key and AES-GCM encrypts the value before HTTP. The backend cannot decrypt the
envelope; Electron decrypts it and immediately returns only operating-system-sealed
ciphertext. The explicit trusted-network HTTP mode instead carries a bounded value to
Electron for immediate sealing, so its network and backend-process exposure is part of
the trusted computing base. Pairing verification, request revision checks, and fixed
secure errors remain defense in depth. Same-user process inspection, Electron
compromise, the approved browser, and the Docker daemon remain inside the trusted
computing base.

Each manager session keeps separate state, leases, requests, cached material, guard,
and container. A fork or different manager session never gains an active lease merely
because another session had one. Workers inherit only the live authority of their
own manager session. A worker assignment change invalidates bindings captured for the
old assignment but does not revoke, duplicate, or move session grants. Every command
passes a fresh manager-lease and assignment check. Forge removes legacy worker-owned
state during startup recovery and destroys orphaned managed containers rather than
attaching them to an unrelated session.

Startup recovery begins in the background and does not delay normal Forge readiness.
The Docker scan selects only containers carrying both Forge's managed label and the
current local execution-scope label. The first attempt to authorize Team Secure Mode
joins that same recovery promise and remains fail-closed until cleanup succeeds, so
startup stays responsive without allowing an orphaned container to overlap new secret
authority. Shutdown also joins an in-progress recovery before closing Secure Sessions
storage.

Each running container also receives a read-only bind mount of a host-owned dead-man
heartbeat file. Forge refreshes that file directly; the guest can only inspect its
modification time. If the Forge backend is terminated without cleanup, PID 1 exits
after 15 seconds, killing descendants and unmounting delivered material. The next
startup still performs confirmed orphan removal. The same host user and Docker daemon
remain trusted, so the heartbeat is crash cleanup and defense in depth rather than a
microVM-grade boundary.

Granting another secret, revoking a lease, consuming a one-use lease, or reaching a
timed expiry tears down the current process environment. This kills background
processes before a new credential set can be used. Container-only `/tmp` and home
state are therefore convenience state, not durable task storage; keep intended
results in the selected workspace. That container rebuild stays inside the same
manager-session authority, so the manager and worker model runtimes keep a valid
binding to the replacement environment. Stopping and later starting Team Secure
Mode creates a new authority generation and invalidates every older runtime binding.

Like ordinary local Bash, a command may launch a background descendant and return
after a short output-drain grace period. That descendant remains inside the same task
container until explicit revocation, expiry, session stop, crash heartbeat, or another
credential-set rebuild destroys it. Per-command RAM files and askpass helpers are
removed when the direct command exits, so background jobs that need long-lived access
should use an inherited environment binding or be launched by a foreground supervisor.

Secure Bash is Linux, even when Forge runs on macOS or Windows. On Windows, Forge uses
Docker Desktop's Linux-container engine and translates command working directories
under the host workspace to `/workspace`. Host-native binaries
and native `node_modules` may be incompatible, local services are not automatically
the container's `localhost`, and package installation writes into the selected
workspace. A dedicated worktree is strongly recommended for native dependency
installs or untrusted work. The integrated terminal and commands that require a real
interactive PTY with live input or resize are not intercepted; SSH password flows use
askpass instead. Non-interactive programs that merely require TTY file descriptors can
be run under the included `script -qec 'command' /dev/null` helper while their output
still passes through the secure guard.

## Operational troubleshooting

| Status | Meaning |
| --- | --- |
| Environment unavailable | Docker is unavailable, unsupported, or the runner image failed its contract check |
| Source locked or unavailable | Desktop safe storage, Bitwarden authentication, or the `bws` host command is unavailable |
| Automatic grant unavailable | This session's automatic grant was skipped; fix its source and choose **Apply now** after it recovers |
| Automatic grant binding conflict | This automatic grant was skipped because its saved delivery collides with another active or automatic delivery |
| Revision conflict | Another view changed the session; refresh before retrying |
| Protected output redacted | The guard removed protected material before it reached the agent; the shared session is quarantined but can continue, or you can stop Team Secure Mode |
| Unsupported runtime | This manager or worker cannot guarantee Forge-owned tools before provider continuation and fails closed |

Do not diagnose these failures by placing a value in chat, a shell command, an
environment file, or a bug report. Provider stderr and exception messages are
deliberately discarded or converted into fixed public codes because upstream errors
can contain sensitive response bodies.

## Readiness and migration recovery

The **Settings → Secrets** readiness panel checks the local Secure Bash backend,
private-entry bridge, and configured sources. **Copy safe diagnostics** includes only
bounded fixed execution/source codes and configured automatic-grant state. It never includes
secret values, ciphertext, provider responses, raw stderr, credentials, provider
locators, or catalog aliases.

Forge Desktop initializes private storage during application startup. If that attempt is
unavailable or cancelled, **Unlock private storage** retries operating-system credential
access and verifies the local vault in the same action. Starting Team Secure Mode also
retries when the current project's automatic grants depend on the local vault. **Test
vault** remains available for manual retries and migration recovery; it is not a
required routine step after unlocking.

When a Forge data directory is copied to another machine, aliases, bindings, scopes,
and automatic-grant policy can remain useful, but local-vault ciphertext and the
encrypted Bitwarden machine-account token remain bound to the original operating
system encryption context. Recover those sources under **Sources**:

- Choose **Test vault**. If saved local values cannot be decrypted, Forge lists the
  affected aliases and offers them one at a time. **Save and continue** replaces only
  that value while preserving its alias, bindings, scope, and automatic-grant policy. You can
  also skip or delete the alias.
- When a Bitwarden source reports **Reconnect required**, choose **Reconnect** and
  enter a new machine-account token. Forge verifies it before replacing only the
  encrypted credential; the connection and its imported aliases, bindings, scopes,
  and automatic-grant policies stay in place.
