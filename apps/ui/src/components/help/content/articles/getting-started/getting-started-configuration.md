Forge needs an LLM provider to run agents. Everything else is optional but worth knowing about.

## Connect a provider

Open **Settings** (gear icon in the sidebar) and go to **Authentication**. Configure at least one provider that supports the agents and models you want:

- **Anthropic** and **OpenAI** use the current OAuth account-pool cards.
- **xAI** uses one direct, non-pooled row for either an API key or OAuth. Configuring one replaces the other.
- **OpenRouter** and **Cursor SDK** use masked key/token-only rows.

For xAI browser OAuth, use **Open authorization URL** or **Copy URL**, then paste the full callback URL if the local callback cannot reach Forge. For a remote or headless backend, choose the device path and enter the displayed code at the verification URL. **Cancel** stops the current attempt, while **Clear** only dismisses completed or failed flow state; neither removes saved auth. Use **Remove** to delete the credential stored on that Forge backend.

Status and auth-type badges appear only on applicable cards. You only need one compatible provider to run agents, while multiple configured providers let different managers or specialists use different models. Native Grok can appear in specialist and spawn choices when xAI auth is configured and the models are visible, but not in normal manager create, change, or override selectors.

## Choose your model

Each manager has a default model set during creation. To change it, open Settings for that manager and pick a different model from the dropdown. Some things to consider:

- **Claude Sonnet** is a good general-purpose choice for managers.
- **Claude Opus** is stronger for complex reasoning and code review.
- **GPT models** work well and offer an alternative when you want model diversity.

Delegated workers can use different models than the manager. Configure Support, Routine, and Deep under **Settings → Delegation**.

## Profile basics

A profile groups settings, memory, and resources for a manager. When you create a manager, a profile is created automatically.

Profile settings include:

- **System prompt** — base instructions for the manager. You can customize this or use the default.
- **Skills** — browse and configure optional skill-backed capabilities such as Brave search, image generation, and the separate `agent-browser` CLI workflow. Managed Browser and External Chrome are local Forge Desktop hosts, not Skills; External Chrome has its own Settings page.
- **Delegation** — worker execution policies, behavior-mode prompts, and custom specialists.
- **Memory** — canonical profile and session memory. This is distinct from profile-scoped Knowledge v2 entries.

Most of these work well with defaults. Adjust them as you learn what your workflow needs.

## Optional: connect Remote Projects

To use projects hosted by another Forge server, open **Settings > Collaboration**, select **Add connection**, enter its URL, choose **Test**, then choose **Add**. Sign in to the saved connection and turn on its **Remote projects** switch. A new connection is automatically opted in only when the successful Test advertised support.

Return to Builder and select a blue, globe-marked remote project header or a nested session row beneath it; nested sessions use status dots. Chat, agents, Files, Source Control, and remote terminals then target the remote server; the project is not cloned or synchronized locally. The Builder/Collab switch is separate—it opens Collaboration channels rather than remote Builder projects. See **Collaboration and Remote Projects** for trust and status details.

## What's next

Start a conversation. The best way to configure Forge is to use it—the manager will ask for clarification when needed. While Knowledge v2 is on, managers and bounded capture checks can save durable preferences as entries.
