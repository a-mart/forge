Profiles and sessions are Forge's two levels of organization. A profile groups configuration and memory for a project or workflow. Sessions are individual conversations within a profile.

## Profiles

A profile holds:

- **Settings** — model selection, system prompt, archetype, working directory
- **Memory** — durable facts and decisions for this project
- **Specialists** — worker configurations (can override global specialists)
- **Reference docs** — files the agent can access for context
- **Sessions** — all conversations that share this config

When you create a new session in a profile, it inherits the profile's settings. By default, that means it uses the profile's default manager model, the same specialists, the same profile memory, and the project's default context management (Summary unless the project opted into experimental Fresh windows). You can later override the model or context policy for an individual session without changing the profile default.

## Sessions

A session is a single conversation thread. Each session has:

- Its own **chat history** stored as a JSONL file
- Its own **working memory** for in-progress context
- Its own **workers** that run during the conversation
- Its own **pinned messages** (up to 10)
- Its own **context management** inherit/override (Summary default, or experimental Fresh windows where supported)

Sessions within a profile are independent. You can have one session debugging a backend issue and another working on a UI feature — both starting from the same profile config but tracking separate context. If you change the profile default model or context mode later, only sessions that still inherit it are updated; sessions with an explicit override keep their own value. Saving a context mode applies at the next context transition rather than clearing the current window. Pinned sessions in the sidebar are just navigation favorites; they are separate from pinned messages inside a conversation.

## Lifecycle

Sessions are either **running** (actively connected) or **idle** (saved but not processing). Archived sessions and archived profiles are a reversible, lossless frozen state: the data stays on disk, but the session or project is read-only and unavailable for runtime use until restored. Archive entries are sorted by last user-message activity and show the last-used date. The default Main session in a project cannot be archived directly. Deleting a session still removes its history, memory, and workers.

## Forking

You can fork a session to branch off from a specific point in the conversation. The fork copies history up to that message and creates a fresh session memory with a note about where it branched. This is useful when you want to try an alternative approach without losing the original thread.

Forks preserve the source session's model state too: if the source was inheriting the profile default, the fork inherits that state; if the source had an explicit session override, the fork keeps that override. The same inherit-or-override rule applies to context management. Cursor SDK runtime state and usage records are omitted from forks so resumed branches do not leak prior SDK state or double-count usage. A source session's initial Pi model-input record is also omitted; a Pi-backed fork records its own initial input on its first model request. Historical Codex sidecar display cards are also omitted from forked sessions.

New sessions and forks inherit all config from the parent profile unless you explicitly override the session model or context policy.
