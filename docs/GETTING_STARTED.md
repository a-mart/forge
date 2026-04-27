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

You'll see a short welcome form from Cortex, Forge's learning system. It asks for your name, technical level, and a few baseline preferences. This isn't decorative. Your answers get written into a Common Knowledge file that's injected into the system prompt for every session you create. Take 30 seconds and fill it out honestly.

### Setting Up Authentication

Before you can do anything, you need to connect at least one AI provider. Go to **Settings → Authentication**.

The authentication pane shows one row per provider with a provider label and an auth-mode badge, so you can tell whether a row is using OAuth or an API key at a glance.

Forge supports three providers:

- **Anthropic** — Claude models (Opus, Sonnet). Supports OAuth or API key auth.
- **Claude SDK** — Native Claude Agent SDK access through Claude Code CLI OAuth. Use this when you want the SDK runtime instead of the Pi-proxied Anthropic path.
- **OpenAI** — GPT and Codex models. Supports OAuth or API key auth.

After adding credentials, you may need to restart the backend (`Ctrl+C` and re-run `pnpm prod:daemon`) for the changes to take effect. On macOS this usually isn't necessary, but on Windows the backend sometimes doesn't pick up auth changes without a restart.

If you use pooled OAuth credentials, Forge refreshes them through the shared auth path before runtime selection, then writes refreshed tokens back into `auth.json` under the pooled key. Missing or clearly expired pooled credentials show up as `auth_error` instead of looking healthy.

> **Tip:** You don't need all providers to get started. One is enough. But having multiple options gives you access to multi-model routing (more on this in [Advanced Usage](#10-advanced-usage)).

### First Impressions

Once authenticated, you'll see the main interface: a chat window in the center, a collapsible sidebar on the right, and a session list on the left. It looks like a chat app. Fundamentally, that's what it is. But the chat is with an AI manager that controls a pool of workers.

---

## 2. Your First Manager

### Creating a Manager

Click the **+** button to create a new manager agent. You'll be prompted for:

- **Name** — Something meaningful. If it's for your web app, call it "webapp" or "analytics-api," not "test." You'll thank yourself later when you have five managers running.
- **Project directory** — The root of the project you want to work on. This is where the manager and its workers will operate.

That's it. Your manager is now live.

### What Is a Manager?

A manager agent is your single point of contact for a project. You talk to the manager. The manager talks to workers. You never directly interact with workers. The manager handles dispatch, status tracking, and result synthesis.

You're the executive. The manager is your team lead. The workers are the ICs doing the actual coding, reviewing, and testing.

### What Is a Session?

A session is a conversation thread within a manager. Your first session is created automatically when you create the manager. You can create additional sessions for different workstreams: one for a feature, one for bug fixes, one for documentation. Each session has its own conversation history, its own memory, and can run workers independently. Sessions inherit the profile's default manager model unless you override the session explicitly.

Sessions are where work actually happens. The manager is just the container.

### The Manager–Worker Relationship

When you ask your manager to do something ("fix the login bug," "add dark mode," "refactor the auth module"), the manager breaks the task down, spawns one or more worker agents, and delegates the actual coding. Workers run in their own processes, execute tool calls (file edits, terminal commands, web searches), and report results back to the manager.

The key insight: **your manager writes better prompts than you do.** Especially at 2am when you're tired, you're not giving the best instructions. But your manager takes your casual, imprecise request and translates it into precise, well-structured worker prompts. It handles the "write a prompt to write a prompt" step that you used to do manually across different chat windows.

---

## 3. The Dashboard

### Chat Interface

The main panel is a chat window. You type messages to your manager, it responds. When it spawns workers, you'll see activity indicators. When workers complete, results flow back through the manager. Agents can also output Mermaid diagrams in standard code fences, and Forge renders them inline with an interactive toolbar.

Two view modes, toggled at the top:

- **Web** (default) — Shows only the messages between you and the manager. Clean, focused.
- **All** — Shows everything: tool calls, worker spawning, agent-to-agent messages, reasoning traces. Useful when you want to see exactly what's happening under the hood.

