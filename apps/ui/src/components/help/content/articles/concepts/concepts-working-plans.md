Working plans give you a compact view of how a manager is approaching substantial multi-step work. They are intentionally a checklist, not a project-management system.

## Checklist plans

Managers use `update_plan` to publish the complete current checklist. Every step is **Pending**, **In progress**, or **Completed**; several steps can be in progress when workers operate in parallel. Small, obvious requests normally do not need a plan.

The first revision anchors one plan card in the conversation. Later revisions update that same card rather than adding timeline noise. The chat header and the compact control above the composer keep active work visible after that card scrolls away. When the plan completes, the existing card becomes a collapsed **Plan complete** card with a frozen final checklist. A later plan creates a new card at its new conversation position.

## Work graphs for coordinated work

For work with meaningful dependencies, decision gates, retries, fan-in, or bounded parallelism, the manager can use `update_work_graph`. A work graph is the executable, richer shape of the same plan—not a separate planning system.

Forge dispatches ready non-decision nodes up to the graph's concurrency limit. A successful worker attempt becomes **awaiting review**. The manager must verify the result and explicitly accept that node before Forge completes it and releases dependent nodes. Decision nodes wait for user or manager input and never dispatch automatically. Resetting a blocked node to pending creates a deliberate retry.

Use a graph only when coordination changes the outcome. Short checklists and one-worker tasks are clearer without one.

## Persistence and scope

Plans are scoped to one Builder session. The current snapshot is stored in `plan.json`; replaced revisions append to `plan-history.ndjson`; assignment and token-usage estimates append to `plan-usage.ndjson`. A graph is stored in that same current snapshot and still projects ordinary plan steps for display and compatibility.

Inline plan cards survive restart and compaction. Clearing the conversation clears its current plan and visible history. Stopping or archiving preserves the plan. Forks begin without the parent's live plan, plan history, or plan accounting. Plan progress is coordination state only: it never substitutes for implementation, verification, or the manager's final response.
