# Secure Sessions research and architecture decision

This document records the research behind Forge Secure Sessions and the decision
implemented in this branch. It is intentionally separate from the
[user and operator guide](SECURE_SESSIONS.md).

Research was refreshed in July 2026 against current product documentation,
repositories, and a privacy-preserving aggregate scan of real Forge sessions.

## Executive decision

Forge should own a provider-neutral secret, lease, audit, redaction, and execution
contract. The first implementation should use one persistent task sandbox beneath
normal Forge coding tools, with protocol-specific credential brokers added over time.

This structure preserves the interaction that matters:

```text
agent sends normal Bash or file-tool request
  -> Forge checks a task/timed/one-use lease
  -> trusted host resolves local-vault or Bitwarden material
  -> task execution backend delivers it after the model boundary
  -> Forge filters output before runtime/provider/history/UI consumers
```

It avoids three designs that do not meet the product need:

1. Putting a value in chat, a prompt, a tool argument, a normal environment setting,
   or Docker CLI metadata.
2. Requiring a special tool for every authenticated program or every one of many
   commands in a task.
3. Limiting the feature to outbound HTTPS credential substitution.

The initial Docker-container backend is deliberately replaceable. It is the fastest
way to validate Bash fidelity, repeated commands, SSH/password-style flows, database
clients, files, teardown, and the complete Forge UI on the current development
machine. It is not the end-state answer for maximum isolation or broker-only
credential use.

## What the Forge codebase required

The existing code made a vault-only change insufficient:

- ordinary shared secret settings are plaintext JSON and can become backend-wide
  environment values;
- Pi Bash can accumulate full output before Forge's outer conversation projector sees
  it;
- provider-native tools can bypass Forge-owned execution hooks;
- tool results flow into live events, JSONL history, replay, extensions, observability,
  error paths, and subsequent provider context;
- runtime lifecycle, WebSocket bootstrap, and replay must agree on the same
  authoritative state.

The implementation therefore puts enforcement at two inner boundaries:

1. A Forge-owned Pi coding-tool layer delivers only already-guarded command output.
2. A runtime event/provider-context guard protects structured values before the
   remaining Forge and model consumers.

Unsupported provider runtimes fail before a Secure Session begins. A public metadata
contract is defined in `packages/protocol`; raw values, ciphertext, and provider-side
locators remain backend-only.

## Real Forge workload census

We performed a content-blind full census of the isolated Forge data copy without
exporting message bodies, identifiers, tool results, provider payloads, authentication
material, or secret-looking values. It streamed all 1,265 canonical session histories:
7.29 GiB and 2,307,597 JSONL records. The aggregate set contained 13,640 canonical
user-role messages across 1,249 sessions with zero parse failures.

The strongest execution signals were:

| Workflow signal | Messages | Sessions |
| --- | ---: | ---: |
| Package, build, test, or development server | 3,526 | 425 |
| Browser, desktop, or UI automation | 1,432 | 287 |
| Shell or local command | 1,045 | 212 |
| System, service, or process management | 882 | 660 |
| Git, GitHub, or source control | 498 | 153 |
| HTTP or API operation | 492 | 155 |
| Docker, container, or VM | 487 | 99 |
| Key, password, token, or certificate language | 511 | 104 |
| Interactive, PTY, or sudo language | 401 | 137 |
| SSH, SCP, SFTP, or rsync | 242 | 42 |
| Database client or protocol | 186 | 70 |
| Remote secret installation or configuration | 180 | 59 |
| Cloud CLI or control plane | 114 | 28 |

Categories overlap and are bounded language predicates, not proof a tool ran or a
security classification. Only canonical `conversation_message/user` records were
selected; assistant text, tools, auth/configuration stores, caches, and worker logs
were excluded.

The direct architectural consequence is that HTTPS-only substitution would not cover
the majority of the interesting authenticated workflows. SSH, raw database protocols,
cloud signing, password prompts, certificates, remote installation, and programs that
must compute with a value all require either general process delivery or a
protocol-specific broker.

## Security tiers

The phrase “the agent cannot see a secret” hides materially different guarantees.
Forge should keep these tiers explicit.

| Tier | Workload receives raw value? | Main protection | Coverage |
| --- | --- | --- | --- |
| Prompt-safe only | Possibly | Value stays out of chat and tool arguments | Storage/UI ingress |
| Model-hidden execution | Yes, in the selected child | Sandbox lifecycle plus pre-observation filtering | General Bash, SSH askpass, databases, files, arbitrary CLIs |
| Broker-only operation | No | Host proxy/signer performs a constrained operation | Supported HTTP, signing, SSH, cloud, or database profiles |

The current implementation is the second tier. It prevents accidental model/provider
and durable-history disclosure on supported paths, while containing processes in a
task-owned environment. It does not claim that malicious code cannot use or transform
a value it legitimately receives.

