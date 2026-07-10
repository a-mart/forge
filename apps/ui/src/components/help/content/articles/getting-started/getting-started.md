You describe what needs to happen. Forge breaks it down, spins up workers, and runs things in parallel while you focus on the next problem.

## How it works

You talk to a **manager** agent. The manager reads your instructions, decides what can run concurrently, and dispatches **workers** to do the actual work. Each worker operates in its own git worktree so nothing collides. Session history is durable on disk, and cached replay views rebuild from canonical transcript history when needed. You watch progress in real time from this dashboard, or walk away and check in later.

One conversation can have dozens of workers running at once. You don't manage them individually — the manager handles coordination, merging, and status tracking.

## What to do first

1. **Add your credentials.** Open Settings and connect your OpenAI or Anthropic account. Forge needs at least one provider to run agents.
2. **Create a manager.** Click the **+** button in the sidebar. Give it a name, point it at a project directory, pick a model, and choose a reasoning level if the model supports one.
3. **Start talking.** Describe the work at whatever level makes sense — a feature, a bug fix, a batch of refactors. The manager figures out the rest.

## A tip before you start

Spend your first few minutes telling the manager how you like to work. Your review process, your branching strategy, how you think about testing. This is not small talk. It's calibration. The better the manager understands your style, the better it orchestrates on your behalf.

After that, rate messages as you go. Thumbs up when the manager nails it, thumbs down when it misses. While Knowledge v2 is on, feedback can directly trigger a bounded capture check so durable preferences are not missed.
