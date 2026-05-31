Forge connects to multiple AI providers and models. Each model has different strengths — some are fast and cheap, others are slower but produce better results on hard problems. You pick a model for your manager session and for each specialist worker.

## What matters when choosing a model

Three things affect the quality and speed of what you get back:

- **The model itself.** GPT-5.5 and GPT-5.4 are the most capable models. Smaller variants like GPT-5.4 Mini or GPT-5.4 Nano are faster and cheaper but less thorough on complex tasks.
- **The reasoning level.** Higher reasoning means the model spends more time thinking before answering. This improves accuracy on hard problems but costs more and takes longer.
- **The task.** A quick file read does not need the same model as a multi-file refactor. Match the model to the work.

## Where models get configured

- **Manager model:** Set when you create a session or change it in Settings. This controls the main orchestration agent.
- **Manager selectors:** The create-session flow, change-default flow, and per-session override dialog can choose concrete models side by side. Family presets still work as a compatibility layer, but the selectors are model-aware first.
- **Specialist models:** Each specialist worker has its own model and reasoning level. Configure these in Settings > Specialists. Specialists can use the Pi-proxied Anthropic provider, the native Claude SDK provider, or the native Cursor SDK provider independently.
- **Fallback models:** Specialists can define a fallback model that kicks in if the primary is unavailable or rate-limited.

## Model-specific instructions

Each model card in Settings > Models has a "Model-specific instructions" field. These are prompt instructions automatically injected into the manager prompt when that model is active. Built-in defaults exist for GPT-5 and Claude families. You can override, clear (to suppress defaults), or leave unchanged to use the built-in.

Start with the defaults. Adjust when you notice a task is too slow, too expensive, or not producing good enough results.
