Reasoning level controls how much a model thinks before responding. Higher levels produce more careful, accurate output but take longer and cost more.

## The five levels

- **None** — No extended reasoning. The model responds immediately with its first-pass answer. Use this for trivial tasks like listing files or echoing values. Not available on Anthropic models.
- **Low** — Minimal reasoning. Suitable for straightforward tasks where the answer is mostly obvious: simple edits, grep results, status checks.
- **Medium** — Moderate reasoning. Good for everyday coding work: writing functions, fixing bugs, making standard refactors. This is a solid default for most tasks.
- **High** — Extended reasoning. The model takes extra time to think through complex problems. Use this for multi-file changes, architecture decisions, code review, and anything where getting it wrong would be expensive. This is the default for most specialists.
- **Max (xhigh)** — Maximum reasoning. The model spends the most time analyzing before responding. Reserve this for the hardest problems: large refactors, subtle bugs, security-sensitive code, architectural planning. Not available on Anthropic models.

## Provider differences

Anthropic models (Claude) normalize reasoning levels differently. Setting "none" on a Claude model behaves like "low," and "max" behaves like "high." The five-level scale works fully on OpenAI models.

## How to choose

Start at **medium** or **high** and adjust from there. If you notice a specialist rushing through complex work, raise its reasoning level. If a task is simple and the specialist is taking too long, lower it.

The reasoning level is set per specialist in Settings > Specialists. You can also set it for the manager model when creating or editing a session.
