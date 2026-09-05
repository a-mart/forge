As a conversation grows, it uses more of the model's context window. Compaction reduces that load so you can keep going without hitting the limit. **Summary** remains the default: older messages are summarized and recent context is retained. **Fresh windows** is experimental: the live window starts from a deterministic checkpoint, and older history stays on disk for agent-only recall.

## Context management

Choose the project default in **Project Settings → Context management**. Eligible local Builder managers can inherit that default or override it from the compact **Context management** control beside Send. Summary remains the default. Saving a mode does not clear the current conversation; it applies at the next context transition.

Fresh is executable only by supported ordinary Pi Builder managers (OpenAI/Codex or Anthropic). Collaboration, Cortex/system, Cursor SDK, plugin/external threads, and workers cannot run it. Workers inherit the owning manager. A project can still save Fresh as a preference even when the current runtime cannot execute it. **Settings → General** is not the home for this policy.

## When to compact

Watch the context window indicator in the header (the ring icon). When it turns amber or red, you're running low. Compaction is also triggered automatically when the context gets critically full.

## How to compact

Open the **⋮ menu** in the chat header. You'll see two options, and both follow the session's effective policy:

- **Compact context** — on Summary, a fast mechanical summary that trims older messages; on Fresh, a deterministic checkpoint with no LLM summary.
- **Smart compact** — on Summary, an AI handoff that preserves important context and nuance, then resumes when the manager was active; on Fresh, the same checkpoint path as Compact, skipping the Smart LLM handoff.

If you run Smart compact manually on **Summary** while a Pi-backed manager is already idle, it stays idle afterward. If the manager is active, interrupted, or waiting on dispatch, it resumes after compaction. On **Fresh**, a busy manual Compact or Smart compact is rejected until streaming, tools, and prompt dispatch settle; retry when idle. An idle Fresh manager stays idle.

Settings for the compaction model, reasoning level, and timeout live in **Settings > General > Compaction**. They apply only to supported Pi-backed manager compaction runtimes, currently OpenAI/Codex and Anthropic. Cursor SDK, xAI/Grok, and user-added OpenRouter manager models are not controlled by these settings; OpenRouter manager eligibility is a separate policy and OpenRouter models are not compaction choices.

## Auto-compaction

When the context window fills up during an active conversation, Forge triggers compaction automatically using the effective policy. You'll see a spinning indicator on the ⋮ menu button and a violet pulsing `C` badge on the session row while compaction or context recovery is active. This prevents the agent from failing mid-response due to context limits.

## History recall

There is no human history drawer. Local Builder managers and ordinary workers recover compacted or older evidence with the agent-only `history` tool: search the current session first (including associated workers), then the current project if needed. Targeted `sessionAgentId` or `profileId` searches are also valid. Every search outside the current project requires a nonempty reason and no approval prompt; `all_local` is a deliberate broad search, not the only cross-project path. Search is lexical (ranked terms, quoted phrases, prefixes, and code or path tokens), not embeddings. Reads use source-qualified references. Historical evidence is not current authority; incomplete catch-up warnings mean a no-match is not proof of absence.

Canonical JSONL remains the source of truth. `shared/cache/history-recall.db` is a rebuildable derived index. Indexing clips each entry to 32,768 characters, readable JSONL rows stop at 1 MiB, and a `history` read is bounded to 20,000 characters across the entry and neighbors.

## Pinned messages

If you've pinned messages (shown by the pin count in the header), their content is preserved through all compaction types, including smart compaction, automatic compaction, Summary, and Fresh. You can pin up to 10 messages per session. Under Summary, pinned content is injected into the agent's custom instructions. Under Fresh, pins are included in the checkpoint.

## After compaction

On Summary, older messages are replaced with a summary and recent messages stay intact. On Fresh, the live window starts from the checkpoint and older transcript remains searchable. The context window indicator should reflect the live runtime state rather than stale pre-compaction descriptor usage, and the sidebar `C` badge clears when compaction or recovery is done. You can continue the conversation normally.
