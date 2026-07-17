Forge separates manager orchestration from worker model selection. The manager understands the request, decides whether delegation helps, and describes the worker's behavior mode and execution policy. Forge then resolves the configured model, reasoning level, fallback, and saved prompt.

## Manager model

The manager model owns routing, task framing, coordination, and acceptance. Pick a model capable of making good delegation decisions for the project. You can set a profile default, override one session, or return a session to the project default.

## Worker behavior and capability

Behavior mode controls the output contract: General, Plan, Correctness Review, Design Review, or Research. Execution policy controls model capability and cost:

- **Support** maps to the stored `fast` configuration.
- **Routine** maps to the stored `standard` configuration.
- **Deep** maps to the stored `deep` configuration.

This lets one project use a fast, inexpensive model for clear work and a stronger model for complex abstractions without teaching the manager provider-specific model IDs. The exact models remain visible and editable under **Settings → Delegation → Execution Policies**.

Plan and review modes default to Deep and cannot use Support. Research defaults to Support. General work defaults to Routine. The manager may choose a different valid policy when task difficulty or risk warrants it.

## Custom specialists

A saved custom specialist is an escape hatch for a durable domain-specific prompt or model assignment. It is selected directly and is not combined with a behavior mode or execution policy.

## Fallback behavior

Each execution policy and direct custom specialist can define a fallback model. Recoverable availability failures are handled inside the runtime before an error reaches the manager. The resolved worker descriptor and usage telemetry retain the concrete model and specialist attribution.

## Compatibility

Existing worker descriptors and stored tier/lens configuration remain supported. The older Light and Max tiers are preserved on disk for compatibility, but new manager delegation uses Support, Routine, and Deep.
