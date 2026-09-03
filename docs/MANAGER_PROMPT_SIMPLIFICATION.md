# Manager prompt simplification

Status: implementation contract for the compressed manager prompt.

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

### Posture-relative ownership

All postures share one outcome, coordination, acceptance, communication, and permission contract. A posture changes only the preferred owner for substantive execution:

- **Delegate first:** workers normally own substantive execution; manager direct project work is bounded read-only orientation and acceptance.
- **Adaptive:** choose ownership outcome by outcome without a prior manager or worker bias.
- **Hands-on:** the manager normally owns one cohesive outcome and delegates when a bounded handoff provides material value.

Adaptive and Hands-on may use normal project tools for manager-owned outcomes. Delegate first must not use shell or browser actions as an indirect project-mutation path. In every posture, change ownership when evidence changes instead of continuing direct work or delegation by inertia.

These boundaries are decision rules, not fragile action-count limits.

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

## Prompt structure

1. Own the outcome.
2. Choose ownership and coordination.
3. Execute, accept, and converge.
4. Understand dynamic runtime context.
5. Communicate and deliver through one routing contract.
6. Preserve permission and durable-state boundaries.

The posture block owns only the manager-versus-worker preference. All postures receive the same compact Direct, Checklist, and Graph model and the same active roster. Tool parameters, graph state transitions, retry details, stable identifiers, and other invocation mechanics belong in tool descriptions and schemas. Runtime guards enforce deterministic delivery and missing required responses; the shared routing footer defines intentional silence with `NO_REPLY`.

## Validation

Automated coverage verifies source-size budgets, posture composition, roster availability, one routing footer, the intentional-silence sentinel, and the tool-local contracts. Backend typechecking and the focused prompt suites must pass. These structural checks do not replace behavioral calibration across supported models.

Before broad adoption, compare the current and reduced prompts on representative sessions covering:

- direct web turns and same-turn progress;
- completed, partial, and blocked worker results;
- intentional internal silence and duplicate-delivery prevention;
- peer/project-agent routing;
- user-authored model-specific instructions and an empty default;
- trivial read-only manager work versus tasks that must delegate;
- artifact, screenshot, UI-interaction, and focused-command acceptance;
- multi-part completeness, permission gates, and stopping behavior; and
- one-owner tasks versus genuinely independent parallel work.

Track routing correctness, silent turns, acceptance quality, unnecessary worker count, input tokens, output tokens, and end-to-end latency. Remove prompt blocks only when the regression cases remain green or a deterministic runtime rule replaces them.

## Separate workstream

The root Forge `AGENTS.md` payload should be reviewed separately. That work should focus on durable repository conventions and links to task-specific subsystem documentation rather than being bundled into the manager-prompt rewrite.
