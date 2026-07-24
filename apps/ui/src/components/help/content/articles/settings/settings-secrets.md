## Secrets and Secure Sessions

**Settings → Secrets** manages private sources and reusable delivery bindings for
local Builder Secure Sessions. Saving a secret does not give it to an agent or task.

## Add a local secret

Open Forge Desktop, choose **Secrets**, and enter an alias, optional display name, and
value. Desktop encrypts the value with the operating-system-backed secure storage
service before the local Builder stores it. Forge never displays the value again.

Private entry is disabled in an ordinary browser, on a remote origin, or when the
operating system does not provide an acceptable encryption backend.

## Connect Bitwarden

Install the official Bitwarden Secrets Manager `bws` CLI on the trusted host. Under
**Sources**, connect a machine account. Then use **Secrets → Import Bitwarden secret
reference** to map a Bitwarden secret UUID to a Forge alias.

The machine token and Bitwarden UUID stay outside chat and public settings responses.
Forge retrieves a value only while preparing an approved use. A Bitwarden connection
removes repeated value entry, but does not automatically grant any task.

## Bind a delivery shape

Under **Bindings**, choose how an approved command receives the value:

- an environment variable;
- standard input;
- a protected file under `/run/forge-secure/bindings/`;
- an askpass helper.

SSH-agent forwarding is reserved but not currently supported. A binding is only a
template. Task, timed, and one-use access are chosen in the chat shield.

## Use the chat shield

Open the shield beside **Send** in a supported local Builder session:

1. Start the Secure Session.
2. Grant an alias and its bindings.
3. Choose task, timed, or one-use access.
4. Let the agent keep using ordinary Bash across repeated commands.
5. Revoke one grant or stop the Secure Session to destroy its container and revoke all
   active access.

Agent requests appear as private approval cards, not transcript messages. Workers do
not automatically inherit manager grants. A one-use grant means the next Secure Bash
command and is consumed even if that command does not reference the binding. Task and
timed grants are injected into every Secure Bash command while active, including child
and background processes.

## Know the boundary

Secure Sessions keep raw values out of model prompts, model-originated tool arguments,
Forge public events, history, and normal command output. Forge routes Pi's Bash tool
through a task-owned Docker container and filters its output before it can become model
context. File tools remain host-side and their structured results pass through the
active exact-value guard; the integrated terminal is not a Secure Session path.

Software that receives a raw value can still intentionally transform it, send it over
the network, or write it to the selected workspace. Redaction catches common accidental
reflection; it is not protection from malicious code that is authorized to receive
the value. The first release also has no destination-constrained network proxy.

Secure Sessions currently require a Pi-backed local Builder runtime and the pinned
Forge Docker runner image. Claude SDK, Cursor SDK, Remote Projects, Collaboration, and
the integrated terminal are not secure-session execution paths. Secure Bash is
non-interactive pipe execution rather than a PTY. SSH passwords work through the
`SSH_ASKPASS` binding. Non-interactive commands that only require TTY descriptors can
use the runner's `script` helper; live terminal input and resize remain unsupported.
