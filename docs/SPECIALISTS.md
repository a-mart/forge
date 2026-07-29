# Worker Delegation

Forge keeps three decisions separate:

- **Work mode** decides whether the manager normally delegates or owns bounded work itself.
- **Task type** chooses a worker's instructions and output contract. The manager tool identifies it with the `mode` field.
- **Execution profile** chooses a model, reasoning level, fallback, and escalation policy from the selected roster. The manager tool identifies that profile with its internal `route` field.

The manager-facing `spawn_agent` tool accepts a task `mode`, an optional execution-profile `route`, and a required concrete `initialMessage`. Omitting `route` uses the selected roster's baseline mapping for that task type; it is not a task-complexity classifier. A named route is appropriate when its current `useWhen` guidance clearly fits an obviously cheaper or stronger executor. Saved custom specialists remain available through `customSpecialist`. Explicit `route: auto`, older tier, effort, and execution-policy inputs remain internal compatibility paths for persisted work.

Work-graph nodes use the same optional named-route override. Forge pins the roster revision, requested and resolved route, concrete model, reasoning, fallback, and escalation target when an attempt starts. Running attempts therefore do not change when a roster is edited or a session selects another roster. Graph size, fan-in, planning, research, or review alone never selects the strongest route.

## Work Mode

**Delegate first** is the product default. The manager delegates project mutations, sustained investigation, multi-step analysis, and substantial implementation while retaining small read-only orientation and acceptance checks.

**Hands-on** asks the manager to own one cohesive bounded outcome directly, including focused changes and validation. It still delegates when parallelism, isolation, model diversity, specialized behavior, independent review, or scheduler-owned readiness adds material value.

A project can set its default work mode. A session can inherit that default or override it from the compact work-mode control beside Send. Changing work mode during a session replaces the manager runtime before its next turn, so the next request may miss the prompt cache once. It does not stop workers or rewrite an active work graph.

## Task Types

| Mode | Purpose |
|---|---|
| `general` | Build and execute: implementation, debugging, and other outcome-focused work |
| `plan` | Task breakdown, sequencing, design analysis, and risks |
| `correctness-review` | Bugs, edge cases, invariants, and contract validation |
| `design-review` | Maintainability, API design, architecture fit, and consistency |
| `research` | Fact-checking, documentation, and source-backed investigation |

## Worker Rosters

A worker roster is a selectable catalog of model-backed execution profiles. It is not a set of live workers, a persona library, a permissions bundle, or graph topology. Each profile is stored internally as a delegation route and contains only:

- a stable ID and label;
- concise `useWhen` and optional `avoidWhen` guidance;
- the primary provider, model, and reasoning level;
- an optional availability fallback; and
- an optional capability-escalation route for a later attempt.

Each roster maps task types to baseline execution profiles. Build & execute also supplies the compatibility fallback for an incomplete mapping, but Forge does not expose that fallback as a separate user choice. The manager normally omits `route` and lets the task mapping apply. It names a profile's route up front only when its guidance clearly matches cheaper bounded work or difficult cross-cutting work; capability escalation is reserved for a later attempt after evidence that the selected profile was inadequate.

The selection order is global default → project default → session override. New sessions inherit their project. A session override stays local to that session and is not remembered for later sessions. Roster changes affect only pending or future attempts.

Forge supplies the manager a compact versioned `[delegationRoster]` runtime context. The roster's model data is intentionally outside the stable system-prompt prefix so switching rosters does not rewrite the cached prompt. The work mode is different: it is part of the system prompt because it changes the manager's operating policy.

Configure rosters under **Settings → Delegation → Worker Rosters**. The default Balanced roster is derived from existing tier bindings until roster settings are first saved.

## Multi-model Coordination Skill

Forge ships `multi-model-coordination` for work that explicitly benefits from independent perspectives and evidence-based synthesis. It is not loaded as a mandatory workflow for ordinary work. The manager reads exactly one matching scenario reference when the user requests a panel, competing approaches, adversarial review, model/provider diversity, or when a consequential ambiguous choice clearly earns the extra coordination.

