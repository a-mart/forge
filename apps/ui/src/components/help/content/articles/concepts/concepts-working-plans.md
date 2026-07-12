Working plans give you a compact view of how a manager is approaching substantial multi-step work. They are intentionally a checklist, not a project-management system.

## How plans work

Managers can use `update_plan` to publish the complete current plan. Every step is **Pending**, **In progress**, or **Completed**, and at most one step can be in progress. A short explanation may accompany a revision when the approach changes.

The plan card appears at the top of chat and highlights the current step. The chat header also shows completed progress and opens the full plan in a popover. Plans remain visible when every step is complete so the final state is easy to verify.

## When plans appear

Managers use plans for substantial, multi-stage, or uncertain work. Small and obvious requests usually do not need one. Updating the checklist never substitutes for implementation, verification, or a final response.

Plans are scoped to one Builder session and saved in that session's `plan.json`. Clearing the conversation clears the plan; stopping or archiving preserves it; a fork starts without copying the parent's plan.

Forge also supplies the latest plan revision to the manager as private runtime context and asks compaction to preserve it. This lets a restarted or compacted manager continue from the visible plan without adding a separate read tool or exposing internal recovery metadata in chat.
