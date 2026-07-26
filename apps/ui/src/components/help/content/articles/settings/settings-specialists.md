Delegation separates manager ownership, worker behavior, and model selection. The manager chooses whether to own bounded work directly, which worker behavior fits delegated work, and which route in the selected model roster should execute it.

## Manager posture

- **Delegation-first** — the default. The manager delegates substantial project work and keeps direct work to answers, bounded read-only orientation, and acceptance checks.
- **Hands-on** — the manager normally owns one cohesive bounded outcome itself, while retaining delegation for useful parallelism, isolation, model diversity, specialized behavior, independent review, or work-graph scheduling.

Projects can set a default posture. An eligible Builder manager session can inherit it or override it from the coordination control beside Send. A mid-session posture change replaces the manager runtime before its next turn and may cause one prompt-cache miss. It does not stop workers or alter an active graph.

## Behavior modes

- **General** — implementation, debugging, and other outcome-focused work. This is the default.
- **Plan** — task breakdown, sequencing, design analysis, and risks.
- **Correctness review** — bugs, edge cases, invariants, and contract validation.
- **Design review** — maintainability, API design, architecture fit, and consistency.
- **Research** — fact-checking, documentation, and source-backed investigation.

Behavior describes the job; it does not choose model capability.

## Delegation rosters

A delegation roster is a selectable catalog of model routes. Each route has concise use/avoid guidance, one primary model and reasoning level, an optional availability fallback, and an optional capability-escalation route.

Each roster maps behavior modes to baseline routes. Managers normally omit `route` and let the selected mode's baseline apply; they name a route only when its guidance clearly fits cheaper bounded work or difficult cross-cutting work. Capability escalation is reserved for a later attempt after evidence that the selected executor was inadequate. Graph size and fan-in are not reasons to select a stronger route.

The selection order is global default → project default → session override. Roster changes affect future attempts; running attempts keep their pinned route, model, fallback, and escalation target. Availability fallback handles provider/model unavailability. Capability escalation is a separate later attempt and never happens merely because a provider is rate-limited.

Configure definitions and the global default in **Delegation Rosters**. Use the compact coordination menu beside Send to select a session roster, return to the project default, or make the current choice the project default.

## Global, project, and Collaboration scopes

Use the scope selector to edit shared definitions or narrower overrides:

- **Global** — behavior-mode prompts and custom specialists shared by all Builder projects.
- **Project** — overrides for one Builder project.
- **Collaboration global** — shared definitions available to collaboration channels.
- **Category** — default behavior-mode and custom-specialist availability for new channels in a category.
- **Channel** — available shared behavior modes and custom specialists plus channel-local definitions for one channel.

Definitions use `TargetSpace` to stay in Builder, Collaboration, or both. Channel-local files shadow the same global handle only inside that channel. Skill selection is managed on the **Skills** settings page.

## Custom specialists

Use **New Specialist** when a durable domain-specific worker needs a complete fixed execution template with its own saved prompt and model configuration. A manager selects it through the custom-specialist path instead of combining it with a behavior mode or roster route.

1. Enter a kebab-case handle and display name.
2. Describe when the manager should use it.
3. Choose its model, reasoning, and optional fallback, or keep its stored tier default.
4. Write a concise standalone worker prompt with its role and output contract.
5. Save it.

Builtin mode prompts can be customized per project. Pin a builtin customization to prevent a future Forge update from replacing it. Use **Revert** to remove a project override and return to the inherited definition.

Legacy Architect and system-managed Codex Plugin definitions live in the collapsed **System & Compatibility** section. They are not offered as normal manager behavior modes, but remain inspectable so existing customizations can be repaired or reverted.

## Multi-model coordination

The built-in `multi-model-coordination` skill provides self-contained examples for parallel exploration, adversarial review, competing solutions, research panels, and thorough code review. It is used when the user asks for that style of work or when a consequential ambiguous decision clearly benefits from independent perspectives. Ordinary implementation, planning, research, and review do not need to read it.

Each scenario declares whether autonomous use needs confirmation and shows one adaptable work-graph topology. The manager keeps the graph small, normally synthesizes two to four accepted results itself, compares evidence rather than votes, and preserves unresolved dissent.

## Dedicated Codex Plugin delegation

Codex Plugin is not a normal behavior mode or custom specialist. When a user includes an active `@Codex` plugin selector, Forge provides a dedicated delegation tool and binds its worker to the server-owned selector scope. The model cannot supply or widen selectors. Explicit retry turns can reuse a stopped or failed worker's stored scope; unrelated turns require a fresh selector tag.

## Roster prompt

In project or channel scope, click **Roster Prompt** to inspect the compact specialist block injected into the manager prompt. Model routes are supplied separately in a versioned runtime context so roster changes do not rewrite the stable system-prompt prefix.