The built-in scenarios are parallel exploration, adversarial review, competing solutions, research panel, and thorough code review. Each reference is self-contained: YAML metadata declares autonomous activation and confirmation behavior, while the body includes selection guidance, one example graph, synthesis rules, and adaptation guidance. The example is a topology starting point rather than a fixed template.

Managers normally synthesize two to four bounded accepted results themselves. Synthesis compares claims, assumptions, and evidence quality rather than contributor identity or vote count; it preserves material dissent and verifies the decisive claim before converging.

## How It Works

Each behavior-mode prompt or custom specialist is a **markdown file with YAML frontmatter**. The filename (without `.md`) becomes its internal handle (kebab-case). Shipped mode prompts normally omit `modelId` because their model comes from the selected delegation route. A custom specialist is a complete fixed execution template and may include `modelId`, `provider`, reasoning, and fallback to own model selection directly.

## File Locations

- **Global specialists** (shared across all profiles): `~/.forge/shared/specialists/<handle>.md`
- **Workspace specialists** (repo-scoped passive resources): `<repo>/.forge/specialists/<handle>.md`
- **Project-specific specialists**: `~/.forge/profiles/<profileId>/specialists/<handle>.md`
- **Collaboration channel-local specialists**: `~/.forge/profiles/_collaboration/sessions/<sessionId>/specialists/<handle>.md`

Project specialists shadow global ones with the same filename. Forge seeds the shipped behavior-mode prompts into the global directory on startup. Builder and Collaboration share the same modes where `TargetSpace` allows it; each surface filters the specialist definitions by `TargetSpace`.

## Frontmatter Fields

```yaml
---
displayName: Backend Engineer        # Required — human-readable name shown in UI and badges
color: "#2563eb"                     # Required — hex color (click color swatch in UI to pick)
enabled: true                        # Required — whether the manager can use this specialist
whenToUse: >-                        # Required — guidance for the manager on when to pick this specialist
  Backend/core implementation, TypeScript refactors, debugging server routes
defaultTier: fast                    # Optional — default tier when this lens is selected without tier
modelId: gpt-5.5                     # Optional — direct custom specialist model override
provider: openai-codex               # Optional with modelId — runtime provider
reasoningLevel: high                 # Optional with modelId — defaults to model preset default
fallbackModelId: gpt-5.5             # Optional — model if primary is unavailable (can be cross-provider)
fallbackReasoningLevel: medium       # Optional — reasoning for fallback (defaults to primary)
pin: true                            # Optional — pin to top of sidebar list
TargetSpace: builder                 # Optional — builder, collaboration, or [builder, collaboration]
builtin: true                        # Internal — marks Forge-shipped specialists (do not set manually)
---
```

`TargetSpace` is the canonical frontmatter key and is case-sensitive when Forge writes files. Use `builder` for normal Builder managers, `collaboration` for collaboration channel managers, or `[builder, collaboration]` for a shared definition available in both surfaces. Files without `TargetSpace` default to Builder-only for legacy compatibility. Collaboration channel-local specialist files are always treated as collaboration-scoped.

`defaultTier` can be one of `light`, `fast`, `standard`, `deep`, or `max`. It remains part of the persisted compatibility format and supplies a default for direct custom-specialist use when no model is stored.

## Stored Tier Compatibility

| Tier | Default Model | Reasoning | Fallback |
|---|---|---|---|
| `light` | `openai-codex/gpt-5.4-mini` | low | `openai-codex/gpt-5.5` low |
| `fast` | `cursor-sdk/composer-2.5` | none | `openai-codex/gpt-5.4` high |
| `standard` | `openai-codex/gpt-5.5` | medium | `openai-codex/gpt-5.5` medium |
| `deep` | `openai-codex/gpt-5.5` | high | `openai-codex/gpt-5.5` medium |
| `max` | `openai-codex/gpt-5.5` | xhigh | `openai-codex/gpt-5.5` medium |

