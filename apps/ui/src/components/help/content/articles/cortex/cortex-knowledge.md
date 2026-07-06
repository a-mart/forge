Cortex manages structured knowledge entries and generated indexes that manager sessions read for context. Entries can be global or profile-scoped.

## Common knowledge

Global entries store facts and preferences that apply everywhere. This includes things like workflow style, technical standards, communication preferences, and known gotchas saved through `save_learning` or capture checks.

All managers can read the generated global index. Cortex updates entries when managers save durable learning, then consolidation merges duplicates, supersedes conflicts, archives stale entries, and regenerates indexes.

## Per-profile memory

Each profile has its own entry set and generated index. This contains project-specific context, decisions, and working notes relevant to that profile's sessions.

## Viewing and editing

Open the Cortex dashboard and use **Index**, **Entries**, **Changelog**, and **Consolidation** to inspect the generated index, edit entries, review changes, and run consolidation.

You can edit entries directly:

1. Open the Entries tab.
2. Select an entry.
3. Make your changes.
4. Save, or cancel to discard.

Entry bodies are markdown. Cortex keeps provenance, support count, evidence tier, supersession history, and token estimates with each entry.

## When knowledge updates

Knowledge changes when managers call `save_learning`, capture-check forks verify missed durable facts, or you edit entries manually. Consolidation reads entries only; it does not mine transcripts.
