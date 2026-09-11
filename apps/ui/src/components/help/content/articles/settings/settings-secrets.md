## Secrets and Secure Sessions

**Settings → Secrets** manages private sources and reusable delivery bindings for
local Builder tasks. Saving alone does not give a secret to an agent or
task. Each manager session owns one secure container, one grant set, and one request
queue. Eligible local Forge Pi workers use that same session authority.

## Choose where an alias is available

Every saved local-vault or Bitwarden-backed secret has a scope:

- Check one or more projects to make it selectable only in those local projects.
- Check **All projects** to make it selectable in every local project, including
  projects created later.

Adding a secret from a project defaults to that project. If a selected-project secret
and an all-projects secret use the same alias, each selected project uses the
selected-project secret while other projects continue to use the all-projects secret.

Right-click a local project header and choose **Project Secrets**, or open
**Project Settings → Project secrets**, to open this page with that project
preselected. Neither route switches conversations or clears the current draft.

## Add a local secret

Open **Secrets**, enter an alias, optional display name, and value. Choose its project
scope and, when appropriate, select projects under **Granted to projects**. In
Desktop, the private bridge encrypts the value directly. A paired HTTPS browser
encrypts it to a one-use Desktop key before the Builder backend relays it. Electron
then seals it with the operating-system-backed secure storage service. A paired browser
can instead use **Trusted network mode** over HTTP only when a user or operator has
established that the network, such as a personal VPN, is trusted and private. Forge
cannot verify that assertion. The HTTP handoff carries the value through the Builder
backend only to the paired Electron vault for immediate sealing; it never enters chat,
agent tools, prompts, or saved secret metadata. HTTPS remains the stronger option;
never use HTTP mode on a public or untrusted network. Forge never displays the value
again.

To use private entry from the same running Builder in another browser, choose
**Pair this browser**, compare the six-digit code, and approve it under
**Settings → Secrets → Paired browsers** in Forge Desktop. Pairing is per browser,
persists across restarts, and can be revoked from Desktop. It does not expose the
Desktop master capability. Remote browser entry uses HTTPS by default and can use the explicit
trusted-network HTTP path only when a user or operator has established that the
connection is private and trusted. Remote Projects and Collaboration remain separate
hosts and do not inherit the local Desktop vault.

## Connect Bitwarden

Install the official Bitwarden Secrets Manager `bws` CLI on the trusted host. Under
**Sources**, connect a machine account. Then use **Secrets → Import Bitwarden secret
reference** to map a Bitwarden secret UUID to a Forge alias.

The machine token and Bitwarden UUID stay outside chat and public settings responses.
Forge retrieves a value only while preparing an approved use. A Bitwarden connection
removes repeated value entry. Bitwarden references support the same project scope and
automatic-grant policy as local-vault secrets.

## Grant a secret automatically

Under **Granted to projects**, select one or more projects. An all-projects secret
can instead use **Every project**, which covers current projects and projects created
later. A selected-project secret can be granted automatically only in the projects
where it is available. Catalog availability alone never grants access.

Agents in a granted project can use that secret automatically. There is no separate
start step. Forge prepares the shared protected environment on the first
`secure_bash` command and reuses it across eligible workers. Commands name only the
aliases they need; values never enter ordinary Bash or model prompts.

New grants and recovered sources are checked on the next protected command. If a
needed granted Bitwarden Password Manager source is locked, unlock it from the
chat shield and retry the command. Other unavailable sources still use **Unlock
secret sources**. Unrelated locked sources do not prompt at launch. An unavailable
source or delivery conflict skips only that grant. Each project
supports at most 50 effective secure grants by default, for both automatic grants
and one manual request batch. Change that limit under **Secure grants per project**
to a whole number from 1 to 256. Forge rejects a lower limit when any project already
has more automatic grants than the new value. Each saved secret still has at most 16
bindings.

Archiving a project preserves its project-only secrets and automatic-grant mappings.
Permanently deleting a project removes that project from selected-project entries,
deleting a secret only if it was the final selected project. It does not delete an
all-projects secret or its **Every project** policy.

## Bind a delivery shape

Under **Advanced delivery**, choose how an approved command receives the value:

- an environment variable;
- standard input;
- a protected file under `/run/forge-secure/bindings/`;
- an askpass helper;
- an execution-local SSH agent.

For a private SSH key, choose **SSH agent**. The agent selects the granted key aliases
needed by each `secure_bash` command. Forge loads only those keys into one short-lived agent and sets
`SSH_AUTH_SOCK` automatically. The agent can use ordinary `ssh`, `scp`, SFTP,
or SSH-backed Git commands without a private-key path. No private-key file is
created. The agent ends when the direct command ends; another command gets a new
agent while the session lease remains active. If OpenSSH cannot load the saved
key, the command reports a fixed key-rejected result without stopping the shared
session container. A binding is only a template. Task, timed, and one-use access
are chosen in the chat shield.

## Use the chat shield

Open the shield beside **Send** in a supported local Builder session:

Project grants work without opening this control. Use the shield to:

- Review the secrets available to this task and their source status.
- Pause secrets for the task and all its agents, or block only the selected worker.
- Restore an explicitly blocked secret, or grant additional temporary access.
- Revoke a grant. Revoking an inherited project secret also blocks it for this task
  until you restore it, so the next command cannot silently regrant it.

If a relevant granted Bitwarden Password Manager source is locked, the shield stays
labeled **Secrets** and turns yellow/amber. The popover says **Bitwarden vault
locked** and offers **Unlock Bitwarden vault** (or directs you to open Forge Desktop to unlock the vault). Other
unavailable sources still use **Unlock secret sources**. A pause or block takes
precedence over that warning.

