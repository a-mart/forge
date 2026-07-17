Delegation separates what a worker should do from how much model capability the task needs. Managers choose a behavior mode and an execution policy for each assignment; Forge translates those choices onto the configured worker runtime, fallback, and attribution machinery.

## Behavior modes

- **General** — implementation, debugging, and other outcome-focused work. This is the default.
- **Plan** — task breakdown, sequencing, design analysis, and risks.
- **Correctness review** — bugs, edge cases, invariants, and contract validation.
- **Design review** — maintainability, API design, architecture fit, and consistency.
- **Research** — fact-checking, documentation, and source-backed investigation.

Those defaults are guidance, not capability floors. A manager may use Support for a bounded, low-risk plan or review and raise the policy when ambiguity or risk warrants it.

## Execution policies

- **Support** — low-cost, low-latency scans, lookups, and simple work.
- **Routine** — ordinary well-specified implementation and balanced day-to-day work.
- **Deep** — complex, ambiguous, or high-risk implementation, planning, and review.

Each policy has a primary model, reasoning level, and optional availability fallback. Fallback and recovery happen inside the worker runtime; the manager does not need to retry on another model manually.

## Global, profile, and Collaboration scopes

Use the scope selector to edit shared definitions or narrower overrides:

- **Global** — behavior-mode prompts and custom specialists shared by all Builder profiles.
- **Profile** — overrides for one Builder profile.
- **Collaboration global** — shared definitions available to collaboration channels.
- **Category** — default behavior-mode and custom-specialist availability for new channels in a category.
- **Channel** — available shared behavior modes and custom specialists plus channel-local definitions for one channel.

Definitions use `TargetSpace` to stay in Builder, Collaboration, or both. Channel-local files shadow the same global handle only inside that channel. Skill selection is managed on the **Skills** settings page.

## Custom specialists

Use **New Specialist** when a durable domain-specific worker needs a complete fixed execution template with its own saved prompt and model configuration. A manager selects it through the custom-specialist path instead of combining it with a behavior mode or execution policy.

1. Enter a kebab-case handle and display name.
2. Describe when the manager should use it.
3. Choose its model, reasoning, and optional fallback, or keep its stored tier default.
4. Write a concise standalone worker prompt with its role and output contract.
5. Save it.

Builtin mode prompts can be customized per profile. Pin a builtin customization to prevent a future Forge update from replacing it. Use **Revert** to remove a profile override and return to the inherited definition.

Legacy Architect and system-managed Codex Plugin definitions live in the collapsed **System & Compatibility** section. They are not offered as normal manager behavior modes, but remain inspectable so existing customizations can be repaired or reverted.

## Dedicated Codex Plugin delegation

Codex Plugin is not a normal behavior mode or custom specialist. When a user includes an active `@Codex` plugin selector, Forge provides a dedicated delegation tool and binds its worker to the server-owned selector scope. The model cannot supply or widen selectors. Explicit retry turns can reuse a stopped or failed worker's stored scope; unrelated turns require a fresh selector tag.

## Roster prompt

In profile or channel scope, click **Roster Prompt** to inspect the compact delegation block injected into the manager prompt. It shows the available behavior modes, exact model behind each execution policy, and selectable custom specialists.
