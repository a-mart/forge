The Source Control workspace brings repository review and safe git operations into Forge without changing the active chat session.

## What it shows

Open **Source Control** from the desktop workspace rail. The workspace includes tabs for:

- **Changes** for the selected worktree's current file changes and diffs.
- **History** for commit history and commit diffs.
- **Worktrees** for a read-only inventory of repository worktrees.
- **Pull Requests** for GitHub pull requests when the repository remote and `gh` CLI setup are available.

Selecting a worktree changes the Source Control and Files context only. You can browse and, on desktop, edit or delete files from that worktree in the Files pane without changing the chat session's working directory or where the manager sends workers. Same-workspace file edits and deletes refresh Source Control so Changes stays current.

## Branch and remote actions

Source Control can fetch from origin, switch branches, create branches, and run fast-forward-only pulls. Write actions use a confirmation flow with a preflight check, including the expected head and status state, before Forge sends the git command. If the matching Files worktree has unsaved inline edits, Forge guards the transition, mutation, or affected file/folder delete instead of discarding the draft.

Forge does not provide force push, stash, discard, rebase, branch deletion, or worktree create/remove actions from this workspace.

## Pull requests

The Pull Requests tab uses the GitHub CLI (`gh`). If the selected repository does not have a GitHub remote, `gh` is not installed, or `gh` is not authenticated, the tab shows an unavailable or degraded state instead of pretending PR data is present.

PR merge uses an explicit confirmation dialog. Forge re-checks the latest PR head commit and sends the merge with GitHub's match-head-commit guard. It does not delete the branch after merge and does not use admin bypass. GitHub branch protection can still block the merge.
