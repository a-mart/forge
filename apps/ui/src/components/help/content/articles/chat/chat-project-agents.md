Project agents are specialized sessions with persistent identities that other sessions can discover and message. Use them for cross-session coordination on recurring tasks like documentation, releases, or domain-specific work.

**Local to Forge** definitions alone use `profiles/<profileId>/project-agents/<handle>/`, with an editable Settings prompt, optional reference documents, and a live **Can create sessions** capability. **Repository `.forge`** placement writes `.forge/project-agents/<handle>/` and does not create a Forge-data definition sidecar; session history stays local. Repo-sourced definition fields are read-only in Settings and are edited in the repository files.

## Two ways to create

### Agent Creator wizard

Right-click a profile header in the sidebar and choose **Create Project Agent**. This opens a new session with the Agent Architect archetype.

The wizard flow:

1. **Repo exploration** — The Agent Architect scans your repository to understand its structure and existing agents.
2. **Interview** — You're asked 2-3 focused questions about the new agent's role and scope.
3. **Proposal** — The architect drafts a configuration including handle, location (**Local to Forge** or **Repository `.forge`**), "when to use" blurb, and role instructions for the `systemPrompt` field. Local-to-Forge definitions alone use `profiles/<profileId>/project-agents/<handle>/`. Repository placement writes `.forge/project-agents/<handle>/config.json` and required `prompt.md` with no Forge-data definition sidecar; session history stays local either way.
4. **Creation** — After you approve, the agent is atomically created and promoted to a project agent.

Repositories can also define Project Agents under `.forge/project-agents/<definitionId>/`. Valid definitions appear in the sidebar as inactive/repo-defined rows; clicking one opens the Repository Resources activation sheet. Repo-defined agents remain unavailable until they are activated or linked.

The wizard session shows a violet Sparkles icon in the sidebar. Once the agent is created, the wizard session auto-hides but remains accessible via "View Creation History" on the created agent's context menu.

### Manual promotion

Right-click any existing session and choose **Promote to Project Agent**. A settings drawer opens where you fill in:

- **Handle** — A unique identifier like `@releases` or `@docs`. Must be unique within the profile and cannot change after promotion.
- **Location** — **Local to Forge** (default) or **Repository `.forge`**. Local definitions stay in `profiles/<profileId>/project-agents/<handle>/`. Repository placement writes `.forge/project-agents/<handle>/` and needs a Git root or valid `.forge` override. It does not create a Forge-data definition sidecar. Session history stays local.
- **When to use** — A description that tells other sessions when to message this agent.
- **Role instructions** — Custom instructions tailored to the agent's role, stored in `prompt.md` and layered with Forge's Project Agent base prompt. Optional for local placement; required for repository placement. After promotion, local agents edit this in Settings; repo-sourced agents edit the repository `prompt.md`.
- **Can create sessions** — For local agents, this remains a live Settings toggle. For repository agents, capabilities are chosen when you activate or re-link, not as a live Settings toggle.
- **Reference docs** — Optional markdown documents scoped to this agent and injected into its prompt context. For local agents, add them from Project Agent Settings by entering a filename and content, or importing a `.md` / `.txt` file. Repository references live under `.forge/project-agents/<definitionId>/reference` and are read-only in Settings.

Click **Generate recommendations** to have AI suggest both the "when to use" text and role instructions based on the session's conversation history. You can edit the suggestions before saving.

## Using project agents

Project agents appear pinned at the top of their profile section in the sidebar with a badge. Click one to open its conversation. Sessions created by a project agent can show a subtle `Created by @handle` label in the sidebar.

To message a project agent from another session, mention its handle in your message (the composer offers autocomplete when you type `@`). Autocomplete includes local agents in the current profile and shared agents explicitly granted from another profile; shared agents are labeled separately so you can tell them apart. The manager interprets your intent and uses the `send_message_to_agent` tool to deliver the message asynchronously. If a project agent created the session, it can keep messaging that session through the same routing path.

Messages to project agents are fire-and-forget — there's no reply threading. The exchange still appears chronologically in both participating Builder conversations: the open session's messages use a deep-blue bubble on the right, while peer replies use a lighter sky-blue bubble on the left. Ordinary worker coordination stays out of the normal Web conversation. If the receiving session is idle, Forge wakes it up to handle the incoming work. Project Agent sends reject attachments, so send text instructions and references instead of attached files.

## Sharing project agents

Project Agent sharing is source-owned and stays editable in Settings for both local and repository-sourced agents. Open the source agent's settings to grant or remove access for another profile. A target profile can discover a shared agent only after that grant exists, through its external/shared-agent directory and @mention autocomplete.

Shared/external turns are constrained. They do not inherit source-only capabilities from target sessions, and Forge sanitizes shared-agent metadata and prompt rendering before showing it outside the source profile.

## Managing project agents

Right-click a project agent to access:

- **Project Agent Settings** — For local agents, edit the "when to use" text, role instructions, reference docs, and the **Can create sessions** capability. For repository-sourced agents, those definition fields are read-only in Settings and are edited in the repository files; capabilities are chosen at activation or re-link rather than a live Settings toggle. Sharing stays source-owned and editable for both. You can regenerate recommendations for local agents here too. Sharing changes refresh affected runtime prompts so source and target sessions pick up the updated directory. The settings drawer is resizable from its left edge and confirms before discarding unsaved changes.
- **View Creation History** — Opens the Agent Architect session that created this agent (if it was created via the wizard).
- **Demote to Session** — For local agents. Converts the project agent back to a normal session. The handle and discovery metadata are removed, but the session and conversation history are preserved. Project Agent Settings uses **Demote**.
- **Unlink from Repository Definition** — For repository-sourced agents. Clears the session's repository source link. Session history and the repository definition files are preserved. Project Agent Settings uses **Deactivate repository Project Agent**.
- Other standard session actions like Rename, Fork, Stop, Delete.

## Wizard sessions

Agent Creator sessions have special behavior:

- They cannot be promoted to project agents themselves.
- They cannot be forked.
- They auto-hide from the sidebar after successful creation (but are not deleted).
- Each creation attempt must use a fresh wizard session — reusing an old Agent Architect conversation is not supported.

## Handles and discovery

Handles must be unique within a profile and are immutable after promotion. If you try to promote a session with a handle that already exists, you'll see an error. Rename the existing project agent or choose a different handle.

The "when to use" blurb is injected into the prompt context of sibling manager sessions and explicitly granted target profiles (but not workers). Local and shared agent directory prompt caps are separate, so adding shared agents does not consume the local project-agent directory budget. This is how managers learn about available project agents and when to message them.