Tier settings remain global at `~/.forge/shared/specialists/tier-configs.json` for persisted workers and compatibility. When `~/.forge/shared/config/delegation-rosters.json` does not exist, Forge derives the Balanced roster from all five tier bindings. Saving rosters writes the new roster file; normal manager delegation then uses routes rather than tier names.

## Shipped Task Instructions and Dedicated Capabilities

Forge uses four editable builtin prompts for non-general task types:

- `planner` (`defaultTier: deep`, Builder and Collaboration)
- `code-reviewer` (`defaultTier: deep`, Builder and Collaboration)
- `code-reviewer-2` (`defaultTier: deep`, Builder and Collaboration)
- `researcher` (`defaultTier: standard`, Builder and Collaboration)

Build & execute workers use the worker archetype prompt. The legacy `architect` prompt remains readable for existing descriptors, but new architecture work uses `mode: general` with `route` omitted or a clearly matching named route. Codex Plugin delegation is a dedicated contextual tool and server-owned authorization path, not a normal task type or custom specialist.

Older builtin handles and tier/lens inputs are still rewritten internally for compatibility. They are not exposed in the current manager tool schema.

## Available Models

| Model ID | Display Name | Provider | Supported Reasoning Levels |
|---|---|---|---|
| `gpt-5.6-sol` | GPT-5.6 Sol | OpenAI Codex | low, medium, high, max, ultra |
| `gpt-5.6-terra` | GPT-5.6 Terra | OpenAI Codex | low, medium, high |
| `gpt-5.6-luna` | GPT-5.6 Luna | OpenAI Codex | low, medium, high |
| `gpt-5.5` | GPT-5.5 | OpenAI Codex | none, low, medium, high, xhigh |
| `gpt-5.4` | GPT-5.4 | OpenAI Codex | none, low, medium, high, xhigh |
| `gpt-5.4-mini` | GPT-5.4 Mini | OpenAI Codex | none, low, medium, high, xhigh |
| `claude-fable-5` | Claude Fable 5 | Anthropic | low, medium, high, xhigh, max |
| `claude-opus-5` | Claude Opus 5 | Anthropic | none, low, medium, high, xhigh, max |
| `claude-opus-4-8` | Claude Opus 4.8 | Anthropic | low, medium, high |
| `claude-opus-4-6` | Claude Opus 4.6 | Anthropic | low, medium, high |
| `claude-sonnet-5` | Claude Sonnet 5 | Anthropic | low, medium, high |
| `composer-2.5` | Composer 2.5 | Cursor SDK | none |
| `grok-4.5` | Grok 4.5 | Cursor SDK | low, medium, high |
| `grok-4.5-fast` | Grok 4.5 Fast | Cursor SDK | low, medium, high |
| `grok-4` | Grok 4 | xAI | none, low, medium, high, xhigh |
| `grok-4-fast` | Grok 4 Fast | xAI | none, low, medium, high, xhigh |
| `grok-4.20-0309-reasoning` | Grok 4.20 Reasoning | xAI | none, low, medium, high, xhigh |
| `grok-4.20-0309-non-reasoning` | Grok 4.20 Non-Reasoning | xAI | none |
| `grok-4.5` | Grok 4.5 (native default) | xAI | API key: low, medium, high, xhigh; OAuth: authenticated metadata, or low, medium, high fallback |
| `grok-build` | Grok Build (account entitlement) | xAI OAuth | authenticated account metadata |
| `grok-composer-2.5-fast` | Grok Composer 2.5 Fast (account entitlement) | xAI OAuth | authenticated account metadata |

