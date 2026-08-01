Forking creates a copy of a session so you can take the conversation in a different direction without losing the original.

## How to fork

Right-click a session in the sidebar and choose **Fork**. A dialog opens where you can give the fork a name (optional, Forge auto-generates one if you leave it blank).

## Full fork

By default, forking copies the entire conversation history into a new session and preserves the source session's model state, including whether it was inheriting the profile default or using an explicit override.

## Partial fork

You can also fork from a specific message. When triggered from a message context, the fork dialog shows which message it will fork from. Only messages up to that point are copied. Everything after is left behind.

The forked session's memory header records where the fork happened, so the boundary with the parent session is explicit.

## What gets copied

- **Conversation history** (all messages, or up to the selected message for partial forks).
- A fresh **session memory** is created with a fork header noting the parent session.

## What does not get copied

- The original session is unchanged. Forking is non-destructive.
- Session memory content from the parent is not carried over. The new session starts with its own empty memory (plus the fork header).
- Cursor SDK runtime state and usage records are not copied, so forks do not leak SDK resume state or double-count usage.
- Pi generation-throughput measurements are not copied, so the fork starts its own throughput history.
- Historical Codex sidecar display cards are not copied.
- Workers from the parent session are not duplicated.

## When to use it

Fork when you want to try an alternative approach, preserve a checkpoint before a risky change, or branch a conversation into two tracks.
