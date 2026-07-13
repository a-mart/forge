Working plans give you a compact view of how a manager is approaching substantial multi-step work. They are intentionally a checklist, not a project-management system.

## How plans work

Managers can use `update_plan` to publish the complete current plan. Every step is **Pending**, **In progress**, or **Completed**. Multiple steps can be in progress when workers are operating in parallel. A short explanation may accompany a revision when the approach changes.

The plan card is anchored in the conversation at the point where the manager creates it. It updates in that same position as work progresses and remains there when every step is complete. The chat header shows completed progress, and a compact control above the message box keeps active steps available even after the inline card scrolls out of view. Either control opens the full plan in a popover.

When a manager finishes a plan, its existing inline card becomes a collapsed **Plan complete** card in place. Expanding it shows the frozen final checklist. Starting another plan creates a new card at the new conversation position; it does not insert the preceding plan late. Normal progress revisions update the current card without adding timeline clutter.

## When plans appear

Managers use plans for substantial, multi-stage, or uncertain work. Small and obvious requests usually do not need one. Updating the checklist never substitutes for implementation, verification, or a final response.

Plans are scoped to one Builder session and saved in that session's `plan.json`. Before Forge replaces or clears a plan revision, it appends the outgoing snapshot to the session's `plan-history.ndjson` file for future offline review. When worker assignments map cleanly to a step, Forge can retain the association and append token-usage estimates to `plan-usage.ndjson`; uncertain and unassociated usage remains explicitly labeled rather than silently assigned. Whole-plan usage closes at the manager's settled turn boundary. If Forge must recover a pending completion later, it stops accounting at the recorded completion time and labels the receipt partial instead of absorbing a later turn. This accounting has no separate interface. Inline plan cards are saved in the conversation timeline and survive restarts. Clearing the conversation clears the current plan and visible conversation history; stopping or archiving preserves both; a fork starts without copying the parent's live plan or revision-history file.

Forge also supplies the latest plan revision to the manager as private runtime context and asks compaction to preserve it. This lets a restarted or compacted manager continue from the visible plan without adding a separate read tool or exposing internal recovery metadata in chat.
