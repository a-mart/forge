The chat interface is where you interact with Forge's manager agents. You send a message, the manager reads it, and it starts streaming a response in real time.

## Layout

The main view has three parts:

- **Sidebar** (left) for navigating managers, profiles, and sessions.
- **Message area** (center) showing the conversation transcript.
- **Desktop workspace rail** (left edge of the workspace) for Chat, Files, Source Control, Terminal, Cron/Schedules, and Artifacts/Dashboard. Chat returns to the current manager/session conversation, including from a selected worker route back to its parent manager thread. Files opens a resizable tree and tabbed file surface: single-click uses one replaceable preview tab, while double-click, first edit, and create make tabs sticky. Markdown defaults to rendered Preview with a Preview/Source toggle, and Files supports empty-file creation plus file/directory rename and delete. Opening another file, hiding Files, or entering Source Control preserves drafts without prompting; destructive path actions and matching Source Control write mutations guard affected dirty tabs. Source Control opens inline with Changes, History, Worktrees, and Pull Requests tabs, and may quietly refresh stale origin data when opened. Selecting a worktree scopes Source Control and Files without changing the chat session's working directory. Files, Source Control, Artifacts/Dashboard, and Schedules switch mutually exclusively, while Terminal stays independent and persistent. Mobile keeps the header/drawer workspace behavior and file content remains read-only.

## Streaming and status

While a manager is responding, you'll see a green status dot in the header and the text "Streaming." The message appears incrementally as it's generated.

## Stopping a response

To stop a running response, open the **⋮ menu** in the header and choose **Stop All**. This terminates the manager and any active workers.

If an active manager stops making progress, amber System rows provide approximate escalation notices. After a backend restart, Forge does not auto-resume; when recovery information is available, a banner below the header offers **Resume all** or **Dismiss**. Open the related **Stalls and restart recovery** article for recovery limits and safety guidance.

## Channel views

The header has a **Web / All** toggle. For a manager, **Web** prioritizes the focused conversation transcript and pending choices you can answer. **All** adds manager-session activity, manager tool rows, and terminal reports returned by workers; it does not inline the workers' internal tool history. Selecting a worker opens that worker's transcript and defaults its view to All.

If a worker completes but the manager does not summarize it, Forge may show a system notice directing you to All or a calm **Worker outcome · auto-surfaced** card with a bounded outcome summary. The notice and card are not clickable links: switch the manager view to **All** manually to read the full terminal report.

For diagnostics and runtime internals, use **Session Audit Log** from the chat header menu. It reads the persisted session history directly from canonical JSONL files. The manager source shows the manager session log; selecting a worker source shows that worker's transcript and internal tool activity. On desktop, Session Audit uses a split list/detail inspector with a draggable, resizable divider. The list stays paginated with compact, clickable summaries and capped previews for performance. Select any row to automatically load the full canonical row into the detail pane, where you can switch between formatted/raw JSON, toggle wrapping, and copy the JSON. Detail fetch is capped at 8 MB per row; very large JSON falls back to a plain scrollable viewer so the audit UI stays responsive while copy still includes the fetched text. Rows include category/type filters, byte offsets, and hidden reasons. This audit surface is for inspection only and is not part of the normal chat transcript or model context.

Builder web also supports Codex app-server sidecars. A plain leading @Codex or [@Codex] starts or continues a direct sidecar text turn. Selector forms like @Codex -<plugin>, @Codex:<plugin>, and [@Codex:<plugin>] scope the turn to a plugin and delegate it through the visible Codex Plugin specialist worker. Direct sidecars show as worker-like external-thread cards and persist by default; plugin-scoped turns stay read-only/safety-gated with bounded redacted previews and metadata. Full connector exports appear as session artifacts rather than long chat output. This is Builder web only, text-only for the direct sidecar path, excludes Collaboration, and allows one active direct Codex turn globally.

Mermaid code blocks also render inline as interactive diagrams, with controls to toggle source, copy the Mermaid text, export SVG or PNG, and expand fullscreen.

## Replying

In normal Builder chat, hover a visible user or assistant message and click **Reply** to quote it in your next message. The composer shows a compact reply target preview; clear it to send without a quote, or choose Reply on another message to change the target. Sent replies show a compact quoted preview above the message. Click that quote to scroll back to the original when it is loaded in the current transcript. Collaboration messages and async Project Agent delivery do not use this reply threading in v1.

## Context window

The ring icon next to the channel toggle shows how full the context window is. While a runtime is live, the live runtime status is authoritative for that meter. Green means plenty of room. Amber means it's getting full. Red means you're near the limit and should consider compacting.

## Active Work

For substantial manager-led work, Forge can show an **Active Work** card above the conversation. It is scoped to the current session and shows the manager's plan, item status, and linked worker evidence. Linked worker chips open that worker's transcript when the worker still belongs to the same session. Expandable **Work Plan created** rows in the timeline show the durable `work_plan_created` receipt snapshot, and the card can disclose a bounded list of previous Work Plans when more than one terminal plan is retained.

The matching header control opens an anchored Active Work popover with an explicit accessible name. It toggles the card open or closed without scrolling or jumping the transcript. Historical receipt rows hydrate from the latest active or recent task snapshot when available, falling back to the creation snapshot only when needed.

## Header controls

The chat header still shows the pin count badge, where you can move to the previous or next pin and the selected pin is auto-scrolled into view and highlighted. Desktop workspace buttons now live behind the activity rail instead of the header; mobile keeps the header workspace actions. Use the Chat rail item to jump back to the current manager/session chat, including from worker-route views back to the parent manager thread.
