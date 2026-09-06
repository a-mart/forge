Forge uses two kinds of agents: **managers** and **workers**. A manager is the agent you talk to in chat and remains the accountable owner of the outcome. Workers are agents the manager can create for specific tasks. Claude models run through the native Anthropic provider and Forge's Pi runtime.

When you send a message, the manager reads it and decides what needs to happen. Selected Work Mode determines ownership and handoff:

- **Delegate first** (default) — workers own substantive execution; the manager answers, orients with bounded read-only checks, and accepts results.
- **Adaptive** — starts directly and hands off only when the total path, including briefing, waiting, acceptance, and likely rework, improves.
- **Hands-on** — keeps investigation, implementation, and validation, including the critical path; explicit delegation remains available.

When the manager delegates, each worker gets a focused job — edit a file, run a command, research a topic. Delegation returns immediately, so the manager can continue receiving your messages while workers run. Each worker's final assistant response is returned automatically to the manager when its run ends; the worker does not need to find the manager or call a messaging tool. Stalled-worker detection remains separate from result delivery. A bare runtime `errorMessage: "terminated"` waits out a short grace period before failure projection; fresh worker progress cancels that transient error.

## What you see

Workers appear as pills below the chat header while they are active. Click a pill to open that worker's transcript, which defaults to **All**. When a worker finishes, its final result is returned to the manager; in the manager thread, that raw result stays out of the focused Web view and is available in **All**. Agents can also produce Mermaid diagrams that render inline in chat instead of staying as raw code fences.

## Why this matters

The manager can keep the work itself or split it across workers. When work is delegated, a single message might trigger a backend fix, a UI update, and a test run — all happening in parallel instead of one after another.

The manager controls the flow. When it delegates, it decides which model each worker uses, what instructions to give, and whether to retry if something fails. You do not need to manage workers directly, but you can watch their progress and see their output in the chat. User-facing manager updates are intentionally concise and focused on decisions, results, and blockers.

## How routing works

The manager picks a model for each worker based on the task. Quick jobs like file reads get a cheaper, faster model. Complex work like architecture review gets a more capable one. If you have specialists configured, the manager routes work to the right specialist automatically based on what the task needs.

Workers can use tools — reading files, running shell commands, making edits — and their final response returns automatically to the manager, which decides the next step. If a worker turn fails, that failure can surface as a system message with the error context preserved instead of looking like a normal completion. The normal chat transcript stays manager-session focused: Web prioritizes the visible conversation transcript and pending choices you can answer, while All adds manager-owned activity and final worker results without expanding into worker-internal tool history.

Raw worker results remain inspectable in **All**. The manager treats them as evidence rather than inherited conclusions, performs focused acceptance, and publishes an accepted result or material blocker.

Use **Session Audit Log** when you need the full persisted diagnostic view. It reads canonical manager and worker JSONL sources, lets you switch from the manager session log to a worker transcript, and keeps the list paginated with compact clickable summaries. On desktop, the audit inspector uses a split list/detail layout with a draggable, resizable divider. Select any row to automatically fetch the full canonical JSONL row (up to an 8 MB detail cap) into a detail pane with formatted/raw toggles, wrapping, and copy. Small rows use syntax highlighting; very large JSON uses a plain scrollable viewer so the UI stays responsive. Mirrored worker tool rows stay hidden by default on the manager session source; they remain available through an explicit `worker_tool_call` filter or by selecting a worker source. Audit rows are not added to normal chat or model context.

Builder web can also route a plain leading @Codex or [@Codex] text message to a direct Codex app-server sidecar, or route selector-based mentions to the manager for delegation to the visible Codex Plugin specialist worker. Those plugin-scoped turns stay read-only/safety-gated with bounded redacted previews and metadata, and full connector exports appear as session artifacts instead of chunked chat output; the direct sidecar path is text-only, Builder web only, excludes Collaboration, and supports one active direct Codex turn globally.
