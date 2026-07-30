Reasoning level controls how much a model thinks before responding. Higher levels produce more careful, accurate output but take longer and cost more.

## The reasoning levels

- **None** — No extended reasoning. The model responds immediately with its first-pass answer. Use this for trivial tasks like listing files or echoing values. Available on Claude Opus 5 (disables thinking) and many non-Anthropic models; not available on Claude Fable 5 or older Opus/Sonnet models.
- **Low** — Minimal reasoning. Suitable for straightforward tasks where the answer is mostly obvious: simple edits, grep results, status checks.
- **Medium** — Moderate reasoning. Good for everyday coding work: writing functions, fixing bugs, making standard refactors. This is a solid default for most tasks.
- **High** — Extended reasoning. The model takes extra time to think through complex problems. Use this for multi-file changes, architecture decisions, code review, and anything where getting it wrong would be expensive.
- **Extra High (xhigh)** — A level above High when a model also exposes Max, including GPT-5.6 Sol, Claude Opus 5, and Claude Fable 5. Reserve this for the hardest problems: large refactors, subtle bugs, security-sensitive code, architectural planning. Models whose top level is xhigh continue to display this level as Max for compatibility.
- **Max** — Deepest effort when a model exposes Max; also the legacy label for xhigh-only models such as GPT-5.5. Use this when the model should spend maximum effort on one hard problem.
- **Ultra** — GPT-5.6 Sol's complex-task orchestration mode. Use this only for tasks that benefit from extra orchestration beyond normal deep reasoning.

## Provider differences

Anthropic reasoning is catalog-driven per model, not one global clamp. Claude Opus 5 supports none, low, medium, high, xhigh (shown as Extra High), and max (default high); Forge `none` disables thinking. Claude Fable 5 supports low, medium, high, xhigh (shown as Extra High), and max, but not none. Older Opus and Sonnet models still clamp unsupported levels: `none` behaves like `low`, and `xhigh`, `max`, or `ultra` behave like `high`. GPT-5.6 Sol supports low, medium, high, xhigh (shown as Extra High), max, and ultra; GPT-5.6 Terra and Luna support low, medium, and high.

## How to choose

Start at **medium** or **high** and adjust from there. If a worker route rushes complex work, raise that route's reasoning level or point its capability escalation at a stronger route. If simple delegated work is taking too long, lower its normal route or choose a faster model.

Worker reasoning is configured per delegation route or direct custom specialist in Settings > Delegation. You can also set it for the manager model when creating or editing a session.
