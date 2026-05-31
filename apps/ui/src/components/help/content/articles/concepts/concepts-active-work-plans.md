Active Work Plans are manager-owned coordination state for a single chat session. They are useful when work has several phases, multiple workers, review gates, blockers, or handoff risk across pauses, stops, compaction, restart, or model changes.

## What they show

When a plan exists, Forge shows an Active Work card in chat with the current plan, item status, and linked worker evidence. The chat header also shows an Active Work indicator that can collapse or expand the card. Collapsing changes only the view; the plan remains saved with that session.

## What they are not

A Work Plan is descriptive progress state, not a workflow runner. The manager still leads the work through normal chat, worker delegation, choices, validation, and final synthesis. Quick answers and routine one-step tasks usually do not need a plan.

## Persistence

Active Work state is stored with the session, so it follows that session rather than the whole project. Other sessions in the same profile have their own plans or no plan at all.

## History and receipts

When a manager creates a plan, Forge records a durable `work_plan_created` receipt in the session timeline. Those receipts stay in canonical session history and are protected from normal in-memory/cache trimming, but very old entries can still be omitted from byte-budgeted bootstrap payloads. The Active Work card can also expand a bounded list of recent previous Work Plans for terminal plans that remain in the live snapshot.

Receipts are view-only: you can review past plan snapshots in chat history, but you cannot edit or reopen them as active plans.
