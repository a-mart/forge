# Worker Delegation

Forge gives managers two task-level choices:

- **Behavior mode** chooses the worker's role and output contract.
- **Execution policy** chooses the configured model, reasoning level, and availability fallback.

The manager-facing `spawn_agent` tool accepts `mode`, `executionPolicy`, and a required concrete `initialMessage`. Saved custom specialists remain available through `customSpecialist`. The older tier/lens representation remains internal so existing workers, fallbacks, attribution, and stored configuration keep working.

For explicit one-worker delegation, the manager chooses mode and policy. For an executable work graph created through `update_work_graph`, Forge normally derives both from the node instead: research leaves use `research` + `support`; ordinary task, implementation, review, and synthesis nodes use `routine`; and a retry after a blocked attempt escalates to `deep`. Fan-in count alone does not escalate a node. A manager may request `effort=deep` for genuinely high-risk or cross-cutting reasoning. This routing deliberately avoids making planning, review, or graph size an automatic reason to spend the Deep policy.

## Behavior Modes

| Mode | Default policy | Purpose |
|---|---|---|
| `general` | `routine` | Implementation, debugging, and other outcome-focused work |
| `plan` | `deep` | Task breakdown, sequencing, design analysis, and risks |
| `correctness-review` | `deep` | Bugs, edge cases, invariants, and contract validation |
| `design-review` | `deep` | Maintainability, API design, architecture fit, and consistency |
| `research` | `support` | Fact-checking, documentation, and source-backed investigation |

Mode defaults are guidance rather than capability floors. A manager may choose `support` for a bounded, low-risk plan or review and raise the policy when ambiguity or risk warrants it.

## Execution Policies

| Policy | Stored tier | Intended use |
|---|---|---|
| `support` | `fast` | Low-cost, low-latency scans, lookups, and simple work |
| `routine` | `standard` | Ordinary well-specified implementation and balanced work |
| `deep` | `deep` | Complex, ambiguous, or high-risk implementation, planning, and review |

The model behind each policy is configurable in **Settings → Delegation → Execution Policies**. Forge still reads the legacy `light` and `max` tiers for persisted workers and compatibility, but they are not part of normal manager delegation.

## How It Works

Each behavior-mode prompt or custom specialist is a **markdown file with YAML frontmatter**. The filename (without `.md`) becomes its internal handle (kebab-case). Shipped mode prompts normally omit `modelId` because their model comes from the selected execution policy. A custom specialist is a complete fixed execution template and may include `modelId`, `provider`, reasoning, and fallback to own model selection directly.

## File Locations

- **Global specialists** (shared across all profiles): `~/.forge/shared/specialists/<handle>.md`
- **Workspace specialists** (repo-scoped passive resources): `<repo>/.forge/specialists/<handle>.md`
- **Profile-specific specialists**: `~/.forge/profiles/<profileId>/specialists/<handle>.md`
- **Collaboration channel-local specialists**: `~/.forge/profiles/_collaboration/sessions/<sessionId>/specialists/<handle>.md`

Profile specialists shadow global ones with the same filename. Forge seeds the shipped behavior-mode prompts into the global directory on startup. Builder and Collaboration share the same modes where `TargetSpace` allows it; each surface filters the roster by `TargetSpace`.

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

Tier settings are global and persisted at `~/.forge/shared/specialists/tier-configs.json`. The Delegation settings page edits the `fast`, `standard`, and `deep` entries under their Support, Routine, and Deep policy names without discarding the other stored entries.

## Shipped Mode Prompts and Dedicated Capabilities

Forge uses four editable builtin prompts for non-general behavior modes:

- `planner` (`defaultTier: deep`, Builder and Collaboration)
- `code-reviewer` (`defaultTier: deep`, Builder and Collaboration)
- `code-reviewer-2` (`defaultTier: deep`, Builder and Collaboration)
- `researcher` (`defaultTier: standard`, Builder and Collaboration)

General workers use the worker archetype prompt. The legacy `architect` prompt remains readable for existing descriptors, but new architecture work uses `mode: general` with `executionPolicy: deep`. Codex Plugin delegation is a dedicated contextual tool and server-owned authorization path, not a normal behavior mode or custom specialist.

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
| `claude-opus-4-8` | Claude Opus 4.8 | Anthropic | low, medium, high |
| `claude-opus-4-6` | Claude Opus 4.6 | Anthropic | low, medium, high |
| `claude-sonnet-5` | Claude Sonnet 5 | Anthropic | low, medium, high |
| `composer-2.5` | Composer 2.5 | Cursor SDK | none |
| `grok-4.5` | Grok 4.5 | Cursor SDK | low, medium, high |
| `grok-4.5-fast` | Grok 4.5 Fast | Cursor SDK | low, medium, high |
| `grok-4.5` | Grok 4.5 (native default) | xAI | API key: low, medium, high, xhigh; OAuth: authenticated metadata, or low, medium, high fallback |
| `grok-build` | Grok Build (account entitlement) | xAI OAuth | authenticated account metadata |
| `grok-composer-2.5-fast` | Grok Composer 2.5 Fast (account entitlement) | xAI OAuth | authenticated account metadata |

