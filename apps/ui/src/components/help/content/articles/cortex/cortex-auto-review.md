Cortex consolidation periodically cleans up knowledge entries without manual intervention.

## How it works

When consolidation is enabled, Cortex runs on a daily schedule from Settings > General. Each cycle, it:

1. **Reads entries** across global and profile scopes.
2. **Merges duplicates** while preserving support and provenance.
3. **Supersedes conflicts** so the newest, best-supported entry wins.
4. **Archives decayed entries** and regenerates indexes under token caps.

## The Consolidation tab

Open the Cortex dashboard and go to the **Consolidation** tab to see the current state:

- **Last run** — Shows the latest completed or failed consolidation run.
- **Next trigger** — Shows the threshold and daily cadence used by the scheduler.
- **Promotion queue** — Lists cross-project promotion candidates that still require user approval.
- **Consolidate now** — Runs consolidation manually.

## Capture checks

Capture checks are separate from consolidation. They run at bounded checkpoints, use restricted tools, and only save durable learning that was missed by the main manager turn.

## Enabling auto-review

Go to **Settings > General** and find the Cortex consolidation section. Toggle it on to keep the daily schedule active while Forge is running.
