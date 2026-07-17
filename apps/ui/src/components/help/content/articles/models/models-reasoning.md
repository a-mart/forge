Reasoning level controls how much a model thinks before responding. Higher levels produce more careful, accurate output but take longer and cost more.

## The reasoning levels

- **None** — No extended reasoning. The model responds immediately with its first-pass answer. Use this for trivial tasks like listing files or echoing values. Not available on Anthropic models.
- **Low** — Minimal reasoning. Suitable for straightforward tasks where the answer is mostly obvious: simple edits, grep results, status checks.
- **Medium** — Moderate reasoning. Good for everyday coding work: writing functions, fixing bugs, making standard refactors. This is a solid default for most tasks.
- **High** — Extended reasoning. The model takes extra time to think through complex problems. Use this for multi-file changes, architecture decisions, code review, and anything where getting it wrong would be expensive.
- **Max (xhigh)** — Legacy maximum reasoning for older OpenAI Codex models. Reserve this for the hardest problems: large refactors, subtle bugs, security-sensitive code, architectural planning. Not available on Anthropic models.
- **Max** — Deepest GPT-5.6 Sol reasoning. Use this when Sol should spend maximum effort on one hard problem.
- **Ultra** — GPT-5.6 Sol's complex-task orchestration mode. Use this only for tasks that benefit from extra orchestration beyond normal deep reasoning.

## Provider differences

Anthropic models (Claude) normalize reasoning levels differently. Setting "none" on a Claude model behaves like "low," and "xhigh," "max," or "ultra" behave like "high." GPT-5.6 Sol supports low, medium, high, max, and ultra; GPT-5.6 Terra and Luna support low, medium, and high.

## How to choose

Start at **medium** or **high** and adjust from there. If workers rush complex work, raise the Deep policy's reasoning level. If simple delegated work is taking too long, lower Support or choose a faster model.

Worker reasoning is configured per execution policy or direct custom specialist in Settings > Delegation. You can also set it for the manager model when creating or editing a session.
