Use **Files** from the desktop workspace rail to browse the current session's repository or the worktree selected in Source Control.

When a Remote Project is selected, Files reads and mutates paths on that Forge server's repository/workspace. Opens, saves, creates, renames, deletes, version checks, and previews use remote server storage; Forge does not create or synchronize a local checkout. Confirm the blue, globe-marked project you selected before making destructive changes.

## Open files and tabs

- **Single-click** a file to open or activate the italic preview tab. There is one preview tab, so another single-click replaces it when it is clean.
- **Double-click** a file or tab to make it sticky. Sticky tabs stay open together.
- The first edit makes a preview tab sticky automatically. A newly created file also opens in a sticky tab.
- Close a tab with its close button. Closing a dirty tab asks you to **Save**, **Discard**, or **Cancel**.

## Edit text and Markdown

Supported text files open in CodeMirror on desktop. Saves are versioned: if the file changed on disk after you loaded it, Forge shows **Reload from disk**, **Overwrite anyway**, and **Cancel** instead of silently replacing the newer version.

Markdown files (`.md`, `.markdown`, and `.mdx`) open in rendered **Preview** by default, even when they are editable. Preview renders the current draft, including unsaved changes. Use **Preview / Source** to switch views. Source is editable CodeMirror on desktop and read-only highlighted text on mobile. Switching to another file and back resets Markdown to Preview.

PDFs use the built-in read-only preview. Unsupported or non-editable content remains read-only.

## Create, rename, and delete

Create an empty file from **New file** in the Files header, the empty-tree action, or a directory context menu. Folder creation is not supported. The new file opens as a sticky tab.

Rename a file or directory from its item context menu. Enter one name component only: slashes, backslashes, NUL, `.`, and `..` are rejected. Intentional leading or trailing whitespace is preserved, and an existing path is never overwritten. Renaming remaps affected open tabs to the new path.

Delete permanently removes a file or recursively removes a folder after confirmation. Tabs for deleted paths are removed. Create, rename, and delete stay inside the selected repository/worktree and reject root, traversal, outside-workspace, and symlink-parent escapes.

Successful create, rename, save, and delete operations refresh the Files tree and Source Control Changes.

## Draft guards and restoration

Selecting another file, hiding Files, or opening Source Control preserves drafts without prompting. Forge asks you to **Save**, **Discard**, or **Cancel** when you:

- close a dirty tab;
- navigate to another session or route;
- rename or delete a path that affects a dirty tab; or
- switch/create a branch or run a fast-forward-only pull in Source Control for the same worktree. Pushing unpublished commits does not trigger the guard.

Unrelated rename/delete operations and read-only Source Control navigation do not trigger the guard.

While the Files surface remains mounted, Forge remembers each session/worktree scope's tabs, active and preview tab, tree expansion, filter/search, tree scroll, and text/Markdown content scroll. Hiding and reopening Files, or switching away from and back to a session/worktree, restores that in-memory state after any required navigation guard is resolved. Browser or app restart clears it.

## Worktrees and mobile

Selecting a linked worktree in Source Control scopes Files browsing and file operations to that worktree without changing the chat session's working directory.

Mobile file content remains read-only. The Source view for Markdown is highlighted but not editable, and desktop item context-menu actions such as rename and delete may not be exposed the same way on mobile.