**Notes:**
- The table above shows models currently available in the Forge catalog. Some models listed in upstream Pi releases may not yet be curated into Forge.
- For the authoritative, up-to-date model list with availability status, see **Settings → Models** in the UI.
- Claude models use the native `anthropic` provider. Former Claude SDK specialist frontmatter is unavailable and must be changed manually; Forge does not rewrite user-authored specialist files.
- The visible `pi-fable` preset selects `anthropic/claude-fable-5` at `high` by default for manager and specialist selection. This is the Fable family default, not a builtin effort-tier default. Fable uses always-on adaptive thinking, so Forge exposes low, medium, high, xhigh, and max but not none.
- Manager and specialist selectors expose `pi-sonnet` for native Anthropic Sonnet 5.
- xAI models are available for specialists and explicit worker spawn choices, but not normal manager create, change, or per-session override selectors. `grok-4.5` is the native xAI default. Under OAuth, authenticated discovery can add exactly `grok-build` and `grok-composer-2.5-fast` when the active account is entitled; the live response determines their reasoning options and they disappear if discovery or entitlement validation fails. Both are OAuth-only and are hidden or rejected under API-key auth. Native xAI `grok-composer-2.5-fast` is distinct from Cursor SDK `composer-2.5`. Settings manages one direct, non-pooled xAI credential slot, so configuring one method replaces the other. `XAI_API_KEY` remains an environment fallback when no Settings-managed xAI credential is configured; it is not a second account, and a stored OAuth refresh failure does not fall through to it.
- Cursor SDK models can appear in manager and delegation policy selectors when credentials and model visibility allow them. The default stored `fast` tier (the Support policy) targets Composer 2.5 with a Codex fallback; Composer exposes only Cursor's `fast` toggle and stores reasoning as `none`. Cursor Grok 4.5 uses the SDK model id `grok-4.5` plus curated-from-live-discovery `effort` and `fast` params; Forge keeps `grok-4.5-fast` as a separate catalog id for attribution. Runtime containment is provider-local and fail-closed: attributed transient transport or throttle failures can retry once before output, auth/permission/cancel/user-state failures are contained and projected without retry, and unattributed/generic/protocol/config failures remain fatal. Usage is captured from turn-ended deltas into session custom entries, then included in stats/token analytics/telemetry provider inference and omitted from forks.
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

- **Global scope**: View and edit shared specialists. Create new global specialists. Builtins are editable but cannot be deleted.
- **Profile scope**: View inherited specialists and create profile-specific overrides or new profile-only specialists.
- **Execution Policies**: Edit the three manager-facing model and fallback policies.

Click any specialist card to expand and edit it. Changes are saved per-file.

**Actions:**
- **Clone**: Duplicate a specialist to create a new variant with different settings
- **Edit handle**: Rename the specialist's handle (kebab-case identifier)
- **Pin**: Pin frequently-used specialists to the top of the list
- **Color picker**: Click the color swatch to choose a custom badge color

### Fallback Models

Each execution policy, and each direct custom specialist with its own model, can optionally define a fallback model. If the primary model is unavailable (rate limited, auth error, capacity), fallback happens transparently inside worker/runtime recovery rather than as a manager-level retry.

Only exhausted fallback failures surface upward.

**Cross-provider fallback is fully supported**: You can use a model from a different provider as your fallback (e.g., primary `grok-4`, fallback `gpt-5.5`). This is exercised silently inside runtime recovery and is useful for provider outages or rate limit mitigation.

Codex Plugin delegation is contextual. It is available only when a user turn includes an active `@Codex` plugin selector, and Forge binds the dedicated worker to the server-stored selector scope. Normal scoped plugin tools return bounded preview/metadata only. Full connector exports, such as Fireflies transcripts or summaries, must use the scoped export artifact tool, which writes redacted JSON artifacts under the session and returns only path/metadata plus a bounded preview. If that scoped worker is stopped or fails, Forge can authorize retry only for an explicit retry/continuation turn that refers to the same Codex/plugin context; unrelated turns require a fresh selector tag.

### Resolution Order

When resolving the roster for a Builder profile:
1. Profile-specific specialists whose `TargetSpace` includes `builder` (in `~/.forge/profiles/<profileId>/specialists/`)
2. Workspace specialists whose `TargetSpace` includes `builder` and either introduce a new handle or explicitly override a non-builtin global specialist with `forgePrecedence: override` (in `<repo>/.forge/specialists/`)
3. Global specialists whose `TargetSpace` includes `builder` (in `~/.forge/shared/specialists/`)

When resolving a collaboration channel roster:
1. Channel-local specialists (in `~/.forge/profiles/_collaboration/sessions/<sessionId>/specialists/`)
2. Selected global specialists whose `TargetSpace` includes `collaboration` (in `~/.forge/shared/specialists/`)

Profile or channel-local files shadow global files with the same handle. Workspace specialists are Builder-only passive project resources and do not override builtins. Collaboration category defaults select global handles for newly created channels only; existing channels keep their own selected-handle list in SQLite.
