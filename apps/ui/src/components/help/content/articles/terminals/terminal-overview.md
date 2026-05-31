Forge includes built-in terminals so you can run shell commands without leaving the app. Each terminal is a real PTY session running your default shell.

## Profile-scoped, not session-scoped

Terminals belong to the manager profile, not to individual chat sessions. When you switch between sessions in the same profile, your terminals stay open. This is useful when you have a long-running process like a dev server or log tail that you want to keep visible across conversations.

Archiving a project suspends its running profile terminals and preserves them for restore. Archiving a single session blocks terminal use until that session is restored. Archive never deletes terminal data.

If you delete a session, the terminals are not affected as long as the profile still has other active sessions. Terminals are cleaned up when the entire manager session group is removed.

## Persistence

Terminal state is saved periodically. If the backend restarts, your terminals restore from the most recent snapshot, including scrollback history and screen content. A brief "Restored" indicator appears in the tab to let you know the session was recovered rather than freshly started.

## Panel layout

The terminal panel sits below the chat area. You can resize it by dragging the top edge, or use the toolbar buttons to collapse, maximize, or hide it. Double-click the resize handle to toggle between maximized and normal size.

On mobile, the terminal opens as a bottom sheet overlay. Tap the backdrop to dismiss it.

## Limits

Each manager supports up to 10 terminals at a time. The + button is disabled when you hit the limit. Archive is separate from delete: archiving preserves terminal data and can resume suspended terminals later, while deletion removes the terminal itself.
