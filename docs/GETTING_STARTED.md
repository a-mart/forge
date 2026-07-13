# Getting Started with Forge

A practical guide to going from first launch to daily use. Covers setup, core concepts, power features, and the habits that make Forge worth the investment.

---

### Contents

1. [First Launch](#1-first-launch)
2. [Your First Manager](#2-your-first-manager)
3. [The Dashboard](#3-the-dashboard)
4. [Working with Your Manager](#4-working-with-your-manager)
5. [Session Management](#5-session-management)
6. [Teaching Forge How You Work](#6-teaching-forge-how-you-work)
7. [Cortex — The Brain](#7-cortex--the-brain)
8. [Reliability & Continuity](#8-reliability--continuity)
9. [Settings & Configuration](#9-settings--configuration)
10. [Advanced Usage](#10-advanced-usage)
11. [Tips](#11-tips)

---

## 1. First Launch

### Starting Forge

After cloning the repo and running `pnpm prod:daemon`, open the UI at [http://127.0.0.1:47189](http://127.0.0.1:47189).

You'll see a short welcome form from Cortex, Forge's learning system. It asks for your name, technical level, and a few baseline preferences. Forge always stores the structured onboarding state. With Knowledge v2 OFF, Settings renders and updates a managed block in legacy `common.md`; with v2 ON, it upserts global v2 preference entries instead. Take 30 seconds and fill it out honestly.

### Setting Up Authentication

To run agents, configure at least one supported model provider. Go to **Settings → Authentication**.

The current pane uses OAuth account-pool cards for **Anthropic** and **OpenAI**, and masked key/token rows for **xAI**, **OpenRouter**, and **Cursor SDK**. Status and auth-type badges appear only on applicable cards. Claude SDK authentication is handled outside these rows: run `claude login` to use its native Claude Code CLI OAuth runtime.

Choose providers based on the models and runtimes you need. Anthropic covers Claude models, OpenAI covers GPT and Codex, xAI covers native Grok models, OpenRouter credentials support user-added OpenRouter models, and Cursor SDK credentials support its catalog models when visible. Existing local OpenAI or Anthropic credentials may still be reflected in provider status, but the current Settings cards add OAuth accounts rather than presenting a general API-key entry flow.

Forge Auth broker mode lets Forge use a separate broker for OpenAI/Codex short-lived leases instead of local OpenAI credentials. For v1 setup, your broker administrator creates a one-time setup link for your name/email. Paste that link into **Settings → Authentication → OpenAI → Forge Auth broker** and redeem it. Forge sends the invite id/secret to the broker from the backend, stores only the returned broker runtime token in secrets, and masks broker status in the UI. Manual broker URL/token entry is still available under advanced setup for older deployments, but setup links are the normal path.

When broker mode is active, local OpenAI OAuth/API-key and pool credentials stay visible for reference but are read-only in Settings. If broker mode is forced by environment variables, Settings cannot redeem setup links or edit broker fields until the env override is removed.

After adding or changing provider credentials, Forge recycles matching idle manager runtimes or defers the recycle until busy runtimes are idle, so the common case does not require recreating sessions or restarting the backend.

If you use pooled OAuth credentials, Forge refreshes them through the shared auth path before runtime selection, then writes refreshed tokens back into `auth.json` under the pooled key. Missing or clearly expired pooled credentials show up as `auth_error` instead of looking healthy.

You can fine-tune the app under **Settings → Appearance**. It supports Light, Dark, and System mode, appearance templates, editable accent/background/foreground colors, and UI/code font choices. Changes are drafted first, then saved with **Apply**. The browser renderer keeps those preferences locally in browser storage, so they do not travel with server-side profile config.

### Connecting Remote Projects (Optional)

Remote Projects lets this Builder open projects that remain on another Forge collaboration server. To connect one:

1. Open **Settings → Collaboration** and choose **Add connection**.
2. Enter the server URL, select **Test**, and confirm the connection succeeds.
3. Select **Add**, then sign in to that connection with your collaboration email and password.
4. Turn on **Remote projects** for the connection. A newly added connection is opted in automatically only when its successful Test response advertised Remote Projects support; an existing connection's preference is not silently changed.
5. Return to Builder and select a blue, globe-marked remote project header or a nested session row beneath it. Nested session rows use status dots rather than the globe marker.

The **Remote projects** switch is a browser-local display/connection preference, not an access control. The collaboration server must separately enable its Remote Projects policy. Remote paths, Files operations, Git and `gh` commands, terminals, agents, and session data run or remain on that server—there is no local clone or sync. When remote terminal access is disabled, existing terminal descriptors or read visibility may remain, but subsequent member terminal lifecycle mutations and new ticket issuance are denied; an already attached terminal socket is not terminated. Members should be trusted instance operators: Remote Projects provides broad Builder read/write access to exposed projects and has no per-project ACL.

In remote chat, author chips identify messages from other users. The viewer indicator is a snapshot of authenticated people subscribed to that session; it is not typing presence, an edit lock, or proof that someone is actively reading.

If you open the UI directly on a collaboration-server origin and its collaboration session cookie is missing or expired, Forge shows a non-dismissible email/password dialog before opening the Builder connection. Successful sign-in reloads the current URL, preserves the requested route, and re-evaluates the account role: admins may continue to Builder, while members are routed to Collaboration. This direct-hosted flow is separate from a configured Remote Projects connection's sign-in and recovery flow under local **Settings → Collaboration**.

See the [Remote Projects guide](collaboration/REMOTE_PROJECTS.md) for server policy, security boundaries, status meanings, and troubleshooting.

> **Tip:** You don't need every provider to get started. One configured provider is enough to run agents, while multiple providers give you more multi-model routing options (more on this in [Advanced Usage](#10-advanced-usage)).

### First Impressions

Once provider credentials are configured, you'll see the main interface: a chat window in the center, a collapsible sidebar on the right, and a session list on the left. It looks like a chat app. Fundamentally, that's what it is. But the chat is with an AI manager that controls a pool of workers.

---

## 2. Your First Manager

### Creating a Manager

Click the **+** button to create a new project. You'll be prompted for:

- **Name** — Something meaningful. If it's for your web app, call it "webapp" or "analytics-api," not "test." You'll thank yourself later when you have five managers running.
- **Project directory** — The root of the project you want to work on. This is where the manager and its workers will operate.
- **Model** — Pick the manager model. If the model supports it, you can also choose a reasoning level; unsupported reasoning options are hidden and the default is used when you leave it out.

By default, the Create Project dialog also seeds repo-root `.forge` project resources. Leave that checkbox on if you want the starter `.forge/` tree; turn it off to skip the scaffold.

That's it. Your manager is now live.

### What Is a Manager?

A manager agent is your single point of contact for a project. You talk to the manager. The manager talks to workers. You never directly interact with workers. The manager handles dispatch, status tracking, and result synthesis.

You're the executive. The manager is your team lead. The workers are the ICs doing the actual coding, reviewing, and testing.

### What Is a Session?

A session is a conversation thread within a manager. Your first session is created automatically when you create the manager. You can create additional sessions for different workstreams: one for a feature, one for bug fixes, one for documentation. Each session has its own conversation history, its own memory, and can run workers independently. Sessions inherit the profile's default manager model unless you override the session explicitly.

Sessions are where work actually happens. The manager is just the container.

### The Manager–Worker Relationship

When you ask your manager to do something ("fix the login bug," "add dark mode," "refactor the auth module"), the manager breaks the task down, spawns one or more worker agents, and delegates the actual coding. Workers run in their own processes, execute tool calls (file edits, terminal commands, web searches), and report evidence back to the manager. The manager retains accountability, performs the smallest focused check needed to accept the work, and reports an accepted result or material blocker.

The key insight: **your manager writes better prompts than you do.** Especially at 2am when you're tired, you're not giving the best instructions. But your manager takes your casual, imprecise request and translates it into precise, well-structured worker prompts. It handles the "write a prompt to write a prompt" step that you used to do manually across different chat windows.

---

## 3. The Dashboard

### Chat Interface

The main panel is a chat window. You type messages to your manager, it responds. When it spawns workers, you'll see activity indicators. When workers complete, results flow back through the manager. In Builder web, a plain leading `@Codex` or `[@Codex]` starts or continues a direct Codex app-server sidecar turn, while selector forms like `@Codex -<plugin>`, `@Codex:<plugin>`, and `[@Codex:<plugin>]` scope the turn to a plugin and delegate it through the visible `Codex Plugin` specialist worker. Normal plugin tool output is bounded to previews and metadata; full connector exports, such as Fireflies transcripts or summaries, appear as session artifacts instead of chat chunks. Agents can also output Mermaid diagrams in standard code fences, and Forge renders them inline with an interactive toolbar.

Two view modes, toggled at the top:

- **Web** (default for managers) — Prioritizes the focused conversation transcript and pending choices you can answer.
- **All** — Adds manager-session activity, manager tool rows, and terminal reports returned by workers. It does not inline the workers' internal tool history.

Selecting a worker pill or worker row opens that worker's own transcript, which defaults to **All**. Return to the manager and switch to All manually when you want to inspect terminal worker reports that are hidden from the manager's Web view.

Raw terminal worker reports remain inspectable in **All**. The manager treats a report as evidence rather than an inherited conclusion, performs focused acceptance, and publishes the accepted result or a material blocker.

Use **Session Audit Log** from the chat header menu when you need the canonical persisted rows and runtime internals. It opens a list/detail inspector: the row list stays compact and paginated, and selecting a row loads the full JSON detail for inspection and copy. On desktop, the list and detail panes are separated by a draggable, keyboard-accessible divider that remembers its width locally. Supported native provider rows, including provider text, tool calls/results, system rows, and hidden thinking blocks, are classified as hidden runtime rows instead of appearing as `Unknown row: message`. Provider internals such as thinking, tool arguments/results, and system content stay out of normal Web/All summaries and list previews; inspect the JSON detail view when you need the underlying row and have access to it.

Agents can include Mermaid diagrams in their responses using standard markdown code fences (` ```mermaid ... ``` `). These render inline with an interactive toolbar for toggling between diagram and source, copying code, exporting as SVG or PNG, and viewing fullscreen.

You can reply to visible user or assistant messages in normal Builder chat. Hover a message and click **Reply** to attach it as the reply target. The composer shows a compact quote preview so you can confirm the target before sending; clear it if you changed your mind, or choose Reply on another message to change targets. Sent replies render a compact quoted preview above the message, and clicking the quote jumps to the original message when that message is loaded in the current transcript.

You can pin important messages to preserve them through compaction. Hover over any user or assistant message and click the pin icon. Pinned messages show an amber indicator and are guaranteed to survive when the context window is summarized. See [Smart Compaction](#8-reliability--continuity) for details.

### Workspace Rail and File Browser

On desktop, Forge uses a left activity rail for Chat, Files, Source Control, Terminal, Cron/Schedules, and Artifacts/Dashboard. Chat returns to the current manager/session conversation, including from a selected worker route back to its parent manager thread. Files opens as a left split pane beside the rail with a resizable file tree and file surface pane for editable text files or previews. Desktop header workspace buttons are hidden behind the rail; mobile keeps the header/drawer workspace actions. Files, Source Control, Artifacts/Dashboard, and Schedules switch mutually exclusively so panes do not stack or hide behind each other, while Terminal stays independent and persistent.

Files uses tabs. Single-click a file to open or activate one replaceable italic preview tab; opening another file by single click replaces that preview if it is clean. Double-click to make a tab sticky. A preview also becomes sticky on its first edit, and newly created files open as sticky tabs. Sticky tabs coexist, so you can keep several files open while still using a separate preview tab.

Supported text files use CodeMirror with syntax highlighting on desktop. Markdown files (`.md`, `.markdown`, and `.mdx`) open in rendered **Preview** by default, including editable files. Preview reflects the current unsaved draft. Use **Preview / Source** to switch between rendered Markdown and CodeMirror source; on mobile, Source is read-only highlighted text. Switching to another file and back resets Markdown to Preview. Other unsupported or non-editable content stays read-only, and PDFs use the built-in preview.

Use **New file** in the Files header, the empty-tree action, or a directory context menu to create an empty file; Files does not create folders. Rename a file or directory from its item context menu. A new name must be one path component: slashes, backslashes, NUL, `.` and `..` are rejected, while intentional leading or trailing whitespace is preserved. Create and rename never overwrite an existing path. Delete permanently removes a file or recursively removes a folder after confirmation. For safety, create, rename, and delete reject repository-root, traversal, outside-workspace, and symlink-parent escapes.

Saves use the version loaded when the file was opened. If the file changed on disk, Forge reports a conflict instead of silently overwriting it; choose **Reload from disk**, **Overwrite anyway**, or **Cancel**. Selecting another file, hiding Files, or entering Source Control does not prompt and does not discard drafts. A **Save / Discard / Cancel** guard appears when you close a dirty tab, navigate to another session or route, rename or delete a path that affects a dirty tab, or run a Source Control branch switch, branch create, or fast-forward-only pull in the same worktree. Unrelated path operations and read-only Source Control navigation do not trigger that guard.

While the Files surface remains mounted, Forge remembers tabs, the active tab, preview identity, tree/filter/search/scroll state, and text or Markdown content scroll in React memory for each session and selected worktree. Hiding and reopening Files, or switching away from and back to a session/worktree, restores that scope after any required navigation guard is resolved. This state does not survive a browser or app restart.

When Source Control has a linked worktree selected, that worktree scopes Files browsing and operations without changing the chat session's working directory. Successful create, rename, save, and delete operations refresh Files metadata/tree state and Source Control; create opens the new file as sticky, rename remaps affected open-tab paths, and delete removes affected tabs. Mobile content editing remains read-only, and desktop item context-menu actions may not have the same discoverability on mobile. In the desktop app, you can still open files in your external editor or use **Show in folder** to reveal a file in Finder or File Explorer. The Files panel also has a separate scaffold action that can add a starter `.forge/` tree and README without overwriting existing files. Use the Chat rail item to return to the current manager/session chat, including from a worker route to the parent manager thread.

> **Editor preference:** By default, external editor links open in VS Code. You can change this to Cursor (or other editors) in **Settings**.

### Source Control Workspace

Desktop Source Control opens inline in the workspace content area from the rail, not as a modal overlay. It evolves the old Changes/Git view into a workspace with tabs for current changes, commit history, worktrees, and pull requests. Selecting a worktree updates the Source Control context and the Files browsing context only; it does not move the chat session CWD or change where the manager sends workers. Successful file creates, renames, saves, and deletes refresh Changes for that scope.

Source Control supports fetch, branch switching, branch creation, and fast-forward-only pull. When you enter Source Control or change repository context, Forge may quietly fetch stale origin data in the background; manual **Fetch** remains explicit and reports errors. Opening Source Control preserves Files drafts without prompting. Branch switch/create and fast-forward-only pull are write mutations: Forge guards dirty tabs in the matching worktree with **Save / Discard / Cancel**, then asks for confirmation and runs a preflight check before sending the git command. Force push, stash, discard, rebase, branch deletion, and worktree create/remove are not available from this workspace.

The Pull Requests tab uses the GitHub CLI (`gh`). If the selected repository does not have a GitHub remote, `gh` is missing, or `gh` is not authenticated, Forge shows an unavailable or degraded state instead of PR data. PR merge has its own confirmation flow, re-checks the PR head commit with GitHub's match-head-commit guard, and does not delete the branch or use admin bypass.

### Session Sidebar

The left sidebar shows all your sessions across all managers. You can switch sessions by clicking them, search by name or message content (with highlights), rename sessions, create new ones with the + button, and fork sessions from any point in a conversation. Enabled remote project headers are mixed into this list with blue styling and a globe marker; their nested session rows use status dots. Remote actions are limited: **Change Working Directory** is available on a project header through the server directory browser, while local rename, archive, delete, fork, and model actions are absent. Their connection section can show connecting, sign-in required, unreachable, **Update Forge to connect**, Remote Projects disabled on the server, or connected with no projects. Selecting a remote project or session targets supported chat/workspace surfaces at that server; selecting a local row switches them back. Dragging local and remote project headers only changes the order saved by the local Builder instance—it does not grant remote access. Session rows can show status badges, including active worker counts and a violet pulsing `C` while compaction or context recovery is active. Use the Archive nav in the Builder sidebar to view archived local projects and directly archived sessions; Archive itself remains local when a remote project is selected. Archive entries are sorted by last user-message activity and show the last-used date. Restore and reopen them from there.

**Pinning sessions:** Right-click any session and select "Pin" to keep it at the top of the sidebar. Pinned sessions appear below project agents but above regular sessions and are never hidden by the "Show N more" pagination. Click "Unpin" to return a session to regular sorting. Sessions are pinned per profile — forked sessions don't inherit pin state.

### Worker Pills

When workers are active, small green pills appear at the bottom of the chat window. Each pill represents a running worker and shows an elapsed timer. Click a pill to open that worker's transcript; worker transcripts default to the **All** view so their activity is visible.

Quick at-a-glance view of parallel work in progress. Codex app-server sidecars appear as worker-like external-thread cards. They persist by default, can be stopped through the same session stop path, and can be reused after stop. Plain `@Codex` / `[@Codex]` text follow-ups continue the direct sidecar thread; plugin selector mentions open the plugin-scoped path, which reaches the manager and is delegated to the visible `Codex Plugin` specialist worker with read-only scoped tools, bounded redacted results, artifact-backed full exports when needed, and normal manager follow-up while scope remains active. If a scoped Codex Plugin worker is stopped or fails, clear continuation or retry turns can reuse the server-stored scope without re-tagging; unrelated turns clear that retry context. The sidecar path is Builder web only, text-only, excludes Collaboration, and allows only one active direct Codex turn globally.

### Artifacts Panel

When agents create plans, design documents, or other working files that aren't part of your repository, they show up in an artifacts panel in the sidebar. On desktop, the rail opens Artifacts or Schedules in the left activity-pane slot with one selected surface at a time, with no internal Artifacts/Schedules tab switcher on that path. Click any artifact to view it inline. This is where implementation plans, review documents, and other intermediate work products end up.

### Schedules

If you've set up scheduled tasks (including the managed daily Cortex consolidation schedule), they appear in the sidebar's Schedules pane.

### Provider Usage

If the backend detects real provider credentials for OpenAI, Anthropic, or Cursor SDK, Forge can display subscription rate-limit monitoring in two places:

- **Sidebar widget** — Compact stacked gauges showing 5-hour rolling and weekly usage windows with reset timers. Click to expand for detailed metrics (deficit/reserve pace, runout estimates), and use the manual refresh button in the detail panel if you want to re-poll immediately.
- **Dashboard stats panel** — Full usage breakdown with the same metrics in a dedicated section.

Usage data survives backend restarts via a shared cache, and weekly pace estimates reflect historical usage curves rather than simple linear interpolation. Cursor SDK usage is included in the same stats, analytics, and telemetry provider inference when Composer 2.5 sessions are active. Pooled OAuth credentials are refreshed before usage polling, and pooled auth failures can suppress usage display. Broker-backed OpenAI/Codex auth can provide broker status and usage when the broker reports it. If auth is API-key-based or malformed, the monitoring stays unavailable without extra noise. The Dashboard stats panel's Sessions card keeps archived projects and sessions in the historical total, while the active subtitle excludes them. Toggle the sidebar widget visibility in **Settings → General → Sidebar**.

---

## 4. Working with Your Manager

### Describing Tasks

Talk to your manager like you'd talk to a capable colleague. You don't need to be precise or exhaustive. That's the manager's job. Just describe what you want:

The manager may stay quiet while workers are running routine tasks. It will surface useful results, blockers, and completion updates instead of narrating every small step.

> "The login page has a bug where the error message doesn't show up after a failed attempt. Fix it."

> "Add a dark mode toggle to the settings page. Follow the existing theme patterns."

> "Refactor the auth middleware to support both JWT and session tokens."

Your manager will break these down, plan the approach, and dispatch workers. For complex tasks, you'll see the plan before implementation starts.

### Parallel Task Execution

You can dump multiple tasks in a single message or in rapid succession:

> "I need three things done in parallel: 1) Fix the broken pagination on the users list, 2) Add input validation to the signup form, 3) Update the API docs for the new endpoints."

The manager spins up separate workers for each task. They all run simultaneously.

Or you can send tasks one at a time as you think of them. While workers are crunching on the first task, you can plan the next one with the manager, start a new conversation thread, or just go get coffee. When you come back, there's a pile of completed work waiting for review.

> At any given time, you might have five or six session agents working, each with their own workers. That could be 50 workers running simultaneously. To do that on your own, that's 50 terminal windows.

### The Prompt Quality Multiplier

This deserves a callout because it's the single biggest thing most people miss.

We're all mediocre prompt writers by default, especially when we're tired or just trying to move fast. The instructions you'd type into a terminal at midnight are not great. But with Forge, those sloppy instructions go to your manager, which translates them into precise, well-structured prompts for the workers actually doing the work.

You used to have to manually chain prompts: ask one model to help you write a better prompt, take that prompt to another model. Forge does this automatically. Your manager is a prompt refinement layer that you get for free on every task.

### When to Intervene vs. Let It Run

Most of the time, let it run. The manager handles worker coordination, error recovery, and status tracking. Intervene when:

- The manager asks you a clarifying question (it will, especially early on)
- You see it going down a wrong path during planning (easier to correct before implementation starts)
- A worker has been stuck for a long time (the automated safeguards usually catch this, but you can always step in)
- You want to change direction mid-task

For everything else, let the machinery work.

---

## 5. Session Management

Sessions are how you organize parallel workstreams. Each one holds a different context.

### Creating New Sessions

Click the **+** button in the session sidebar and give it a descriptive name. The new session inherits your manager's configuration (including the profile default manager model, system prompt, and skills) but starts with a fresh conversation. If you later change the profile default model, only sessions that still inherit it will update.

Name your sessions meaningfully. Forge forces you to enter a name when creating one for a reason. "fix-pagination-bug" is infinitely more useful than "test" when you're bouncing between six active workstreams.

### Forking Conversations

Forking is one of the most useful features for daily workflow. Say you've had a long discovery conversation where you've researched an issue, discussed architecture, and explored options. Now you want to branch into different implementation paths.

**Fork from a specific message:** Right-click (or use the menu on) any message and select "Fork." The new session contains only the conversation up to that message. Nothing below it. Perfect for "we discussed all this, now let me branch here."

**Fork the full conversation:** Use the fork option at the session level to copy the entire conversation into a new session. Same context, fresh workspace.

Either way, the forked session keeps the source session's model state, including whether it was inheriting the profile default or using an explicit override. Cursor SDK runtime state and usage records are omitted from forks so resumed branches do not leak prior SDK state or double-count usage. Historical Codex sidecar display cards are omitted from forked sessions. Pinned messages are preserved through forks, but only those present in the forked history (if you fork from message #5 and had a pin on message #8, that pin won't carry over). You can take each fork in a completely different direction without them interfering with each other.

### Switching Between Sessions

Click any session in the sidebar to switch to it. Your manager tracks state independently per session, so you can bounce between "fix-auth-bug," "dark-mode-feature," and "api-docs-update" without losing your place.

### Working plans

For substantial multi-step work, a manager can publish a working plan with `update_plan`. The card at the top of chat highlights the current work, while the header popover shows the complete checklist and completion count. Plans use only Pending, In progress, and Completed states, and multiple steps can be In progress during parallel work; small requests usually skip the plan entirely.

When a manager delegates work that clearly belongs to one plan step, Forge can associate that worker assignment with the exact step text. The visible checklist stays unchanged. After steps and the plan complete, Forge writes append-only token-usage estimates to the session's `plan-usage.ndjson` for future offline analysis, including manager totals, per-step worker totals, unassigned usage, and attribution coverage.

### Archive and Restore

You can archive a session or an entire project from the sidebar, but archived items are read-only and unavailable for chat, model, CWD, project-agent reference edits, or terminal use until restored. The default Main session in a project cannot be archived directly. Archiving a project only marks the project as archived; it does not recursively stamp every session, but the whole project becomes operationally unavailable until restored. Archiving a project stops live sessions under that profile, clears active tool snapshots, and suspends running profile terminals so they can resume on restore. Session archives do not delete terminal data. Archive entries are sorted by last user-message activity and show the last-used date.

### Session Search

The search bar in the sidebar searches across session names, then digs into message content with highlighted matches. When you have dozens of sessions, this is how you find that conversation from last Tuesday about the caching strategy.

### Project Agents

Sometimes you want a session to serve as a persistent specialist that other sessions can message asynchronously. For example, a dedicated documentation agent that multiple implementation sessions can coordinate with, or a research agent that gathers context for various features.

**Promoting a session:** Right-click any session in the sidebar and select "Promote to Project Agent." You'll provide:

- **Handle** — A unique identifier like `@docs` or `@research`. Used for discovery and @mentions in chat.
- **When to use** — A brief description that helps other session agents understand when to message this project agent (e.g., "Ask me to write or review documentation").
- **Role instructions** — Stored in the `systemPrompt`/`prompt.md` field and layered after Forge's Project Agent base prompt. Use this for the project agent's role, scope, constraints, validation habits, and domain-specific behavior.

Profile-local promoted agents are stored in dedicated per-handle directories under `profiles/<profileId>/project-agents/<handle>/`, with a `config.json`, editable `prompt.md` file, and per-agent `reference/` documents. Repositories can also ship Project Agent definitions under `.forge/project-agents/<definitionId>/` with `config.json`, live `prompt.md`, and optional read-only `reference/*.md`; activating/linking creates a normal session source link, and unlinking preserves session history and repository files. Valid repo-defined Project Agents appear in the sidebar as inactive/repo-defined rows; clicking one opens the Repository Resources activation sheet, and the agent stays unavailable until it is activated/linked. Handles are immutable after promotion, so renaming the underlying session does not change the agent handle.

**AI-assisted promotion:** The promotion dialog includes an "AI Assist" option that analyzes the session's history and suggests a handle, description, and role instructions based on what the session has actually been doing.

**Creating with the Agent Architect:** Instead of promoting an existing session, you can use the Agent Creator wizard for a guided creation flow. Right-click any profile header in the sidebar and select "Create Project Agent." This opens a fresh Agent Architect session (marked with a violet Sparkles icon) that:

1. Spawns a scout worker to explore your repository structure, `AGENTS.md`, git history, and existing project agent role instructions
2. Runs a focused 2–3 turn interview about the new agent's role, autonomy level, and validation expectations
3. Drafts a complete proposal including session name, handle, `whenToUse` description (max 280 chars), and role instructions for the `systemPrompt` field
4. Waits for your explicit approval before proceeding
5. Atomically creates and promotes the new session via `create_project_agent`

Each creation attempt starts a fresh dedicated Agent Architect session. After successful creation, the wizard session automatically hides from the sidebar. You can revisit the creation conversation anytime by right-clicking the created agent and selecting "View Creation History."

Agent Creator sessions cannot be promoted, forked, or created within the Cortex profile.

**Discovery:** Once promoted, project agents appear at the top of the sidebar in their profile with a special badge. Other local session agents in the same profile, plus sessions in profiles that have an explicit sharing grant, can discover them through the injected directory and send fire-and-forget messages using the existing `send_message_to_agent` tool.

**Session creation capability:** Some project agents can be given a **Can create sessions** toggle in Settings. When enabled, that project agent can create new manager sessions in the same profile. Those created sessions show a subtle `Created by @handle` attribution in the sidebar, and the creator can keep messaging them through the normal routing path.

**Messaging:** Project Agent exchanges appear inline in both participating Builder conversations. Messages sent by the currently open session are right-aligned in deep blue; replies from the peer session are left-aligned in a lighter sky-blue, with both session names shown. Ordinary worker coordination remains in **All** rather than the normal Web conversation. The project agent wakes up if idle and can respond by sending a message back to the sender. Project Agent sends are text-only; attachments are rejected.

**@mentions:** Type `@` in the chat composer to see autocomplete suggestions for local project agents in the current profile and shared project agents explicitly granted from another profile. Selecting one inserts a mention chip. This is purely UI convenience — the actual routing happens when your session agent interprets your message and decides to use `send_message_to_agent`.

**Sharing:** Project Agent sharing is source-owned. Open the source agent's Project Agent Settings to grant or remove access for target profiles. Shared agents appear in the target profile's external/shared-agent directory and autocomplete only after a grant, and they are labeled separately from local agents. External/shared turns are constrained and do not inherit source-only capabilities from target sessions.

**Demoting:** Right-click a promoted session and select "Demote from Project Agent" to convert it back to a regular session.

---

## 6. Teaching Forge How You Work

Different developers work differently, and Forge adapts to you. But it can't read your mind. You have to teach it.

### The "Mentor Your AI" Philosophy

Before diving into implementation, have some conceptual conversations with your manager about how you like to work:

- How do you prefer to handle git branching?
- What's your code review process?
- How do you like documentation written?
- What's your testing philosophy?
- Do you prefer small incremental changes or big-bang implementations?

These conversations give your manager useful context. When a durable preference is saved as knowledge, future managers can find and apply it.

> "Don't just use it as 'I'm using what I have and that's what I get.' Use it as somebody you're almost trying to mentor and teach how you like to work."

### The Track System (an Example)

One approach that works well for large features is a four-track system:

1. **Brainstorm** — Have a conversation about the feature. Explore options, discuss tradeoffs.
2. **Plan with review** — The manager creates an implementation plan, then has a separate high-quality model review it and provide feedback. The plan gets updated based on the review.
3. **Implement** — Workers execute the plan. Backend work goes to one model (e.g., GPT-5.5 at high reasoning), frontend to another (e.g., GPT-5.5 at medium reasoning).
4. **Code review** — Two separate models review the implementation independently, then their findings go to a remediation agent to fix any issues.

This approach has enabled one-shotting features with 20,000+ lines of code. It's just one way to work. You'd teach your manager your own version.

### The Feedback System

Message feedback in Forge sits behind one feedback trigger and popover. It offers **Good response**, **Needs work**, and **Add/update comment** actions, and feeds directly into Cortex's learning system.

**Needs work** — When the manager or a worker does something wrong. You can optionally select a category or write a comment explaining what was bad. This is your most important feedback signal.

**Good response** — When something is impressive. An innovative solution, a well-structured plan, a clean implementation. Don't overuse this. Save it for the moments that matter.

**Add/update comment** — For patterns you're noticing. "I'm seeing a tendency to over-engineer simple solutions" or "Always check for null before accessing nested properties in this codebase." Comments don't require a positive or negative rating.

**Session-level ratings** — You can also rate entire sessions, which helps Cortex understand which conversations were productive.

You don't need to rate every message. Focus on the meaningful ones: the spectacular successes, the frustrating failures, and the patterns you want to reinforce or correct.

### How Feedback Becomes Learning

Feedback signals can trigger a bounded Cortex capture check, which verifies whether a durable fact should be saved. Cortex does not run the former transcript-review pipeline. More on the current architecture in the Cortex section.

---

## 7. Cortex — The Brain

Cortex is Forge's durable learning system. It appears as a pinned Builder sidebar entry and, in Knowledge v2 mode, maintains provenance-bearing entries that managers can search and read on demand.

### Knowledge v2 is an opt-in preview

Knowledge v2 is **off by default**. It is separate from `FORGE_CORTEX_ENABLED`: the mode switch chooses v2 or legacy prompt sourcing, while `FORGE_CORTEX_ENABLED=false` disables the entire Cortex subsystem.

Prompt sources are explicit:

- **Knowledge v2 ON:** the generated global `shared/knowledge/INDEX.md`, active-profile `knowledge/INDEX.md`, and current session `memory.md`.
- **Knowledge v2 OFF:** legacy shared `common.md`, canonical profile `memory.md`, and current session `memory.md`.

Canonical profile memory continues to be maintained with v2 ON. Legacy common knowledge is preserved during normal switching, but neither is prompt-injected in that mode. Normal mode switching preserves both stores. Turning v2 OFF restores the legacy prompt sources only while those originals remain; explicit legacy cleanup archives and removes them. Profile memory and profile-scoped v2 knowledge are different stores.

### Guarded activation

A normal false→true activation is allowed only after a guarded migration has produced a strictly valid completed manifest and released its ownership-safe cross-process lock. A successful migration commits that manifest, releases the lock, and immediately persists v2 activation. Earlier valid v1 manifests remain accepted; new migrations write a truthful v2 `authorized_pending` authorization. If activation persistence fails after the manifest commit, the manifest remains an authorized recovery point and v2 stays OFF. It permits an ordinary recovery enable, as well as ordinary re-enable after a later user disable.

**Settings → General** and first-launch v2 onboarding use the backend's fail-closed capability result. Before migration, Settings shows migration-required guidance and onboarding does not offer or request activation. The ordinary toggle never migrates data. Direct unsafe activation is rejected with HTTP 409 and `KNOWLEDGE_V2_MIGRATION_REQUIRED`.

Operators run migration explicitly from the repository root with a deliberate data directory:

```bash
node scripts/knowledge-v2-migrate.mjs --data-dir /path/to/forge-data
```

Cleanup and rollback are separate explicit operations:

```bash
node scripts/knowledge-v2-migrate.mjs --data-dir /path/to/forge-data --cleanup-legacy --confirm
node scripts/knowledge-v2-migrate.mjs --data-dir /path/to/forge-data --rollback
node scripts/knowledge-v2-migrate.mjs --data-dir /path/to/forge-data --rollback --manifest /path/to/manifest.json
```

Cleanup archives legacy files and retired Cortex artifacts under `shared/knowledge/.archive/legacy-cleanup/<timestamp>/` and removes the originals, so OFF alone can no longer restore their prior content. Rollback restores manifest-listed legacy backups, disables v2, and reports that a restart is required.

### How learning works

Managers can save durable facts directly with `save_learning`. At bounded compaction, idle, and session-archive checkpoints, a deterministic cadence check and small judge can launch a restricted capture-check fork for facts that may have been missed; feedback signals bypass the judge and trigger that check directly. Managers use the `knowledge` tool to search and read full entries behind the compact indexes.

While Knowledge v2 is ON, Cortex's consolidator reads entries only. It merges duplicates, supersedes conflicts, archives stale entries, and regenerates token-capped indexes. It does **not** mine transcripts or create new entries.

### Cortex dashboard

Open Cortex from its pinned Builder sidebar entry. The resizable dashboard has four tabs:

- **Index** — View generated global/profile indexes and token-cost meters.
- **Entries** — Read entry bodies and provenance details; the current dashboard is read-only.
- **Log** — Inspect verified consolidation log activity.
- **Run** — Use **Consolidate now**, see **Last run**, and inspect the **Promotion review queue**.

While Knowledge v2 is ON, the daily consolidation schedule can be enabled or disabled under **Settings → General**, and manual consolidation is available from **Run**.

---

## 8. Reliability & Continuity

Forge is designed to run unsupervised. Here's how it handles failure cases.

### Smart Compaction

If you've used Claude Code, you know the pain: the context window fills up, it compacts, and suddenly the agent has amnesia. It doesn't know what it was doing, what's been tried, or what the plan was.

Forge's smart compaction works differently:

1. **Early trigger** — When context usage hits ~84–88% (visible on the context meter dial in the chat), the system auto-stops the session agent.
2. **Handoff file** — Before compaction, the agent writes a markdown handoff file capturing current state, in-progress work, decisions made, and next steps.
3. **Selective retention** — The most recent ~20,000 tokens of conversation stay intact (your latest messages, tool calls, and reasoning).
4. **Summary generation** — Everything older gets summarized by a separate model and included as context.
5. **Pinned messages** — Any messages you've pinned (up to 10 per session) are preserved verbatim in the summary under a dedicated "Preserved Messages (Pinned)" section.
6. **Resume** — If compaction happened while the session was active, interrupted, or waiting on dispatch, the agent comes back with the detailed recent context, a high-level summary of older work, pinned messages, and the handoff file.

If you trigger Smart compact manually while the Pi-backed manager is already idle, it compacts and stays idle afterward. If it was active, interrupted, or dispatch-pending, it resumes after compaction. While compaction or context recovery is active, the session row shows a violet pulsing `C` badge in the sidebar. **Settings → General → Compaction** controls the compaction model, reasoning, and timeout for supported Pi-backed OpenAI/Codex and Anthropic manager compaction runtimes only, not Claude SDK/native runtimes or xAI/Grok.

Sessions can compact 50+ times and still maintain full continuity. You can just keep going indefinitely.

### Pinning Messages

Hover over any user or assistant message and click the pin icon to mark it as important. Pinned messages show an amber indicator. When compaction happens, these messages are preserved verbatim regardless of age. This is useful for:

- Key architectural decisions that need to stay visible
- Critical requirements or constraints
- Specific instructions that shouldn't be summarized away
- Reference examples you want to keep intact

You can have up to 10 pinned messages per session. The pin count badge appears in the chat header near the compaction controls when you have active pins. Click the badge to open a navigator that lets you jump directly to any pinned message with prev/next buttons (keyboard arrow keys also work). The chat auto-scrolls and highlights each pin as you navigate. Click the pin icon again to unpin.

While a runtime is live, the context meter follows runtime status rather than a stale pre-compaction header value, so compaction can update the view without making old descriptor usage look fresh.

### Context Window Indicator

The small dial icon in the chat header shows current context utilization. When the runtime is live, that live status is authoritative for the meter. Watch it creep up during long sessions. When smart compaction triggers during active work, you'll see a brief pause while the handoff and summary are generated, a violet pulsing `C` appears on the session row, then work resumes.

You can also trigger compaction manually from the three-dot menu (**⋯ → Smart Compact**) if you want to proactively clear space. Pinned messages are preserved during manual compaction the same way they are during automatic compaction. If the manager is already idle, a manual Smart compact leaves it idle afterward on Pi-backed managers.

### Idle Worker Detection

Workers are supposed to report back to the manager when they finish. But LLMs are probabilistic. Sometimes a worker completes its task and just doesn't send the callback message.

Forge detects this. When a worker finishes its turn, it can auto-report on `agent_end`/turn end even before the runtime flips to idle. The idle watchdog/status-idle path still acts as a fallback and noise-suppression layer for cases that never report cleanly. The session agent can then inspect the worker's output, nudge it, or spin up a replacement. Those idle/stall reports are suppressed while the worker or parent runtime is recovering, so recovery can finish without duplicate watchdog noise.

If a worker runtime reports a bare \`errorMessage: "terminated"\`, Forge holds it for a 60-second grace period before failure projection. If the worker resumes progress or self-reports during that window, the transient error is canceled. If it does not recover, it expires through the normal worker error/watchdog path once.

### Stalled Worker Auto-Kill

Sometimes workers get stuck on a command that hangs. An infinite loop, a misconfigured server, a command waiting for input that will never come.

Forge's stall detector works in two stages:

1. **5-minute warning** — If a worker has been streaming without making progress for 5 minutes, the system notifies the manager. The manager can inspect and decide what to do. This is skipped while the worker or parent runtime is recovering.
2. **10-minute auto-kill** — If the worker is still stuck after another 5 minutes (10 total), the system kills it and notifies the manager, unless runtime recovery is already in progress.

### Manager Stalls and Restart Recovery

Forge also watches active **manager** turns for prolonged silence. A watchdog evaluates about once every 60 seconds and can add amber System notices after roughly 30 seconds, 5 minutes, and 10 minutes without progress, so each notice may arrive up to about one polling interval late. New progress resets the ladder. Manager tool execution, compaction, and runtime recovery can pause or suppress its clock, although a hung tool can still reach the final tier at about 10 minutes.

The notices do not include an inline recycle action. If the manager remains stuck, use **Three-dot menu → Stop All**, then send the request again to begin a fresh turn/runtime. Waiting may also let a pending recycle run once the runtime becomes idle.

A backend restart does not automatically resume interrupted work. When recovery information is available, Builder shows a banner below the chat header with interrupted session and worker counts. **Resume all** makes a best-effort attempt from the last persisted state by prompting interrupted managers/workers and redelivering pending worker-report text where available. **Dismiss** only hides that recovery snapshot. Neither action is persisted as a durable recovery decision, and the banner does not currently provide a per-item error breakdown.

Mid-generation output cannot be reconstructed, and the internal recovery ledger is fail-open and rotating rather than an exact crash-safe record. Before resuming work that may repeat side effects—publishing, deployments, payments, or destructive commands—inspect the current external state and tell the manager what already completed.

### Manual Stop Controls

In the rare case you need to manually intervene:

- **Three-dot menu → Stop** — Stops the current session agent and all its workers.
- **Right-click a worker pill → Stop** — Stops an individual worker.

You'll rarely need these. The automated safeguards handle most failure cases.

---

## 9. Settings & Configuration

### Notifications

Go to **Settings → Notifications** for per-session notification controls. Recommended setup:

- **Project sessions:** Turn on "All Done" notifications. This fires when your session agent completes and all workers are finished. Clean "your work is ready" signal.
- **Cortex:** Keep notifications off if you do not want messages from scheduled consolidation or direct Cortex activity.

The "Unread" notification fires whenever the session agent sends you a message. Can be useful but gets noisy if your manager is running many workers (each worker completion triggers a message).

You can upload custom notification sounds if you want to distinguish between sessions by ear.

> A global notification setting that applies to all sessions (except Cortex) is planned.

### Skills

Go to **Settings → Skills** to configure agent capabilities:

- **Brave Search** — Paste your Brave API key here. Gives all agents web search. You don't have to tell agents to use Brave; they'll search automatically when they need external information.
- **Chrome CDP** — If you're running Chrome 146+, you can enable Chrome DevTools Protocol access. This lets agents connect to tabs you have open in your browser, with access to your authenticated sessions.
- **Custom skills** — Reusable custom skills can be scaffolded and validated with the built-in `create-skill` helper, which can create global skills, profile/project skills, or repository `.forge/skills` skills as needed.
- **Skill sharing** — Share a user-created global or project skill to generate a temporary bearer link from the skill share service. Recipients can open the link or a `forge://skill-import` deep link, but Forge always shows a preview first and never auto-installs. Conflicts default to reject; replacing an existing directory or installing an override requires explicit confirmation. Built-in and repository skills are not shareable in v1.

> **Chrome CDP tip:** Always set an allowlist of URLs. Without it, agents see every open tab (all 168 of them) and things get slow. And they will comment on your tab count.

Chrome CDP also supports multiple Chrome profiles, which is useful for testing applications that need multiple authenticated users simultaneously.

### System Prompt Preview

Go to **Settings → Prompts** and click **Preview** to see the exact system prompt being sent to your session agent. This is the full runtime prompt, not just your customizations: system instructions, Cortex knowledge, loaded skills, and operational directives.

You can see exactly what Forge is telling your agents to do, and you can edit the customizable portions. Your edits are local to your instance. Future updates won't overwrite your changes.

### Slash Commands

**Settings → Slash Commands** lets you create auto-expander shortcuts. Type `/` in the chat, pick a command, press Tab, and the shortcut expands to your predefined text.

Right now these are text snippets for commonly used prompts. Functional slash commands (that execute actions rather than expand text) are coming.

### Remote Projects

Use **Settings → Collaboration** to manage collaboration connections and their separate **Remote projects** preferences. Adding a connection uses **Add connection → URL → Test → Add**. After you sign in, the Builder/Collab switch opens collaboration channels, while the per-connection **Remote projects** switch controls whether that server's normal Builder projects appear in your unified Builder sidebar. These are two different controls and Remote Projects are not Collaboration channels.

A remote selection makes supported project-scoped surfaces use the remote origin: chat and execution, Files, Source Control, attachments, Session Audit, model availability, and terminals. If the server disables member terminal access, existing descriptors or read visibility may remain while subsequent lifecycle mutations and ticket issuance are denied. Non-chat Settings, Stats, Archive, onboarding, Cortex, provider-usage data, and the mixed sidebar-order setting remain local. Remote New Project and Change Working Directory browse paths on the server rather than opening a local native folder picker.

Turning the browser preference off does not revoke the collaboration session, stop remote agents, or change server policy. Likewise, a server disabling Remote Projects denies subsequent member Builder HTTP requests and commands but does not disconnect existing sockets or subscriptions. Disabling remote terminals blocks subsequent member terminal lifecycle and ticket access; it does not terminate an already attached terminal socket or make the server a full sandbox. See the [canonical Remote Projects guide](collaboration/REMOTE_PROJECTS.md).

### Observability

**Settings → Observability** configures the Builder-only Arize Phoenix exporter. Forge sends OTLP HTTP/protobuf traces to a local loopback endpoint, defaulting to `http://127.0.0.1:6006/v1/traces`. Rich capture can include runtime, prompt, LLM, tool, delivery, lifecycle, error, and feedback spans. Use the capture toggles, redaction settings, and content caps to control what goes into Phoenix.

Collaboration mode is not supported in V1. It uses a no-op/fail-closed observability facade and does not export traces.

### Editor Preference

Under **Settings**, you can change the default editor for "Open in editor" on files. Options include VS Code and Cursor.

---

## 10. Advanced Usage

### Multi-Model Routing

Different models have different strengths. A powerful workflow pattern is routing different kinds of work to different models:

- **Backend/systems work** → GPT-5.5 (high reasoning) via Codex workers
- **Frontend/UI work** → GPT-5.5 at medium reasoning (strong at design and visual code)
- **Plan review** → A high-reasoning model different from the one that wrote the plan
- **Code review** → Two separate models reviewing independently, then a third model remediating

Your manager can handle this routing automatically once you've taught it your preferences. Tell it which models to use for which kinds of tasks.

### Plan → Review → Remediate Cycles

For complex features, the highest-quality approach:

1. **Plan** — Manager creates a detailed implementation plan.
2. **Review** — A separate, high-quality model worker reviews the plan. Catches architectural issues, missing edge cases, design flaws.
3. **Remediate** — Plan is updated based on review feedback.
4. **Implement** — Workers execute the reviewed plan.
5. **Code review** — Two separate model workers review the implementation.
6. **Final remediation** — A third worker addresses code review findings.

This pipeline is what enables one-shotting massive features. The review loops catch issues before they compound.

### Git Worktrees for Parallel Development

When multiple workers are editing files in the same repository, they can step on each other. The solution: git worktrees.

Tell your manager to create a new worktree for a task, and the worker operates in an isolated copy of the repository. When it's done, the manager merges the worktree back. This lets you run truly parallel development without merge conflicts disrupting individual workers.

### Running 24/7 with Mobile Access

Forge is designed for continuous operation. The daemon mode (`pnpm prod:daemon`) keeps it running in the background. Combined with the mobile app (currently in TestFlight beta for iOS), you get push notifications when workers complete, full chat access from your phone, and the ability to kick off tasks from mobile and check results later.

This enables an "always-on" workflow. Dump tasks before bed, wake up to completed work. Kick off a big feature during lunch and review results when you're back at your desk.

### Telegram Bot Integration

If you don't have the mobile app, Telegram works for remote access. Create a bot via [@BotFather](https://t.me/botfather), add the token in **Settings → Integrations → Telegram**, and you can chat with your manager directly from Telegram with full bidirectional messaging.

### Extensions

Forge has two extension systems:
- [Forge Extensions](FORGE_EXTENSIONS.md) for Forge-native hooks like session lifecycle, runtime errors, versioning commits, and cross-runtime tool interception
- [Pi Extensions & Packages](PI_EXTENSIONS.md) for Pi-native runtime extensibility

If you want safety policies, local automation, or versioning/session hooks that follow Forge itself, start with Forge Extensions.

```typescript
// ~/.forge/extensions/protect-env.ts
export default function (forge) {
  forge.on("tool:before", (event) => {
    if (event.toolName !== "write") return
    if (event.input?.path !== ".env") return
    return { block: true, reason: "Blocked: .env writes are protected" }
  })
}
```

For power users who want Pi-native custom tools, event handlers, packages, prompts, and themes: Forge also exposes the full [Pi extension system](PI_EXTENSIONS.md). Pi extensions are TypeScript modules that hook into the agent lifecycle and can:

- **Register custom tools** — Give agents access to your ticket tracker, internal APIs, databases, or any external service
- **Intercept tool calls** — Block dangerous commands (`rm -rf /`), prevent writes to sensitive files (`.env`, `.git/`), or require approval for specific operations
- **Modify context** — Inject project-specific instructions, redact secrets from output, or add reminders before each LLM call
- **Audit behavior** — Log every tool call for compliance or debugging

**Quick start:** Save a `.ts` file to `~/.forge/agent/extensions/` and it's loaded for all workers. No build step, no restart — extensions load per-session.

```typescript
// ~/.forge/agent/extensions/protected-paths.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event) => {
    if (event.toolName === "write" && event.input?.path?.includes(".env")) {
      return { block: true, reason: "Blocked: .env writes are protected" };
    }
  });
}
```

There's a growing ecosystem of community Pi packages you can install from npm or git — security guardrails, usage tracking, code intelligence tools, and more. See the [Pi Extensions guide](PI_EXTENSIONS.md) for the full reference including package installation, available events, and headless mode caveats.

### The Data Directory

All of Forge's state lives in a single directory:

- **macOS/Linux:** `~/.forge`
- **Windows:** `%LOCALAPPDATA%\forge`

No database. Everything is files (JSON, JSONL, and Markdown):

```
~/.forge/
├── swarm/agents.json              # Global agent registry
├── shared/
│   ├── config/
│   │   ├── auth/                  # Your authentication credentials
│   │   └── knowledge-v2.json      # Default-off Knowledge v2 mode settings
│   └── knowledge/
│       ├── common.md              # Legacy common knowledge (prompt source only with v2 OFF)
│       ├── entries/               # Global Knowledge v2 entries
│       ├── archive/               # Archived global Knowledge v2 entries
│       ├── .archive/              # Migration backups and explicit legacy-cleanup archives
│       ├── INDEX.md               # Generated global Knowledge v2 index
│       ├── .knowledge-v2-migration-manifest.json
│       └── .knowledge-v2-migration.lock.json/ # Cross-process lock while busy
└── profiles/<profileId>/
    ├── memory.md                  # Canonical profile memory (prompt source only with v2 OFF)
    ├── knowledge/
    │   ├── entries/               # Profile-scoped Knowledge v2 entries
    │   ├── archive/               # Archived profile-scoped entries
    │   └── INDEX.md               # Generated profile Knowledge v2 index
    ├── project-agents/<handle>/
    │   ├── config.json            # Agent config (handle, whenToUse, agentId, timestamps)
    │   ├── prompt.md              # Project Agent role instructions (editable, layered with Forge's base prompt)
    │   └── reference/             # Per-agent reference documents
    └── sessions/<sessionId>/
        ├── session.jsonl          # Conversation history (the source of truth)
        ├── plan.json              # Current Builder working plan snapshot
        ├── plan-history.ndjson    # Outgoing working-plan revisions
        ├── plan-usage.ndjson      # Append-only worker assignment and token-usage receipts
        ├── meta.json              # Session metadata
        ├── memory.md              # Session working memory
        └── workers/               # Individual worker logs
```

Cached conversation sidecars rebuild from canonical `session.jsonl` on first load if they are stale or truncated, so sessions affected by async deliveries should show full history again after refresh.

Cortex is architecturally just another manager agent. It lives in the same profile structure with its own sessions and workers.

**Backing up:** Copy the `~/.forge` directory. That's it. No database dumps, no export tools. Just files.

Your repo directory is disposable from Forge's perspective. You can delete and re-clone it. All durable state (history, memory, knowledge, settings) lives in the data directory.

---

## 11. Tips

### Name Your Sessions

Every time you create or fork a session, give it a real name. "fix-pagination-bug" beats "test3" when you're scanning six active workstreams at a glance.

### Rate the Meaningful Messages

You don't need to rate everything. But when your manager nails a complex task, thumbs up. When it makes the same mistake for the third time, thumbs down with a comment. When you notice a pattern, leave a comment. These signals feed through Cortex into real behavioral improvement.

### Don't Just Use It — Teach It

The difference between "Forge is fine, I guess" and "this is indispensable" is whether you invest in the teaching loop. Have those conceptual conversations about how you like to work. Correct mistakes when you see them. Rate the big wins. After a few weeks, Forge knows your preferences well enough that you barely need to specify them.

### Start with One Task, Then Scale

For your first few sessions, send one task at a time and watch how the manager handles it. Understand the dispatch → worker → report cycle. Then start sending two tasks. Then three. Then dump a list of five and watch it parallelize. Build your trust incrementally.

### Be Careful with Permissions

These agents have real system access. They can run commands, modify files, install packages, and interact with databases. This is exactly what makes them useful, but it also means they can do damage.

A clear instruction authorizes the named action or action class for the current conversation, so Forge should not ask twice for the same scoped permission. Broad autonomy does not authorize unrelated destructive, externally visible, costly, security-sensitive, or production-impacting actions.

Real story: agents have hard-deleted a Postgres database. Twice. On a local development machine, fortunately, but with data that was actually wanted. No recovery.

Also be aware of prompt injection risks when agents browse the web. Malicious websites can include hidden instructions that agents pick up and execute.

**Mitigations:**
- Keep backups of your data directory
- Use allowlists for Chrome CDP access
- Be cautious with agents that have broad system permissions
- Review what agents are doing, especially early on

### Back Up Your Data Directory

`~/.forge` is everything. Your conversation history, your Cortex knowledge, your preferences, your session memory. Copy it periodically. If your machine dies, this directory is all you need to pick back up.

### Watch GitHub Releases for Updates

Forge is actively developed. Watch the [GitHub repository](https://github.com/a-mart/forge) releases to get notifications when new versions ship.

### Beyond Development

Forge isn't just for coding. It handles any knowledge work that benefits from parallel AI execution:

- Download a meeting transcript and have it extracted into action items
- Analyze a batch of documents for patterns
- Generate and review documentation
- Research and summarize technical topics

If you can describe the task to a capable colleague, you can describe it to your manager.

---

## What's Next

Once you're comfortable with the basics:

1. **Build your workflow preferences** — Have conversations with your manager about how you like to work and save the durable parts as knowledge.
2. **Explore Cortex** — When Knowledge v2 is active, inspect **Index**, read-only **Entries**, **Log**, and **Run**.
3. **Try forking** — Next time you finish a discovery conversation, fork it into parallel workstreams and dispatch different tasks.
4. **Experiment with parallel execution** — Give your manager multiple tasks and watch it coordinate workers.
5. **Review consolidation settings** — While Knowledge v2 is ON, use **Settings → General** for the daily entry consolidation schedule; manual consolidation is available under Cortex **Run**.
6. **Explore multi-model routing** — If you have multiple providers configured, teach your manager which providers and models to use for different kinds of work. Use **Change Default Model** for the profile default, **Override Session Model** for a one-off session, and **Use Project Default** to return a session to inherited state. `claude-sdk` is a separate provider option from `anthropic`, so specialists can be configured with either independently.
7. **Try extensions** — Use `~/.forge/extensions/` for Forge-native hooks or `~/.forge/agent/extensions/` for Pi-native runtime extensions. See [FORGE_EXTENSIONS.md](FORGE_EXTENSIONS.md) and [PI_EXTENSIONS.md](PI_EXTENSIONS.md).

> "Forge builds Forge. When I'm working on other projects, as soon as I run into something that's either a bug or a little feature I want, I just pop down, click the conversation with Forge, tell it, and then it chews on it, plans it, whatever."

---

*Forge is built on [Middleman](https://github.com/SawyerHood/middleman) by Sawyer Hood. The Forge repository lives at [github.com/a-mart/forge](https://github.com/a-mart/forge).*
