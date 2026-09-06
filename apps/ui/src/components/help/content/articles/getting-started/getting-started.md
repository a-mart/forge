You describe what needs to happen. The manager owns the outcome, executes or delegates according to Work Mode, and can run work in parallel while you focus on the next problem.

## How it works

You talk to a **manager** agent. The manager reads your instructions and remains accountable. Work Mode decides whether it keeps the work or assigns it: Delegate first remains the default and delegates substantive execution, Adaptive starts directly and hands off only when the total path improves, and Hands-on keeps the critical path while explicit delegation remains available. When it delegates, **workers** run focused tasks in their own git worktrees so nothing collides. Session history is durable on disk, and cached replay views rebuild from canonical transcript history when needed. You watch progress in real time from this dashboard, or walk away and check in later.

When work is delegated, one conversation can have dozens of workers running at once. You don't manage them individually — the manager handles coordination, merging, and status tracking.

## What to do first

1. **Add your credentials.** Open Settings and connect your OpenAI or Anthropic account. Forge needs at least one provider to run agents.
2. **Create a manager.** Click the **+** button in the sidebar. Give it a name, point it at a project directory, pick a model, and choose a reasoning level if the model supports one.
3. **Start talking.** Describe the work at whatever level makes sense — a feature, a bug fix, a batch of refactors. The manager figures out the rest.

## A tip before you start

Spend your first few minutes telling the manager how you like to work. Your review process, your branching strategy, how you think about testing. This is not small talk. It's calibration. The better the manager understands your style, the better it orchestrates on your behalf.

After that, rate messages as you go. Thumbs up when the manager nails it, thumbs down when it misses. While Knowledge v2 is on, feedback can directly trigger a bounded capture check so durable preferences are not missed.
