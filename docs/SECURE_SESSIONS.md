# Secure Sessions

Secure Sessions let a local Builder task use an approved secret without putting the
secret value in chat, a model prompt, tool arguments, WebSocket messages, or the
conversation transcript. The agent continues to call the ordinary Pi Bash and file
tools. Forge routes Bash through the secure execution plane and resolves approved
values only after the tool call has reached that local boundary.

This feature is designed for the practical middle ground between two unsafe extremes:
giving the model a password and building a special-purpose tool for every command that
might need one.

## What a Secure Session is

A Secure Session belongs to one local Builder manager task. While it is active:

- Pi Bash commands run in one reusable, task-owned Linux container;
- the workspace is mounted directly into the container (at the same path on
  macOS/Linux and at `/workspace` on Windows);
- approved values can be delivered to a command as an environment variable, stdin,
  a protected RAM-backed file, or an askpass helper;
- one task or timed grant can be reused across many commands;
- every Bash output byte is filtered before the Pi tool accumulator, Forge events,
  persistence, extensions, UI, or the next provider request;
- host-side file-tool results pass through the same active exact-value guard before
  they can be returned to the runtime;
- stopping the Secure Session revokes its leases and destroys the container and its
  descendant processes.

The agent sees only catalog aliases, delivery destinations, lease status, and fixed
error codes. It cannot ask the Secure Sessions tools to return a stored value or a
provider locator.

Secure Sessions are currently available only for local Builder sessions using a
Pi-backed runtime. Claude SDK, Cursor SDK, Remote Projects, Collaboration channels,
and ordinary integrated terminals fail closed or do not expose the control.

## Set up the execution environment

Secure Sessions currently use Docker as a replaceable first execution backend. Build
the pinned runner image from the repository root:

```bash
docker build \
  --tag forge-secure-runner:node22-v4 \
  --file apps/backend/src/swarm/secure-sessions/execution/Dockerfile.secure-runner \
  apps/backend/src/swarm/secure-sessions/execution
```

The image is based on the pinned Node 22 runtime and includes Bash, Git, curl, jq,
OpenSSH client, PostgreSQL client, Python 3, rsync, npm, the repository's pinned pnpm,
the `script` PTY helper, and a Debian build toolchain. Forge checks the runner contract
label before offering the environment. It does not silently fall back to host
execution if Docker or the image is unavailable.

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

Open **Settings → Secrets** in Forge Desktop. The browser-only UI can display metadata,
but private value entry requires the Desktop bridge.

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

Under **Secrets**, import a Bitwarden secret UUID and assign a Forge alias. Forge keeps
the UUID and encrypted machine credential backend-only. When an approved command needs
the value, the trusted host invokes `bws` with an isolated temporary configuration
directory, captures a bounded response in memory, and removes that directory.

Bitwarden is a long-lived source, not a permanent task grant. Reusing a task grant does
not require re-entering the value, but every task still needs an explicit lease.

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

## Start, grant, reuse, and revoke

1. Open a local Builder manager whose current runtime is supported.
2. Select the shield beside **Send** and start a Secure Session.
3. Select one or more saved aliases. Forge gives a newly saved secret a stable,
   generated environment delivery automatically; advanced saved bindings remain
   available when a specific askpass, file, stdin, or environment shape is needed.
4. Choose a lease:
   - **Until Secure Session stops** is the default and remains available until the
     user revokes it or stops the Secure Session.
   - **Timed** remains available for the selected duration, up to 24 hours.
   - **One use** is atomically consumed by the next Secure Bash command, whether or
     not that command actually references the binding.
5. Continue working normally. The same task or timed lease is checked on every
   command, so a 16-command workflow does not require 16 prompts.
6. Revoke an individual lease, or stop the Secure Session to revoke everything and
   destroy the environment.

Every active task or timed grant is injected into every Secure Bash command and is
available to that command's child processes. This broad process scope is what
preserves ordinary Bash syntax; it is not a semantic promise that the value is used
only for the action the user had in mind. Grant narrowly and revoke promptly.

Secure Bash calls for one task are serialized across their complete authorization,
execution, and teardown boundary. This is intentional: two model-requested Bash calls
cannot race one-use consumption or enter the old container while the first call is
destroying it. Different tasks can still execute in parallel.

An agent can inspect safe session status and request an alias, binding, and lease
shape. Requests appear as private approval cards outside the persisted transcript.
Secure grants remain manager-local. Forge blocks spawning, retrying, or assigning
workers while Secure Mode is active; stop Secure Mode before delegating work.

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
- successful output redaction completes the command normally, consumes a one-use
  lease when applicable, and leaves task or timed leases available for later commands;
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

The workspace mount is writable by design. Secure Sessions protect unrelated host
paths and make hard process revocation reliable, but they do not protect the selected
workspace from the task. Use a dedicated worktree for untrusted or destructive work.

## Storage and lifecycle

`shared/state/secure-sessions.db` stores:

- provider and secret metadata;
- Electron-encrypted local values and provider credentials;
- backend-only provider locators;
- delivery bindings;
- revisioned session state, requests, leases, reservations, and fixed-field audit
  entries.

Plaintext values are resolved into bounded host memory only while an operation is
being prepared. Forge makes a best-effort zeroization of owned buffers after use.
JavaScript, operating-system, vault client, Docker daemon, and same-user process
boundaries remain part of the trusted computing base.

The initial Secure Sessions release assumes a trusted, single-user local machine.
Every mutation of secret or lease authority requires a random per-launch capability
shared only between the Electron main renderer and its backend child. The capability
is not persisted, logged, included in agent runtime state, or given to managed-browser
popouts. Origin and loopback checks remain defense in depth. Same-user process
inspection, Electron compromise, and the Docker daemon remain inside the trusted
computing base.

Forks, resumed runtimes, and workers never gain an active lease merely because another
session had one. A stopped session must pass a fresh lease check before another
credentialed command. Forge recovers and destroys orphaned managed containers rather
than attaching them to an unrelated task.

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
results in the selected workspace.

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
| Revision conflict | Another view changed the session; refresh before retrying |
| Protected output redacted | The guard removed protected material before it reached the agent; the Secure Session can continue |
| Unsupported runtime | The current runtime cannot guarantee Forge-owned tools before provider continuation |

Do not diagnose these failures by placing a value in chat, a shell command, an
environment file, or a bug report. Provider stderr and exception messages are
deliberately discarded or converted into fixed public codes because upstream errors
can contain sensitive response bodies.
