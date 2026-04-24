import type { HelpArticle } from '../help-types'

const modelsOverview: HelpArticle = {
  id: 'models-overview',
  title: 'Understanding Models in Forge',
  category: 'models',
  summary: 'How Forge uses different AI models and how to pick the right one for your work.',
  content: `Forge connects to multiple AI providers and models. Each model has different strengths — some are fast and cheap, others are slower but produce better results on hard problems. You pick a model for your manager session and for each specialist worker.

## What matters when choosing a model

Three things affect the quality and speed of what you get back:

- **The model itself.** GPT-5.4 and Claude Opus 4.6 are the most capable models. Smaller variants like GPT-5.4 Mini or Claude Haiku 4.5 are faster and cheaper but less thorough on complex tasks.
- **The reasoning level.** Higher reasoning means the model spends more time thinking before answering. This improves accuracy on hard problems but costs more and takes longer.
- **The task.** A quick file read does not need the same model as a multi-file refactor. Match the model to the work.

## Where models get configured

- **Manager model:** Set when you create a session or change it in Settings. This controls the main orchestration agent.
- **Specialist models:** Each specialist worker has its own model and reasoning level. Configure these in Settings > Specialists. Specialists can use either the Pi-proxied Anthropic provider or the native Claude SDK provider independently.
- **Fallback models:** Specialists can define a fallback model that kicks in if the primary is unavailable or rate-limited.

## Model-specific instructions

Each model card in Settings > Models has a "Model-specific instructions" field. These are prompt instructions automatically injected into the manager prompt when that model is active. Built-in defaults exist for GPT-5 and Claude families. You can override, clear (to suppress defaults), or leave unchanged to use the built-in.

Start with the defaults. Adjust when you notice a task is too slow, too expensive, or not producing good enough results.`,
  keywords: ['model', 'models', 'select', 'choose', 'AI', 'provider', 'overview'],
  relatedIds: ['models-providers', 'models-reasoning', 'models-routing'],
  contextKeys: ['settings.general', 'settings.specialists'],
}

const modelsProviders: HelpArticle = {
  id: 'models-providers',
  title: 'Provider Guide',
  category: 'models',
  summary: 'What each AI provider offers and when to use their models.',
  content: `Forge supports four AI providers. Each has a different set of models with different tradeoffs.

## OpenAI / Codex

OpenAI offers the GPT-5 model family through the Codex runtime.

- **GPT-5.3 Codex** — The original Codex coding model. Strong at implementation tasks, refactors, and debugging. Supports all reasoning levels from none to max.
- **GPT-5.4** — The newest and most capable OpenAI model. Better than 5.3 at complex planning, architecture, and multi-step reasoning. Good default for backend work and code review.
- **GPT-5.4 Mini** — A smaller, faster variant of 5.4. Good for lightweight tasks like reading files, quick edits, and exploration. Much cheaper than the full model.
- **GPT-5.4 Nano** — The smallest variant. Very fast and very cheap. Best for simple lookups, grep-style searches, and tasks where speed matters more than depth.

## Anthropic

Anthropic offers the Claude model family through the Pi-proxied path.

- **Claude Opus 4.6** — Anthropic's top-tier model. Particularly strong at frontend work, UI polish, writing, and nuanced code review. Reasoning levels are limited to low, medium, and high (no "none" or "max").
- **Claude Sonnet 4.5** — A mid-range model. Faster than Opus, still capable. Good for documentation, lighter code tasks, and cases where Opus is overkill.
- **Claude Haiku 4.5** — The fast, affordable option. Use it for bulk tasks, formatting, and anything that does not need deep analysis.

## Claude SDK

Claude SDK uses the local Claude Code CLI OAuth session instead of an API key. It is a native path for Claude models and can be used independently from the Pi-proxied Anthropic path.

- **sdk-opus** — Native Claude SDK preset for Opus-class work.
- **sdk-sonnet** — Native Claude SDK preset for Sonnet-class work.

## xAI / Grok

xAI provides the Grok model family. Grok models are available for specialist workers but not for manager sessions.

- **Grok 4** — xAI's flagship. Strong general-purpose model.
- **Grok 4 Fast** — Optimized for speed at some quality tradeoff.
- **Grok 4.20** — A newer variant with expanded capabilities.

You need provider credentials for each provider configured in Settings > Auth before its models appear in selectors. Claude SDK uses Claude Code CLI OAuth, and SDK models can be disabled in Settings > Models if you do not want to see them.`,
  keywords: ['provider', 'OpenAI', 'Codex', 'Anthropic', 'Claude', 'Grok', 'xAI', 'GPT', 'Opus', 'Sonnet', 'Haiku'],
  relatedIds: ['models-overview', 'models-cost', 'models-reasoning'],
  contextKeys: ['settings.general', 'settings.auth', 'settings.specialists'],
}

