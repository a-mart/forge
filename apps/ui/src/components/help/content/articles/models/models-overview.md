Forge connects to multiple AI providers and models. Each model has different strengths — some are fast and cheap, others are slower but produce better results on hard problems. You pick a model for the manager session and configure worker profiles for delegated work.

## What matters when choosing a model

Three things affect the quality and speed of what you get back:

- **The model itself.** GPT-5.5 and GPT-5.4 are the most capable models. Smaller variants like GPT-5.4 Mini or GPT-5.4 Nano are faster and cheaper but less thorough on complex tasks.
- **The reasoning level.** Higher reasoning means the model spends more time thinking before answering. This improves accuracy on hard problems but costs more and takes longer.
- **The task.** A quick file read does not need the same model as a multi-file refactor. Match the model to the work.

## Where models get configured

- **Manager model:** Set when you create a session or change it in Settings. This controls the main orchestration agent.
- **Manager selectors:** The create-session flow, change-default flow, and per-session override dialog can choose concrete models side by side. Family presets still work as a compatibility layer, but the selectors are model-aware first.
- **Worker profiles:** Each profile in a Worker Roster has a model and reasoning level. Different rosters can optimize for speed, cost, provider diversity, or deeper capability without changing worker behavior.
- **Fallback models:** Worker profiles and direct custom specialists can define a fallback model that activates if the primary is unavailable or rate-limited.

## Model-specific instructions

Each model card in Settings > Models has a "Model-specific instructions" field. User-authored instructions are injected into the manager prompt when that model is active. Forge does not add built-in model-specific instructions. Leave the field empty to use only the manager prompt, or add a narrow instruction when a particular model needs different behavior. Reset removes the custom instructions.
