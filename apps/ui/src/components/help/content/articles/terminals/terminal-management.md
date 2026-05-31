You can have up to 10 terminals open per manager. Each one runs independently with its own shell process, working directory, and scrollback.

## Creating a terminal

Click the **+** button in the terminal tab bar, or press **Ctrl+Shift+`** (⌘+Shift+` on Mac). The new terminal opens in the manager's working directory by default.

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

New terminals inherit the working directory from the manager session's configuration. If you need a different directory, use `cd` after the terminal opens. The terminal does not change directories when you switch chat sessions.
