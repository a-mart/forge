## Secrets and Secure Sessions

**Settings → Secrets** manages private sources and reusable delivery bindings for
local Builder Secure Sessions. Saving alone does not give a secret to an agent or
task. An automatic project default receives a lease only when Secure Mode starts.

## Choose where an alias is available

Every saved local-vault or Bitwarden-backed secret has a scope:

- **Only this project** makes it selectable in one local project.
- **All projects** makes it selectable in every local project.

Adding a secret from a project defaults to that project. If both scopes contain the
same alias, that project uses its project-scoped secret while other projects continue
to use the all-projects secret.

## Add a local secret

Open Forge Desktop, choose **Secrets**, and enter an alias, optional display name, and
value. Choose its project scope and optionally mark it **Automatically available in
this project**. Desktop encrypts the value with the operating-system-backed secure
storage service before the local Builder stores it. Forge never displays the value
again.

Private entry is disabled in an ordinary browser, on a remote origin, or when the
operating system does not provide an acceptable encryption backend.

## Connect Bitwarden

Install the official Bitwarden Secrets Manager `bws` CLI on the trusted host. Under
**Sources**, connect a machine account. Then use **Secrets → Import Bitwarden secret
reference** to map a Bitwarden secret UUID to a Forge alias.

The machine token and Bitwarden UUID stay outside chat and public settings responses.
Forge retrieves a value only while preparing an approved use. A Bitwarden connection
removes repeated value entry. Bitwarden references support the same project scope and
project-default policy as local-vault secrets.

## Make a secret a project default

**Automatically available in this project** gives the secret an **Until Secure
Session stops** task lease when Secure Mode starts in that project. It does not put the
value in standard Bash, a model prompt, a worker, the integrated terminal, or another
project.

Changing this setting while Secure Mode is already active does not silently attach the
secret. Use the current **Grant access** flow to grant it explicitly, or stop and
restart Secure Mode. An unavailable source or a conflicting delivery skips that
default and reports its fixed status without blocking other defaults or session
startup.

Archiving a project preserves its project-only secrets and defaults. Permanently
deleting the project removes its project-only secrets and default mappings, but does
not delete an all-projects secret.

## Bind a delivery shape

Under **Advanced delivery**, choose how an approved command receives the value:

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

If the requested alias does not exist, the agent can propose its alias, purpose,
delivery, and lease. The tool cannot include or receive protected material. Choose
**Add secret and approve** to enter the value privately in Forge Desktop and save it
to the local vault. The dialog defaults to the current project and can instead save to
all projects or make the secret automatic in the current project. Choose **Use for
this task only** when you do not want a reusable saved secret.

The missing-secret dialog currently saves local-vault material. Import a Bitwarden
reference under **Settings → Secrets** first when the source should be Bitwarden; the
agent can then request that saved alias normally.

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
