Every model choice is a tradeoff between cost, speed, and output quality. Here is a practical breakdown.

## Fast and cheap

Use these for high-volume or simple tasks where speed matters more than depth.

- **GPT-5.4 Nano** — Fastest, cheapest. Good for file reads, searches, and quick lookups.
- **GPT-5.4 Mini** — Fast with decent quality. The Scout specialist uses this by default for exploration and information gathering.
- **GPT-5.5 at low reasoning** — A fast, cheaper Codex option for bulk formatting, simple code generation, and lightweight review. Good for doc-heavy and simple specialist work.

## Balanced

These work well for everyday development tasks.

- **GPT-5.5** — The standard full coding model. Good balance of speed and quality for implementation work.
- **GPT-5.5 at low reasoning** — A practical middle ground for documentation tasks where higher-reasoning models would be wasteful.
- **Grok 4.6 at low reasoning** — A lighter native xAI choice for manager or specialist tasks.
- **Cursor Grok 4.5 Fast** — Cursor SDK fast-pool variant for Grok 4.5 sessions.

## Thorough but expensive

Reserve these for work where quality matters most.

- **GPT-5.5** — OpenAI's strongest full coding model. Best for complex backend work and multi-file refactors.
- **GPT-5.5 at medium reasoning** — The strongest Codex default for specialist work. Best for frontend work, nuanced code review, and tasks that need careful judgment.
- **Grok 4.6 at high reasoning** — The native xAI default configured for more thorough manager or specialist work.
- **Cursor Grok 4.5** — Cursor SDK Grok 4.5 for high-quality Cursor runtime sessions; the fast variant trades higher price for lower latency.

## Reasoning level adds cost too

Higher reasoning levels multiply both cost and latency on top of the base model cost. A GPT-5.4 task at "max" reasoning costs significantly more than the same task at "low." Adjust reasoning level alongside model choice — sometimes dropping from max to high saves time without noticeably affecting quality.

## General advice

Match the model to the task. Use cheap models for exploration, mid-range models for standard work, and expensive models for the tasks that actually need them. The specialist system makes this automatic once configured.
