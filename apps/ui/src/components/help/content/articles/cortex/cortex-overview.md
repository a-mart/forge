Cortex is Forge's durable learning system. Its Knowledge v2 architecture stores structured entries, runs bounded capture checks for missed durable facts, and consolidates the entry set so future sessions start with compact context. Cortex appears as a pinned Builder sidebar entry.

Knowledge v2 is an opt-in, default-off preview. It is separate from the whole-subsystem `FORGE_CORTEX_ENABLED` control.

## What Cortex does

- **Knowledge management.** Maintains provenance-bearing global and profile-scoped entries that managers search and read through the `knowledge` tool.
- **Capture checks.** At bounded checkpoints, can fork a session with restricted tools to verify durable facts were saved. Feedback signals bypass the judge and trigger the check directly.
- **Consolidation.** Reads entries to merge duplicates, supersede conflicts, archive stale entries, and regenerate token-capped indexes. It does not mine transcripts or create entries.
- **Onboarding.** Captures basic preferences such as your name, technical level, and communication style.

## The Cortex dashboard

Open Cortex from its pinned Builder sidebar entry. The resizable dashboard has four tabs:

- **Index** — View generated global/profile indexes and token-cost meters.
- **Entries** — Browse and edit structured entries with provenance.
- **Changelog** — Review added, merged, archived, superseded, and reindexed actions.
- **Consolidation** — See the latest run, next trigger, and manual consolidation action.

## Prompt modes

With Knowledge v2 ON, prompts receive global and active-profile `INDEX.md` files plus current session `memory.md`. Full entries are retrieved on demand. Canonical profile `memory.md` and legacy `shared/knowledge/common.md` stay maintained and preserved but are not prompt-injected.

With Knowledge v2 OFF, Forge restores legacy `common.md` + profile `memory.md` + session `memory.md` injection. Switching OFF does not delete v2 entries or indexes.

Settings and first-launch v2 onboarding do not migrate data. They offer activation only after the backend verifies a completed guarded migration; otherwise Settings shows migration-required guidance and onboarding does not send an unsafe enable request.

## Consolidation schedule

When Cortex consolidation is enabled in **Settings > General**, Forge runs the entry-only consolidator on its configured cadence. You can also trigger consolidation manually from the **Consolidation** tab.

## Disabling Cortex

Use the Knowledge v2 switch to move between v2 and legacy prompt modes. To disable the entire Cortex subsystem instead, set `FORGE_CORTEX_ENABLED=false`. Whole-subsystem disable hides Cortex surfaces and stops capture/consolidation; it is not the Knowledge v2 mode switch. Existing data remains on disk.