**Notes:**
- The table above shows models currently available in the Forge catalog. Some models listed in upstream Pi releases may not yet be curated into Forge.
- For the authoritative, up-to-date model list with availability status, see **Settings → Models** in the UI.
- Claude models use the native `anthropic` provider. Former Claude SDK specialist frontmatter is unavailable and must be changed manually; Forge does not rewrite user-authored specialist files.
- The visible `pi-fable` preset selects `anthropic/claude-fable-5` at `high` by default for manager and specialist selection. This is the Fable family default, not a builtin effort-tier default. Fable uses always-on adaptive thinking, so Forge exposes low, medium, high, xhigh, and max but not none.
- The visible `pi-opus` preset selects `anthropic/claude-opus-5` at `high` by default for manager and specialist selection. Claude Opus 5 is the Opus family default; Claude Opus 4.8 remains an explicit variant. Catalog limits are 1M context and 128k max output tokens. Thinking is on by default; Forge `none` disables it. Unlike Fable, Opus 5 supports `none` as well as low, medium, high, xhigh, and max. Do not combine disabled thinking with xhigh or max (the provider returns 400). Unlike Fable 5, Opus 5 has no special 30-day Covered Model retention requirement in Forge docs. Do not treat provider refusals as automatic model fallback.
- Manager and specialist selectors expose `pi-sonnet` for native Anthropic Sonnet 5.
- Native xAI `grok-4.5` is available for normal manager create, change, and exact per-session override selectors when xAI auth is configured, as well as specialist and explicit worker spawn choices. API-key auth supports low, medium, high, and xhigh reasoning; OAuth starts with a low/medium/high fallback, then authenticated account metadata is authoritative for available reasoning choices. OAuth discovery can add exactly `grok-build` and `grok-composer-2.5-fast` when the active account is entitled; those models remain OAuth-only worker/specialist choices excluded from normal manager selectors, disappear if discovery or entitlement validation fails, and are hidden or rejected under API-key auth. Native xAI `grok-composer-2.5-fast` is distinct from Cursor SDK `composer-2.5`. Settings manages one direct, non-pooled xAI credential slot, so configuring one method replaces the other. `XAI_API_KEY` remains an environment fallback when no Settings-managed xAI credential is configured; it is not a second account, and a stored OAuth refresh failure does not fall through to it. xAI/Grok remains ineligible for manager compaction.
- Cursor SDK models can appear in manager and worker-profile selectors when credentials and model visibility allow them. The legacy stored `fast` tier targets Composer 2.5 with a Codex fallback; Composer exposes only Cursor's `fast` toggle and stores reasoning as `none`. Cursor Grok 4.5 uses the SDK model id `grok-4.5` plus curated-from-live-discovery `effort` and `fast` params; Forge keeps `grok-4.5-fast` as a separate catalog id for attribution. Runtime containment is provider-local and fail-closed: attributed transient transport or throttle failures can retry once before output, auth/permission/cancel/user-state failures are contained and projected without retry, and unattributed/generic/protocol/config failures remain fatal. Usage is captured from turn-ended deltas into session custom entries, then included in stats/token analytics/telemetry provider inference and omitted from forks.
- To audit model catalog drift against Pi upstream, run `pnpm model-catalog:audit`.

## System Prompt

The markdown body below the frontmatter is a custom specialist's **full standalone system prompt**. It is not layered on top of hidden role prompts. Keep it short and include only the rules the worker actually needs:

```
You are a worker agent in a swarm.
- Own the assigned outcome and verify it in proportion to risk.
- Your final assistant response is returned to the manager automatically.
- You are not user-facing.
- End users see only manager-owned user-visible outputs: final web/session replies projected from plain assistant text as `assistant_output`, direct-web progress projected as `assistant_progress`, explicit routed `speak_to_user` deliveries for non-web or exceptional cases, and structured choice UI.
- Incoming messages prefixed with "SYSTEM:" are internal control/context updates, not direct end-user chat.
- Persistent memory for this runtime is at ${SWARM_MEMORY_FILE} and is auto-loaded into context.
- Workers read their owning manager's memory file.
- Only write memory when explicitly asked to remember/update/forget durable information.
- Follow the memory skill workflow before editing the memory file, and never store secrets in memory.
```

