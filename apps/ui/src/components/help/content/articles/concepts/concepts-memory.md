Forge maintains session memory, profile memory, and Cortex knowledge as distinct layers. Which files enter a prompt depends on the Knowledge v2 mode.

## Profile memory

Each profile has a canonical `memory.md` for durable project facts, conventions, and decisions shared through the memory-merge lifecycle. Forge continues maintaining this file in both knowledge modes.

Do not confuse profile memory with **profile-scoped Knowledge v2**. The latter is a set of provenance-bearing entries with its own generated `INDEX.md`.

## Session memory

Each chat session has its own `memory.md` for working state: what the agent tried, what worked, and open questions. It is private to that session and remains prompt-injected in both modes.

This separation keeps a session's exploratory or temporary state from automatically becoming shared profile context. Durable session insights can still be merged into canonical profile memory.

## Legacy common knowledge

`shared/knowledge/common.md` stores legacy cross-profile preferences, including the managed onboarding-preferences block. With v2 OFF, preference changes render and update that block. With v2 ON, those changes upsert global v2 preference entries instead; the legacy file is preserved during normal switching but is not maintained by those updates.

## Prompt sources by mode

Knowledge v2 is an opt-in, default-off preview:

- **Knowledge v2 ON:** prompts receive the generated global and active-profile `INDEX.md` files plus session `memory.md`. Canonical profile `memory.md` and legacy `common.md` are not prompt-injected.
- **Knowledge v2 OFF:** prompts receive legacy `common.md`, canonical profile `memory.md`, and session `memory.md`.

Normal switching preserves both stores. Turning v2 off restores the legacy sources while their original files remain; explicit confirmed legacy cleanup archives and removes those originals, so OFF alone cannot restore their prior content. The ordinary Settings toggle does not migrate data.

These files are plain Markdown on disk and remain available for inspection. Managers can use the `knowledge` tool to search and read full v2 entries behind the compact indexes.
