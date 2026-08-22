As a conversation grows, it uses more of the model's context window. Compaction reduces the token count by summarizing older messages so you can keep going without hitting the limit.

## When to compact

Watch the context window indicator in the header (the ring icon). When it turns amber or red, you're running low. Compaction is also triggered automatically when the context gets critically full.

## How to compact

Open the **⋮ menu** in the chat header. You'll see two options:

- **Compact context** — a fast, mechanical summary that trims older messages.
- **Smart compact** — uses an AI pass to produce a more intelligent summary that preserves important context and nuance. Takes longer but keeps more useful information.

If you run Smart compact manually while a Pi-backed manager is already idle, it stays idle afterward. If the manager is active, interrupted, or waiting on dispatch, it resumes after compaction.

Settings for the compaction model, reasoning level, and timeout live in **Settings > General > Compaction**. They apply only to supported Pi-backed manager compaction runtimes, currently OpenAI/Codex and Anthropic. Cursor SDK, xAI/Grok, and user-added OpenRouter manager models are not controlled by these settings; OpenRouter manager eligibility is a separate policy and OpenRouter models are not compaction choices.

## Auto-compaction

When the context window fills up during an active conversation, Forge triggers compaction automatically. You'll see a spinning indicator on the ⋮ menu button and a violet pulsing `C` badge on the session row while compaction or context recovery is active. This prevents the agent from failing mid-response due to context limits.


## Pinned messages

If you've pinned messages (shown by the pin count in the header), their content is preserved through all compaction types, including smart compaction and automatic compaction. You can pin up to 10 messages per session. Pinned content is injected into the agent's custom instructions so it survives every compaction mode.

## After compaction

Your older messages are replaced with a summary. Recent messages stay intact. The context window indicator should reflect the live runtime state rather than stale pre-compaction descriptor usage, and the sidebar `C` badge clears when compaction or recovery is done. You can continue the conversation normally.