Then add the custom specialist's role and output contract. Forge's shipped behavior-mode prompts are different: their editable markdown is a role delta layered after a small stable Forge worker contract. This keeps SYSTEM-message handling, memory safety, action boundaries, and manager-owned delivery consistent without repeating those rules in every mode file.

## Example

```markdown
---
displayName: Payments Expert
color: "#7c3aed"
enabled: true
whenToUse: Payment provider integration analysis and implementation
modelId: grok-4.5
provider: cursor-sdk
---
You are the payments integration worker. Own the assigned payment-provider outcome, inspect the real code path, and verify changes with focused tests.

You are not user-facing. Return status, summary, changed files, verification, and remaining risks to the manager.
```

## Managing Specialists

### Settings UI

Go to **Settings → Delegation** to manage worker delegation:

- **Worker Rosters**: Define execution profiles, automatic task mappings, availability fallbacks, capability escalation, and the global default roster.
- **Global scope**: View and edit shared specialists. Create new global specialists. Builtins are editable but cannot be deleted.
- **Project scope**: View inherited specialists and create project-specific overrides or new project-only specialists.

Click any specialist card to expand and edit it. Changes are saved per-file.

**Actions:**
- **Clone**: Duplicate a specialist to create a new variant with different settings
- **Edit handle**: Rename the specialist's handle (kebab-case identifier)
- **Pin**: Pin frequently-used specialists to the top of the list
- **Color picker**: Click the color swatch to choose a custom badge color

### Fallback Models

Each execution profile (delegation route), and each direct custom specialist with its own model, can optionally define a fallback model. If the primary model is unavailable (rate limited, auth error, capacity), fallback happens transparently inside worker/runtime recovery rather than as a manager-level retry. The fallback binding is pinned when the attempt starts.

Only exhausted fallback failures surface upward.

**Availability fallback is not capability escalation.** A provider outage or rate limit may use the configured fallback at equivalent intended capability; it must not silently buy a stronger execution profile. Capability escalation creates a new attempt with the profile explicitly linked for that purpose.

**Cross-provider fallback is supported**: You can use a model from a different provider as your fallback (e.g., primary `grok-4`, fallback `gpt-5.5`). This is exercised silently inside runtime recovery and is useful for provider outages or rate limit mitigation.

Codex Plugin delegation is contextual. It is available only when a user turn includes an active `@Codex` plugin selector, and Forge binds the dedicated worker to the server-stored selector scope. Normal scoped plugin tools return bounded preview/metadata only. Full connector exports, such as Fireflies transcripts or summaries, must use the scoped export artifact tool, which writes redacted JSON artifacts under the session and returns only path/metadata plus a bounded preview. If that scoped worker is stopped or fails, Forge can authorize retry only for an explicit retry/continuation turn that refers to the same Codex/plugin context; unrelated turns require a fresh selector tag.

### Resolution Order

When resolving specialist definitions for a Builder project:
1. Project-specific specialists whose `TargetSpace` includes `builder` (in `~/.forge/profiles/<profileId>/specialists/`)
2. Workspace specialists whose `TargetSpace` includes `builder` and either introduce a new handle or explicitly override a non-builtin global specialist with `forgePrecedence: override` (in `<repo>/.forge/specialists/`)
3. Global specialists whose `TargetSpace` includes `builder` (in `~/.forge/shared/specialists/`)

When resolving a collaboration channel roster:
1. Channel-local specialists (in `~/.forge/profiles/_collaboration/sessions/<sessionId>/specialists/`)
2. Selected global specialists whose `TargetSpace` includes `collaboration` (in `~/.forge/shared/specialists/`)

Project or channel-local files shadow global files with the same handle. Workspace specialists are Builder-only passive project resources and do not override builtins. Collaboration category defaults select global handles for newly created channels only; existing channels keep their own selected-handle list in SQLite.
