Forge separates manager ownership, worker behavior, and worker model selection. The manager decides whether delegation helps, chooses a behavior mode for delegated work, and normally omits `route` so the selected roster applies its baseline worker profile. Forge then pins the profile's route, model, reasoning, fallback, and saved prompt for that attempt.

## Manager model

The manager model owns routing, task framing, coordination, and acceptance. Pick a model capable of making good delegation decisions for the project. You can set a project default, override one session, or return a session to the project default.

You can set the project default from the project header with **Change Default Model**, override a single session with **Override Session Model**, or switch a session back to inherited state with **Use Project Default**. In eligible Builder manager sessions, the compact model pill beside **Send** shows the effective model and reasoning level and opens a compact nested menu for either choice. Choosing **Use Project Default** clears the session override so it inherits future project-default changes again. New Project/Create Project uses the same model-aware reasoning selector, with unsupported options hidden and defaults applied when reasoning is omitted.

## Work mode

Delegate first is the default work mode and prefers workers for substantive project work. Hands-on asks the manager to own one cohesive bounded outcome directly while retaining delegation for useful parallelism, isolation, model diversity, independent review, or work-graph scheduling.

Set a project default or use the work-mode control beside Send for a session override. Work mode is part of the manager system prompt. Changing it mid-session replaces the runtime before the next turn and may cause one prompt-cache miss.

## Worker behavior and profiles

Behavior mode controls the output contract: General, Plan, Correctness Review, Design Review, or Research. A worker roster controls model capability and cost. Each roster contains named worker profiles with concise use/avoid guidance and automatic mappings from behavior modes. The manager's `route` argument selects a profile by its stable ID.

Omitting `route` uses the roster's baseline mapping for the selected behavior mode; it does not infer task complexity. A manager names a profile's route when its current guidance clearly fits an obviously cheaper or stronger executor. Capability escalation is a separate later-attempt decision after evidence that the selected profile was inadequate. Graph size, fan-in, planning, research, or review alone does not justify a stronger executor.

The roster selection order is global default → project default → session override. The manager receives the selected roster as compact dynamic context, outside the stable system-prompt prefix. Switching rosters therefore does not require a manager runtime replacement. Running attempts stay pinned; only future attempts see the new roster.

## Custom specialists

A saved custom specialist is an escape hatch for a durable domain-specific prompt or model assignment. It is selected directly and is not combined with a behavior mode or roster route.

## Fallback behavior

Each worker profile and direct custom specialist can define an availability fallback. Recoverable provider or model availability failures are handled inside the runtime before an error reaches the manager. Fallback does not imply greater capability.

A worker profile may separately name an escalation profile for a later attempt after evidence that the original executor was insufficient. The resolved worker descriptor and usage telemetry retain the concrete roster, route, model, and specialist attribution.

## Compatibility

Existing worker descriptors and stored tier/lens configuration remain supported. Until delegation rosters are first saved, Forge derives the Balanced roster from the five stored tier bindings. New manager delegation uses routes rather than tier or execution-policy names.
