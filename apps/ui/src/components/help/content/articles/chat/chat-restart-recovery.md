Forge watches active manager turns for prolonged silence. The watchdog checks about once per minute, so its notices are approximate rather than exact timers.

## Amber stall notices

Amber **System** rows can appear after roughly 30 seconds, 5 minutes, and 10 minutes without manager progress. New progress resets that escalation. Manager tool execution, compaction, and runtime recovery can pause or suppress the clock; a hung tool can still reach the final notice at about 10 minutes, plus up to one polling interval.

These notices do not provide an inline runtime recycle action. If the manager remains stuck, use **⋮ → Stop All**, then send the request again to start a fresh turn/runtime. In some cases Forge may recycle a pending runtime after it becomes idle, so waiting can also allow recovery.

## Recovery after a backend restart

Forge does not automatically resume interrupted work after a backend restart. When restart recovery information is available, Builder shows a banner below the chat header with counts of interrupted sessions and workers.

- **Resume all** makes a best-effort attempt from the last persisted state. It prompts interrupted managers and workers and redelivers pending worker-report text where available.
- **Dismiss** hides the current recovery banner. It does not resume or cancel work.

Resume does not reconstruct output that was still being generated when the backend stopped, and it does not guarantee that every prior action was recorded. Before resuming work that could have external or repeated side effects—such as publishing, payments, deployments, or destructive commands—inspect the current state and tell the manager what has already completed. Recovery errors are not currently presented as a per-item breakdown in the banner.
