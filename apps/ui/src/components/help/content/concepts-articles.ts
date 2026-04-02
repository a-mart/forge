import type { HelpArticle } from '../help-types'

const conceptsMultiAgent: HelpArticle = {
  id: 'concepts-multi-agent',
  title: 'Multi-Agent Architecture',
  category: 'concepts',
  summary:
    'How managers and workers coordinate to handle complex tasks.',
  content: `Forge uses two kinds of agents: **managers** and **workers**. A manager is the agent you talk to in chat. Workers are agents the manager creates to do specific tasks.

When you send a message, the manager reads it, decides what needs to happen, and spawns one or more workers. Each worker gets a focused job — edit a file, run a command, research a topic. Workers run in parallel when their tasks are independent. The manager collects their results and responds to you.

## What you see

Workers appear as pills below the chat header while they are active. Click a pill to see what that worker is doing. When a worker finishes, it reports back to the manager and disappears.

## Why this matters

Splitting work across workers means the manager can handle multiple things at once. A single message might trigger a backend fix, a UI update, and a test run — all happening in parallel instead of one after another.

The manager controls the flow. It decides which model each worker uses, what instructions to give, and whether to retry if something fails. You do not need to manage workers directly, but you can watch their progress and see their output in the chat.

## How routing works

The manager picks a model for each worker based on the task. Quick jobs like file reads get a cheaper, faster model. Complex work like architecture review gets a more capable one. If you have specialists configured, the manager routes work to the right specialist automatically based on what the task needs.

Workers can use tools — reading files, running shell commands, making edits — but they always report results back to the manager, which decides the next step.`,
  keywords: [
    'manager',
    'worker',
    'agent',
    'multi-agent',
    'orchestration',
    'parallel',
    'spawn',
    'routing',
  ],
  relatedIds: ['concepts-specialists', 'concepts-sessions'],
  contextKeys: ['chat.workers', 'chat.main'],
}

const conceptsMemory: HelpArticle = {
  id: 'concepts-memory',
  title: 'Memory System',
  category: 'concepts',
  summary:
    'How Forge remembers context across sessions using profile memory, session memory, and common knowledge.',
  content: `Forge keeps three layers of memory so agents have the right context without you repeating yourself.

## Profile memory

Each profile has a memory file that stores durable facts — project conventions, tech stack details, decisions you have made. Every session in that profile can read this memory. Think of it as the shared knowledge base for a particular project or workflow.

## Session memory

Each chat session has its own working memory. This is where the agent records things it learns during a conversation — what it tried, what worked, open questions. Session memory is private to that session. Other sessions in the same profile do not see it.

This separation is useful because a session might explore a dead-end approach. You do not want that polluting the shared profile memory. When a session produces insights worth keeping, the memory can be merged up into the profile level.

## Common knowledge

Common knowledge lives above profiles. It stores cross-project preferences — things like your name, how you prefer to communicate, and workflow habits. Cortex manages this file. Every profile and session can read it.

## How they interact

When an agent starts working, it loads all three layers: common knowledge, then profile memory, then session memory. More specific layers take precedence. If session memory says "use approach B" but profile memory says "use approach A," the agent follows the session.

You can ask the agent to remember something and it writes to session memory. Profile memory updates happen through explicit merges or Cortex reviews. Common knowledge updates when you tell Cortex about a cross-project preference.

Memory files are plain markdown stored on disk. You can read and edit them directly if you want.`,
  keywords: [
    'memory',
    'profile memory',
    'session memory',
    'common knowledge',
    'context',
    'remember',
    'persistence',
    'cortex',
  ],
  relatedIds: ['concepts-sessions', 'cortex-overview', 'cortex-knowledge'],
  contextKeys: ['chat.main', 'cortex.knowledge'],
}

