Forge delegates work by separating work mode, task instructions, and the execution profile used to run an assignment. The delegation tool identifies the task type with `mode` and the profile with its internal `route` field. This keeps each decision narrow while allowing different providers and models behind the scenes.

## Work mode

Delegate first is the default and prefers workers for substantive project work. Hands-on prefers one cohesive bounded manager-owned outcome, but still delegates when independent context, parallelism, diversity, or graph scheduling adds real value.

## Task types

The manager chooses the instructions and output contract that fit the task: Build & Execute, Planning, Correctness Review, Design Review, or Research. Build & Execute uses the normal worker prompt. The other task types use concise, editable builtin prompts.

## Worker rosters

A worker roster is a selectable catalog of named execution profiles. Each profile contains concise use/avoid guidance, a primary model and reasoning level, an optional availability fallback, and an optional escalation profile. A roster maps each task type to a baseline profile. The manager normally omits `route` and lets that mapping apply; it names a profile's route only when the current guidance clearly fits an obviously cheaper or stronger executor.

Execution profiles contain no saved persona, task prompt, tools, permissions, ownership, or graph topology. Task instructions, specialists, and the work graph own those concerns.

## Custom specialists

A custom specialist is a complete saved domain-specific execution template with its own name, standalone prompt, model settings, fallback, and "when to use" guidance. It is an escape hatch for durable roles that do not fit the shared task types. Managers select a custom specialist directly rather than combining it with a mode or roster route.

## TargetSpace and scope

Task-instruction prompts and custom specialists are TargetSpace-aware. Builder and Collaboration each receive the appropriate roster. Collaboration also supports channel-local definitions that shadow a selected global handle only for that channel.

Global definitions are file-backed and can be overridden per project. Channel selection state is stored separately from the markdown definitions so definitions can be reused without coupling them to one channel.

## Routing and fallback

The manager receives a compact specialist block plus a separate versioned `[delegationRoster]` context containing current execution profiles and exact executors. Forge pins the resolved route and fallback on each attempt, then handles availability fallback and worker-result attribution internally. Capability escalation is a distinct retry decision.

Configure this under **Settings → Delegation**. Project-level overrides take precedence over global specialist definitions; roster selection resolves global → project → session.
