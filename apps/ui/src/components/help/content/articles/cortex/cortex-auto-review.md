While Knowledge v2 is ON, Cortex consolidation can periodically clean up existing knowledge entries.

## How it works

When the daily consolidation schedule is enabled, each run:

1. **Reads entries** across global and profile scopes.
2. **Merges duplicates** while preserving support and provenance.
3. **Supersedes conflicts** using entry evidence.
4. **Archives decayed entries** and regenerates indexes under token caps.

The consolidator reads entries only. It does not mine transcripts or create entries.

## The Run tab

Open Cortex and select **Run** to:

- choose **Consolidate now** for a manual run,
- see **Last run**, and
- inspect the **Promotion review queue**.

The **Log** tab shows verified consolidation log activity.

## Capture checks

Capture checks are separate from consolidation. While v2 is ON, bounded cadence checks can run after compaction, a sufficient idle gap, or session archive. Feedback signals can trigger a restricted capture-check fork directly.

## Consolidation schedule

Use the Cortex schedule control in **Settings > General** to enable or disable the daily cadence. Scheduled and manual consolidation operate only while Knowledge v2 is ON.
