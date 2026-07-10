Everything in Forge starts with a manager session. Here's how to get one running.

## Create a manager

Click the **+** button at the top of the sidebar to create a new project. You'll need three things:

- **Name** — something that identifies the project or workstream. You can rename it later.
- **Working directory** — the project folder where workers will operate. Each worker gets its own worktree branched from this directory.
- **Model** — which LLM powers the manager. Claude Sonnet and GPT models both work well. You can change this later in Settings, and supported models also let you choose a reasoning level.

By default, the Create Project dialog also seeds repo-root `.forge` project resources. Leave that checked if you want the starter `.forge/` tree; turn it off to skip the scaffold.

Click **Create** and the manager appears in the sidebar.

## Send your first message

Type in the chat input at the bottom. Start with something concrete:

- "Fix the failing tests in the auth module"
- "Add dark mode support to the settings page"
- "Review the last three PRs and summarize the changes"

The manager reads your message, plans the work, and spawns workers as needed. You may see fewer routine status updates while it focuses on useful results, blockers, and completion updates.

## Watch workers run

Active workers show up as green pills below the chat header. Click a pill to open that worker's transcript, which defaults to **All**. Active Work Plans are currently parked, so there is no live plan card/header, manager `task` tool or guidance, or task-snapshot hydration. Older sessions may still show read-only `work_plan_created` receipts rendered from their creation snapshots. The manager stays outcome-focused, so expect useful results, blockers, and completion updates rather than constant narration of routine worker activity.

Workers run independently. You can keep talking to the manager, start a new task, or close the tab entirely. Workers continue in the background and the manager tracks everything.

## Sessions and profiles

Your manager can have multiple **sessions** — independent conversations with their own history and memory. Right-click the manager in the sidebar to create a new session or fork an existing one. You can also archive sessions or whole projects from the sidebar; archived items stay on disk, but they are read-only and unavailable until restored. Archive entries are sorted by last user-message activity and show the last-used date.

Sessions belong to a **profile**, which holds shared settings like model choice, system prompt, and persistent memory. Changes to the profile apply to all sessions under it. Archiving a profile marks only the profile as archived, not each session individually, but the whole project becomes unavailable until restored. Archive entries are sorted by last user-message activity and show the last-used date.

Once you're comfortable with sessions, you can promote them to **project agents** — persistent specialist sessions that other sessions can discover and message for cross-session coordination. See the Project Agents help article for details.
