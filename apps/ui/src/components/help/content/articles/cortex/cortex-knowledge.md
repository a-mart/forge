Cortex Knowledge v2 manages provenance-bearing entries and generated indexes. It is a default-off preview with global and profile-scoped knowledge.

## Global knowledge

Global entries store durable facts and preferences that apply everywhere, such as workflow style, technical standards, communication preferences, and known gotchas saved through `save_learning` or capture checks.

When v2 is ON, managers receive the token-capped global `INDEX.md` and can use the `knowledge` tool to search or read full entries on demand.

## Profile-scoped knowledge

Each profile has its own entry set and generated `INDEX.md` for project-specific conventions, decisions, and gotchas. This is separate from the profile's canonical `memory.md`.

With v2 ON, the prompt sources are the global index, active-profile index, and current session `memory.md`. Canonical profile `memory.md` and legacy shared `common.md` continue to be maintained, but are not prompt-injected. Normal switching preserves both stores, and v2 OFF restores legacy injection while the originals remain. Explicit confirmed legacy cleanup archives and removes those originals, so OFF alone cannot restore their prior content.

## Viewing knowledge

Open the Cortex dashboard and use **Index**, **Entries**, **Log**, and **Run**. **Entries** shows entry bodies and provenance details, but the current dashboard is read-only. **Log** shows verified consolidation activity. **Run** provides **Consolidate now**, **Last run**, and the **Promotion review queue**.

Entry bodies are Markdown on disk. Cortex records provenance, support count, evidence tier, supersession history, and token estimates with each entry.

## When knowledge updates

Knowledge changes when managers call `save_learning` or capture-check forks verify missed durable facts. While Knowledge v2 is ON, consolidation reads entries only; it does not mine transcripts or create new entries. It merges duplicates, supersedes conflicts, archives stale entries, and regenerates indexes.

## Guarded activation

The UI does not run migration. A successful guarded migration commits a valid manifest and immediately activates v2. If activation persistence fails, the manifest remains an authorized recovery point with v2 OFF; it also permits ordinary re-enable after a later disable. Without a valid manifest, Settings shows migration-required guidance and onboarding does not issue activation.