const conceptsPromptResolution: HelpArticle = {
  id: 'concepts-prompt-resolution',
  title: 'Prompt System',
  category: 'concepts',
  summary:
    'How Forge resolves system prompts through three layers: profile, repo, and builtin defaults.',
  content: `The prompt system controls what instructions agents receive when they start working. Forge resolves prompts through three layers, checked in order.

## The three layers

1. **Profile** — Custom prompts you save for a specific profile. These live in your profile's prompt directory and take highest priority.
2. **Repo** — Prompts stored in the project repository (like \`AGENTS.md\`). These apply to anyone working in that repo.
3. **Builtin** — Default prompts that ship with Forge. These are the fallback when no profile or repo override exists.

Forge checks profile first. If it finds a matching prompt there, it uses it and stops looking. Otherwise it checks the repo layer, then falls back to builtins.

## What this means in practice

Say the builtin manager prompt works for most of your projects, but one project needs specific instructions about its deployment process. You save a profile-level prompt override for that project's profile. Other profiles keep using the builtin. If you later want to go back to the default, delete the profile override.

## Prompt preview

Open the system prompt viewer in chat to see the full prompt an agent is actually using. This shows the resolved result — not just the raw template, but the complete context including memory, project guidance, and any loaded skills. Use this when you want to understand exactly what instructions the agent is following.

## Archetypes

Archetypes are prompt templates for different agent roles — the default manager, Cortex, and others. Each archetype defines the base behavior for that kind of agent. Profile overrides layer on top of the archetype, so you can customize without replacing the whole prompt.

You can browse and edit prompts in **Settings > Prompts**.`,
  keywords: [
    'prompt',
    'system prompt',
    'resolution',
    'archetype',
    'override',
    'profile prompt',
    'repo prompt',
    'builtin',
    'template',
  ],
  relatedIds: ['settings-prompts', 'chat-system-prompt'],
  contextKeys: ['settings.prompts', 'chat.system-prompt'],
}

const conceptsSpecialists: HelpArticle = {
  id: 'concepts-specialists',
  title: 'Specialist Workers',
  category: 'concepts',
  summary:
    'Named worker templates with dedicated models, prompts, and routing rules.',
  content: `Specialists are predefined worker types with their own name, model, and system prompt. Instead of the manager picking a generic worker for every task, it routes work to the right specialist.

## What a specialist includes

Each specialist has:

- A **display name** and color for identification in the UI
- A **model and reasoning level** tuned for its role
- A **system prompt** with instructions specific to that specialty
- A **"when to use"** description that tells the manager when to pick this specialist
- An optional **fallback model** if the primary is unavailable

For example, a "Frontend" specialist might use Claude Opus with instructions focused on React, accessibility, and visual consistency. A "Backend" specialist might use GPT Codex with instructions about API design and database patterns.

## How routing works

When the manager needs to spawn a worker, it reads the specialist roster and their "when to use" descriptions. It picks the specialist whose description best matches the task. The worker then runs with that specialist's model and prompt — no manual selection needed.

If specialists are disabled or none match, the manager falls back to its default model routing logic.

## Customization

Forge ships with builtin specialists that cover common roles. You can:

- **Edit** a builtin specialist to adjust its model, prompt, or routing rules
- **Create** new specialists for your specific workflow
- **Disable** specialists you do not need
- **Override per profile** — a specialist can behave differently for different projects

Manage specialists in **Settings > Specialists**. Profile-level overrides take precedence over global definitions.`,
  keywords: [
    'specialist',
    'worker',
    'routing',
    'model',
    'template',
    'named worker',
    'fallback',
    'prompt',
  ],
  relatedIds: ['concepts-multi-agent', 'settings-specialists'],
  contextKeys: ['settings.specialists', 'chat.workers'],
}

