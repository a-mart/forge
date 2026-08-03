Git Monitoring lets local Builder projects notice when a configured Git remote has incoming commits. It is an awareness feature: it helps you review upstream work without changing your current branch, worktree, or chat working directory.

## Where it applies

This Builder-only setting is available at **Settings → Git Monitoring**. It applies only to eligible local Git projects that Forge knows about. Remote Projects and Collaboration servers do not receive this local monitoring service.

The global switch is the master switch. When it is Off, no project runs monitoring: a project set to **On** does not override global Off. When the master switch is On, each eligible project can inherit the global setting or explicitly choose **On** or **Off**. Projects that are archived, removed, moved to a different working directory, or no longer valid local Git repositories are removed from monitoring eligibility.

## What you see

When Forge detects a newer remote tip, the project can show an incoming-update state. Open the project detail to inspect a bounded list of incoming commits and changed files, refresh its observation, or dismiss the exact update you reviewed. Dismissing one observed tip does not hide a later remote update.

Monitoring is not a replacement for Source Control. Use Source Control to inspect changes, switch branches, or pull. Each monitoring check runs `git fetch` for the selected remote ref, updating the selected remote-tracking ref. Git Monitoring never merges, checks out, or pushes for you.

## Privacy and availability

Forge checks only configured repository remotes through your local Git installation. A network or Git failure is shown as a monitoring problem for that project; it does not change the repository. Turn the global switch off, or set a project override to Off, to stop future checks.
