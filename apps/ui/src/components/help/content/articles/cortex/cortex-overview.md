Cortex is a background system that watches your sessions and learns from them. It reviews conversation transcripts, tracks feedback you give, and updates shared knowledge so future sessions start with better context. It is shown as a pinned Builder sidebar entry.

## What Cortex does

Cortex handles three things:

- **Knowledge management.** It maintains a shared knowledge base that all your manager sessions can read. This includes common facts, workflow preferences, and technical standards that Cortex extracts from your sessions over time.
- **Session reviews.** Cortex periodically scans sessions for unreviewed content. Raw JSONL/session growth is used as a pre-scan signal, then Cortex reviews reviewable transcript drift, memory changes, or feedback you've left. Allowlisted internal/custom/system entries are ignored when measuring reviewable transcript drift, while unknown or malformed drift is surfaced. When it finds something, it can run a review to extract useful patterns and update knowledge.
- **Onboarding.** On first launch, Cortex captures basic preferences (your name, technical level, and communication style) so managers can respond naturally from the start.

## The Cortex dashboard

Open the Cortex dashboard from the chat header to see its current state. The dashboard has four tabs:

- **Knowledge** — View and edit the shared knowledge base and per-profile memory files.
- **Notes** — Working notes and tentative observations Cortex has collected but hasn't committed to knowledge yet.
- **Review** — The review status panel showing which sessions need attention, active review runs, and transcript coverage.
- **Cron** — Scheduled tasks tied to the current profile.

The dashboard panel is resizable — drag the left edge to adjust its width.

## How it fits together

Cortex runs alongside your regular sessions. It doesn't interrupt your work. When auto-review is enabled in Settings > General, Cortex checks for changes on a schedule and runs reviews automatically. You can also trigger reviews manually from the Review tab.

The knowledge Cortex builds is available to all managers through the common knowledge file and per-profile memory. You can view and edit these files directly in the Knowledge tab.

## Disabling Cortex

Set the `FORGE_CORTEX_ENABLED` environment variable to `false` to disable the entire Cortex subsystem. When disabled, no Cortex profile is created, auto-reviews don't run, and Cortex sections are hidden from Settings. Existing Cortex data is preserved on disk and restored if you re-enable it.
