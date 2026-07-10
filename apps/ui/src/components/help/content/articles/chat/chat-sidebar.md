The sidebar on the left is your main navigation for everything in Forge. It shows your managers (profiles) and their sessions in a tree structure. The Builder/Collab toggle lives in the sidebar header, and when collaboration is enabled the New Project action moves next to session search. Collaboration channels are backed by sessions and can carry per-channel instructions and reference docs. The Collab sidebar lists all configured collaboration backend connections, and the active connection controls the detail view and full channel/history subscription. Use the Builder Archive view from the sidebar to review archived projects and directly archived sessions. Archive entries are sorted by last user-message activity and show the last-used date. Restore and reopen them when needed. The Archive view is separate from the active session list. Cortex is also shown here as a pinned sidebar entry, while other system profiles and collaboration-surface sessions remain hidden from the Builder sidebar/profile lists.

## Structure

Each **profile** is a collapsible group. Inside each profile are its **sessions**. Inside each session, you can expand to see active **workers**. Click any item to switch to it.

Project agents appear pinned at the top of each profile section with a badge, above regular sessions. Session pinning in the sidebar is separate from message pinning inside a conversation.

## Search

The search bar at the top filters local and connected remote sessions and workers by name in one result set. Remote connection status cards are hidden while a search is active so they are not counted as matches. Prefix shortcuts:

- `s:` searches only session names.
- `w:` searches only worker names.

## Profile actions

Right-click a profile header to access: New Session, Create Project Agent, Rename, Change Default Model, Change Working Directory, Mark All as Read, Mute/Unmute All Sessions, Archive Project, or Delete Manager. Changing the default model updates only sessions that still inherit the project default; sessions with an explicit session override are not affected. Changing the working directory updates the CWD for all sessions in the profile — active workers keep their old CWD, but new spawns inherit the new path. Archiving a project marks only the profile as archived, not each session individually, but the whole project becomes read-only and unusable until restored.

You can drag local and connected remote project headers into one shared order. Forge saves that unified order on the local Builder instance, so browsers and the desktop app connected to the same local Forge use the same layout. The preference is never written to a remote collaboration server. Offline, disabled, archived, and client-unseen projects keep their positions: one client's connection registry or project snapshot cannot delete positions another client still needs. Deleted projects and removed connections can therefore remain as harmless hidden anchors until Forge has explicit local-instance cleanup authority. Local Cortex stays pinned above the mixed project list. The **+** button on a local profile header creates a new session.

## Session actions

Right-click any session to access: Copy session data path, Rename, Fork, Override Session Model, Use Project Default, Stop, Resume, Archive, Restore, Mark as Unread, Mute/Unmute, or Delete. The Main (default) session in each profile cannot be deleted or archived directly. Muting a session suppresses notification sounds while keeping the unread badge visible. Override Session Model opens a one-screen dialog for picking a concrete model, and Use Project Default clears the override so the session inherits the project default again. Every session, including the root session, can override the project default model or revert to inheriting it. Archived sessions are read-only and unavailable for chat, model, CWD, project-agent reference edits, and terminal use until restored. Archive entries are sorted by last user-message activity and show the last-used date. Restore can open the restored target immediately when requested.

## Workers

Sessions with active workers show a numbered amber badge. Sessions in compaction or context recovery show a violet pulsing `C` badge. If both are active, the worker-count badge and `C` badge appear side by side. Expand the session to see individual workers with their status dots and specialist badges. Right-click a worker to stop, resume, or delete it.

## Mobile

On smaller screens, the sidebar is hidden by default. Tap the hamburger menu in the header to open it. An unread badge shows on the menu button when there are unread messages.
