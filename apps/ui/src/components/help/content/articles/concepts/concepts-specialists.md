Specialists are predefined worker types with their own name, model, and system prompt. Instead of the manager picking a generic worker for every task, it routes work to the right specialist.

## TargetSpace

Specialists are TargetSpace-aware. **Builder** and **Collaboration** each keep their own visible roster, so channel-only specialists do not leak into the Builder picker and Builder-only definitions do not appear in Collab views. Collaboration also supports channel-local specialists that shadow any global handle with the same name for that channel session.

Channel selection state is separate from the file-backed specialist definitions. The active channel remembers which specialists are selected, but the specialist files themselves still live on disk and can be reused or overridden independently.

## What a specialist includes

Each specialist has:

- A **display name** and color for identification in the UI
- A **model and reasoning level** tuned for its role
- A **system prompt** with instructions specific to that specialty
- A **"when to use"** description that tells the manager when to pick this specialist
- An optional **fallback model** if the primary is unavailable

For example, a "Frontend" specialist might use Claude Opus with instructions focused on React, accessibility, and visual consistency. A "Backend" specialist might use GPT Codex with instructions about API design and database patterns.

## How routing works

When the manager needs to spawn a worker, it reads the specialist roster and their "when to use" descriptions. It picks the specialist whose description best matches the task. The worker then runs with that specialist's model and prompt — no manual selection needed.

If specialists are disabled or none match, the manager falls back to its default model routing logic.

## Customization

Forge ships with builtin specialists that cover common roles. You can:

- **Edit** a builtin specialist to adjust its model, prompt, or routing rules
- **Create** new specialists for your specific workflow
- **Disable** specialists you do not need
- **Override per profile** — a specialist can behave differently for different projects

Manage specialists in **Settings > Specialists**. Profile-level overrides take precedence over global definitions.