const conceptsSessions: HelpArticle = {
  id: 'concepts-sessions',
  title: 'Sessions and Profiles',
  category: 'concepts',
  summary:
    'How profiles group settings and memory, and how sessions track individual conversations.',
  content: `Profiles and sessions are Forge's two levels of organization. A profile groups configuration and memory for a project or workflow. Sessions are individual conversations within a profile.

## Profiles

A profile holds:

- **Settings** — model selection, system prompt, archetype, working directory
- **Memory** — durable facts and decisions for this project
- **Specialists** — worker configurations (can override global specialists)
- **Reference docs** — files the agent can access for context
- **Sessions** — all conversations that share this config

When you create a new session in a profile, it inherits the profile's settings. Two sessions in the same profile use the same model config, the same specialists, and the same profile memory.

## Sessions

A session is a single conversation thread. Each session has:

- Its own **chat history** stored as a JSONL file
- Its own **working memory** for in-progress context
- Its own **workers** that run during the conversation
- Its own **pinned messages** (up to 10)

Sessions within a profile are independent. You can have one session debugging a backend issue and another working on a UI feature — both using the same profile config but tracking separate context. Pinned sessions in the sidebar are just navigation favorites; they are separate from pinned messages inside a conversation.

## Lifecycle

Sessions are either **running** (actively connected) or **idle** (saved but not processing). There is no "closed" state — a session exists until you delete it. Deleting a session removes its history, memory, and workers.

## Forking

You can fork a session to branch off from a specific point in the conversation. The fork copies history up to that message and creates a fresh session memory with a note about where it branched. This is useful when you want to try an alternative approach without losing the original thread.

New sessions and forks inherit all config from the parent profile.`,
  keywords: [
    'session',
    'profile',
    'conversation',
    'fork',
    'lifecycle',
    'config',
    'inheritance',
    'memory',
    'idle',
    'running',
  ],
  relatedIds: ['concepts-memory', 'concepts-multi-agent', 'chat-fork-session'],
  contextKeys: ['chat.sidebar', 'chat.main'],
}

const conceptsProjectAgents: HelpArticle = {
  id: 'concepts-project-agents',
  title: 'Project Agents',
  category: 'concepts',
  summary:
    'Promoted sessions that become discoverable, persistent agents for cross-session collaboration.',
  content: `Project agents are sessions promoted to persistent specialist roles within a profile. Unlike regular sessions, they have dedicated handles and are discoverable by sibling sessions for async collaboration.

## What makes a project agent

A project agent is a regular session with special properties:

- A **unique handle** (like \`@releases\` or \`@docs\`) that identifies it across the profile
- A **"when to use"** blurb that tells other sessions what this agent is for
- An optional **custom system prompt** tailored to its specialized role
- Appears **pinned at the top** of the profile section in the sidebar with a badge

Project agents persist across restarts and appear in the agent directory that manager sessions can query.

## How discovery works

When a manager session starts, it receives an injected directory of available project agents in its prompt context. Each entry includes the agent's handle and "when to use" description. The manager can then message relevant project agents when it needs help with tasks that match their specialty.

Worker agents never see the project agent directory — this is a manager-to-manager coordination mechanism only.

## Fire-and-forget messaging

Project agents communicate through the existing \`send_message_to_agent\` tool. Messages are asynchronous and one-way — there's no reply threading or delivery confirmation. This keeps the model simple: a manager sends work to a project agent, the project agent processes it in its own session, and results appear in that agent's conversation.

If the receiving session is idle when a message arrives, Forge wakes it up automatically to handle the incoming work.

## @mention autocomplete

The chat composer offers autocomplete for project agent handles when you type \`@\`. This is a convenience feature only — it inserts the handle as text in your message. The \`@mention\` syntax does not trigger any special routing. The manager interprets the intent from the message content and uses the normal tool to send a message if appropriate.

## Two ways to create

You can create project agents in two ways:

1. **Manual promotion** — Right-click an existing session and choose "Promote to Project Agent." Fill in the handle and "when to use" description. Optionally request AI-generated recommendations for both fields based on the session's conversation history.

2. **Agent Creator wizard** — Right-click a profile header and choose "Create Project Agent." This opens a dedicated Agent Architect session that explores your repository, interviews you about the new agent's role, drafts a configuration proposal, and atomically creates and promotes the agent after you approve.

## Sidebar placement

Project agents are always pinned at the top of their profile section, above regular sessions. They remain visible even when the session list is paginated. This makes them easy to find and message.

## Demoting

Right-click a project agent and choose "Demote to Regular Session" to convert it back to a normal session. The handle and discovery metadata are removed, but the conversation history and session memory are preserved.`,
  keywords: [
    'project agent',
    'promotion',
    'handle',
    '@mention',
    'discovery',
    'cross-session',
    'messaging',
    'agent creator',
    'specialist',
    'async',
  ],
  relatedIds: ['concepts-sessions', 'concepts-multi-agent', 'chat-project-agents'],
  contextKeys: ['chat.sidebar', 'chat.main'],
}

export const conceptsArticles: HelpArticle[] = [
  conceptsMultiAgent,
  conceptsMemory,
  conceptsPromptResolution,
  conceptsSpecialists,
  conceptsSessions,
  conceptsProjectAgents,
]
