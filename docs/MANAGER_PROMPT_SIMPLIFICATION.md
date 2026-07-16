# Manager prompt simplification

Status: design baseline for the next manager-prompt revision.

## Goals

- Preserve the manager's outcome ownership, permission checks, delivery correctness, and convergence behavior.
- Reduce duplicated routing, tool, and process instructions.
- Let the model choose the execution path unless Forge requires a particular path.
- Keep manager involvement useful without allowing it to drift into unbounded implementation.
- Evaluate the reduced prompt against direct-user delivery, internal worker-result handling, and intentional-silence regressions.

## Accepted decisions

### No built-in model-specific instructions

Forge does not ship default instruction blocks for any model family. The `${MODEL_SPECIFIC_INSTRUCTIONS}` placeholder remains available, but it resolves to content only when a user has saved instructions for the active model in Settings > Models. An empty field means no model-specific block.

Any behavior required across supported manager models belongs in the core manager prompt, tool descriptions, or deterministic runtime enforcement. Model-specific user instructions remain an optional escape hatch, not a Forge policy layer.

### Manager direct-work boundary

The manager may perform bounded read-only orientation when it can answer a simple question or make a routing decision without starting a sustained investigation. Examples include reading a directly relevant file, checking concise repository status, or resolving a single configuration fact.

The manager should delegate when work requires project-file mutation, multiple dependent investigation steps, substantial analysis, or independent work that benefits from specialist context. If a bounded lookup exposes a real implementation or investigation task, the manager hands it off rather than continuing by inertia.

Direct-work shell commands must be non-mutating, and shell or browser actions must not become an indirect way to perform implementation or other consequential mutations.

This boundary should be expressed as a decision rule, not a fragile action-count limit.

### Manager acceptance role

The manager independently accepts delegated work at the primary use point. This is a product-owner check, not a second implementation pass.

Appropriate acceptance work includes:

- reading or rendering the final artifact;
- inspecting representative screenshot or visual evidence;
- exercising one primary UI/browser interaction;
- running one focused test, status command, or acceptance command; and
- reconciling the evidence with the user's requested outcome.

A screenshot can establish appearance but cannot prove an interaction it does not exercise. Worker-reported tests and screenshots are evidence, but the manager still makes the acceptance decision. The manager does not rerun broad suites, repeat the worker's investigation, or edit the implementation. When acceptance finds a blocker, the manager delegates one focused fix and rechecks the failed acceptance point.

### Delegation boundary

Use one owner by default. Add workers when work can be divided into independent bounded lanes, requires distinct specialist context, or gains meaningful wall-clock or review coverage. Avoid overlapping implementation ownership and automatic reviewer waves.

## Target prompt structure

1. Role and outcome ownership.
2. Instruction and permission priority.
3. Proceed, ask, delegate, or directly inspect decision rules.
4. One delivery-routing table.
5. Delegation and manager-acceptance policy.
6. Completion, evidence, and stopping rules.
7. Concise communication style.
8. Dynamic specialist, project-agent, memory, skill, and repository context.

Tool parameters and tool-local mechanics belong in tool descriptions. Source-specific routing overlays should be conditional where practical. Runtime guards remain responsible for deterministic delivery, permission, and silent-turn failure handling.

## Validation before adoption

Compare the current and reduced prompts on representative cases covering:

- direct web turns and same-turn progress;
- completed, partial, and blocked worker results;
- intentional internal silence and duplicate-delivery prevention;
- peer/project-agent and non-web routing;
- user-authored model-specific instructions and an empty default;
- trivial read-only manager work versus tasks that must delegate;
- artifact, screenshot, UI-interaction, and focused-command acceptance;
- multi-part completeness, permission gates, and stopping behavior; and
- one-owner tasks versus genuinely independent parallel work.

Track routing correctness, silent turns, acceptance quality, unnecessary worker count, input tokens, output tokens, and end-to-end latency. Remove prompt blocks only when the regression cases remain green or a deterministic runtime rule replaces them.

## Separate workstream

The root Forge `AGENTS.md` payload should be reviewed separately. That work should focus on durable repository conventions and links to task-specific subsystem documentation rather than being bundled into the manager-prompt rewrite.