A worker block resets the team's shared protected environment and interrupts
protected commands to stop retained processes. Access blocks survive restarts.
Forks inherit task pauses and blocked secrets; individual worker blocks stay with
the original task. Temporary grants are not copied. Unlocking a source does not
remove a block. Older tasks that previously used secrets and were stopped before
this update begin paused; restore access once in the shield.

Agent requests appear as private approval cards, not transcript messages. A request
belongs to the manager session; a worker identity is recorded only to show who asked.
A one-use grant is consumed by the next `secure_bash` command that selects its alias.
Task and timed grants remain available to the manager and eligible workers, but each
command receives only the active aliases it selects. The direct command's child
processes inherit that delivery. An SSH-agent socket is
intentionally command-local: a detached background process cannot keep using it after
the direct `secure_bash` command returns.

Eligible local Forge Pi workers remain available for delegation. Forge prepares each
worker by validating its runtime, workspace, and assignment before delivering secure
work through the manager container. Follow-ups and reassignments keep using the same
session environment. A stale assignment binding fails closed, while worker stop,
deletion, or idle status does not revoke the manager session. Unsupported worker
runtimes fail closed instead of receiving the work outside the protected environment.

If the requested alias does not exist, the agent can propose its alias, purpose,
delivery, and lease. The tool cannot include or receive protected material. Choose
**Add secret and approve** to enter the value privately. The private entry dialog supports an optional visible username for login construction, a password/passphrase generator, and **Store in** either the Forge local vault or a selected unlocked Bitwarden Password Manager collection. Saving as a Login/reference then continues the same approval. The requested alias, delivery, and lease remain fixed; the display name and username stay editable. The dialog defaults to the current project and can instead save to
all projects or make the secret automatic in the current project. Choose **Use for
this task only** when you do not want a reusable saved secret. A paired browser uses
the same dialog and continues automatically after Desktop approves the pairing; the
browser clearly labels the trusted-network HTTP path when it is active. A locked source must be unlocked before its collection appears as a destination, and saving still requires explicit user approval.

## Know the boundary

Secure Sessions keep raw values out of model prompts, model-originated tool arguments,
Forge public events, history, and normal command output. Forge keeps Pi's `bash` tool
on the host and adds a separate `secure_bash` tool backed by the manager-session-owned
Linux container. Only `secure_bash` receives approved values or Forge-managed SSH
trust. Output from both tools is filtered before Pi can accumulate or persist it. If
protected output is found, Forge redacts it and marks the shared session. The team can
continue with task or timed grants still active, or you can pause secret access.
File tools remain host-side and their structured results pass through the active
exact-value guard; the integrated terminal is not a Secure Session path.

Software that receives a raw value can still intentionally transform it, send it over
the network, or write it to the selected workspace. Redaction catches common accidental
reflection; it is not protection from malicious code that is authorized to receive
the value. Normal `bash` also retains the host user's ordinary PATH, credentials, and
developer-tool authority, which may include Docker control. This is intended for
trusted local agents and developers, not for isolating a malicious agent that controls
the same host account. Team processes share the same container and selected workspace, so
concurrent file and process changes can race. Use separate Git worktrees for high-risk
or concurrently writing agents. The first release also has no
destination-constrained network proxy.

Secure Sessions currently require a Pi-backed local Builder runtime and the pinned
Forge Docker runner image. Supported local Forge Pi workers can participate with
the manager session's authority. Cursor SDK, Remote Projects, Collaboration, Codex
plugin/external-thread workers, and the integrated terminal are not secure-session
execution paths. Secure Bash is non-interactive pipe execution
rather than a PTY. SSH passwords work through the `SSH_ASKPASS` binding.
Non-interactive commands that only require TTY descriptors can use the runner's
`script` helper; live terminal input and resize remain unsupported.

On Windows, normal `bash` is normally Git Bash and keeps access to Windows-integrated
tools such as authenticated Git and GitHub CLI. `secure_bash` is Linux inside Docker
Desktop, with the workspace mapped to `/workspace`; prefer relative paths there.

## Check readiness and recover a copied data directory

The readiness panel checks Secure Bash, private entry, and configured sources.
**Copy safe diagnostics** includes bounded fixed status codes and
configured automatic-grant state only. It never includes values, ciphertext, provider output,
raw errors, credentials, locators, or aliases.

Forge Desktop initializes private storage during application startup. If that startup
attempt is unavailable or cancelled, **Unlock private storage** retries the
operating-system credential request and immediately verifies the local vault after a
successful unlock. Starting Team Secure Mode also retries when the current project's
automatic grants require the local vault. You do not need to run **Test vault** as a
routine second step.

Copying the Forge data directory alone does not migrate saved values because the
operating-system seal is machine-bound. For a one-time move, open **Sources → Move
vault to another machine**:

1. On the old machine, export the encrypted transfer file and save its displayed code
   separately. Forge does not store the code.
2. Quit Forge without changing the vault, then copy the Forge data directory and the
   transfer file to the new machine.
3. Start Forge on the new machine, unlock private storage, and import the file with its
   code. Forge verifies the copied database and atomically re-seals saved local values
   and Bitwarden credentials for the new machine.
4. Test the vault and connected sources, then delete the transfer file and code.

This transfer control is available only in Forge Desktop, not in a paired browser. If
the old machine or transfer is unavailable, **Test vault** still offers affected local
aliases one at a time, and **Reconnect** replaces a Bitwarden machine-account token.
Those fallback actions preserve the existing aliases, bindings, scopes, and automatic
grant policy.
