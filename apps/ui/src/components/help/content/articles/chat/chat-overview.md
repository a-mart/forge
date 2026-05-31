The chat interface is where you interact with Forge's manager agents. You send a message, the manager reads it, and it starts streaming a response in real time.

## Layout

The main view has three parts:

- **Sidebar** (left) for navigating managers, profiles, and sessions.
- **Message area** (center) showing the conversation transcript.
- **Panels** (right/bottom) for artifacts, terminals, and file browsing.

## Streaming and status

While a manager is responding, you'll see a green status dot in the header and the text "Streaming." The message appears incrementally as it's generated.

## Stopping a response

To stop a running response, open the **⋮ menu** in the header and choose **Stop All**. This terminates the manager and any active workers.

## Channel views

The header has a **Web / All** toggle. "Web" shows only your conversation messages. "All" includes internal activity. A **Detailed** toggle can further reveal owned direct-worker tool activity for manager-scoped rows, but it stays off by default and resets when you switch views or agents.

Builder web also supports Codex app-server sidecars. Start a message with @Codex or [@Codex] to send text to an external Codex thread instead of the manager. Codex sidecars show as worker-like external-thread cards and persist by default. Select the Codex sidecar and send a direct text follow-up to continue that same sidecar thread. This is Builder web only, text-only, excludes Collaboration, allows one active Codex turn globally, requires the Codex CLI app-server, and does not add direct MCP support in Forge.

Mermaid code blocks also render inline as interactive diagrams, with controls to toggle source, copy the Mermaid text, export SVG or PNG, and expand fullscreen.

## Context window

The ring icon next to the channel toggle shows how full the context window is. While a runtime is live, the live runtime status is authoritative for that meter. Green means plenty of room. Amber means it's getting full. Red means you're near the limit and should consider compacting.

## Active Work

For substantial manager-led work, Forge can show an **Active Work** card above the conversation. It is scoped to the current session and shows the manager's plan, item status, and linked worker evidence. Linked worker chips open that worker's transcript when the worker still belongs to the same session. Expandable **Work Plan created** rows in the timeline show the durable `work_plan_created` receipt snapshot, and the card can disclose a bounded list of previous Work Plans when more than one terminal plan is retained.

The matching header indicator toggles the card open or closed and is wired for keyboard and screen-reader access. Collapsing the card only changes the view; the saved plan stays with the session.

## Header controls

The chat header also gives you access to the terminal panel, file browser, diff viewer, and artifact panel through icon buttons on the right side. A pin count badge opens the pinned-message navigator/popover, where you can move to the previous or next pin and the selected pin is auto-scrolled into view and highlighted.
