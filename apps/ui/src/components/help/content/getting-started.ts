import type { HelpArticle } from '../help-types'

export const gettingStartedArticles: HelpArticle[] = [
  {
    id: 'getting-started',
    title: 'Welcome to Forge',
    category: 'getting-started',
    summary:
      'What Forge does and how to start using it.',
    content: `You describe what needs to happen. Forge breaks it down, spins up workers, and runs things in parallel while you focus on the next problem.

## How it works

You talk to a **manager** agent. The manager reads your instructions, decides what can run concurrently, and dispatches **workers** to do the actual work. Each worker operates in its own git worktree so nothing collides. You watch progress in real time from this dashboard, or walk away and check in later.

One conversation can have dozens of workers running at once. You don't manage them individually — the manager handles coordination, merging, and status tracking.

## What to do first

1. **Add your credentials.** Open Settings and connect your OpenAI or Anthropic account. Forge needs at least one provider to run agents.
2. **Create a manager.** Click the **+** button in the sidebar. Give it a name, point it at a project directory, and pick a model.
3. **Start talking.** Describe the work at whatever level makes sense — a feature, a bug fix, a batch of refactors. The manager figures out the rest.

## A tip before you start

Spend your first few minutes telling the manager how you like to work. Your review process, your branching strategy, how you think about testing. This is not small talk. It's calibration. The better the manager understands your style, the better it orchestrates on your behalf.

After that, rate messages as you go. Thumbs up when the manager nails it, thumbs down when it misses. This feedback feeds into Cortex, which learns your preferences over time and improves future sessions.`,
    keywords: [
      'welcome',
      'getting started',
      'overview',
      'introduction',
      'first steps',
      'new user',
      'onboarding',
    ],
    relatedIds: [
      'getting-started-first-session',
      'getting-started-configuration',
      'getting-started-help',
    ],
    contextKeys: ['chat.main', 'chat.sidebar'],
  },

  {
    id: 'getting-started-first-session',
    title: 'Your First Chat Session',
    category: 'getting-started',
    summary:
      'Create a manager, send a message, and see workers in action.',
    content: `Everything in Forge starts with a manager session. Here's how to get one running.

## Create a manager

Click the **+** button at the top of the sidebar. You'll need three things:

- **Name** — something that identifies the project or workstream. You can rename it later.
- **Working directory** — the project folder where workers will operate. Each worker gets its own worktree branched from this directory.
- **Model** — which LLM powers the manager. Claude Sonnet and GPT models both work well. You can change this later in Settings.

Click **Create** and the manager appears in the sidebar.

## Send your first message

Type in the chat input at the bottom. Start with something concrete:

- "Fix the failing tests in the auth module"
- "Add dark mode support to the settings page"
- "Review the last three PRs and summarize the changes"

The manager reads your message, plans the work, and spawns workers as needed.

## Watch workers run

Active workers show up as green pills below the chat header. Click any pill to peek at what that worker is doing. The manager streams status updates into the chat as workers report progress.

Workers run independently. You can keep talking to the manager, start a new task, or close the tab entirely. Workers continue in the background and the manager tracks everything.

## Sessions and profiles

Your manager can have multiple **sessions** — independent conversations with their own history and memory. Right-click the manager in the sidebar to create a new session or fork an existing one.

Sessions belong to a **profile**, which holds shared settings like model choice, system prompt, and persistent memory. Changes to the profile apply to all sessions under it.`,
    keywords: [
      'first session',
      'create manager',
      'new manager',
      'send message',
      'workers',
      'worker pills',
      'sessions',
      'profiles',
      'chat',
    ],
    relatedIds: [
      'getting-started',
      'getting-started-configuration',
      'chat-overview',
      'concepts-multi-agent',
    ],
    contextKeys: ['chat.main', 'chat.sidebar'],
  },

  {
    id: 'getting-started-configuration',
    title: 'Essential Setup',
    category: 'getting-started',
    summary:
      'Connect a provider, choose a model, and configure your profile.',
    content: `Forge needs an LLM provider to run agents. Everything else is optional but worth knowing about.

## Connect a provider

Open **Settings** (gear icon in the sidebar) and go to the **Auth** tab. You can sign in with OAuth or paste an API key for:

- **Anthropic** — Claude models (Sonnet, Opus, Haiku)
- **OpenAI** — GPT models and Codex

You need at least one provider connected. Both can be active at the same time — different managers or specialists can use different providers.

## Choose your model

Each manager has a default model set during creation. To change it, open Settings for that manager and pick a different model from the dropdown. Some things to consider:

- **Claude Sonnet** is a good general-purpose choice for managers.
- **Claude Opus** is stronger for complex reasoning and code review.
- **GPT models** work well and offer an alternative when you want model diversity.

Specialists (named worker templates) can use different models than the manager. Configure these under **Settings → Specialists**.

## Profile basics

A profile groups settings, memory, and resources for a manager. When you create a manager, a profile is created automatically.

Profile settings include:

- **System prompt** — base instructions for the manager. You can customize this or use the default.
- **Skills** — toggle built-in capabilities like web search, image generation, and browser automation.
- **Specialists** — named worker templates with their own model and prompt configuration.
- **Memory** — persistent knowledge the manager accumulates over time, managed by Cortex.

Most of these work well with defaults. Adjust them as you learn what your workflow needs.

## What's next

Start a conversation. The best way to configure Forge is to use it — the manager will ask for clarification when it needs it, and Cortex learns your preferences from how you work.`,
    keywords: [
      'setup',
      'configuration',
      'auth',
      'authentication',
      'api key',
      'oauth',
      'model',
      'provider',
      'anthropic',
      'openai',
      'profile',
      'settings',
      'specialists',
    ],
    relatedIds: [
      'getting-started',
      'getting-started-first-session',
      'settings-auth',
      'settings-general',
      'models-overview',
    ],
    contextKeys: ['settings.auth', 'settings.general'],
  },

  {
    id: 'getting-started-help',
    title: 'Using the Help System',
    category: 'getting-started',
    summary:
      'Find answers with the help drawer, keyboard shortcuts, and search.',
    content: `Forge has built-in documentation that stays relevant to what you're looking at.

## The help drawer

Click the **?** icon in the header to open the help drawer. It slides in from the right and shows articles related to your current view. If you're in Settings, you'll see settings docs. If you're in chat, you'll see chat docs.

You can also open it with **Ctrl+/** (or **⌘+/** on Mac) from anywhere in the app.

## Finding things

Use the search field at the top of the help drawer to find articles by keyword. Results update as you type. You can also browse by category using the tabs at the top of the drawer.

Every article includes links to related topics at the bottom, so you can follow a thread without going back to search.

## Keyboard shortcuts

Press **?** when you're not typing in an input field to see all available keyboard shortcuts in an overlay. This shows shortcuts grouped by context — global, chat, settings, and terminal.

Close the overlay with **Esc** or by pressing **?** again.

## Context-aware help

Help triggers appear throughout the app — small **?** icons next to settings, controls, and panels. These open the help drawer directly to the relevant article. Tooltips on controls also include "Learn more" links when there's a related article.

## If you get stuck

The help system covers every major surface in Forge: chat, settings, Cortex, terminals, models, and core concepts like memory, prompts, and specialists. Start with search if you're not sure where to look.`,
    keywords: [
      'help',
      'documentation',
      'docs',
      'search',
      'keyboard shortcuts',
      'shortcuts',
      'help drawer',
      'context help',
      'how to',
      'find',
    ],
    relatedIds: ['getting-started'],
    contextKeys: ['chat.main', 'settings.general'],
  },
]
