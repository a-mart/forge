Forge delegates work by separating manager posture, worker behavior, and the model route used to execute an assignment. This keeps each decision narrow while allowing different providers and models behind the scenes.

## Manager posture

Delegation-first is the default and prefers workers for substantive project work. Hands-on prefers one cohesive bounded manager-owned outcome, but still delegates when independent context, parallelism, diversity, or graph scheduling adds real value.

## Behavior modes

The manager chooses the output contract that fits the task: General, Plan, Correctness Review, Design Review, or Research. General uses the normal worker prompt. The other modes use concise, editable builtin prompts.

## Delegation rosters

A roster is a selectable catalog of named model routes. Each route contains concise use/avoid guidance, a primary model and reasoning level, an optional availability fallback, and an optional capability-escalation route. A roster maps each behavior mode to a baseline route. The manager normally omits `route` and lets that mapping apply; it names a route only when the current guidance clearly fits an obviously cheaper or stronger executor.

Rosters contain no worker personas, tools, permissions, ownership, or graph topology. Those concerns remain in behavior modes, specialists, and the work graph.

## Custom specialists

A custom specialist is a complete saved domain-specific execution template with its own name, standalone prompt, model settings, fallback, and "when to use" guidance. It is an escape hatch for durable roles that do not fit the shared behavior modes. Managers select a custom specialist directly rather than combining it with a mode or roster route.

## TargetSpace and scope

Behavior-mode prompts and custom specialists are TargetSpace-aware. Builder and Collaboration each receive the appropriate roster. Collaboration also supports channel-local definitions that shadow a selected global handle only for that channel.

Global definitions are file-backed and can be overridden per project. Channel selection state is stored separately from the markdown definitions so definitions can be reused without coupling them to one channel.

## Routing and fallback

The manager receives a compact specialist block plus a separate versioned `[delegationRoster]` context containing current routes and exact executors. Forge pins the resolved route and fallback on each attempt, then handles availability fallback and worker-result attribution internally. Capability escalation is a distinct retry decision.

Configure this under **Settings → Delegation**. Project-level overrides take precedence over global specialist definitions; roster selection resolves global → project → session.
