## Secrets and Secure Sessions

**Settings → Secrets** manages private sources and reusable delivery bindings for
local Builder Team Secure Mode. Saving alone does not give a secret to an agent or
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

Right-click a local project header and choose **Project Secrets** to open this page
with that project preselected. The shortcut does not switch conversations or clear
the current draft.

## Add a local secret

Open **Secrets**, enter an alias, optional display name, and value. Choose its project
scope and, when appropriate, select projects under **Automatically grant in**. In
Desktop, the private bridge encrypts the value directly. A paired HTTPS browser
encrypts it to a one-use Desktop key before the Builder backend relays it. Electron
then seals it with the operating-system-backed secure storage service. Forge never
displays the value again.

To use private entry from the same running Builder in another browser, choose
**Pair this browser**, compare the six-digit code, and approve it under
**Settings → Secrets → Paired browsers** in Forge Desktop. Pairing is per browser,
persists across restarts, and can be revoked from Desktop. It does not expose the
Desktop master capability. Remote browser entry requires HTTPS; Remote Projects and
Collaboration remain separate hosts and do not inherit the local Desktop vault.

## Connect Bitwarden

Install the official Bitwarden Secrets Manager `bws` CLI on the trusted host. Under
**Sources**, connect a machine account. Then use **Secrets → Import Bitwarden secret
reference** to map a Bitwarden secret UUID to a Forge alias.

The machine token and Bitwarden UUID stay outside chat and public settings responses.
Forge retrieves a value only while preparing an approved use. A Bitwarden connection
removes repeated value entry. Bitwarden references support the same project scope and
automatic-grant policy as local-vault secrets.

## Grant a secret automatically

Under **Automatically grant in**, select one or more projects. An all-projects secret
can instead use **Every project**, which covers current projects and projects created
later. A selected-project secret can be granted automatically only in the projects
where it is available. Catalog availability alone never grants access.

Each selected policy gives the manager session one **Until Secure Session stops**
lease when Team Secure Mode starts. Eligible workers use that existing lease without
duplicating or re-resolving material. The policy does not put the value in standard
Bash, a model prompt, the integrated terminal, another project, or an unsupported
worker runtime.

Changing this setting while Team Secure Mode is active marks it **Configured**. Choose
**Apply now** in the shield to apply or retry non-active automatic grants for the
session without restarting. An unavailable source or conflicting delivery skips only
that grant and reports a fixed status without blocking other grants. Each project
supports at most 16 effective automatic grants.

Archiving a project preserves its project-only secrets and automatic-grant mappings.
Permanently deleting a project removes that project from selected-project entries,
deleting a secret only if it was the final selected project. It does not delete an
all-projects secret or its **Every project** policy.

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

1. Start Team Secure Mode.
2. Grant an alias and its bindings to the manager session.
3. Choose task, timed, or one-use access.
4. Let the agent keep using ordinary Bash across repeated commands.
5. Revoke one shared grant or stop Team Secure Mode to revoke the session.

Agent requests appear as private approval cards, not transcript messages. A request
belongs to the manager session; a worker identity is recorded only to show who asked.
A one-use grant means the session's next Secure Bash command and is consumed even if
the command does not reference the binding. Task and timed grants are injected into
every Secure Bash command from the manager or an eligible worker while active,
including child and background processes.

Eligible local Forge Pi workers remain available for delegation. Forge prepares each
worker by validating its runtime, workspace, and assignment before delivering secure
work through the manager container. Follow-ups and reassignments keep using the same
session environment. A stale assignment binding fails closed, while worker stop,
deletion, or idle status does not revoke the manager session. Unsupported worker
runtimes fail closed instead of receiving the work outside Team Secure Mode.

If the requested alias does not exist, the agent can propose its alias, purpose,
delivery, and lease. The tool cannot include or receive protected material. Choose
**Add secret and approve** to enter the value privately and save it to the local
vault. The requested alias, delivery, and lease remain fixed; the prefilled display
name is editable. The dialog defaults to the current project and can instead save to
all projects or make the secret automatic in the current project. Choose **Use for
this task only** when you do not want a reusable saved secret. A paired HTTPS browser
uses the same dialog and continues automatically after Desktop approves the pairing.

The missing-secret dialog currently saves local-vault material. Import a Bitwarden
reference under **Settings → Secrets** first when the source should be Bitwarden; the
agent can then request that saved alias normally.

## Know the boundary

Secure Sessions keep raw values out of model prompts, model-originated tool arguments,
Forge public events, history, and normal command output. Forge routes Pi's Bash tool
through a manager-session-owned Docker container and filters its output before it can
become model context. If protected output is found, Forge redacts it and marks the
shared session. The team can continue with task or timed grants still active, or you
can stop Team Secure Mode. File tools remain host-side and their structured
results pass through the active exact-value guard; the integrated terminal is not a
Secure Session path.

Software that receives a raw value can still intentionally transform it, send it over
the network, or write it to the selected workspace. Redaction catches common accidental
reflection; it is not protection from malicious code that is authorized to receive
the value. Team processes share the same container and selected workspace, so
concurrent file and process changes can race. Use separate Git worktrees for high-risk
or concurrently writing agents. The first release also has no
destination-constrained network proxy.

Secure Sessions currently require a Pi-backed local Builder runtime and the pinned
Forge Docker runner image. Supported local Forge Pi workers can participate with
the manager session's authority. Cursor SDK, Cursor ACP, Remote Projects,
Collaboration, Codex plugin/external-thread workers, and the integrated terminal are
not secure-session execution paths. Secure Bash is non-interactive pipe execution
rather than a PTY. SSH passwords work through the `SSH_ASKPASS` binding.
Non-interactive commands that only require TTY descriptors can use the runner's
`script` helper; live terminal input and resize remain unsupported.

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

After copying a Forge data directory to another machine, aliases and configuration can
remain valid while operating-system-sealed values cannot. Under **Sources**:

- **Test vault** is the manual retry and migration-recovery path. It identifies affected
  local aliases and offers them one at a time.
  Re-entering a value preserves its bindings, scope, and automatic-grant policy. You can
  also skip or delete it.
- **Reconnect** on a Bitwarden source verifies and replaces only its machine-account
  token. The connection and imported secret references stay in place.
