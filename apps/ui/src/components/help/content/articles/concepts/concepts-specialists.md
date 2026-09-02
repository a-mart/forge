Forge delegates work through rosters of complete specialists. Work mode decides who normally owns an outcome. A specialist combines a task type and its instructions with the model, reasoning, use/avoid guidance, fallback, and escalation behavior used to run the assignment.

## Work mode

Delegate first is the default and prefers workers for substantive project work. Adaptive chooses ownership outcome by outcome based on context continuity and the real value of delegation. Hands-on prefers one cohesive bounded manager-owned outcome, but still delegates when independent context, parallelism, diversity, or graph scheduling adds real value.

## Task types

The manager chooses the instructions and output contract that fit the task: Build & Execute, Planning, Correctness Review, Design Review, or Research. Build & Execute uses the normal worker prompt. The other task types use concise, editable builtin prompts.

## Rosters

A roster is a reusable team of specialists. One specialist is the default for each task type, and a roster may contain alternatives for the same task when a cheaper, independent, or stronger executor is useful. The manager normally uses the task default and names an alternative only when its guidance clearly fits.

Internally, Forge retains stable task-mode and route identifiers for persistence and replay. Those compatibility fields are not separate concepts users need to configure.

## Custom specialists

A custom specialist is a complete saved domain-specific execution template with its own name, standalone prompt, model settings, fallback, and "when to use" guidance. It is an escape hatch for durable roles that do not fit the shared task types. Managers select a custom specialist directly rather than combining it with a mode or roster route.

## TargetSpace and scope

Task-instruction prompts and custom specialists are TargetSpace-aware. Builder and Collaboration each receive the appropriate roster. Collaboration also supports channel-local definitions that shadow a selected global handle only for that channel.

Global task instructions are file-backed and can be overridden per project. Channel selection state is stored separately from the markdown definitions so definitions can be reused without coupling them to one channel.

## Routing and fallback

The manager receives a compact instruction/custom-specialist block plus a separate versioned `[delegationRoster]` context containing the active roster specialists. Forge pins the resolved specialist, model, and fallback on each attempt, then handles availability fallback and worker-result attribution internally. Capability escalation is a distinct new-attempt decision.

Configure this under **Settings → Delegation**. Project-level task-instruction overrides take precedence over global definitions; roster selection resolves global → project → session.
