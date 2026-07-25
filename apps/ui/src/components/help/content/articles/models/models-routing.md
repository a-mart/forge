Forge separates manager ownership, worker behavior, and worker model selection. The manager decides whether delegation helps, chooses a behavior mode for delegated work, and normally lets the selected roster resolve `route: auto`. Forge then pins the route, model, reasoning, fallback, and saved prompt for that attempt.

## Manager model

The manager model owns routing, task framing, coordination, and acceptance. Pick a model capable of making good delegation decisions for the project. You can set a project default, override one session, or return a session to the project default.

You can set the project default from the project header with **Change Default Model**, override a single session with **Override Session Model**, or switch a session back to inherited state with **Use Project Default**. In eligible Builder manager sessions, the compact model pill beside **Send** shows the effective model and reasoning level and opens the same **Session Model** dialog. Choosing **Use Project Default** clears the session override so it inherits future project-default changes again. New Project/Create Project uses the same model-aware reasoning selector, with unsupported options hidden and defaults applied when reasoning is omitted.

## Manager posture

Delegation-first is the default posture and prefers workers for substantive project work. Hands-on asks the manager to own one cohesive bounded outcome directly while retaining delegation for useful parallelism, isolation, model diversity, independent review, or work-graph scheduling.

Set a project default or use the coordination control beside Send for a session override. Posture is part of the manager system prompt. Changing it mid-session replaces the runtime before the next turn and may cause one prompt-cache miss.

## Worker behavior and model routes

Behavior mode controls the output contract: General, Plan, Correctness Review, Design Review, or Research. A delegation roster controls model capability and cost. Each roster contains named routes with concise use/avoid guidance and automatic mappings from behavior modes.

Most assignments use `route: auto`. A manager chooses a named route only when its guidance clearly applies. Graph size, fan-in, planning, research, or review alone does not justify a stronger executor.

The roster selection order is global default → project default → session override. The manager receives the selected roster as compact dynamic context, outside the stable system-prompt prefix. Switching rosters therefore does not require a manager runtime replacement. Running attempts stay pinned; only future attempts see the new roster.

## Custom specialists

A saved custom specialist is an escape hatch for a durable domain-specific prompt or model assignment. It is selected directly and is not combined with a behavior mode or roster route.

## Fallback behavior

Each route and direct custom specialist can define an availability fallback. Recoverable provider or model availability failures are handled inside the runtime before an error reaches the manager. Fallback does not imply greater capability.

A route may separately name a capability-escalation route for a later attempt after evidence that the original executor was insufficient. The resolved worker descriptor and usage telemetry retain the concrete roster, route, model, and specialist attribution.

## Compatibility

Existing worker descriptors and stored tier/lens configuration remain supported. Until delegation rosters are first saved, Forge derives the Balanced roster from the five stored tier bindings. New manager delegation uses routes rather than tier or execution-policy names.
