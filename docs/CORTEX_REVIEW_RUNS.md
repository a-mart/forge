# Cortex Review Runs

Cortex Review is the backlog/knowledge-review surface for session drift. It scans transcript, memory, and feedback deltas, then lets you launch focused reviews from the dashboard.

## Automatic scheduled reviews

Cortex runs automatic periodic reviews by default. Every 2 hours (configurable), the scheduler checks all sessions for changes and runs reviews only when something needs attention.

**Key behaviors:**

- **Enabled by default** — no setup required. Fresh installs start with automatic reviews on a 2-hour interval.
- **Zero cost when nothing changed** — a deterministic pre-check (`scanCortexReviewStatus()`) runs before creating any LLM session. If all sessions are up to date, no tokens are spent.
- **Deduplication** — if a review is already queued or running, duplicate scheduled runs are coalesced instead of piling up.
- **Configurable in Settings** — toggle on/off and adjust the interval (15m, 30m, 1h, 2h, 4h, 8h, 12h, 24h) under **Settings → General**.
- **Persisted config** — settings live at `shared/config/cortex-auto-review.json` in your data directory. The schedule entry is managed in the Cortex profile's `schedules.json` with ID `cortex-auto-review`.

Automatic reviews use the same queueing and session-creation behavior as manual reviews. They appear in **Recent Runs** with a `scheduled` trigger label.

## Current behavior

- **Fresh backing session per run** — every review request starts in a dedicated hidden Cortex session (`sessionPurpose: cortex_review`) instead of reusing the main interactive Cortex chat.
- **Hidden by default in the sidebar** — review-run sessions stay out of the normal Cortex session list unless one is currently selected or you are searching. This keeps the left sidebar focused on primary sessions.
- **Clickable hidden-run hint** — when review sessions are hidden, the Cortex row shows a hint that opens the **Cortex Review** tab directly.
- **Running indicator in the sidebar** — the Cortex row shows a running pill when any hidden review run is actively working.
- **FIFO queueing** — if a review is already active, new review requests are queued in request order instead of being permanently blocked. Queued runs start automatically when the active run finishes.
- **Shared run history** — manual and scheduled review requests both appear in **Recent Runs**, including queued/running/completed state, queue position, and an **Open** action for the backing session.

## Operator notes

- Use **Review All** to enqueue a full sweep of sessions that currently need attention.
- Never-reviewed sessions now expose **Exclude** so you can skip them from automatic review without deleting anything.
- Excluded never-reviewed sessions stay visible with **Resume review** and are removed from actionable review counts/coverage until resumed.
- Already-reviewed sessions that are currently up to date expose **Reprocess**, which reuses the normal review-run API to force a fresh review pass.
- Use the per-session send button to enqueue a targeted transcript/memory/feedback review.
- If you need the detailed backing conversation, open it from **Recent Runs** rather than from the default sidebar list.