Broker-only is stronger but cannot replace general execution. It should be added for
high-value protocols where a stable operation boundary exists.

## Modern sandbox landscape

### Docker Sandboxes

[Docker Sandboxes](https://docs.docker.com/ai/sandboxes/) is the most polished current
local product reference. It provides a persistent microVM, same-absolute-path workspace
mounts, `sbx exec`, a private Docker daemon, host network policy, and host-side
credential injection. Its [credential design](https://docs.docker.com/ai/sandboxes/security/credentials/)
places a sentinel in the VM and substitutes the real value in approved outbound
requests. Its [default posture](https://docs.docker.com/ai/sandboxes/security/defaults/)
blocks unapproved HTTP(S), raw TCP/UDP, private ranges, host files outside the
workspace, and the host Docker daemon.

It is the best fast-path product backend when its Docker account, daemon, telemetry,
governance, and proprietary CLI dependency are acceptable. The current Forge
implementation uses ordinary Docker rather than `sbx`, because `sbx` was not installed
on the validation machine and does not presently expose the stable embedded Node
contract Forge needs.

### Matchlock

[Matchlock](https://github.com/jingkaihe/matchlock) is the closest open-source project
to the complete desired boundary: Firecracker or Apple Virtualization microVMs, normal
execution, network allowlisting, MITM-based host secret substitution, and SDK control.
Its own repository labels it experimental. It deserves the first embedded/open bakeoff,
especially because its network hooks can support response rewriting as well as request
injection.

### Microsandbox

[Microsandbox](https://github.com/superradcompany/microsandbox) is the strongest
daemonless embedded architecture candidate. It uses local microVMs, has multiple SDKs,
normal command and lifecycle APIs, and a host-side placeholder secret model. Current
package documentation states that the real value stays on the host and is substituted
only for allowed network destinations.

The adoption gate is its provider handoff. Forge must prove that values can be supplied
through a non-persistent callback or in-memory channel; an SDK call that writes raw
values into sandbox configuration would expand the durable secret surface.

### BoxLite

[BoxLite](https://github.com/boxlite-ai/boxlite) is a credible Apache-2.0 alternate:
daemonless embedding, OCI images, PTY/stream execution, persistent boxes, disks,
snapshots, and cross-platform SDKs. Its execution plane is well documented, but its
secret-routing guarantees are not yet documented as precisely as Matchlock,
Microsandbox, Docker, or Daytona. The secret path needs source-level audit and
adversarial testing before selection.

### Nono

[Nono](https://nono.sh/credential-injection) is the best host-native fallback. It uses
operating-system sandboxing, command shims, and phantom credentials so the agent can
continue invoking tools such as Git, `gh`, curl, and Kubernetes clients by their normal
names. It preserves host toolchain fidelity better than a Linux guest, but it is not a
hypervisor boundary.

### Hosted references

[Daytona](https://www.daytona.io/docs/en/secrets/) currently documents the clearest
broker-only behavior: opaque placeholders, HTTPS-header-only substitution for allowed
hosts, and response scrubbing that changes a reflected real value back to the
placeholder before it reaches the sandbox. This proves the proxy/scrub design is
practical, but the HTTPS restriction is exactly why it is only one layer of the Forge
answer.

[Vercel Sandbox](https://vercel.com/changelog/safely-inject-credentials-in-http-headers-with-vercel-sandbox)
is a strong policy reference for live, domain-bound header injection outside the VM.
Its later request proxying and filtering provide a useful route toward
method/path/header-aware capabilities.

E2B, Fly Sprites/Machines, Modal, and Cloudflare Sandbox are credible remote compute
backends. Their documented general secret modes do not independently solve arbitrary
non-extractable credentials for Forge; they would need the same Forge-owned provider
and broker layer.

## Credential and proxy projects worth borrowing

| Project | Useful idea | Forge conclusion |
| --- | --- | --- |
| [iron-proxy](https://docs.iron.sh/) | Default-deny egress, DNS/TLS handling, secret providers, fixed-field audit | Strong candidate for a future boundary proxy; response scrubbing must be proven |
| [Airut](https://airut.org/) | Transparent allowlisting, format-preserving surrogates, AWS SigV4 re-signing | Best detailed reference for cloud signing and foreign-credential stripping |
| [Infisical Agent Vault](https://github.com/Infisical/agent-vault) | Agent proposals, session leases, proxy use, approval lifecycle | Good approval/audit semantics; optional enterprise provider |
| [OneCLI](https://onecli.sh/blog/bitwarden-agent-access-sdk-onecli) | Bitwarden Agent Access plus request-time gateway injection | Strategic personal-vault/interactive approval path |
| [Dagger secret providers](https://docs.dagger.io/getting-started/types/secret/) | Provider-neutral references such as environment, file, command, 1Password, Vault, and AWS | Useful provider syntax; normal Dagger secret env/file delivery is still workload-readable |

## Bitwarden decision

Bitwarden supports both a current [Secrets Manager SDK](https://bitwarden.com/help/secrets-manager-sdk/)
with Node-API bindings and its official [`bws` CLI](https://bitwarden.com/help/secrets-manager-cli/).
The SDK can authenticate with a machine access token and retrieve one or more secrets.
The CLI documentation explicitly shows that `bws run` injects secrets as environment
variables and warns that untrusted child commands gain access.

Forge therefore does not expose `bws run` to the agent. The first adapter invokes
`bws secret get` only in the trusted host source process, with:

- an Electron-encrypted machine token;
- an isolated temporary home/config root;
- bounded stdout captured in memory;
- discarded provider stderr;
- fixed public error codes;
- no Bitwarden process inside the task container.

The official Node-API SDK is the preferred follow-up once its packaged native binaries,
Electron/backend ABI behavior, self-hosted endpoint configuration, and error-containment
path pass Forge's release matrix.

Bitwarden Agent Access plus a gateway such as OneCLI is a separate strategic path for
personal-vault, user-approved broker-only access. It should not be conflated with
organization Secrets Manager machine accounts.

## Why ordinary Docker was selected for the first implementation

The development machine already had Docker Desktop and could exercise the end-to-end
contract immediately. The task container supplies:

- reuse across 16 or more commands;
- same-path workspace behavior;
- stdin, environment, protected file, and askpass delivery;
- real OpenSSH client behavior against a disposable SSH server;
- explicit cancellation, timeout, detached-child, hard-revoke, and orphan-recovery
  tests;
- inspectable metadata proving values do not appear in Docker arguments or container
  configuration.

The execution backend never uses `docker exec -e VALUE`, `docker run -e VALUE`,
plaintext workspace files, or secret-bearing CLI arguments. A fixed guest executor
receives a bounded binary stdin frame after the container is running.

The tradeoff is important: a conventional container shares Docker's Linux kernel and
the selected workspace is directly writable. This is a useful execution and lifecycle
boundary, not the same assurance as Docker Sandboxes, Matchlock, Microsandbox, or
BoxLite microVM isolation.

## Output filtering decision

Redaction is defense in depth, not credential containment. The implementation follows
lessons from mature CI runners:

- raw byte matching rather than independently decoded chunks;
- state carried across arbitrary chunks and across stdout/stderr emission boundaries;
- longest/overlap-safe matching;
- bounded common encodings;
- end-buffering for short or low-entropy values, with whole-result quarantine only
  when an exact registered form matches or safe processing cannot complete;
- filtering before the Pi output accumulator;
- structured filtering again before Forge events and provider context.

It cannot recognize arbitrary transformations, character-at-a-time disclosure,
encryption, compression, screenshots, network-only exfiltration, or a value written to
an unobserved external system. This limitation is fundamental rather than a missing
regular expression.

## Acceptance gates

The implementation is not complete merely because a settings screen exists. Required
gates are:

1. A synthetic canary appears nowhere in tool arguments, Docker CLI arguments,
   inspect metadata, host logs, temp files, JSONL, WebSocket events, replay,
   extensions, observability, UI state, or provider-spy requests.
2. Raw and supported encoded reflections are sanitized across every chunk boundary.
3. Sixteen protected and unprotected commands reuse one task sandbox without repeated
   secret entry.
4. Environment, stdin, protected file, askpass, real SSH, HTTP reflection, database
   client shape, cancellation, timeout, background descendants, revoke, and restart
   paths are exercised.
5. One-use reservation is atomic; task/timed leases expire or revoke without unsafe
   fallback.
6. Docker, source, safe-storage, guard, runtime, and revision failures are
   distinguishable through fixed non-secret codes.
7. The actual Electron UI is validated with an isolated copy of Forge data and
   provider authentication, while schedules, goals, notifications, terminals,
   extensions, tunnels, collaboration, and observability are quarantined.
8. Security and UX reviews have no unresolved critical finding.

## Forward path

The current provider-neutral contract should be retained while the assurance level
improves:

1. Finish and measure the Docker end-to-end path.
2. Add an egress proxy and broker-only profiles for HTTP, Git, cloud signing,
   constrained SSH signing, and selected databases.
3. Bake off Matchlock, Microsandbox, and BoxLite with the same conformance suite.
4. Prefer an embedded microVM backend once private non-persistent value delivery,
   workspace fidelity, PTY behavior, packaging, and cross-platform operation are
   proven.
5. Keep a clearly labeled host-native Nono-style fallback when virtualization is
   unavailable.

The stable product concept is not “Docker secrets” or “an HTTPS proxy.” It is a
task-scoped capability plane in which Forge owns consent and lifecycle, the execution
provider owns containment, vault providers own storage, and the model receives only
metadata and guarded results.
