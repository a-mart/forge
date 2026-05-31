Auto-review lets Cortex scan your sessions periodically and run reviews when it finds new content. This keeps knowledge up to date without manual intervention.

## How it works

When auto-review is enabled, Cortex runs on a schedule (configurable in Settings > General). Each cycle, it:

1. **Scans all sessions** across profiles, using raw JSONL/session growth as a pre-scan signal and comparing reviewable transcript drift, memory, and feedback against what was last reviewed.
2. **Identifies drift.** Sessions with reviewable transcript drift, changed memory, or new feedback are flagged as needing review. Allowlisted internal/custom/system entries are excluded from transcript drift, while unknown or malformed drift is surfaced.
3. **Skips unchanged sessions.** If nothing has changed since the last review, Cortex does nothing. This prevents unnecessary work.
4. **Runs review sessions** for anything that needs attention. Each review is a real Cortex session that reads the changed content and updates knowledge files.

## The Review tab

Open the Cortex dashboard and go to the **Review** tab to see the current state:

- **Summary bar** — Shows how many sessions need review, how many are up to date, excluded count, and total pending bytes.
- **Drift badges** — Transcript drift, memory drift, and feedback drift counts tell you what kind of changes are pending.
- **Coverage bar** — Shows overall transcript review coverage as a percentage.
- **Recent runs** — Lists active and completed review runs with status (queued, running, completed, interrupted), trigger type (scheduled or manual), and worker count.
- **Session list** — Grouped by profile, each session shows its review status and what changed.

## Manual reviews

You don't have to wait for the schedule. From the Review tab:

- Click the send icon next to any session to review it immediately.
- Click **Review All** to queue reviews for every session that needs one.
- Use **Exclude** to skip a session, or **Resume review** to bring it back.
- Use **Reprocess** on up-to-date sessions if you want Cortex to re-read them.

## Enabling auto-review

Go to **Settings > General** and find the Cortex auto-review section. Toggle it on and set the interval. The schedule runs in the background while Forge is running.
