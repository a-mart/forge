Forge needs an LLM provider to run agents. Everything else is optional but worth knowing about.

## Connect a provider

Open **Settings** (gear icon in the sidebar) and go to the **Auth** tab. You can sign in with OAuth or paste an API key for:

- **Anthropic** — Claude models (Sonnet, Opus, Haiku)
- **Claude SDK** — native Claude Code CLI OAuth; run `claude login` first
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

## Optional: connect Remote Projects

To use projects hosted by another Forge server, open **Settings > Collaboration**, select **Add connection**, enter its URL, choose **Test**, then choose **Add**. Sign in to the saved connection and turn on its **Remote projects** switch. A new connection is automatically opted in only when the successful Test advertised support.

Return to Builder and select a blue, globe-marked remote project header or a nested session row beneath it; nested sessions use status dots. Chat, agents, Files, Source Control, and remote terminals then target the remote server; the project is not cloned or synchronized locally. The Builder/Collab switch is separate—it opens Collaboration channels rather than remote Builder projects. See **Collaboration and Remote Projects** for trust and status details.

## What's next

Start a conversation. The best way to configure Forge is to use it — the manager will ask for clarification when it needs it, and Cortex learns your preferences from how you work.
