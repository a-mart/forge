The Source Control workspace brings repository review and safe git operations into Forge without changing the active chat session.

## What it shows

Open **Source Control** from the desktop workspace rail. The workspace includes tabs for:

- **Changes** for the selected worktree's current file changes and diffs.
- **History** for commit history and commit diffs.
- **Worktrees** for a read-only inventory of repository worktrees.
- **Pull Requests** for GitHub pull requests when the repository remote and `gh` CLI setup are available.

Selecting a worktree changes the Source Control and Files context only. You can browse and, on desktop, create, edit, rename, or delete paths from that worktree in Files without changing the chat session's working directory or where the manager sends workers. Successful create, rename, save, and delete operations refresh Source Control so Changes stays current.

When a Remote Project is selected, the repository and worktrees are on that Forge server. Status, history, diffs, branch operations, fetch/pull, and GitHub CLI (`gh`) requests execute on the remote server against its repository, credentials, and network—not on your local machine or a synchronized clone.

## Branch and remote actions

Source Control can fetch from origin, switch branches, create branches, and pull from upstream. When you enter Source Control or change repository context, Forge may quietly fetch stale origin data in the background. Manual **Fetch** remains explicit and reports errors if it cannot complete. Opening Source Control preserves Files drafts without prompting. Branch switch/create and fast-forward-only pull guard dirty tabs in the matching worktree with **Save**, **Discard**, or **Cancel**, then use a confirmation flow with an expected-head/status preflight before Forge sends the git command. Read-only Source Control navigation does not trigger the dirty guard.

Forge does not provide force push, stash, discard, rebase, branch deletion, or worktree create/remove actions from this workspace.

## Pull requests

The Pull Requests tab uses the GitHub CLI (`gh`). Its shortcut can show an open PR count after you visit the tab. If the selected repository does not have a GitHub remote, `gh` is not installed, or `gh` is not authenticated, the tab shows an unavailable or degraded state instead of pretending PR data is present.

PR merge uses an explicit confirmation dialog. Forge re-checks the latest PR head commit and sends the merge with GitHub's match-head-commit guard. It does not delete the branch after merge and does not use admin bypass. GitHub branch protection can still block the merge.
