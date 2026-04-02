import type { HelpArticle } from '../help-types'

export const chatArticles: HelpArticle[] = [
  {
    id: 'chat-overview',
    title: 'Chat Interface',
    category: 'chat',
    summary: 'How the chat interface works, including streaming responses and stopping agents.',
    content: `The chat interface is where you interact with Forge's manager agents. You send a message, the manager reads it, and it starts streaming a response in real time.

## Layout

The main view has three parts:

- **Sidebar** (left) for navigating managers, profiles, and sessions.
- **Message area** (center) showing the conversation transcript.
- **Panels** (right/bottom) for artifacts, terminals, and file browsing.

## Streaming and status

While a manager is responding, you'll see a green status dot in the header and the text "Streaming." The message appears incrementally as it's generated.

## Stopping a response

To stop a running response, open the **⋮ menu** in the header and choose **Stop All**. This terminates the manager and any active workers.

## Channel views

The header has a **Web / All** toggle. "Web" shows only your conversation messages. "All" includes internal activity like tool calls and worker messages, which is useful for debugging.

## Context window

The ring icon next to the channel toggle shows how full the context window is. Green means plenty of room. Amber means it's getting full. Red means you're near the limit and should consider compacting.

## Header controls

The chat header also gives you access to the terminal panel, file browser, diff viewer, and artifact panel through icon buttons on the right side. A pin count badge opens the pinned-message navigator/popover, where you can move to the previous or next pin and the selected pin is auto-scrolled into view and highlighted.`,
    keywords: ['chat', 'streaming', 'stop', 'status', 'channel', 'context window', 'overview'],
    relatedIds: ['chat-sending', 'chat-sidebar', 'chat-compaction'],
    contextKeys: ['chat.main'],
  },
  {
    id: 'chat-sending',
    title: 'Sending Messages',
    category: 'chat',
    summary: 'How to send messages, keyboard shortcuts, formatting mode, and slash commands.',
    content: `Type in the text area at the bottom and press **Enter** to send. That's the default quick-send mode.

## Two input modes

Forge has two input modes, toggled with the **Aa** button (or \`Shift+Cmd+X\` / \`Shift+Ctrl+X\`):

- **Quick-send mode** (default): Enter sends the message. Shift+Enter adds a new line.
- **Format mode**: Enter adds a new line. Cmd+Enter (Ctrl+Enter on Windows/Linux) sends. A formatting toolbar appears with bullet and numbered list buttons.

Your mode preference is saved across sessions.

## Slash commands

Type \`/\` to open a command picker. Slash commands are shortcuts that expand into predefined prompts. You can create custom ones in Settings > Slash Commands.

Arrow keys navigate the list. Enter or Tab selects a command.

## Drafts

If you switch sessions with unsent text, Forge saves it as a draft. When you switch back, the draft is restored. Drafts also survive page refreshes.

## Voice input

Click the microphone button to record a voice message. Forge transcribes it and inserts the text into the input area. Recording stops automatically after the time limit. Requires an OpenAI API key configured in Settings > Authentication.

## Sending while streaming

You can send follow-up messages while the agent is still responding. The input field stays active during streaming so you can queue up additional instructions or corrections.`,
    keywords: ['send', 'enter', 'format', 'slash', 'command', 'draft', 'voice', 'microphone', 'keyboard'],
    relatedIds: ['chat-overview', 'chat-attachments'],
    contextKeys: ['chat.main'],
  },
  {
    id: 'chat-attachments',
    title: 'Attachments',
    category: 'chat',
    summary: 'How to attach files and images to messages.',
    content: `You can attach files to your messages before sending. Forge supports images, text files, and binary files.

## How to attach

- Click the **paperclip** button in the input area and pick files.
- **Paste** an image from your clipboard directly into the text area.
- **Drag and drop** files onto the input area.

Attached files appear as chips above the text area. Click the X on any chip to remove it before sending.

## What gets sent

- **Images** (PNG, JPG, GIF, WebP) are sent as image attachments the agent can see.
- **Text files** are sent as text content with the filename attached.
- **Binary files** are sent as base64-encoded data.

## Per-session attachment drafts

Like text drafts, attachments are saved when you switch sessions and restored when you return. They also persist across page refreshes.

## Limits

Very large files may exceed the attachment size budget. If an upload fails or is too large, the chip won't appear. Stick to reasonably sized files for best results.

## Supported formats

Forge categorizes files automatically. Common image formats are recognized and shown as visual attachments. Text-based files (source code, configs, markdown) are read and sent as text content. Everything else is treated as binary data.`,
    keywords: ['attach', 'file', 'image', 'paste', 'clipboard', 'drag', 'drop', 'upload', 'paperclip'],
    relatedIds: ['chat-sending', 'chat-artifacts'],
    contextKeys: ['chat.main'],
  },
  {
    id: 'chat-sidebar',
    title: 'Sidebar Navigation',
    category: 'chat',
    summary: 'How to use the sidebar to navigate managers, sessions, and workers.',
    content: `The sidebar on the left is your main navigation for everything in Forge. It shows your managers (profiles) and their sessions in a tree structure.

## Structure

Each **profile** is a collapsible group. Inside each profile are its **sessions**. Inside each session, you can expand to see active **workers**. Click any item to switch to it.

Project agents appear pinned at the top of each profile section with a badge, above regular sessions. Session pinning in the sidebar is separate from message pinning inside a conversation.

## Search

The search bar at the top filters sessions and workers by name. Prefix shortcuts:

- \`s:\` searches only session names.
- \`w:\` searches only worker names.

## Profile actions

Right-click a profile header to access: New Session, Create Project Agent, Rename, Change Model, or Delete Manager.

You can also drag profiles to reorder them. The **+** button on a profile header creates a new session.

## Session actions

Right-click any session to access: Copy Path, Rename, Fork, Stop, Resume, Mark as Unread, or Delete. The Main (default) session in each profile cannot be deleted.

## Workers

Sessions with active workers show a numbered badge. Expand the session to see individual workers with their status dots and specialist badges. Right-click a worker to stop, resume, or delete it.

## Mobile

On smaller screens, the sidebar is hidden by default. Tap the hamburger menu in the header to open it. An unread badge shows on the menu button when there are unread messages.`,
    keywords: ['sidebar', 'navigation', 'search', 'profile', 'session', 'worker', 'tree', 'mobile', 'hamburger'],
    relatedIds: ['chat-sessions', 'chat-profiles', 'chat-workers', 'chat-project-agents'],
    contextKeys: ['chat.sidebar'],
  },
  {
    id: 'chat-sessions',
    title: 'Session Management',
    category: 'chat',
    summary: 'Creating, switching, renaming, and deleting sessions.',
    content: `Sessions are individual conversations within a profile. Each session has its own chat history and session memory, but shares the profile's settings and core memory.

## Create a session

Click the **+** button on a profile header in the sidebar, or right-click the profile and choose **New Session**. You can give it a name or let Forge auto-generate one.

## Switch sessions

Click any session in the sidebar to switch to it. Your context, history, and any attached draft are restored.

## Rename a session

Right-click the session and choose **Rename**. This changes the display name only. The underlying session ID stays the same.

## Stop and resume

Right-click a session and choose **Stop** to pause it. A stopped session keeps its history but won't respond to new messages until you **Resume** it.

## Delete a session

Right-click and choose **Delete**. This permanently removes the session's history and memory. You'll be asked to confirm. The default "Main" session in each profile cannot be deleted.

If you delete the session you're currently viewing, Forge routes you to the most recent session in the same profile.

## Clear conversation

To start fresh without creating a new session, open the **⋮ menu** in the chat header and choose **Clear conversation**. This resets the active session in place, keeping the same session identity.`,
    keywords: ['session', 'create', 'switch', 'rename', 'delete', 'stop', 'resume', 'clear', 'new'],
    relatedIds: ['chat-sidebar', 'chat-profiles', 'chat-fork-session'],
    contextKeys: ['chat.sidebar'],
  },
  {
    id: 'chat-profiles',
    title: 'Profiles',
    category: 'chat',
    summary: 'What profiles are and what they control.',
    content: `A profile is the set of settings, memory, and resources that a manager uses. When you create a new project in Forge, you're creating a profile.

## What a profile controls

- **Model and reasoning level** for the manager agent.
- **System prompt** (archetype and custom prompts).
- **Core memory** shared across all sessions in the profile.
- **Specialists** and their configuration.
- **Skills** and environment variables.
- **Reference documents** attached to the profile.
- **Integrations** like Telegram.

## Sessions and profiles

Each profile can have multiple sessions. Sessions inherit all config from the profile but maintain their own conversation history and session memory. Think of it as: the profile is the "who," and sessions are individual conversations.

## Rename a profile

Right-click the profile header in the sidebar and choose **Rename**. This only changes the display name. The profile ID and data directory stay the same.

## Change model

Right-click the profile and choose **Change Model** to update the model preset and reasoning level. Changes take effect on the next message or session resume.

## Reorder profiles

Drag profile headers in the sidebar to rearrange them. The order is saved automatically.

## Deleting a profile

Right-click the profile header and choose **Delete Manager**. This removes the profile and all its sessions, history, and memory permanently. The Cortex profile cannot be deleted.`,
    keywords: ['profile', 'manager', 'settings', 'memory', 'model', 'config', 'rename', 'reorder'],
    relatedIds: ['chat-sessions', 'chat-sidebar'],
    contextKeys: ['chat.sidebar'],
  },
  {
    id: 'chat-workers',
    title: 'Worker Agents',
    category: 'chat',
    summary: 'How worker pills, quick look, and worker monitoring work.',
    content: `Workers are agents that the manager spawns to handle tasks. They appear in two places: the pill bar above the message area, and nested under sessions in the sidebar.

## Worker pill bar

When workers are actively streaming, green pills appear in a bar above the chat input. Each pill shows the worker's name and a live elapsed timer.

**Hover** a pill to see the worker's model, reasoning level, and latest tool call.

**Click** a pill to open a quick-look popover with recent activity, including tool calls and messages. From there you can click "View full conversation" to navigate to that worker's transcript.

Pills fade out when a worker finishes and disappear after a short delay.

## Workers in the sidebar

Expand a session in the sidebar to see its workers listed underneath. Each worker shows a status dot (green = active, gray = idle) and an optional specialist badge.

Right-click a worker to Stop, Resume, or Delete it.

## Specialist badges

Workers spawned from a specialist template show a colored badge with the specialist name. This helps you identify which worker was assigned which role.

## Monitoring

The session row itself shows a numbered amber ring when workers are actively streaming, telling you at a glance how many are running. Hover the session in the sidebar for model and reasoning details.`,
    keywords: ['worker', 'pill', 'quick look', 'specialist', 'badge', 'streaming', 'monitoring', 'activity'],
    relatedIds: ['chat-overview', 'chat-sidebar'],
    contextKeys: ['chat.workers'],
  },
  {
    id: 'chat-artifacts',
    title: 'Artifact Panel',
    category: 'chat',
    summary: 'How to view files and artifacts generated during a conversation.',
    content: `The artifact panel is a slide-out viewer for files that agents create or reference during a conversation. It opens on the right side without blocking chat interaction. You can still type and send messages while a file is open.

## Opening the panel

Click a file reference in a chat message, or toggle the panel with the **sidebar icon** in the header (the rightmost icon). For Cortex sessions, this button opens the Cortex dashboard instead.

## What it shows

The panel loads the file content from the agent's working directory and displays it based on file type:

- **Markdown files** (.md, .mdx) render with full formatting, including Mermaid diagrams.
- **Images** (PNG, JPG, GIF, WebP, SVG) display inline.
- **Code and text files** show syntax-highlighted source.

The header shows the file name, full path, and an "Open in Editor" link. In the desktop app, a "Show in folder" button also appears.

## Opening in your editor

Click "Open in [Editor]" in the panel header to open the file directly in your preferred editor. Set your editor (VS Code, VS Code Insiders, or Cursor) in Settings > General.

## Revealing in the file system

In the desktop app, click "Show in folder" to reveal the file in Finder (macOS) or File Explorer (Windows). This is useful when you want to see the file's location or work with it outside the editor.

## Navigating between files

Click any file reference in the conversation to switch the panel to that file. Links within markdown documents also work, so you can follow references between files.

## Closing

Press **Esc** or click the X button. The panel slides away and returns you to the full chat view.`,
    keywords: ['artifact', 'file', 'panel', 'viewer', 'preview', 'editor', 'markdown', 'code', 'image'],
    relatedIds: ['chat-overview', 'chat-attachments'],
    contextKeys: ['chat.artifacts'],
  },
  {
    id: 'chat-fork-session',
    title: 'Forking Sessions',
    category: 'chat',
    summary: 'How to fork a session, including partial forks from a specific message.',
    content: `Forking creates a copy of a session so you can take the conversation in a different direction without losing the original.

## How to fork

Right-click a session in the sidebar and choose **Fork**. A dialog opens where you can give the fork a name (optional, Forge auto-generates one if you leave it blank).

## Full fork

By default, forking copies the entire conversation history into a new session.

## Partial fork

You can also fork from a specific message. When triggered from a message context, the fork dialog shows which message it will fork from. Only messages up to that point are copied. Everything after is left behind.

The forked session's memory header records where the fork happened, so the boundary with the parent session is explicit.

## What gets copied

- **Conversation history** (all messages, or up to the selected message for partial forks).
- A fresh **session memory** is created with a fork header noting the parent session.

## What does not get copied

- The original session is unchanged. Forking is non-destructive.
- Session memory content from the parent is not carried over. The new session starts with its own empty memory (plus the fork header).
- Workers from the parent session are not duplicated.

## When to use it

Fork when you want to try an alternative approach, preserve a checkpoint before a risky change, or branch a conversation into two tracks.`,
    keywords: ['fork', 'branch', 'copy', 'partial', 'duplicate', 'checkpoint', 'split'],
    relatedIds: ['chat-sessions', 'chat-sidebar'],
    contextKeys: ['chat.fork'],
  },
  {
    id: 'chat-system-prompt',
    title: 'System Prompt Viewer',
    category: 'chat',
    summary: 'How to inspect the full runtime system prompt for the current session.',
    content: `The system prompt viewer shows you the complete prompt that the agent is actually using at runtime. This is the full context the model sees before your messages.

## How to open it

Switch to the **All** channel view using the toggle in the chat header. A scroll icon button appears to the left of the channel toggle. Click it to open the system prompt dialog.

The viewer is only available in "All" mode because it shows runtime internals.

## What's included

The system prompt includes more than what you see in the prompt editor in Settings. The full runtime prompt typically contains:

- The **base system prompt** (from the archetype or custom prompt template).
- **Memory context** (profile core memory and session memory).
- **AGENTS.md** guidance loaded from the working directory.
- **Loaded skills** and their instructions.
- Any **custom instructions** like pinned message content.

## Copy and refresh

Click the **copy** button in the header to copy the full prompt to your clipboard. The prompt is fetched fresh each time you open the dialog, so it reflects the current state.

## When it's not available

Agents created before system prompt persistence was added won't have a stored prompt. The dialog will show a message explaining this.`,
    keywords: ['system prompt', 'runtime', 'context', 'viewer', 'inspect', 'bootstrap', 'memory'],
    relatedIds: ['chat-overview', 'chat-compaction'],
    contextKeys: ['chat.system-prompt'],
  },
  {
    id: 'chat-compaction',
    title: 'Context Compaction',
    category: 'chat',
    summary: 'What context compaction is, when to use it, and the difference between modes.',
    content: `As a conversation grows, it uses more of the model's context window. Compaction reduces the token count by summarizing older messages so you can keep going without hitting the limit.

## When to compact

Watch the context window indicator in the header (the ring icon). When it turns amber or red, you're running low. Compaction is also triggered automatically when the context gets critically full.

## How to compact

Open the **⋮ menu** in the chat header. You'll see two options:

- **Compact context** — a fast, mechanical summary that trims older messages.
- **Smart compact** — uses an AI pass to produce a more intelligent summary that preserves important context and nuance. Takes longer but keeps more useful information.

## Auto-compaction

When the context window fills up during an active conversation, Forge triggers compaction automatically. You'll see a spinning indicator on the ⋮ menu button while it runs. This prevents the agent from failing mid-response due to context limits.

## Pinned messages

If you've pinned messages (shown by the pin count in the header), their content is preserved through all compaction types, including smart compaction and automatic compaction. You can pin up to 10 messages per session. Pinned content is injected into the agent's custom instructions so it survives every compaction mode.

## After compaction

Your older messages are replaced with a summary. Recent messages stay intact. The context window indicator should show more available space. You can continue the conversation normally.`,
    keywords: ['compact', 'compaction', 'context', 'token', 'summary', 'smart compact', 'auto', 'pin'],
    relatedIds: ['chat-overview', 'chat-system-prompt'],
    contextKeys: ['chat.compaction'],
  },
  {
    id: 'chat-feedback',
    title: 'Message Feedback',
    category: 'chat',
    summary: 'How to rate messages and sessions with thumbs up/down and comments.',
    content: `Forge lets you rate both individual messages and entire sessions. Feedback is stored locally and helps you track what's working well and what isn't.

## Message feedback

Hover over any agent message to see thumbs up and thumbs down buttons.

- **Thumbs up**: Click once to upvote. Click again to open a detail panel where you can select reason codes (like "Accuracy," "Great Outcome," "Instruction Following") and add an optional comment.
- **Thumbs down**: Click to open a reason picker immediately. Select what went wrong (like "Verbosity," "Over-Engineered," "Poor Outcome") and optionally add a comment. Submit to record the downvote.

## Session feedback

Session-level feedback appears in the chat header, next to the status indicator. It works the same way as message feedback but applies to the session as a whole.

## Comments

The speech bubble button lets you add a standalone comment without voting. If a comment already exists (shown by a filled icon), you can update or remove it.

## Reason codes

Reason codes are quick labels that categorize what was good or bad. Available codes differ for upvotes and downvotes. You can select multiple.

## Where feedback goes

Feedback is saved to the session's feedback file on disk. It's local to your Forge instance.`,
    keywords: ['feedback', 'rating', 'thumbs', 'upvote', 'downvote', 'comment', 'reason', 'vote'],
    relatedIds: ['chat-overview'],
    contextKeys: ['chat.main'],
  },
  {
    id: 'chat-project-agents',
    title: 'Creating and Using Project Agents',
    category: 'chat',
    summary: 'How to create project agents, message them, and manage their settings.',
    content: `Project agents are specialized sessions with persistent identities that other sessions can discover and message. Use them for cross-session coordination on recurring tasks like documentation, releases, or domain-specific work.

## Two ways to create

### Agent Creator wizard

Right-click a profile header in the sidebar and choose **Create Project Agent**. This opens a new session with the Agent Architect archetype.

The wizard flow:

1. **Repo exploration** — The Agent Architect scans your repository to understand its structure and existing agents.
2. **Interview** — You're asked 2-3 focused questions about the new agent's role and scope.
3. **Proposal** — The architect drafts a configuration including handle, "when to use" blurb, and system prompt.
4. **Creation** — After you approve, the agent is atomically created and promoted to a project agent.

The wizard session shows a violet Sparkles icon in the sidebar. Once the agent is created, the wizard session auto-hides but remains accessible via "View Creation History" on the created agent's context menu.

### Manual promotion

Right-click any existing session and choose **Promote to Project Agent**. A dialog opens where you fill in:

- **Handle** — A unique identifier like \`@releases\` or \`@docs\`. Must be unique within the profile.
- **When to use** — A description that tells other sessions when to message this agent.
- **System prompt** (optional) — Custom instructions tailored to the agent's role.

Click **Generate recommendations** to have AI suggest both the "when to use" text and system prompt based on the session's conversation history. You can edit the suggestions before saving.

## Using project agents

Project agents appear pinned at the top of their profile section in the sidebar with a badge. Click one to open its conversation.

To message a project agent from another session, mention its handle in your message (the composer offers autocomplete when you type \`@\`). The manager interprets your intent and uses the \`send_message_to_agent\` tool to deliver the message asynchronously.

Messages to project agents are fire-and-forget — there's no reply threading. If the receiving session is idle, Forge wakes it up to handle the incoming work.

## Managing project agents

Right-click a project agent to access:

- **Settings** — Edit the handle, "when to use" text, and system prompt. You can regenerate recommendations here too.
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

Handles must be unique within a profile. If you try to promote a session with a handle that already exists, you'll see an error. Rename the existing project agent or choose a different handle.

The "when to use" blurb is injected into the prompt context of all sibling manager sessions (but not workers). This is how managers learn about available project agents and when to message them.`,
    keywords: [
      'project agent',
      'create',
      'promotion',
      'agent creator',
      'wizard',
      'agent architect',
      'handle',
      '@mention',
      'messaging',
      'settings',
      'demote',
    ],
    relatedIds: ['concepts-project-agents', 'chat-sidebar', 'chat-sessions'],
    contextKeys: ['chat.sidebar', 'chat.main'],
  },
]
