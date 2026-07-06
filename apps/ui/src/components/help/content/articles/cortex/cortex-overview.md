Cortex is a background system for durable session learning. Managers save structured knowledge entries, capture-check forks catch missed durable facts at checkpoints, and consolidation keeps the entry set clean so future sessions start with better context. It is shown as a pinned Builder sidebar entry.

## What Cortex does

Cortex handles three things:

- **Knowledge management.** It maintains structured global and profile-scoped entries that all manager sessions can read through generated indexes.
- **Capture checks.** At bounded checkpoints, Cortex can fork a session with restricted tools to verify durable facts were saved. Feedback signals bypass the judge and trigger the check directly.
- **Consolidation.** Cortex reads entries, merges duplicates, supersedes conflicts, archives stale entries, and regenerates indexes under token caps.
- **Onboarding.** On first launch, Cortex captures basic preferences (your name, technical level, and communication style) so managers can respond naturally from the start.

## The Cortex dashboard

Open the Cortex dashboard from the chat header to see its current state. The dashboard has four tabs:

- **Index** — View generated global/profile indexes and token-cost meters.
- **Entries** — Browse and edit structured entries with provenance.
- **Changelog** — Review added, merged, archived, superseded, and reindexed actions.
- **Consolidation** — See the latest run, next trigger, and manual consolidation action.

The dashboard panel is resizable — drag the left edge to adjust its width.

## How it fits together

Cortex runs alongside your regular sessions. It doesn't interrupt your work. When Cortex consolidation is enabled in Settings > General, Cortex periodically consolidates entries. You can also trigger consolidation manually from the Consolidation tab.

The knowledge Cortex builds is available to managers through generated indexes. You can view indexes and edit entries directly in the dashboard.

## Disabling Cortex

Set the `FORGE_CORTEX_ENABLED` environment variable to `false` to disable the entire Cortex subsystem. When disabled, no Cortex profile is created, capture/consolidation do not run, and Cortex sections are hidden from Settings. Existing Cortex data is preserved on disk and restored if you re-enable it.