const modelsReasoning: HelpArticle = {
  id: 'models-reasoning',
  title: 'Reasoning Levels Explained',
  category: 'models',
  summary: 'What each reasoning level does and when to raise or lower it.',
  content: `Reasoning level controls how much a model thinks before responding. Higher levels produce more careful, accurate output but take longer and cost more.

## The five levels

- **None** — No extended reasoning. The model responds immediately with its first-pass answer. Use this for trivial tasks like listing files or echoing values. Not available on Anthropic models.
- **Low** — Minimal reasoning. Suitable for straightforward tasks where the answer is mostly obvious: simple edits, grep results, status checks.
- **Medium** — Moderate reasoning. Good for everyday coding work: writing functions, fixing bugs, making standard refactors. This is a solid default for most tasks.
- **High** — Extended reasoning. The model takes extra time to think through complex problems. Use this for multi-file changes, architecture decisions, code review, and anything where getting it wrong would be expensive. This is the default for most specialists.
- **Max (xhigh)** — Maximum reasoning. The model spends the most time analyzing before responding. Reserve this for the hardest problems: large refactors, subtle bugs, security-sensitive code, architectural planning. Not available on Anthropic models.

## Provider differences

Anthropic models (Claude) normalize reasoning levels differently. Setting "none" on a Claude model behaves like "low," and "max" behaves like "high." The five-level scale works fully on OpenAI models.

## How to choose

Start at **medium** or **high** and adjust from there. If you notice a specialist rushing through complex work, raise its reasoning level. If a task is simple and the specialist is taking too long, lower it.

The reasoning level is set per specialist in Settings > Specialists. You can also set it for the manager model when creating or editing a session.`,
  keywords: ['reasoning', 'level', 'none', 'low', 'medium', 'high', 'xhigh', 'max', 'thinking', 'quality'],
  relatedIds: ['models-overview', 'models-cost', 'models-providers'],
  contextKeys: ['settings.general', 'settings.specialists'],
}

