Forge separates manager ownership, task instructions, and worker model selection. The manager decides whether delegation helps, chooses a task type for delegated work, and normally omits `route` so the selected roster applies its baseline execution profile. Forge then pins the profile's route, model, reasoning, fallback, and saved prompt for that attempt.

## Manager model

The manager model owns routing, task framing, coordination, and acceptance. Pick a model capable of making good delegation decisions for the project. You can set a project default, override one session, or return a session to the project default.

You can set the project default from the project header with **Change Default Model**, override a single session with **Override Session Model**, or switch a session back to inherited state with **Use Project Default**. In eligible Builder manager sessions, the compact model pill beside **Send** shows the effective model and reasoning level and opens a compact nested menu for either choice. Choosing **Use Project Default** clears the session override so it inherits future project-default changes again. New Project/Create Project uses the same model-aware reasoning selector, with unsupported options hidden and defaults applied when reasoning is omitted.

## Work mode

Delegate first is the default work mode and prefers workers for substantive project work. Hands-on asks the manager to own one cohesive bounded outcome directly while retaining delegation for useful parallelism, isolation, model diversity, independent review, or work-graph scheduling.

Set a project default or use the work-mode control beside Send for a session override. Work mode is part of the manager system prompt. Changing it mid-session replaces the runtime before the next turn and may cause one prompt-cache miss.

## Task types and execution profiles

Task type controls the instructions and output contract: Build & Execute, Planning, Correctness Review, Design Review, or Research. A worker roster controls model capability and cost. Each roster contains named execution profiles with concise use/avoid guidance and automatic mappings from task types. The manager's internal `route` argument selects a profile by its stable ID.

Omitting `route` uses the roster's baseline mapping for the selected task type; it does not infer task complexity. A manager names a profile's route when its current guidance clearly fits an obviously cheaper or stronger executor. Capability escalation is a separate later-attempt decision after evidence that the selected profile was inadequate. Graph size, fan-in, planning, research, or review alone does not justify a stronger executor.

The roster selection order is global default → project default → session override. The manager receives the selected roster as compact dynamic context, outside the stable system-prompt prefix. Switching rosters therefore does not require a manager runtime replacement. Running attempts stay pinned; only future attempts see the new roster.

Native xAI routing also follows the effective credential. `grok-4.5` remains the family default and is available to normal manager create, change, and exact per-session override selectors when xAI auth is configured. Authenticated OAuth discovery can add `grok-build` and `grok-composer-2.5-fast` only for entitled accounts; these remain OAuth-only worker/specialist choices excluded from normal manager selectors. Switching to API-key auth hides the entitlement models and rejects stale selections before a provider request. Losing entitlement or failing discovery removes them from refreshed catalog, projection, and selector results. The xAI Composer ID is separate from Cursor SDK `composer-2.5`. xAI/Grok is not eligible for manager compaction.

## Custom specialists

A saved custom specialist is an escape hatch for a durable domain-specific prompt or model assignment. It is selected directly and is not combined with a task type or roster route.

## Fallback behavior

Each execution profile and direct custom specialist can define an availability fallback. Recoverable provider or model availability failures are handled inside the runtime before an error reaches the manager. Fallback does not imply greater capability.

An execution profile may separately name an escalation profile for a later attempt after evidence that the original executor was insufficient. The resolved worker descriptor and usage telemetry retain the concrete roster, route, model, and specialist attribution.

## Compatibility

Existing worker descriptors and stored tier/lens configuration remain supported. Until delegation rosters are first saved, Forge derives the Balanced roster from the five stored tier bindings. New manager delegation uses execution-profile routes rather than tier or execution-policy names.
