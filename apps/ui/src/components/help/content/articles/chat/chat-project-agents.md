Project agents are specialized sessions with persistent identities that other sessions can discover and message. Use them for cross-session coordination on recurring tasks like documentation, releases, or domain-specific work. Each project agent has its own storage directory with a dedicated `prompt.md` file and optional per-agent reference documents.

## Two ways to create

### Agent Creator wizard

Right-click a profile header in the sidebar and choose **Create Project Agent**. This opens a new session with the Agent Architect archetype.

The wizard flow:

1. **Repo exploration** — The Agent Architect scans your repository to understand its structure and existing agents.
2. **Interview** — You're asked 2-3 focused questions about the new agent's role and scope.
3. **Proposal** — The architect drafts a configuration including handle, "when to use" blurb, and role instructions for the `systemPrompt` field. The resulting agent is stored in a dedicated per-handle directory under `profiles/<profileId>/project-agents/<handle>/`.
4. **Creation** — After you approve, the agent is atomically created and promoted to a project agent.

The wizard session shows a violet Sparkles icon in the sidebar. Once the agent is created, the wizard session auto-hides but remains accessible via "View Creation History" on the created agent's context menu.

### Manual promotion

Right-click any existing session and choose **Promote to Project Agent**. A settings drawer opens where you fill in:

- **Handle** — A unique identifier like `@releases` or `@docs`. Must be unique within the profile and cannot change after promotion.
- **When to use** — A description that tells other sessions when to message this agent.
- **Role instructions** (optional) — Custom instructions tailored to the agent's role, stored in the agent's `prompt.md` file and layered with Forge's Project Agent base prompt.
- **Reference docs** — Optional markdown documents scoped to this agent and injected into its prompt context. Add them from Project Agent Settings by entering a filename and content, or importing a `.md` / `.txt` file.

Click **Generate recommendations** to have AI suggest both the "when to use" text and role instructions based on the session's conversation history. You can edit the suggestions before saving.

## Using project agents

Project agents appear pinned at the top of their profile section in the sidebar with a badge. Click one to open its conversation. Sessions created by a project agent can show a subtle `Created by @handle` label in the sidebar.

To message a project agent from another session, mention its handle in your message (the composer offers autocomplete when you type `@`). The manager interprets your intent and uses the `send_message_to_agent` tool to deliver the message asynchronously. If a project agent created the session, it can keep messaging that session through the same routing path.

Messages to project agents are fire-and-forget — there's no reply threading. If the receiving session is idle, Forge wakes it up to handle the incoming work.

## Managing project agents

Right-click a project agent to access:

- **Settings** — Edit the "when to use" text and role instructions, add reference docs, and manage the agent's files. You can regenerate recommendations here too. The settings drawer is resizable from its left edge and confirms before discarding unsaved changes.
- **View Creation History** — Opens the Agent Architect session that created this agent (if it was created via the wizard).
- **Demote to Regular Session** — Converts the project agent back to a normal session. The handle and discovery metadata are removed, but the conversation history is preserved.
- Other standard session actions like Rename, Fork, Stop, Delete.

## Wizard sessions

Agent Creator sessions have special behavior:

- They cannot be promoted to project agents themselves.
- They cannot be forked.
- They auto-hide from the sidebar after successful creation (but are not deleted).
- Each creation attempt must use a fresh wizard session — reusing an old Agent Architect conversation is not supported.

## Handles and discovery

Handles must be unique within a profile and are immutable after promotion. If you try to promote a session with a handle that already exists, you'll see an error. Rename the existing project agent or choose a different handle.

The "when to use" blurb is injected into the prompt context of all sibling manager sessions (but not workers). This is how managers learn about available project agents and when to message them.
