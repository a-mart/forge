Forge watches active manager turns for prolonged silence. The watchdog checks about once per minute, so its notices are approximate rather than exact timers.

## Amber stall notices

Amber **System** rows can appear after roughly 30 seconds, 5 minutes, and 10 minutes without manager progress. New progress resets that escalation. Manager tool execution, compaction, and runtime recovery can pause or suppress the clock; a hung tool can still reach the final notice at about 10 minutes, plus up to one polling interval.

These notices do not provide an inline runtime recycle action. If the manager remains stuck, use **⋮ → Stop All**, then send the request again to start a fresh turn/runtime. In some cases Forge may recycle a pending runtime after it becomes idle, so waiting can also allow recovery.

## Runaway manager responses

If a manager response becomes repetitive or overlong, Forge stops it and withholds that output as a clean final. **System** rows explain the recovery. Forge retries that obligation once, or continues already queued work, then does not keep retrying. Active workers keep running. After an exhausted stop with nothing queued, send a new message to continue.

If automatic interruption cannot finish cleanly, wait for the stream to settle. Use **Stop All** only if you intend to stop the manager and any active workers. For a genuinely stalled manager, **Stop All** remains the right recovery and still terminates both.

## Recovery after a backend restart

Forge does not automatically resume interrupted work after a backend restart. When recovery information is available, Builder shows a banner below the chat header with interrupted session and worker counts.

- **Resume all** makes a best-effort, one-time attempt from the last persisted recovery record. It prompts interrupted managers and workers and redelivers pending worker-report text where available.
- **Dismiss** records that you chose not to resume this recovery snapshot and hides the banner. It does not send a continuation prompt. Interrupted work-graph nodes are left blocked so the manager can review and retry them deliberately.

Resume cannot reconstruct output that was still being generated when the backend stopped, and recovery is not a transaction log. Before resuming work that could repeat external effects—publishing, payments, deployments, or destructive commands—inspect the external state and tell the manager what already completed. The banner intentionally does not present a per-item error breakdown.
