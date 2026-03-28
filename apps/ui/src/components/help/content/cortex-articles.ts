import type { HelpArticle } from '../help-types'

export const cortexArticles: HelpArticle[] = [
  {
    id: 'cortex-overview',
    title: 'What is Cortex?',
    category: 'cortex',
    summary:
      'Cortex is Forge\'s self-improvement system. It reviews sessions, manages knowledge, and keeps your preferences current.',
    content: `Cortex is a background system that watches your sessions and learns from them. It reviews conversation transcripts, tracks feedback you give, and updates shared knowledge so future sessions start with better context.

## What Cortex does

Cortex handles three things:

- **Knowledge management.** It maintains a shared knowledge base that all your manager sessions can read. This includes common facts, workflow preferences, and technical standards that Cortex extracts from your sessions over time.
- **Session reviews.** Cortex periodically scans sessions for unreviewed content — new transcript data, memory changes, or feedback you've left. When it finds something, it can run a review to extract useful patterns and update knowledge.
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

The knowledge Cortex builds is available to all managers through the common knowledge file and per-profile memory. You can view and edit these files directly in the Knowledge tab.`,
    keywords: [
      'cortex',
      'self-improvement',
      'knowledge',
      'review',
      'dashboard',
      'learning',
      'notes',
      'sessions',
    ],
    relatedIds: ['cortex-knowledge', 'cortex-auto-review', 'cortex-onboarding'],
    contextKeys: ['cortex.dashboard'],
  },
  {
    id: 'cortex-knowledge',
    title: 'Knowledge management',
    category: 'cortex',
    summary:
      'Cortex maintains a shared knowledge base with common facts, preferences, and per-profile memory.',
    content: `Cortex manages knowledge files that your manager sessions read for context. There are two levels: common knowledge shared across all profiles, and per-profile memory scoped to individual managers.

## Common knowledge

The common knowledge file stores facts and preferences that apply everywhere. This includes things like your workflow style, technical standards, communication preferences, and known gotchas that Cortex has learned from reviewing your sessions.

All managers can read common knowledge. Cortex updates it when reviews surface patterns that are broadly useful — not tied to one specific project or profile.

## Per-profile memory

Each profile has its own memory file. This contains project-specific context, decisions, and working notes relevant to that profile's sessions. Profile memory is injected into sessions alongside common knowledge, so managers get both general and project-specific context.

## Viewing and editing

Open the Cortex dashboard and go to the **Knowledge** tab. Use the dropdown at the top to switch between Common Knowledge and individual profile memory files. The file size is shown next to each profile name.

You can edit any knowledge file directly:

1. Select the file from the dropdown.
2. Click the edit button (pencil icon) in the toolbar.
3. Make your changes in the editor.
4. Click save, or cancel to discard.

The content is markdown. Cortex uses structured sections with headers like "Workflow Preferences", "Technical Standards", and "Known Gotchas" to organize what it learns. You can restructure these however you want — Cortex will respect your edits in future reviews.

## When knowledge updates

Knowledge changes when Cortex completes a review run. It reads session transcripts and feedback, extracts durable facts, and merges them into the relevant knowledge file. You can also edit files manually at any time — your changes take effect immediately for new sessions.`,
    keywords: [
      'knowledge',
      'common knowledge',
      'profile memory',
      'memory',
      'edit',
      'preferences',
      'facts',
      'cortex',
    ],
    relatedIds: ['cortex-overview', 'cortex-auto-review'],
    contextKeys: ['cortex.dashboard', 'cortex.knowledge'],
  },
  {
    id: 'cortex-auto-review',
    title: 'Auto-review',
    category: 'cortex',
    summary:
      'Cortex can automatically review sessions on a schedule, checking transcripts, memory, and feedback for changes.',
    content: `Auto-review lets Cortex scan your sessions periodically and run reviews when it finds new content. This keeps knowledge up to date without manual intervention.

## How it works

When auto-review is enabled, Cortex runs on a schedule (configurable in Settings > General). Each cycle, it:

1. **Scans all sessions** across profiles, comparing current transcript size, memory, and feedback against what was last reviewed.
2. **Identifies drift.** Sessions with new transcript data, changed memory, or new feedback are flagged as needing review.
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

Go to **Settings > General** and find the Cortex auto-review section. Toggle it on and set the interval. The schedule runs in the background while Forge is running.`,
    keywords: [
      'auto-review',
      'review',
      'schedule',
      'scan',
      'drift',
      'transcript',
      'memory',
      'feedback',
      'cortex',
      'coverage',
    ],
    relatedIds: ['cortex-overview', 'cortex-knowledge'],
    contextKeys: ['cortex.review'],
  },
  {
    id: 'cortex-onboarding',
    title: 'First-run onboarding',
    category: 'cortex',
    summary:
      'On first launch, Forge captures your name, technical level, and communication preferences so managers respond naturally.',
    content: `When you launch Forge for the first time, Cortex runs an onboarding step before any manager session is created. This captures a few basics so your managers can communicate in a way that fits you.

## What it asks

The onboarding form collects three things:

- **Your name** — Used in conversation so managers address you naturally.
- **Technical level** — Developer, technical non-developer, semi-technical, or non-technical. This adjusts how much managers explain and what assumptions they make.
- **Additional preferences** — Free text for anything else: whether you prefer concise or detailed responses, how much explanation you want, communication style, or any other instruction.

## Where preferences go

Your onboarding preferences are saved to the common knowledge file under a managed section. Every manager session across all profiles reads these on startup. This means a new manager already knows your name and how to adjust its communication — no repeat introductions.

The preferences are stored as structured facts in the knowledge base, not as raw form data. Cortex renders them into the common knowledge markdown alongside other cross-profile facts.

## Updating preferences later

You can change your onboarding preferences at any time from **Settings > General** under "Welcome preferences." Changes are saved to common knowledge immediately and apply to new sessions going forward. Existing sessions keep whatever context they started with.

## Skipping onboarding

If you skip onboarding on first launch, Forge moves straight to manager creation. You can fill in preferences later from Settings. Managers will still work — they just won't have your name or communication style until you add them.`,
    keywords: [
      'onboarding',
      'first launch',
      'welcome',
      'preferences',
      'name',
      'technical level',
      'setup',
      'cortex',
    ],
    relatedIds: ['cortex-overview', 'cortex-knowledge'],
    contextKeys: ['cortex.dashboard'],
  },
]
