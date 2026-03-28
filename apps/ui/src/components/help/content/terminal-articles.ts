import type { HelpArticle } from '../help-types'

export const terminalArticles: HelpArticle[] = [
  {
    id: 'terminal-overview',
    title: 'Integrated Terminals',
    category: 'terminals',
    summary:
      'Full shell terminals inside Forge, scoped to your profile and persisted across sessions.',
    content: `Forge includes built-in terminals so you can run shell commands without leaving the app. Each terminal is a real PTY session running your default shell.

## Profile-scoped, not session-scoped

Terminals belong to the manager profile, not to individual chat sessions. When you switch between sessions in the same profile, your terminals stay open. This is useful when you have a long-running process like a dev server or log tail that you want to keep visible across conversations.

If you delete a session, the terminals are not affected as long as the profile still has other active sessions. Terminals are cleaned up when the entire manager session group is removed.

## Persistence

Terminal state is saved periodically. If the backend restarts, your terminals restore from the most recent snapshot, including scrollback history and screen content. A brief "Restored" indicator appears in the tab to let you know the session was recovered rather than freshly started.

## Panel layout

The terminal panel sits below the chat area. You can resize it by dragging the top edge, or use the toolbar buttons to collapse, maximize, or hide it. Double-click the resize handle to toggle between maximized and normal size.

On mobile, the terminal opens as a bottom sheet overlay. Tap the backdrop to dismiss it.

## Limits

Each manager supports up to 10 terminals at a time. The + button is disabled when you hit the limit.`,
    keywords: [
      'terminal',
      'shell',
      'pty',
      'command line',
      'console',
      'persist',
      'scrollback',
      'profile',
    ],
    relatedIds: ['terminal-shortcuts', 'terminal-management'],
    contextKeys: ['terminal.panel'],
  },
  {
    id: 'terminal-shortcuts',
    title: 'Terminal Keyboard Shortcuts',
    category: 'terminals',
    summary: 'Keyboard shortcuts for opening, switching, and navigating terminals.',
    content: `Most terminal actions have keyboard shortcuts so you can stay in the flow without reaching for the mouse.

## Opening and closing

- **Ctrl+\`** (or **⌘+\`** on Mac) toggles the terminal panel. If no terminals exist, this creates one automatically.
- **Ctrl+Shift+\`** (or **⌘+Shift+\`**) creates a new terminal and opens the panel.
- **Escape** while focused in a terminal collapses the panel back to the tab strip and returns focus to the chat input.

## Switching terminals

- **Alt+Shift+[** moves to the previous terminal tab.
- **Alt+Shift+]** moves to the next terminal tab.

These shortcuts cycle through all open terminals in tab order. If the panel was hidden or collapsed, it opens automatically when you switch.

## Tab interactions

Click a terminal tab to open it. Click the active tab again to collapse the panel down to the tab strip. This lets you quickly peek at a terminal and get back to chat.

Double-click a tab name to rename it. Press Enter to save or Escape to cancel.

Middle-click a tab to close that terminal.

## Resize

Drag the top edge of the terminal panel to adjust its height. The panel remembers your preferred height across page reloads. Double-click the resize handle to toggle between maximized and normal size.

## Desktop app

In the Electron desktop app, these same shortcuts are available through the application menu. The menu provides fallback access if a shortcut conflicts with your OS or shell.`,
    keywords: [
      'shortcut',
      'keyboard',
      'hotkey',
      'escape',
      'toggle',
      'switch',
      'tab',
      'focus',
      'resize',
    ],
    relatedIds: ['terminal-overview', 'terminal-management'],
    contextKeys: ['terminal.panel'],
  },
  {
    id: 'terminal-management',
    title: 'Managing Terminals',
    category: 'terminals',
    summary: 'How to create, rename, close, and organize your terminals.',
    content: `You can have up to 10 terminals open per manager. Each one runs independently with its own shell process, working directory, and scrollback.

## Creating a terminal

Click the **+** button in the terminal tab bar, or press **Ctrl+Shift+\`** (⌘+Shift+\` on Mac). The new terminal opens in the manager's working directory by default.

If you already have 10 terminals, the + button is disabled and a tooltip explains the limit.

## Renaming

Double-click a terminal tab to edit its name inline. Type the new name and press Enter. Press Escape to cancel without saving.

Renaming is useful when you have several terminals open for different tasks, like separating a build watcher from a test runner.

## Closing

Click the **×** on a terminal tab, or middle-click the tab. The shell process is terminated and the terminal is removed.

If you close the active terminal, the panel switches to the next available one. If that was the last terminal, the panel hides automatically.

## Status indicators

Each tab shows a small colored dot:

- **Green** — the shell process is running.
- **Amber** — the terminal was restored from a saved snapshot (clears after a few seconds).
- **Red** — the shell exited with an error, or the restore failed.
- **Gray** — the shell exited normally.

## Working directory

New terminals inherit the working directory from the manager session's configuration. If you need a different directory, use \`cd\` after the terminal opens. The terminal does not change directories when you switch chat sessions.`,
    keywords: [
      'create',
      'new',
      'close',
      'delete',
      'rename',
      'status',
      'indicator',
      'working directory',
      'cwd',
    ],
    relatedIds: ['terminal-overview', 'terminal-shortcuts'],
    contextKeys: ['terminal.panel'],
  },
  {
    id: 'playwright-overview',
    title: 'Playwright Dashboard',
    category: 'playwright',
    summary:
      'Live browser session viewer for Playwright tests and automation, with filtering and preview.',
    content: `The Playwright dashboard shows browser sessions that Forge discovers across your project worktrees. It is designed for monitoring and debugging Playwright-based tests and browser automation run by agents.

## What it shows

The dashboard scans configured root directories for Playwright CLI session files. Each discovered session appears as a card with its name, status, associated worktree, and (when available) a live screenshot preview.

Sessions are color-coded by liveness:

- **Active** — the browser process is currently running.
- **Inactive** or **Stale** — the session file exists but the browser is no longer connected. These are hidden by default but you can reveal them with the filter controls.

## View modes

- **Grid** — a mosaic of thumbnail tiles. Good for monitoring several sessions at once.
- **Split** — a session list on the left with a live preview pane on the right. Click a session to see its live view.
- **Focus** — full-screen live preview of a single session. Enter focus mode by double-clicking a tile or using the expand button.

## Filtering and search

Use the filter bar to narrow results by status, worktree, or search text. The search matches session names, file paths, worktree names, and correlated agent names.

## Availability

The dashboard requires macOS or Linux. It is not available on Windows. Enable it in Settings or with the \`FORGE_PLAYWRIGHT_DASHBOARD_ENABLED\` environment variable. If the env var forces it off, the Settings toggle is disabled.

When no scan roots are configured, the dashboard shows a prompt to add them in Settings.`,
    keywords: [
      'playwright',
      'browser',
      'dashboard',
      'live preview',
      'session',
      'worktree',
      'automation',
      'test',
      'screenshot',
    ],
    relatedIds: ['terminal-overview'],
    contextKeys: ['playwright.dashboard'],
  },
]
