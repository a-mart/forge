The sidebar on the left is your main navigation for everything in Forge. The new project view is on by default. Use **Settings → General → Sidebar → Use new project view** to keep it, or turn it off to roll back to Classic. It opens in **Inbox**, with **Projects** keeping the familiar project/session tree.

The Builder/Collab toggle lives in the sidebar header, and when collaboration is enabled the New Project action moves next to session search. Collaboration channels are backed by sessions and can carry per-channel instructions and reference docs. The Collab sidebar lists all configured collaboration backend connections, and the active connection controls the detail view and full channel/history subscription. Use the Builder Archive view from the sidebar to review archived projects and directly archived sessions. Archive entries are sorted by last user-message activity and show the last-used date. Restore and reopen them when needed. The Archive view is separate from the active session list. Other system profiles and collaboration-surface sessions remain hidden from the Builder sidebar/profile lists.

On desktop, Cortex lives in the activity-rail popover. On mobile, and in Classic, it remains a pinned sidebar row.

## Inbox

Inbox is the default new project view. It lists:

- **Needs you** — server-issued work-lifecycle attention. Unread badges, pending choices, and error dots do not create these items.
- **Active** — currently working sessions, capped with an **N more** link into Projects.
- **Recent** — sessions updated in the last 7 days, also bounded.
- **Projects** — the same project/session tree as Projects mode, shown inline after those sections.

**Done** and **Clear** dismiss the exact **Needs you** items they target. Muting a session only hides it from **Needs you** and the Inbox badge; it does not dismiss the attention. Origins that do not support session attention omit **Needs you** instead of inventing items from local badges. Right-click a **Needs you**, **Active**, or **Recent** session for the same local session actions as Projects; remote Inbox rows stay limited the same way as remote project sessions.

## Projects

Each **profile** is a collapsible group. Inside each profile are its **sessions**. Inside each session, you can expand to see active **workers**. Click a session or worker to switch to it. Project headers expand or collapse their nested sessions; they do not select a conversation.

Enabled remote project headers appear in Builder with blue styling and a globe marker, mixed with local projects. Nested session rows sit beneath each header and use status dots rather than the globe marker. Remote actions are limited: right-click a remote project header to use **Change Working Directory** through the server directory browser. Local rename, archive, delete, fork, and model actions remain absent. Selecting a remote project or session makes its server the active origin for supported chat and workspace surfaces; selecting a local row switches those surfaces back.

A connection without a selectable project can show **Connecting**, **Sign in required**, **Unreachable**, **Update Forge to connect**, Remote Projects disabled on the server, or connected with no projects. These states describe connectivity, authentication, policy, and protocol compatibility; they do not create a local copy of the remote project.

Project agents appear pinned at the top of each profile section with a badge, above regular sessions. Session pinning in the sidebar is separate from message pinning inside a conversation.

## Search

The search bar at the top filters local and connected remote sessions and workers by name in one result set. Remote connection status cards are hidden while a search is active so they are not counted as matches. Prefix shortcuts remain available in Projects:

- `s:` searches only session names.
- `w:` searches only worker names.

## Profile actions

For a local Builder project, right-click its header and choose **Project Settings**. You can also hover the header, or focus its actions button, then open the **…** menu. The page stays scoped to that selected project and provides its name, working directory, default model and reasoning level, Context management, Project secrets, and Repository resources `.forge` controls. Context management is the project default for Summary vs experimental Fresh windows. Cortex and Remote Projects do not offer Project Settings.

The direct header context-menu shortcuts remain: New Session, Create Project Agent, Rename, Change Default Model, Change Working Directory, Project Secrets, Mark All as Read, Mute/Unmute All Sessions, Archive Project, and Delete Manager. Changing the default model updates only sessions that still inherit the project default; sessions with an explicit session override are not affected. Changing the working directory updates the CWD for all sessions in the profile — active workers keep their old CWD, but new spawns inherit the new path. Archiving a project marks only the profile as archived, not each session individually, but the whole project becomes read-only and unusable until restored.

You can drag local and connected remote project headers into one shared order. Forge saves that unified order on the local Builder instance, so browsers and the desktop app connected to the same local Forge use the same layout. Ordering is only presentation state: it is never written to a remote collaboration server and does not grant access, change membership, or enable Remote Projects. Offline, disabled, archived, and client-unseen projects keep their positions: one client's connection registry or project snapshot cannot delete positions another client still needs. Deleted projects and removed connections can therefore remain as harmless hidden anchors until Forge has explicit local-instance cleanup authority. The **+** button on a local profile header creates a new session.

## Session actions

Right-click any session to access: Copy session data path, Rename, Fork, Override Session Model, Use Project Default, Stop, Resume, Archive, Restore, Mark as Unread, Mute/Unmute, or Delete. The Main (default) session in each profile cannot be deleted or archived directly. Muting a session suppresses notification sounds while keeping the unread badge visible. In Inbox, mute also hides that session from **Needs you** and the Inbox badge without dismissing the server attention. Override Session Model opens a one-screen dialog for picking a concrete model, and Use Project Default clears the override so the session inherits the project default again. Every session, including the root session, can override the project default model or revert to inheriting it. Archived sessions are read-only and unavailable for chat, model, CWD, project-agent reference edits, and terminal use until restored. Archive entries are sorted by last user-message activity and show the last-used date. Restore can open the restored target immediately when requested.

## Workers

Sessions with active workers show a numbered amber badge. Sessions in compaction or context recovery show a violet pulsing `C` badge. If both are active, the worker-count badge and `C` badge appear side by side. Expand the session to see individual workers with their status dots and specialist badges. Right-click a worker to stop, resume, or delete it.

## Mobile

On smaller screens, the sidebar is hidden by default. Tap the hamburger menu in the header to open it. An unread badge shows on the menu button when there are unread messages. Cortex stays in the sidebar on mobile because the desktop activity rail is hidden.
