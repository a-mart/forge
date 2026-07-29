Sessions are individual conversations within a profile. Each session has its own chat history, working plan, and session memory, but shares the profile's settings and core memory. If a session previously showed truncated history, Forge rebuilds the cached replay from canonical disk history on first load, especially for async project-agent deliveries.

## Create a session

Click the **+** button on a profile header in the sidebar, or right-click the profile and choose **New Session**. You can give it a name or let Forge auto-generate one.

## Switch sessions

Click any session in the sidebar to switch to it. Your context, history, and any attached draft are restored.

## Rename a session

Right-click the session and choose **Rename**. This changes the display name only. The underlying session ID stays the same.

## Stop and resume

Right-click a session and choose **Stop** to pause it. A stopped session keeps its history but won't respond to new messages until you **Resume** it.

## Delete a session

Right-click and choose **Delete**. This permanently removes the session's history and memory. You'll be asked to confirm. Deletion is terminal: Forge attempts to revoke browser authority, then clears its Desktop/External Chrome session state and checkpoints even if a stale release cannot be acknowledged, so browser cleanup cannot block deletion. The default "Main" session in each profile cannot be deleted.

If you delete the session you're currently viewing, Forge routes you to the most recent session in the same profile. Archive is separate and reversible; it remains fail-closed when browser release cannot be acknowledged rather than proceeding with an unresolved lifecycle release.

## Clear conversation

To start fresh without creating a new session, open the **⋮ menu** in the chat header and choose **Clear conversation**. This resets the active session in place, keeping the same session identity.
