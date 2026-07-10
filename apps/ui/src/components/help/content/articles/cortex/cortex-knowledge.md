Cortex Knowledge v2 manages provenance-bearing entries and generated indexes. It is a default-off preview with global and profile-scoped knowledge.

## Global knowledge

Global entries store durable facts and preferences that apply everywhere, such as workflow style, technical standards, communication preferences, and known gotchas saved through `save_learning` or capture checks.

When v2 is ON, managers receive the token-capped global `INDEX.md` and can use the `knowledge` tool to search or read full entries on demand.

## Profile-scoped knowledge

Each profile has its own entry set and generated `INDEX.md` for project-specific conventions, decisions, and gotchas. This is separate from the profile's canonical `memory.md`.

With v2 ON, the prompt sources are the global index, active-profile index, and current session `memory.md`. Canonical profile `memory.md` and legacy shared `common.md` continue to be maintained and preserved, but are not prompt-injected. Turning v2 OFF restores legacy common + profile + session injection without deleting v2 files.

## Viewing and editing

Open the Cortex dashboard and use **Index**, **Entries**, **Changelog**, and **Consolidation** to inspect generated indexes, edit entries, review changes, and run consolidation.

To edit an entry:

1. Open **Entries**.
2. Select an entry.
3. Make your changes.
4. Save, or cancel to discard.

Entry bodies are Markdown. Cortex keeps provenance, support count, evidence tier, supersession history, and token estimates with each entry.

## When knowledge updates

Knowledge changes when managers call `save_learning`, capture-check forks verify missed durable facts, or you edit entries manually. Consolidation reads entries only; it does not mine transcripts or create new entries. It merges duplicates, supersedes conflicts, archives stale entries, and regenerates indexes.

## Guarded activation

The normal toggle is available only after Forge verifies a strictly valid completed migration manifest and no active migration lock. Before that, Settings shows migration-required guidance and onboarding does not issue an activation request. The UI does not run migration. Migrated users can enable v2, and enabled users can disable it.
