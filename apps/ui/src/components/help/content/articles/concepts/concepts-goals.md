Goals let you ask a Builder manager to keep pursuing one durable outcome across turns, restarts, compaction, and multiple working plans. They are deliberately small: one unfinished goal per session, a visible status bar, and no project-management hierarchy.

## Starting and pursuing a goal

A manager creates a goal only when you explicitly ask for sustained pursuit. Ordinary tasks do not become goals automatically. The goal holds the outcome; working plans remain optional, replaceable checklists for the current phase beneath it.

While an active goal is idle, Forge can start a private continuation turn so the manager keeps making meaningful progress. It waits when the session is stopped or archived, a choice or runtime recovery is pending, or workers are still running. A goal never grants new authority: actions that needed your approval before still need it during goal pursuit.

The manager can mark the goal complete only after the outcome is genuinely achieved and every current plan step is complete. It can mark the goal blocked only after the same blocker persists for at least three goal turns and no safe meaningful progress remains. Resuming a blocked goal starts a fresh three-turn blocking audit. Difficulty, uncertainty, and a reached token budget are not blockers.

## Goal bar and controls

An active, paused, or blocked goal stays visible directly below the chat header. The bar shows the objective, active elapsed time, status, and optional token budget. Expand it for the goal-turn and token totals. You can edit the objective or budget, pause or resume automatic pursuit, or cancel the goal. Completed and cancelled goals leave the active bar but remain in the on-disk history.

Only one unfinished goal can exist in a session. After it completes or is cancelled, the manager can create the next goal in the same session.

## Token budget and persistence

An optional token budget is added only when you explicitly request one. Forge estimates usage from recorded manager and worker token events during the goal window, including workers running in parallel. If a recorded usage entry lacks a timestamp, coverage is labeled partial instead of silently guessing. At the next safe idle boundary after the budget is reached, Forge pauses the goal; it does not mark the goal complete or blocked.

The current state is stored in `goal.json`, and completed or cancelled goal records append to `goal-history.ndjson` beside the session. Restart and compaction restore the current goal. Stopping or archiving preserves it without continuing work. Clearing the conversation cancels and archives an unfinished goal before clearing the current state. Forks start without the parent's current goal or goal history.