Agents can include Mermaid diagrams in their responses using standard markdown code fences (` ```mermaid ... ``` `). These render inline with an interactive toolbar for toggling between diagram and source, copying code, exporting as SVG or PNG, and viewing fullscreen.

You can pin important messages to preserve them through compaction. Hover over any user or assistant message and click the pin icon. Pinned messages show an amber indicator and are guaranteed to survive when the context window is summarized. See [Smart Compaction](#8-reliability--continuity) for details.

### File Browser

The left sidebar has a file browser pointed at your project directory. Currently read-only, but you can browse your entire codebase without leaving Forge. Click any file to view it. There's a button to open it directly in your editor. In the desktop app, there's also a "Show in folder" button to reveal the file in Finder or File Explorer.

> **Editor preference:** By default, files open in VS Code. You can change this to Cursor (or other editors) in **Settings**.

### Git View

Below the file browser, there's a Git view. Think GitHub Desktop built into Forge. Full commit history, diff viewer for any commit, branch information.

Currently read-only (you can't switch branches or make commits from the UI), but you won't need to. Your agents handle git operations. The view is there so you can inspect what they've done.

### Session Sidebar

The left sidebar shows all your sessions across all managers. You can switch sessions by clicking them, search by name or message content (with highlights), rename sessions, create new ones with the + button, and fork sessions from any point in a conversation.

**Pinning sessions:** Right-click any session and select "Pin" to keep it at the top of the sidebar. Pinned sessions appear below project agents but above regular sessions and are never hidden by the "Show N more" pagination. Click "Unpin" to return a session to regular sorting. Sessions are pinned per profile — forked sessions don't inherit pin state.

### Worker Pills

When workers are active, small green pills appear at the bottom of the chat window. Each pill represents a running worker and shows an elapsed timer. Click a pill to see what that worker is doing: commands it's running, files it's editing, with elapsed time on each tool call.

Quick at-a-glance view of parallel work in progress.

### Artifacts Panel

When agents create plans, design documents, or other working files that aren't part of your repository, they show up in an artifacts panel in the sidebar. Click any artifact to view it inline. This is where implementation plans, review documents, and other intermediate work products end up.

### Schedules

If you've set up scheduled tasks (like automated Cortex reviews on a cron schedule), they appear in the sidebar's Schedules pane.

### Provider Usage

If the backend detects real OAuth credentials for OpenAI or Anthropic, Forge can display subscription rate-limit monitoring in two places:

- **Sidebar widget** — Compact stacked gauges showing 5-hour rolling and weekly usage windows with reset timers. Click to expand for detailed metrics (deficit/reserve pace, runout estimates), and use the manual refresh button in the detail panel if you want to re-poll immediately.
- **Dashboard stats panel** — Full usage breakdown with the same metrics in a dedicated section.

Usage data survives backend restarts via a shared cache, and weekly pace estimates reflect historical usage curves rather than simple linear interpolation. Pooled OAuth credentials are refreshed before usage polling, and pooled auth failures can suppress usage display. If auth is API-key-based or malformed, the monitoring stays unavailable without extra noise. Toggle the sidebar widget visibility in **Settings → General → Sidebar**.

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

Either way, the forked session keeps the source session's model state, including whether it was inheriting the profile default or using an explicit override. Pinned messages are preserved through forks, but only those present in the forked history (if you fork from message #5 and had a pin on message #8, that pin won't carry over). You can take each fork in a completely different direction without them interfering with each other.

### Switching Between Sessions

Click any session in the sidebar to switch to it. Your manager tracks state independently per session, so you can bounce between "fix-auth-bug," "dark-mode-feature," and "api-docs-update" without losing your place.

### Session Search

The search bar in the sidebar searches across session names, then digs into message content with highlighted matches. When you have dozens of sessions, this is how you find that conversation from last Tuesday about the caching strategy.

### Project Agents

Sometimes you want a session to serve as a persistent specialist that other sessions can message asynchronously. For example, a dedicated documentation agent that multiple implementation sessions can coordinate with, or a research agent that gathers context for various features.

**Promoting a session:** Right-click any session in the sidebar and select "Promote to Project Agent." You'll provide:

- **Handle** — A unique identifier like `@docs` or `@research`. Used for discovery and @mentions in chat.
- **When to use** — A brief description that helps other session agents understand when to message this project agent (e.g., "Ask me to write or review documentation").
- **System prompt** — An authoritative prompt that completely replaces the base manager template. Defines the project agent's role and behavior.

Promoted agents are stored in dedicated per-handle directories under `profiles/<profileId>/project-agents/<handle>/`, with a `config.json`, editable `prompt.md` file, and per-agent `reference/` documents. Handles are immutable after promotion, so renaming the underlying session does not change the agent handle.

**AI-assisted promotion:** The promotion dialog includes an "AI Assist" option that analyzes the session's history and suggests a handle, description, and system prompt based on what the session has actually been doing.

**Creating with the Agent Architect:** Instead of promoting an existing session, you can use the Agent Creator wizard for a guided creation flow. Right-click any profile header in the sidebar and select "Create Project Agent." This opens a fresh Agent Architect session (marked with a violet Sparkles icon) that:

1. Spawns a scout worker to explore your repository structure, `AGENTS.md`, git history, and existing project agent prompts
2. Runs a focused 2–3 turn interview about the new agent's role, autonomy level, and validation expectations
3. Drafts a complete proposal including session name, handle, `whenToUse` description (max 280 chars), and full system prompt
4. Waits for your explicit approval before proceeding
5. Atomically creates and promotes the new session via `create_project_agent`

Each creation attempt starts a fresh dedicated Agent Architect session. After successful creation, the wizard session automatically hides from the sidebar. You can revisit the creation conversation anytime by right-clicking the created agent and selecting "View Creation History."

Agent Creator sessions cannot be promoted, forked, or created within the Cortex profile.

**Discovery:** Once promoted, project agents appear at the top of the sidebar in their profile with a special badge. Other session agents in the same profile can discover them through the injected directory and send fire-and-forget messages using the existing `send_message_to_agent` tool.

**Session creation capability:** Some project agents can be given a **Can create sessions** toggle in Settings. When enabled, that project agent can create new manager sessions in the same profile. Those created sessions show a subtle `Created by @handle` attribution in the sidebar, and the creator can keep messaging them through the normal routing path.

**Messaging:** When a project agent receives a message, it appears as a blue right-justified bubble in its chat (similar to user messages but with sender attribution). The project agent wakes up if idle and can respond by sending a message back to the sender.

**@mentions:** Type `@` in the chat composer to see autocomplete suggestions for all project agents in the current profile. Selecting one inserts a mention chip. This is purely UI convenience — the actual routing happens when your session agent interprets your message and decides to use `send_message_to_agent`.

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

These conversations become part of your manager's context and Cortex's learning material. Over time, Forge internalizes your preferences and applies them automatically.

> "Don't just use it as 'I'm using what I have and that's what I get.' Use it as somebody you're almost trying to mentor and teach how you like to work."

### The Track System (an Example)

One approach that works well for large features is a four-track system:

1. **Brainstorm** — Have a conversation about the feature. Explore options, discuss tradeoffs.
2. **Plan with review** — The manager creates an implementation plan, then has a separate high-quality model review it and provide feedback. The plan gets updated based on the review.
3. **Implement** — Workers execute the plan. Backend work goes to one model (e.g., GPT-5.4), frontend to another (e.g., Claude Opus).
4. **Code review** — Two separate models review the implementation independently, then their findings go to a remediation agent to fix any issues.

This approach has enabled one-shotting features with 20,000+ lines of code. It's just one way to work. You'd teach your manager your own version.

### The Feedback System

Every message in Forge has three buttons: **👍**, **👎**, and **💬** (comment). These feed directly into Cortex's learning system.

**Thumbs down** — When the manager or a worker does something wrong. You can optionally select a category or write a comment explaining what was bad. This is your most important feedback signal.

**Thumbs up** — When something is impressive. An innovative solution, a well-structured plan, a clean implementation. Don't overuse this. Save it for the moments that matter.

**Comment** — For patterns you're noticing. "I'm seeing a tendency to over-engineer simple solutions" or "Always check for null before accessing nested properties in this codebase." Comments don't require a positive or negative rating.

**Session-level ratings** — You can also rate entire sessions, which helps Cortex understand which conversations were productive.

You don't need to rate every message. Focus on the meaningful ones: the spectacular successes, the frustrating failures, and the patterns you want to reinforce or correct.

### How Feedback Becomes Learning

Your ratings and comments get picked up by Cortex during its review cycles. It analyzes patterns across your feedback and distills those into knowledge that improves future sessions. More on this in the Cortex section.

---

## 7. Cortex — The Brain

Cortex is what makes Forge a self-improving system rather than just an agent orchestrator. It learns from your usage and makes the whole system better over time.

### What Cortex Is

Cortex is architecturally just another manager agent. There's no special technical machinery. But its job is unique: it reviews your sessions, analyzes your feedback, identifies patterns, and updates knowledge files that get injected into every session's system prompt. It is surfaced in the Builder sidebar as a pinned entry, while other system profiles and collaboration-surface sessions stay hidden from Builder lists.

It's the institutional memory of your Forge instance.

### Opening Cortex

Click the brain icon (🧠) in the sidebar to open Cortex from its pinned Builder sidebar entry. That opens the Cortex dashboard/interface, with several tabs in the special sidebar.

### Common Knowledge

Knowledge that applies across all your projects and sessions. Cortex puts things here that are about how you work as a person, not about any specific project:

- Your prompting habits (including errors your voice dictation consistently makes)
- Your git workflow preferences
- Documentation standards
- General coding style preferences

Common Knowledge gets added to the system prompt for every session in every project. Cortex is conservative about what goes here. It should stay small and high-signal. You'll see this updated the least.

### Project Knowledge

In the Knowledge dropdown, you'll see a file for every project you have a manager for. Project-specific learning goes here:

- Architecture patterns specific to this codebase
- Common pitfalls and gotchas
- Testing approaches that work for this project
- Dependencies and integration notes

Project Knowledge files get updated more frequently than Common Knowledge as Cortex processes your sessions.

### Editing Knowledge

Both Common Knowledge and Project Knowledge are editable. If you see something wrong:

- Edit it directly in the UI
- Tell Cortex to update it (in the main Cortex session): "Hey, that note about preferring Jest is wrong, we switched to Vitest"

### Cortex's Own Notes

The **Notes** tab is Cortex's private scratchpad. It keeps observations and self-improvement notes here. It's not just learning about you. It's learning about how to learn about you. It reviews its own notes to improve its review process.

This meta-learning loop is subtle but effective. After a few weeks of usage, you'll see Cortex making increasingly sophisticated observations about patterns in your work.

### The Review System

The **Review** tab is where Cortex processes your sessions. Every session you work in appears here as a reviewable item. Cortex can analyze the conversation, your feedback, and the outcomes to extract learning.

**Automatic reviews:** By default, Forge runs automatic Cortex reviews every 2 hours. These check all sessions for changes (transcript, memory, feedback) and only run reviews when something needs attention. If nothing changed, no tokens are spent. You can adjust the interval or turn this off in **Settings → General**.

**Running reviews manually:**
- **Review All** — Queues all pending sessions for review. They execute one at a time (single concurrency) so they don't overwhelm your system.
- **Per-session review** — Hover over any row and click the send button to queue just that session.
- **Exclude sessions** — Mark sessions you don't want reviewed (like test sessions) so Cortex skips them.

**Drift detection:** If you keep working in a session after it's been reviewed, Cortex detects "transcript drift" and flags it for re-review. Same with "feedback drift" if you add ratings to messages in an already-reviewed session.

> Toggle the "All" view in the Cortex chat to see the full tool call activity behind the scenes. The "Web" view shows just the summary messages.

### Talking to Cortex Directly

The main Cortex session is for direct conversations with Cortex about your workflow, preferences, and knowledge management:

- Discuss your working style and preferences
- Ask Cortex to update or correct knowledge entries
- Talk about patterns you're noticing across projects
- Request changes to how Cortex reviews or learns

**Don't do project work in the Cortex session.** It's for meta-level conversations about how you work, not for actual coding tasks. Do your project work in your project manager sessions.

### Cortex Without the Meta Stuff

Even without diving into Cortex's review system, Forge is useful on its own. Cortex just makes it improve over time. If you're not ready for the meta-learning aspects, just use the basic feedback buttons (thumbs up/down) as you work and let Cortex run reviews periodically. The system improves in the background.

### Versioning and Rollback

All of Cortex's changes to knowledge files are versioned in git. If Cortex makes a bad update (learns something incorrect or overfits to a temporary pattern), you can roll back to any previous version. Safety net for the self-improvement loop.

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

If you trigger Smart compact manually while the Pi-backed manager is already idle, it compacts and stays idle afterward. If it was active, interrupted, or dispatch-pending, it resumes after compaction.

Sessions can compact 50+ times and still maintain full continuity. You can just keep going indefinitely.

### Pinning Messages

Hover over any user or assistant message and click the pin icon to mark it as important. Pinned messages show an amber indicator. When compaction happens, these messages are preserved verbatim regardless of age. This is useful for:

- Key architectural decisions that need to stay visible
- Critical requirements or constraints
- Specific instructions that shouldn't be summarized away
- Reference examples you want to keep intact

You can have up to 10 pinned messages per session. The pin count badge appears in the chat header near the compaction controls when you have active pins. Click the badge to open a navigator that lets you jump directly to any pinned message with prev/next buttons (keyboard arrow keys also work). The chat auto-scrolls and highlights each pin as you navigate. Click the pin icon again to unpin.

### Context Window Indicator

The small dial icon in the chat header shows current context utilization. Watch it creep up during long sessions. When smart compaction triggers during active work, you'll see a brief pause while the handoff and summary are generated, then work resumes.

You can also trigger compaction manually from the three-dot menu (**⋯ → Smart Compact**) if you want to proactively clear space. Pinned messages are preserved during manual compaction the same way they are during automatic compaction. If the manager is already idle, a manual Smart compact leaves it idle afterward on Pi-backed managers.

### Idle Worker Detection

Workers are supposed to report back to the manager when they finish. But LLMs are probabilistic. Sometimes a worker completes its task and just doesn't send the callback message.

Forge detects this. When a worker goes idle without reporting back, the system notifies the session agent: "This worker went idle without sending a message." The session agent can then inspect the worker's output, nudge it, or spin up a replacement.

If a worker turn fails instead of finishing cleanly, that failure can now surface in the transcript as a system message with the error context preserved, so it does not just look like a missing callback.

### Stalled Worker Auto-Kill

Sometimes workers get stuck on a command that hangs. An infinite loop, a misconfigured server, a command waiting for input that will never come.

Forge's stall detector works in two stages:

1. **5-minute warning** — If a worker has been streaming without making progress for 5 minutes, the system notifies the manager. The manager can inspect and decide what to do.
2. **10-minute auto-kill** — If the worker is still stuck after another 5 minutes (10 total), the system kills it and notifies the manager.

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
- **Cortex:** Turn notifications off. During review cycles, Cortex gets chatty and you'll be bombarded with alerts.

The "Unread" notification fires whenever the session agent sends you a message. Can be useful but gets noisy if your manager is running many workers (each worker completion triggers a message).

You can upload custom notification sounds if you want to distinguish between sessions by ear.

> A global notification setting that applies to all sessions (except Cortex) is planned.

### Skills

Go to **Settings → Skills** to configure agent capabilities:

- **Brave Search** — Paste your Brave API key here. Gives all agents web search. You don't have to tell agents to use Brave; they'll search automatically when they need external information.
- **Chrome CDP** — If you're running Chrome 146+, you can enable Chrome DevTools Protocol access. This lets agents connect to tabs you have open in your browser, with access to your authenticated sessions.
- **Custom skills** — Reusable custom skills can be scaffolded and validated with the built-in `create-skill` helper, which can create global skills or project skills as needed.

> **Chrome CDP tip:** Always set an allowlist of URLs. Without it, agents see every open tab (all 168 of them) and things get slow. And they will comment on your tab count.

Chrome CDP also supports multiple Chrome profiles, which is useful for testing applications that need multiple authenticated users simultaneously.

### System Prompt Preview

Go to **Settings → Prompts** and click **Preview** to see the exact system prompt being sent to your session agent. This is the full runtime prompt, not just your customizations: system instructions, Cortex knowledge, loaded skills, and operational directives.

You can see exactly what Forge is telling your agents to do, and you can edit the customizable portions. Your edits are local to your instance. Future updates won't overwrite your changes.

### Slash Commands

**Settings → Slash Commands** lets you create auto-expander shortcuts. Type `/` in the chat, pick a command, press Tab, and the shortcut expands to your predefined text.

Right now these are text snippets for commonly used prompts. Functional slash commands (that execute actions rather than expand text) are coming.

### Editor Preference

Under **Settings**, you can change the default editor for "Open in editor" on files. Options include VS Code and Cursor.

---

## 10. Advanced Usage

### Multi-Model Routing

Different models have different strengths. A powerful workflow pattern is routing different kinds of work to different models:

- **Backend/systems work** → GPT-5.4 (high reasoning) via Codex workers
- **Frontend/UI work** → Claude Opus (strong at design and visual code)
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
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

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
│   │   └── auth/                  # Your authentication credentials
│   └── knowledge/                 # Cortex knowledge files (common + per-project)
└── profiles/<profileId>/
    ├── memory.md                  # Profile-level memory
    ├── project-agents/<handle>/
    │   ├── config.json            # Agent config (handle, whenToUse, agentId, timestamps)
    │   ├── prompt.md              # System prompt (editable, takes effect on restart)
    │   └── reference/             # Per-agent reference documents
    └── sessions/<sessionId>/
        ├── session.jsonl          # Conversation history (the source of truth)
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

1. **Build your workflow preferences** — Have conversations with your manager about how you like to work. Let Cortex learn from them.
2. **Run your first Cortex review** — Go to Cortex's review tab and queue up a session for analysis. See what it learns. (Automatic reviews run by default every 2 hours, but manually triggering one helps you understand the process.)
3. **Try forking** — Next time you finish a discovery conversation, fork it into parallel workstreams and dispatch different tasks.
4. **Experiment with parallel execution** — Give your manager multiple tasks and watch it coordinate workers.
5. **Adjust review frequency** — Check **Settings → General** to configure how often automatic Cortex reviews run or turn them off if you prefer manual control.
6. **Explore multi-model routing** — If you have OpenAI, Anthropic, or Claude SDK configured, teach your manager which providers and models to use for which kinds of work. Use **Change Default Model** for the profile default, **Override Session Model** for a one-off session, and **Use Project Default** to return a session to inherited state. `claude-sdk` is a separate provider option from `anthropic`, so specialists can be configured with either independently.
7. **Try extensions** — Use `~/.forge/extensions/` for Forge-native hooks or `~/.forge/agent/extensions/` for Pi-native runtime extensions. See [FORGE_EXTENSIONS.md](FORGE_EXTENSIONS.md) and [PI_EXTENSIONS.md](PI_EXTENSIONS.md).

> "Forge builds Forge. When I'm working on other projects, as soon as I run into something that's either a bug or a little feature I want, I just pop down, click the conversation with Forge, tell it, and then it chews on it, plans it, whatever."

---

*Forge is built on [Middleman](https://github.com/SawyerHood/middleman) by Sawyer Hood. The Forge repository lives at [github.com/a-mart/forge](https://github.com/a-mart/forge).*
