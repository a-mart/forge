Working plans give you a compact view of how a manager is approaching substantial multi-step work. They are intentionally a checklist, not a project-management system.

## How plans work

Managers can use `update_plan` to publish the complete current plan. Every step is **Pending**, **In progress**, or **Completed**. Multiple steps can be in progress when workers are operating in parallel. A short explanation may accompany a revision when the approach changes.

The plan card appears at the top of chat and highlights the current work. The chat header shows completed progress, and a compact control above the message box keeps active steps available even after the card scrolls out of view. Either control opens the full plan in a popover. Plans remain visible when every step is complete so the final state is easy to verify.

When a manager finishes a plan and then starts a different one, Forge leaves one collapsed **Completed plan** card in the conversation. Expanding it shows the frozen final checklist. Normal progress revisions update the current card without adding timeline clutter.

## When plans appear

Managers use plans for substantial, multi-stage, or uncertain work. Small and obvious requests usually do not need one. Updating the checklist never substitutes for implementation, verification, or a final response.

Plans are scoped to one Builder session and saved in that session's `plan.json`. Before Forge replaces or clears a plan revision, it appends the outgoing snapshot to the session's `plan-history.ndjson` file for future offline review. When worker assignments map cleanly to a step, Forge can retain the association and append token-usage estimates to `plan-usage.ndjson`; uncertain and unassociated usage remains explicitly labeled rather than silently assigned. This accounting has no separate interface. Completed-plan cards are saved in the conversation timeline and survive restarts. Clearing the conversation clears the current plan and visible conversation history; stopping or archiving preserves both; a fork starts without copying the parent's live plan or revision-history file.

Forge also supplies the latest plan revision to the manager as private runtime context and asks compaction to preserve it. This lets a restarted or compacted manager continue from the visible plan without adding a separate read tool or exposing internal recovery metadata in chat.
