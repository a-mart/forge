The artifact panel is a slide-out viewer for files that agents create or reference during a conversation. On desktop, it now opens from the left activity rail as a single selected activity-pane surface; mobile keeps the header/drawer behavior. You can still type and send messages while a file is open.

## Opening the panel

Click a file reference in a chat message, or toggle the panel with the **sidebar icon** in the header (the rightmost icon). For Cortex sessions, this button opens the Cortex dashboard instead.

## What it shows

The panel loads the file at the absolute path referenced in the chat message and displays it based on file type:

- **Markdown files** (.md, .mdx) render with full formatting, including Mermaid diagrams.
- **Images** (PNG, JPG, GIF, WebP, SVG) display inline.
- **PDFs** open in the same built-in preview used by Files, with page, zoom, and reload controls. In the desktop app, **Open PDF** uses the system default PDF app; in the browser it opens a new tab.
- **Code and text files** show syntax-highlighted source.

Artifact viewing is distinct from the Files rail's inline editor. Use the Files rail when you want desktop in-app editing; use this panel for conversation artifacts and file references. The header shows the file name, full path, and an "Open in Editor" link. In the desktop app, a "Show in folder" button also appears.

## Opening in your editor

Click "Open in [Editor]" in the panel header to open the file directly in your preferred external editor. Set your editor (VS Code, VS Code Insiders, or Cursor) in Settings > General.

## Revealing in the file system

In the desktop app, click "Show in folder" to reveal the file in Finder (macOS) or File Explorer (Windows). This is useful when you want to see the file's location or work with it outside the editor.

## Navigating between files

Click any file reference in the conversation to switch the panel to that file. Links within markdown documents also work, so you can follow references between files.

## Closing

Press **Esc** or click the X button. The panel slides away and returns you to the full chat view.