const modelsRouting: HelpArticle = {
  id: 'models-routing',
  title: 'How Model Routing Works',
  category: 'models',
  summary: 'How Forge picks which model runs each task through specialists and fallbacks.',
  content: `Forge uses a specialist system to route different kinds of work to different models. The manager decides which specialist to use, and each specialist has its own model configuration.

## Manager model

The manager model handles orchestration: reading your messages, deciding what to do, breaking work into tasks, and coordinating specialist workers. The manager does not write code directly. Pick a capable model here — it affects the quality of task planning and delegation.

You can set the profile default from the profile header with **Change Default Model**, override a single session with **Override Session Model**, or switch a session back to inherited state with **Use Project Default**.

## Specialist routing

When the manager spawns a worker, it picks a specialist based on the task. Each specialist has:

- A **primary model** and reasoning level — the default for that specialist's work.
- An optional **fallback model** — used when the primary model is unavailable or rate-limited.
- A **"when to use" description** — tells the manager which tasks to send to this specialist.

For example, the builtin Backend Engineer uses GPT-5.4 at high reasoning. The Frontend Engineer uses Claude Opus 4.6 at high reasoning. The Architect uses GPT-5.5 with Claude Opus 4.6 as fallback. The Planner uses GPT-5.5 with Claude Opus 4.6 as fallback. The Scout uses GPT-5.4 Mini at low reasoning for quick exploration.

## Fallback behavior

If a specialist's primary model fails (rate limit, outage, credentials issue), Forge falls back to the specialist's fallback model if one is configured. If no fallback is set, the task fails and the manager reports the error.

Set fallbacks for critical specialists to avoid interruptions during long-running work.

## Customizing per profile

Specialist model assignments can be overridden per profile. Open Settings > Specialists, pick a profile scope, and customize any specialist. Profile overrides take priority over global defaults without affecting other profiles.

This is useful when different projects need different model routing — for example, a frontend-heavy project might upgrade the Frontend Engineer to max reasoning while keeping the global default at high.`,
  keywords: ['routing', 'specialist', 'fallback', 'delegation', 'manager', 'worker', 'spawn'],
  relatedIds: ['models-overview', 'models-providers', 'concepts-specialists'],
  contextKeys: ['settings.specialists', 'chat.workers'],
}

const modelsCost: HelpArticle = {
  id: 'models-cost',
  title: 'Cost and Speed Tradeoffs',
  category: 'models',
  summary: 'Which models are fast and cheap versus slow and thorough.',
  content: `Every model choice is a tradeoff between cost, speed, and output quality. Here is a practical breakdown.

## Fast and cheap

Use these for high-volume or simple tasks where speed matters more than depth.

- **GPT-5.4 Nano** — Fastest, cheapest. Good for file reads, searches, and quick lookups.
- **GPT-5.4 Mini** — Fast with decent quality. The Scout specialist uses this by default for exploration and information gathering.
- **Claude Haiku 4.5** — Anthropic's fast option. Good for bulk formatting, simple code generation, and lightweight review.

## Balanced

These work well for everyday development tasks.

- **GPT-5.3 Codex** — The standard coding model. Good balance of speed and quality for implementation work.
- **Claude Sonnet 4.5** — Mid-range Anthropic model. The Doc Writer specialist uses this for documentation tasks where full Opus would be wasteful.
- **Grok 4 Fast** — Quick Grok variant for specialist tasks.

## Thorough but expensive

Reserve these for work where quality matters most.

- **GPT-5.4** — OpenAI's strongest. Best for complex backend work and multi-file refactors. The Backend Engineer specialist defaults to this; Architect now defaults to GPT-5.5.
- **Claude Opus 4.6** — Anthropic's strongest. Best for frontend work, nuanced code review, and tasks that need careful judgment. The Frontend Engineer specialist defaults to this; Planner now defaults to GPT-5.5 with Opus 4.6 as fallback.
- **Grok 4** — xAI's flagship for specialist use.

## Reasoning level adds cost too

Higher reasoning levels multiply both cost and latency on top of the base model cost. A GPT-5.4 task at "max" reasoning costs significantly more than the same task at "low." Adjust reasoning level alongside model choice — sometimes dropping from max to high saves time without noticeably affecting quality.

## General advice

Match the model to the task. Use cheap models for exploration, mid-range models for standard work, and expensive models for the tasks that actually need them. The specialist system makes this automatic once configured.`,
  keywords: ['cost', 'speed', 'fast', 'cheap', 'expensive', 'tradeoff', 'token', 'latency', 'price'],
  relatedIds: ['models-overview', 'models-reasoning', 'models-routing'],
  contextKeys: ['settings.general', 'settings.specialists'],
}

export const modelsArticles: HelpArticle[] = [
  modelsOverview,
  modelsProviders,
  modelsReasoning,
  modelsRouting,
  modelsCost,
]
