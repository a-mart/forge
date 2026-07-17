Forge delegates work by separating a worker's behavior from the model capability used to run it. This keeps the manager's decision small while allowing different providers and models behind the scenes.

## Behavior modes

The manager chooses the output contract that fits the task: General, Plan, Correctness Review, Design Review, or Research. General uses the normal worker prompt. The other modes use concise, editable builtin prompts.

## Execution policies

Support, Routine, and Deep choose the configured model, reasoning level, and fallback chain. The manager reasons about task difficulty and risk instead of selecting provider-specific model IDs. Mode defaults guide normal routing, but a bounded low-risk plan or review may still use Support.

## Custom specialists

A custom specialist is a complete saved domain-specific execution template with its own name, standalone prompt, model settings, fallback, and "when to use" guidance. It is an escape hatch for durable roles that do not fit the shared behavior modes. Managers select a custom specialist directly rather than combining it with a mode or policy.

## TargetSpace and scope

Behavior-mode prompts and custom specialists are TargetSpace-aware. Builder and Collaboration each receive the appropriate roster. Collaboration also supports channel-local definitions that shadow a selected global handle only for that channel.

Global definitions are file-backed and can be overridden per profile. Channel selection state is stored separately from the markdown definitions so definitions can be reused without coupling them to one channel.

## Routing and fallback

The manager receives a compact roster with available modes, the exact configured model behind each execution policy, and selectable custom specialists. Forge translates the request onto its existing tier/lens runtime, then handles availability fallback and worker-result attribution internally.

Configure this under **Settings → Delegation**. Profile-level overrides take precedence over global definitions.
