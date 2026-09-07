Forge separates task notes, session memory, profile memory, and Cortex knowledge. Which files enter a prompt depends on the Knowledge v2 mode.

## Profile memory

Each profile has a canonical `memory.md` for durable project facts, conventions, and decisions shared through the memory-merge lifecycle. Forge continues maintaining this file in both knowledge modes.

Do not confuse profile memory with **profile-scoped Knowledge v2**. The latter is a set of provenance-bearing entries with its own generated `INDEX.md`.

## Session memory

Each chat session has its own `memory.md` for durable facts and decisions you ask the agent to remember. It remains prompt-injected in both knowledge modes. Approved durable session insights can enter the profile memory-merge lifecycle.

## Task notes

The agent can keep task notes automatically while doing authorized work: the objective, your corrections, progress, open questions, evidence references, and next steps. These notes are separate from `memory.md`. They survive context transitions and restart without automatically becoming profile memory or Cortex knowledge. Fresh windows uses these notes to continue the same task and retrieves earlier evidence when more detail is needed.

Each agent owns its notes. A fork from the current state receives an independent snapshot; a fork at an earlier message starts fresh notes so later discoveries do not leak into that branch. Clearing or deleting a session removes its task notes. Notes preserve working state, but do not create new permission or prove the current state of files and services.

## Legacy common knowledge

`shared/knowledge/common.md` stores legacy cross-profile preferences, including the managed onboarding-preferences block. With v2 OFF, preference changes render and update that block. With v2 ON, those changes upsert global v2 preference entries instead; the legacy file is preserved during normal switching but is not maintained by those updates.

## Prompt sources by mode

Knowledge v2 is an opt-in, default-off preview:

- **Knowledge v2 ON:** prompts receive the generated global and active-profile `INDEX.md` files plus session `memory.md`. Canonical profile `memory.md` and legacy `common.md` are not prompt-injected.
- **Knowledge v2 OFF:** prompts receive legacy `common.md`, canonical profile `memory.md`, and session `memory.md`.

Normal switching preserves both stores. Turning v2 off restores the legacy sources while their original files remain; explicit confirmed legacy cleanup archives and removes those originals, so OFF alone cannot restore their prior content. The ordinary Settings toggle does not migrate data.

These files are plain Markdown on disk and remain available for inspection. Managers can use the `knowledge` tool to search and read full v2 entries behind the compact indexes.

## History recall

Transcript history preserves messages and tool results. Local Builder managers and ordinary workers can browse context windows, list earlier items, search, and read evidence with the agent-only `history` tool. The agent starts with the current session and associated workers, then widens to a project or explicitly selected session when needed. Searches outside the current project need a reason, without a separate approval prompt.

Ranked word searches help discover related work. Literal search finds exact wording, paths, or errors. Results report incomplete coverage or bounded scans, so an empty partial result does not prove that evidence is absent. The agent should read relevant results and verify current state before acting.

**Settings → History** pauses or resumes indexing. Conversation recording and direct window/item browsing, literal scans, and canonical reads remain available while the index is paused. Canonical JSONL is the source of truth; the local index is a rebuildable cache. Restricted runtime content and Secure Sessions secrets remain excluded. Remote Projects keep their own origin-scoped history. There is no separate human history drawer.
