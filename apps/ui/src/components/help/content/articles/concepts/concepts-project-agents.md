Project agents are sessions promoted to persistent specialist roles within a profile. Unlike regular sessions, they have dedicated handles and are discoverable by sibling sessions for async collaboration. **Local to Forge** definitions alone use `profiles/<profileId>/project-agents/<handle>/`. **Repository `.forge`** placement writes `.forge/project-agents/<handle>/` and does not create a Forge-data definition sidecar; session history stays local. If a cached conversation sidecar was truncated, the project agent conversation rebuilds from canonical session history on first load. If a project-agent session is archived, it becomes read-only and unavailable for messaging until restored, just like any other archived session. Archive entries are sorted by last user-message activity and show the last-used date.

## What makes a project agent

A project agent is a regular session with special properties:

- A **unique handle** (like `@releases` or `@docs`) that identifies it across the profile
- A **"when to use"** blurb that tells other sessions what this agent is for
- A dedicated `prompt.md` file containing role instructions layered with Forge's Project Agent base prompt. Local agents edit this in Settings or the profile file; repo-sourced agents edit the repository file, and Settings shows it read-only.
- Optional **per-agent reference documents** that are injected into the agent's prompt context. Local references are editable in Settings; repository references are read-only there.
- Appears **pinned at the top** of the profile section in the sidebar with a badge

Project agents persist across restarts and appear in the agent directory that manager sessions can query. Handles are immutable after promotion, so renaming the underlying session does not change the project agent handle. Sessions created by a project agent inherit the profile default model unless the creator explicitly sets a model or reasoning override for the new session. Local agents can keep a live **Can create sessions** Settings toggle. Repository capabilities are chosen at activation or re-link rather than a live Settings toggle. Created sessions keep creator attribution in the sidebar.

Repo-defined Project Agents under `.forge/project-agents/<definitionId>/` also surface in the sidebar as inactive/repo-defined rows when valid. They remain discoverable but unavailable until activated or linked through the Repository Resources flow, which opens from the sidebar row.

## How discovery works

When a manager session starts, it receives an injected directory of available project agents in its prompt context. Each entry includes the agent's handle and "when to use" description. The directory includes local agents in the same profile plus shared agents explicitly granted from another profile. The manager can then message relevant project agents when it needs help with tasks that match their specialty.

Worker agents never see the project agent directory — this is a manager-to-manager coordination mechanism only. Local and shared directory prompt caps are separate.

## Fire-and-forget messaging

Project agents communicate through the existing `send_message_to_agent` tool. Messages are asynchronous and one-way — there's no reply threading or delivery confirmation. The exchange appears in both participating Builder conversations, using distinct right/left blue bubbles so the current session and peer are easy to distinguish; ordinary worker coordination remains in **All**. If a project agent has session-creation capability, it can create new manager sessions in the same profile and continue messaging those sessions through the normal routing path.

If the receiving session is idle when a message arrives, Forge wakes it up automatically to handle the incoming work. Project Agent sends reject attachments.

## Sharing

Sharing is source-owned and stays editable in Settings for both local and repository-sourced agents. The source Project Agent's settings control which other profiles have a grant. Target profiles cannot browse arbitrary agents in other profiles; shared agents appear in their external/shared-agent directory and autocomplete only after a grant exists.

Forge distinguishes local and shared agents in the UI and sanitizes external shared-agent metadata and prompt rendering. External/shared turns are constrained and do not inherit source-only capabilities from target sessions. Sharing changes refresh affected runtime prompts so directory changes propagate.

## @mention autocomplete

The chat composer offers autocomplete for project agent handles when you type `@`. Suggestions include local project agents and explicitly granted shared agents, with shared agents labeled separately. This is a convenience feature only — it inserts the handle as text in your message. The `@mention` syntax does not trigger any special routing. The manager interprets the intent from the message content and uses the normal tool to send a message if appropriate.

## Two ways to create

You can create project agents in two ways:

1. **Manual promotion** — Right-click an existing session and choose "Promote to Project Agent." Fill in the handle, location (**Local to Forge** or **Repository `.forge`**), "when to use" description, and role instructions. Role instructions are optional locally and required for repository placement. Local definitions use `profiles/<profileId>/project-agents/<handle>/`. Repository placement writes `.forge/project-agents/<handle>/` with no Forge-data definition sidecar; session history stays local. AI Assist can recommend role instructions from the session's conversation history.

2. **Agent Creator wizard** — Right-click a profile header and choose "Create Project Agent." This opens a dedicated Agent Architect session that explores your repository, interviews you about the new agent's role and location, drafts a configuration proposal, and atomically creates and promotes the agent after you approve.

## Sidebar placement

Project agents are always pinned at the top of their profile section, above regular sessions. They remain visible even when the session list is paginated. This makes them easy to find and message. Sessions created by a project agent show subtle creator attribution in the sidebar.

## Unlinking, deactivating, and demoting

Local and repository-sourced agents use different actions:

- **Demote to Session** — For local agents. Converts the project agent back to a normal session. The handle and discovery metadata are removed, but the session, conversation history, and session memory are preserved. Project Agent Settings uses **Demote**.
- **Unlink from Repository Definition** — For repository-sourced agents. Clears the session's repository source link. Session history and the repository definition files are preserved. Project Agent Settings uses **Deactivate repository Project Agent**.
