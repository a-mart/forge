The chat interface is where you interact with Forge's manager agents. You send a message, the manager reads it, and it starts streaming a response in real time.

## Layout

The main view has three parts:

- **Sidebar** (left) for navigating managers, profiles, and sessions.
- **Message area** (center) showing the conversation transcript.
- **Desktop workspace rail** (left edge of the workspace) for Chat, Files, Source Control, Terminal, Cron/Schedules, and Artifacts/Dashboard. Chat returns to the current manager/session conversation, including from a selected worker route back to its parent manager thread. Files opens as a left split pane beside the rail with resizable tree and file surface panes; on desktop, supported text files open directly in an editable CodeMirror surface with syntax highlighting, and editable Markdown opens in source/editor mode by default. Non-editable files stay preview/read-only. File-tree context menus can permanently delete files or folders after confirmation; folder deletion warns that contents are removed recursively. If the delete affects a dirty open file, Forge first routes through the Save / Discard / Cancel guard, then clears affected selections and refreshes file and Source Control state after deletion. Source Control opens inline with Changes, History, Worktrees, and Pull Requests tabs, and may quietly refresh stale origin data when opened. Selecting a worktree updates Source Control and Files browsing/editing context without changing the chat session's working directory. Files, Source Control, Artifacts/Dashboard, and Schedules switch mutually exclusively so panes do not stack or hide behind each other, while Terminal stays independent and persistent. Mobile keeps the header/drawer workspace behavior and remains read-only for file editing.

## Streaming and status

While a manager is responding, you'll see a green status dot in the header and the text "Streaming." The message appears incrementally as it's generated.

## Stopping a response

To stop a running response, open the **⋮ menu** in the header and choose **Stop All**. This terminates the manager and any active workers.

## Channel views

The header has a **Web / All** toggle. "Web" prioritizes the visible conversation transcript and pending choices you can answer. "All" adds manager-session activity and tool rows that belong to the visible chat flow. Worker-internal tool activity is not shown in normal Web, All, or Detailed chat views.

For diagnostics, use **Session Audit Log** from the chat header menu. It reads the persisted session history directly from canonical JSONL files. The manager source shows the manager session log; selecting a worker source shows that worker's transcript and internal tool activity. On desktop, Session Audit uses a split list/detail inspector with a draggable, resizable divider. The list stays paginated with compact, clickable summaries and capped previews for performance. Select any row to automatically load the full canonical row into the detail pane, where you can switch between formatted/raw JSON, toggle wrapping, and copy the JSON. Detail fetch is capped at 8 MB per row; very large JSON falls back to a plain scrollable viewer so the audit UI stays responsive while copy still includes the fetched text. Rows include category/type filters, byte offsets, and hidden reasons. This audit surface is for inspection only and is not part of the normal chat transcript or model context.

Builder web also supports Codex app-server sidecars. A plain leading @Codex or [@Codex] starts or continues a direct sidecar text turn. Selector forms like @Codex -<plugin>, @Codex:<plugin>, and [@Codex:<plugin>] scope the turn to a plugin and delegate it through the visible Codex Plugin specialist worker. Direct sidecars show as worker-like external-thread cards and persist by default; plugin-scoped turns stay read-only/safety-gated with bounded redacted previews and metadata. Full connector exports appear as session artifacts rather than long chat output. This is Builder web only, text-only for the direct sidecar path, excludes Collaboration, and allows one active direct Codex turn globally.

Mermaid code blocks also render inline as interactive diagrams, with controls to toggle source, copy the Mermaid text, export SVG or PNG, and expand fullscreen.

## Context window

The ring icon next to the channel toggle shows how full the context window is. While a runtime is live, the live runtime status is authoritative for that meter. Green means plenty of room. Amber means it's getting full. Red means you're near the limit and should consider compacting.

## Active Work

For substantial manager-led work, Forge can show an **Active Work** card above the conversation. It is scoped to the current session and shows the manager's plan, item status, and linked worker evidence. Linked worker chips open that worker's transcript when the worker still belongs to the same session. Expandable **Work Plan created** rows in the timeline show the durable `work_plan_created` receipt snapshot, and the card can disclose a bounded list of previous Work Plans when more than one terminal plan is retained.

The matching header control opens an anchored Active Work popover with an explicit accessible name. It toggles the card open or closed without scrolling or jumping the transcript. Historical receipt rows hydrate from the latest active or recent task snapshot when available, falling back to the creation snapshot only when needed.

## Header controls

The chat header still shows the pin count badge, where you can move to the previous or next pin and the selected pin is auto-scrolled into view and highlighted. Desktop workspace buttons now live behind the activity rail instead of the header; mobile keeps the header workspace actions. Use the Chat rail item to jump back to the current manager/session chat, including from worker-route views back to the parent manager thread.
