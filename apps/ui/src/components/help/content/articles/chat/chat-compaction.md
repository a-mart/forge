As a conversation grows, it uses more of the model's context window. **Summary** remains the default: older messages are summarized and recent context is retained. **Context v2** is experimental: the agent continues from task notes and retrieves earlier messages and tool results when it needs more detail.

## Context management

Choose the project default in **Project Settings → Context management**. Eligible local Builder managers can inherit that default or override it from **Context management** beside Send. Saving a mode does not clear the current conversation; it applies at the next context transition.

The session control shows the policy the current runtime can use. If a saved Context v2 preference is unsupported, it shows **Summary**, keeps your saved preference, and explains the restriction. Context v2 requires a supported ordinary Pi Builder manager and an eligible model. Collaboration, Cortex/system, Cursor SDK, plugin/external threads, and workers use Summary. **Settings → General → Compaction** controls the Summary compaction model, reasoning, and timeout; it does not select Summary or Context v2.

## Continuing with Context v2

During substantial work, the agent can keep task notes containing the objective, your corrections, completed work, important evidence, and next steps. These notes belong to this session's work. They survive a context transition and restart without automatically becoming profile memory or knowledge for other tasks.

Context v2 gives the agent room to continue the same work. Earlier messages and tool results remain available for recovery, so notes can point to evidence instead of repeating every detail. The agent can check its remaining context, update its notes, and request another window. A context transition does not itself grant new permission or restart completed work.

## Manual and automatic transitions

The context indicator in the header shows how full the live window is. Amber or red means room is running low. Forge can transition automatically during active work.

Open the **⋮ menu** in the chat header for:

- **Compact context** — on Summary, compacts older context; on Context v2, starts another window from the saved continuation state without an AI summarizing pass.
- **Smart compact** — on Summary, creates an AI handoff and resumes work when appropriate; on Context v2, follows the same transition as Compact context.

A manually compacted idle manager stays idle. On Context v2, manual compaction requires the manager to be idle; retry after active work settles. During compaction or recovery, the menu indicator spins and the session row shows a violet `C` badge. Continue the conversation normally once the transition finishes.

## Recovering earlier evidence

Local Builder managers and ordinary workers can use the agent-only `history` tool to browse earlier context windows, list messages and tool results without guessing a search term, search, and read matching evidence. They start with the current session and its associated workers, then widen to the project or another explicitly identified scope when needed. Wider recall does not require an extra approval prompt, but it must have a reason when it crosses the current project boundary.

History supports ranked word searches for discovery and literal searches for exact wording, paths, or errors. Results indicate whether coverage or a bounded scan is incomplete. An empty result from incomplete coverage does not establish that something never happened. The agent should read relevant evidence and verify current state before acting on it.

**Settings → History** controls background indexing and shows its progress. Pausing the index leaves conversation recording and direct same-session recovery available. Restricted runtime content and Secure Sessions secrets remain excluded. Remote Projects keep their own origin-scoped history. There is no separate human history drawer.

## Pinned messages

You can pin up to 10 messages per session to highlight material that should survive compaction. Summary includes pinned content in compaction instructions. Context v2 carries pins in its continuation checkpoint; when space is limited, it can retain a preview and a reference to recover the full message. Pinning does not promise that every character stays in the live context.
