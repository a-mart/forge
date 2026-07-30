Delegation separates manager ownership from worker configuration. A delegation preset is a roster of complete specialists. Each specialist combines one task type and its instructions with the model, reasoning, use/avoid guidance, fallback, and escalation behavior used to run it.

## Work mode

- **Delegate first** — the default. The manager delegates substantial project work and keeps direct work to answers, bounded read-only orientation, and acceptance checks.
- **Hands-on** — the manager normally owns one cohesive bounded outcome itself, while retaining delegation for useful parallelism, isolation, model diversity, specialized behavior, independent review, or work-graph scheduling.

Projects can set a default work mode. An eligible Builder manager session can inherit it or override it from the work-mode control beside Send. A mid-session work-mode change replaces the manager runtime before its next turn and may cause one prompt-cache miss. It does not stop workers or alter an active graph.

## Task types

- **Build & execute** — implementation, debugging, and other outcome-focused work. This is the default.
- **Planning** — task breakdown, sequencing, design analysis, and risks.
- **Correctness review** — bugs, edge cases, invariants, and contract validation.
- **Design review** — maintainability, API design, architecture fit, and consistency.
- **Research** — fact-checking, documentation, and source-backed investigation.

Task type describes the specialist's job. A roster may contain more than one specialist for the same task type when different cost, capability, or provider choices are useful.

## Delegation presets

A delegation preset is a team of complete roster specialists. Every specialist has one task type and a complete execution configuration. One specialist is the default for each task type; alternatives can provide cheaper, independent, or stronger execution when their guidance clearly fits.

Managers normally choose the work to delegate and let Forge use that task type's default specialist. They name another specialist only when its guidance clearly fits. Capability escalation is reserved for a later attempt after evidence that the selected specialist was inadequate. Graph size and fan-in are not reasons to select a stronger specialist.

The preset selection order is global default → project default → session override. Preset changes affect future attempts; running attempts keep their pinned specialist and execution settings. Availability fallback swaps only the model when the primary is unavailable and keeps the same attempt. Capability escalation starts a fresh attempt on another specialist and never happens merely because a provider is rate-limited.

Configure this under **Delegation presets**. Select a roster specialist to edit both what it does and how it runs. Its task-type badge shows its job; the **Default** badge shows whether Forge chooses it automatically for that task. Use **Make default** to replace the current default without editing a separate routing table. Use the compact work menu beside Send to select a session preset, return to the project default, or make the current choice the project default.

## Global, project, and Collaboration scopes

Use the scope selector to edit shared definitions or narrower overrides:

- **Global** — task-instruction prompts and custom specialists shared by all Builder projects.
- **Project** — overrides for one Builder project.
- **Collaboration global** — shared definitions available to collaboration channels.
- **Category** — default task-instruction and custom-specialist availability for new channels in a category.
- **Channel** — available shared task instructions and custom specialists plus channel-local definitions for one channel.

Definitions use `TargetSpace` to stay in Builder, Collaboration, or both. Channel-local files shadow the same global handle only inside that channel. Skill selection is managed on the **Skills** settings page.

## Custom specialists

Use **New Specialist** in the Instruction library when a durable domain-specific worker needs a complete standalone prompt and fixed model configuration outside the normal roster task types.

1. Enter a kebab-case handle and display name.
2. Describe when the manager should use it.
3. Choose its model, reasoning, and optional fallback, or keep its stored tier default.
4. Write a concise standalone worker prompt with its role and output contract.
5. Save it.

Builtin mode prompts can be customized per project. Pin a builtin customization to prevent a future Forge update from replacing it. Use **Revert** to remove a project override and return to the inherited definition.

Legacy Architect and system-managed Codex Plugin definitions live in the collapsed **System & Compatibility** section. They are not offered as normal task types, but remain inspectable so existing customizations can be repaired or reverted.

## Multi-model coordination

The built-in `multi-model-coordination` skill provides self-contained examples for parallel exploration, adversarial review, competing solutions, research panels, and thorough code review. It is used when the user asks for that style of work or when a consequential ambiguous decision clearly benefits from independent perspectives. Ordinary implementation, planning, research, and review do not need to read it.

Each scenario declares whether autonomous use needs confirmation and shows one adaptable work-graph topology. The manager keeps the graph small, normally synthesizes two to four accepted results itself, compares evidence rather than votes, and preserves unresolved dissent.

## Dedicated Codex Plugin delegation

Codex Plugin is not a normal task type or custom specialist. When a user includes an active `@Codex` plugin selector, Forge provides a dedicated delegation tool and binds its worker to the server-owned selector scope. The model cannot supply or widen selectors. Explicit retry turns can reuse a stopped or failed worker's stored scope; unrelated turns require a fresh selector tag.

## Prompt preview

In project or channel scope, use the prompt preview to inspect the compact instruction/custom-specialist block injected into the manager prompt. The active roster is supplied separately in a versioned runtime context so preset changes do not rewrite the stable system-prompt prefix.
