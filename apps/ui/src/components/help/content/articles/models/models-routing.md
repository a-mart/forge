Forge separates manager orchestration from worker model selection. The manager understands the request, decides whether delegation helps, and describes the worker's behavior mode and execution policy. Forge then resolves the configured model, reasoning level, fallback, and saved prompt.

## Manager model

The manager model owns routing, task framing, coordination, and acceptance. Pick a model capable of making good delegation decisions for the project. You can set a profile default, override one session, or return a session to the project default.

You can set the profile default from the profile header with **Change Default Model**, override a single session with **Override Session Model**, or switch a session back to inherited state with **Use Project Default**. In eligible Builder manager sessions, the compact model pill beside **Send** shows the effective model and reasoning level and opens the same **Session Model** dialog. Choosing **Use Project Default** clears the session override so it inherits future project-default changes again. New Project/Create Project uses the same model-aware reasoning selector, with unsupported options hidden and defaults applied when reasoning is omitted.

## Worker behavior and capability

Behavior mode controls the output contract: General, Plan, Correctness Review, Design Review, or Research. Execution policy controls model capability and cost:

- **Support** maps to the stored `fast` configuration.
- **Routine** maps to the stored `standard` configuration.
- **Deep** maps to the stored `deep` configuration.

This lets one project use a fast, inexpensive model for clear work and a stronger model for complex abstractions without teaching the manager provider-specific model IDs. The exact models remain visible and editable under **Settings → Delegation → Execution Policies**.

Plan and review modes default to Deep, Research defaults to Support, and General work defaults to Routine. These defaults are guidance rather than capability floors: the manager may use Support for any bounded mode and raise the policy when task difficulty, ambiguity, or risk warrants it.

Native xAI routing also follows the effective credential. `grok-4.5` remains the family default, while authenticated OAuth discovery can add `grok-build` and `grok-composer-2.5-fast` only for entitled accounts. Switching to API-key auth hides these models and rejects stale selections before a provider request. Losing entitlement or failing discovery removes them from refreshed catalog, projection, and selector results. The xAI Composer ID is separate from Cursor SDK `composer-2.5`.

## Custom specialists

A saved custom specialist is an escape hatch for a durable domain-specific prompt or model assignment. It is selected directly and is not combined with a behavior mode or execution policy.

## Fallback behavior

Each execution policy and direct custom specialist can define a fallback model. Recoverable availability failures are handled inside the runtime before an error reaches the manager. The resolved worker descriptor and usage telemetry retain the concrete model and specialist attribution.

## Compatibility

Existing worker descriptors and stored tier/lens configuration remain supported. The older Light and Max tiers are preserved on disk for compatibility, but new manager delegation uses Support, Routine, and Deep.
