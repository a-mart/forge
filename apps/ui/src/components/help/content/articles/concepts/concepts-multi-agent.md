Forge uses two kinds of agents: **managers** and **workers**. A manager is the agent you talk to in chat. Workers are agents the manager creates to do specific tasks. Forge supports multiple runtime providers, including the native Claude SDK path alongside the Pi-proxied Anthropic path. Claude SDK sessions also auto-compact natively at 80% of the context window, which the SDK handles internally without a session restart.

When you send a message, the manager reads it, decides what needs to happen, and spawns one or more workers. Each worker gets a focused job — edit a file, run a command, research a topic. Workers run in parallel when their tasks are independent. The manager collects their results and responds to you. A worker can auto-report on turn end / `agent_end` before the runtime flips fully idle; the idle watchdog/status-idle path is a fallback and noise-suppression layer, not the only completion gate. Watchdog and stall warnings are suppressed while worker or parent runtime recovery is active so duplicate completion reporting does not leak through. A bare runtime `errorMessage: "terminated"` waits out a 60-second grace period before failure projection; if the worker resumes progress or self-reports to the manager during that window, the transient error is canceled.

## What you see

Workers appear as pills below the chat header while they are active. Click a pill to see what that worker is doing. When a worker finishes, it reports back to the manager and disappears. Agents can also produce Mermaid diagrams that render inline in chat instead of staying as raw code fences.

## Why this matters

Splitting work across workers means the manager can handle multiple things at once. A single message might trigger a backend fix, a UI update, and a test run — all happening in parallel instead of one after another.

The manager controls the flow. It decides which model each worker uses, what instructions to give, and whether to retry if something fails. You do not need to manage workers directly, but you can watch their progress and see their output in the chat. User-facing manager updates are intentionally concise and focused on decisions, results, and blockers.

## How routing works

The manager picks a model for each worker based on the task. Quick jobs like file reads get a cheaper, faster model. Complex work like architecture review gets a more capable one. If you have specialists configured, the manager routes work to the right specialist automatically based on what the task needs.

Workers can use tools — reading files, running shell commands, making edits — but they always report results back to the manager, which decides the next step. If a worker turn fails, that failure can surface as a system message with the error context preserved instead of looking like a normal completion. The normal chat transcript stays manager-session focused: Web shows conversation messages, and All adds manager-owned activity without expanding into worker-internal tool history.

Use **Session Audit Log** when you need the full persisted diagnostic view. It reads canonical manager and worker JSONL sources, lets you switch from the manager session log to a worker transcript, and keeps the list paginated with compact summaries. Select a row and choose **View JSON** to fetch the full canonical JSONL row (up to an 8 MB detail cap) into a detail pane with formatted/raw toggles and copy. Small rows use syntax highlighting; very large JSON uses a plain scrollable viewer so the UI stays responsive. Worker internals are visible only after explicitly selecting a worker source in that audit view, and audit rows are not added to normal chat or model context.

Builder web can also route a plain leading @Codex or [@Codex] text message to a direct Codex app-server sidecar, or route selector-based mentions to the manager for delegation to the visible Codex Plugin specialist worker. Those plugin-scoped turns stay read-only/safety-gated with bounded redacted results; the direct sidecar path is text-only, Builder web only, excludes Collaboration, and supports one active direct Codex turn globally.
