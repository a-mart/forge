Forge separates manager ownership from worker configuration. The manager decides whether delegation helps, then chooses from the complete specialists in the active delegation preset. Each specialist combines its task instructions with the model, reasoning, fallback, and escalation behavior used for the attempt.

## Manager model

The manager model owns routing, task framing, coordination, and acceptance. Pick a model capable of making good delegation decisions for the project. You can set a project default, override one session, or return a session to the project default.

For a local Builder project, use **Project Settings → Default model → Change** to set the project default and supported reasoning level. The existing project-header **Change Default Model** shortcut remains available. Override a single session with **Override Session Model**, or switch a session back to inherited state with **Use Project Default**. In eligible Builder manager sessions, the compact model pill beside **Send** shows the effective model and reasoning level and opens a compact nested menu for either choice. Choosing **Use Project Default** clears the session override so it inherits future project-default changes again. New Project/Create Project uses the same model-aware reasoning selector, with unsupported options hidden and defaults applied when reasoning is omitted.

## Work mode

Delegate first is the default work mode and prefers workers for substantive project work. Hands-on asks the manager to own one cohesive bounded outcome directly while retaining delegation for useful parallelism, isolation, model diversity, independent review, or work-graph scheduling.

Set a project default or use the work-mode control beside Send for a session override. Work mode is part of the manager system prompt. Changing it mid-session replaces the runtime before the next turn and may cause one prompt-cache miss.

## Task types, presets, and roster specialists

Task type controls the instructions and output contract: Build & Execute, Planning, Correctness Review, Design Review, or Research. A delegation preset is a roster of complete specialists. Every specialist owns one task type, its use/avoid guidance, model capability, reasoning, fallback, and escalation. One specialist is the default for each task type, and a roster may include alternatives for the same task.

The manager normally lets Forge use the task's default specialist. It names an alternative when that specialist's guidance clearly fits a cheaper, independent, or stronger executor. Capability escalation is a separate later-attempt decision after evidence that the first specialist was inadequate. Graph size, fan-in, planning, research, or review alone does not justify a stronger executor.

The preset selection order is global default → project default → session override. The manager receives the selected preset as compact dynamic context, outside the stable system-prompt prefix. Switching presets therefore does not require a manager runtime replacement. Running attempts stay pinned; only future attempts see the new preset.

Native xAI routing also follows the effective credential. `grok-4.6` is the family default, `grok-4.5` remains an explicit variant, and both are available to normal manager create, change, and exact per-session override selectors when xAI auth is configured. Authenticated OAuth discovery can add `grok-build` and `grok-composer-2.5-fast` only for entitled accounts; these remain OAuth-only worker/specialist choices excluded from normal manager selectors. Switching to API-key auth hides the entitlement models and rejects stale selections before a provider request. Losing entitlement or failing discovery removes them from refreshed catalog, projection, and selector results. The xAI Composer ID is separate from Cursor SDK `composer-2.5`. xAI/Grok is not eligible for manager compaction.

### User-added OpenRouter manager models

OpenRouter rows follow a stricter exact-model path than Forge's built-in families. Forge derives `supportsTools` only from live OpenRouter metadata when adding a model and when OpenRouter Settings loads and reconciles stored exact IDs; request-body capability claims are ignored. Settings reconciliation automatically refreshes matched legacy rows. The backend must have live-verified `supportsTools: true`; unmatched or unrefreshable rows, an absent field, or `supportsTools: false` remain non-manager and fail closed until a later live verification. Reconciliation refreshes only `supportsTools`; it does not enable manager agents or mutate the exact row's default-off `managerEnabled` opt-in. Each verified row remains manager-disabled by default. Enable only that model's **Manager agents** setting with `managerEnabled: true` under `openrouter:<exact-model-id>`; the override does not create a family, preset, or alias.

A manager create, change, or session override must name `{ provider: "openrouter", modelId: "<exact-model-id>" }`, and an OpenRouter API key must be configured. Unknown, unverified, disabled, credential-less, or retired IDs fail closed rather than falling back to another provider. Removing a row clears its manager override; retired OpenRouter IDs remain rejected rather than migrated across providers. Worker/specialist use of a retained legacy row is a separate path and does not make it manager-eligible.

OpenRouter manager eligibility is also separate from compaction: OpenRouter remains outside the supported compaction provider list and its models are not compaction choices.

## Custom specialists

A saved custom specialist is an escape hatch for a durable domain-specific prompt or model assignment. It is selected directly and is not combined with a task type or roster route.

## Fallback behavior

Each roster specialist and direct custom specialist can define an availability fallback. Recoverable provider or model availability failures are handled inside the runtime before an error reaches the manager. Fallback does not imply greater capability.

A roster specialist may separately name another specialist for a fresh attempt after evidence that the original executor was insufficient. The resolved worker descriptor and usage telemetry retain the concrete preset, internal route, model, and specialist attribution.

## Compatibility

Existing worker descriptors and stored tier/lens configuration remain supported. Until delegation presets are first saved, Forge derives the Balanced preset from the stored tier bindings. The persisted fields remain `roster`, `route`, and `mode` for compatibility, while the UI presents presets and complete roster specialists.
