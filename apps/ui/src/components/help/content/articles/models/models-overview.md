Forge connects to multiple AI providers and models. Each model has different strengths — some are fast and cheap, others are slower but produce better results on hard problems. You pick a model for the manager session and configure roster specialists for delegated work.

## What matters when choosing a model

Three things affect the quality and speed of what you get back:

- **The model itself.** GPT-6 Astra is the most capable Codex option. GPT-5.6 and GPT-5.5 remain selectable families, with GPT-5.5 unchanged as the Forge default. Smaller variants like GPT-5.6 Luna are faster and cheaper but less thorough on complex tasks.
- **The reasoning level.** Higher reasoning means the model spends more time thinking before answering. This improves accuracy on hard problems but costs more and takes longer.
- **The task.** A quick file read does not need the same model as a multi-file refactor. Match the model to the work.

## Where models get configured

- **Manager model:** Set when you create a session or change it in Settings. This controls the main orchestration agent.
- **Manager selectors:** The create-session flow, change-default flow, and per-session override dialog can choose supported checked-in catalog models side by side. Family presets still work as a compatibility layer, but the selectors are model-aware first. User-added OpenRouter rows use a separate exact-ID manager path rather than a family or preset.
- **Roster specialists:** Each specialist in a roster combines a task type with its model and reasoning level. Different rosters can optimize for speed, cost, provider diversity, or deeper capability.
- **Fallback models:** Roster specialists and direct custom specialists can define a fallback model that activates if the primary is unavailable or rate-limited.
- **User-added OpenRouter models:** These start with manager access off. A model needs live-verified tool support, an explicit per-model **Manager agents** opt-in, and a configured OpenRouter key before an exact manager selection can use it.

## Model-specific instructions

Each model card in Settings > Models has a "Model-specific instructions" field. User-authored instructions are injected into the manager prompt when that model is active. Forge does not add built-in model-specific instructions. Leave the field empty to use only the manager prompt, or add a narrow instruction when a particular model needs different behavior. Reset removes the custom instructions.
