Forge uses a specialist system to route different kinds of work to different models. The manager decides which specialist to use, and each specialist has its own model configuration.

## Manager model

The manager model handles orchestration: reading your messages, deciding what to do, breaking work into tasks, and coordinating specialist workers. The manager does not write code directly. Pick a capable model here — it affects the quality of task planning and delegation.

You can set the profile default from the profile header with **Change Default Model**, override a single session with **Override Session Model**, or switch a session back to inherited state with **Use Project Default**. In eligible Builder manager sessions, the compact model pill beside **Send** shows the effective model and reasoning level and opens the same **Session Model** dialog. Choosing **Use Project Default** clears the session override so it inherits future project-default changes again. New Project/Create Project uses the same model-aware reasoning selector, with unsupported options hidden and defaults applied when reasoning is omitted.

## Specialist routing

When the manager spawns a worker, it picks a specialist based on the task. Each specialist has:

- A **primary model** and reasoning level — the default for that specialist's work.
- An optional **fallback model** — used when the primary model is unavailable or rate-limited.
- A **"when to use" description** — tells the manager which tasks to send to this specialist.

For example, the builtin Backend Engineer uses GPT-5.5 at high reasoning. The builtin Code Reviewer also uses GPT-5.5 at high reasoning. The Frontend Engineer uses GPT-5.5 at medium reasoning. The Architect uses GPT-5.5 at medium reasoning. The Planner uses GPT-5.5 at medium reasoning. The Scout uses GPT-5.4 Mini at low reasoning for quick exploration.

## Fallback behavior

If a specialist's primary model fails (rate limit, outage, credentials issue), Forge falls back to the specialist's fallback model if one is configured. If no fallback is set, the task fails and the manager reports the error.

Set fallbacks for critical specialists to avoid interruptions during long-running work.

## Customizing per profile

Specialist model assignments can be overridden per profile. Open Settings > Specialists, pick a profile scope, and customize any specialist. Profile overrides take priority over global defaults without affecting other profiles.

This is useful when different projects need different model routing — for example, a frontend-heavy project might upgrade the Frontend Engineer to max reasoning while keeping the global default at high.
