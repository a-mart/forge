# Specialists, Tiers, and Lenses

Forge routes worker spawns through two concepts:

- **Effort tiers** choose the model, provider, reasoning level, and fallback chain.
- **Specialist lenses** choose the persona, prompt, color, and "when to use" guidance.

The manager sees a compact tier/lens roster and can spawn a worker with `tier`, `lens`, or both. Custom legacy specialists are still supported as direct worker spawn templates.

## How It Works

Each custom specialist or lens is a **markdown file with YAML frontmatter**. The filename (without `.md`) becomes the handle (kebab-case). Builtin lenses normally omit `modelId` because their model is supplied by the selected tier. Custom specialists can still include `modelId` and `provider` to behave like the older direct specialist templates.

## File Locations

- **Global specialists** (shared across all profiles): `~/.forge/shared/specialists/<handle>.md`
- **Workspace specialists** (repo-scoped passive resources): `<repo>/.forge/specialists/<handle>.md`
- **Profile-specific specialists**: `~/.forge/profiles/<profileId>/specialists/<handle>.md`
- **Collaboration channel-local specialists**: `~/.forge/profiles/_collaboration/sessions/<sessionId>/specialists/<handle>.md`

Profile specialists shadow global ones with the same filename. Forge ships with builtin lenses that are seeded to the global directory on startup. Builder and Collaboration share the same core lenses where `TargetSpace` allows it; each surface filters the roster by `TargetSpace`.

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

`defaultTier` can be one of `light`, `fast`, `standard`, `deep`, or `max`. It only affects lens-only spawns. If both `tier` and `lens` are provided, the explicit tier wins unless the lens has an explicit `modelId` override.

## Builtin Tiers

| Tier | Default Model | Reasoning | Fallback |
|---|---|---|---|
| `light` | `openai-codex/gpt-5.4-mini` | low | `openai-codex/gpt-5.5` low |
| `fast` | `cursor-sdk/composer-2.5` | medium | `openai-codex/gpt-5.4` high |
| `standard` | `openai-codex/gpt-5.5` | medium | `openai-codex/gpt-5.5` medium |
| `deep` | `openai-codex/gpt-5.5` | high | `openai-codex/gpt-5.5` medium |
| `max` | `openai-codex/gpt-5.5` | xhigh | `openai-codex/gpt-5.5` medium |

Tier settings are global and editable in **Settings → Specialists → Tiers**. They are persisted at `~/.forge/shared/specialists/tier-configs.json`.

## Builtin Lenses

Forge ships six builtin lenses:

- `architect` (`defaultTier: max`, Builder and Collaboration)
- `planner` (`defaultTier: deep`, Builder and Collaboration)
- `code-reviewer` (`defaultTier: deep`, Builder and Collaboration)
- `code-reviewer-2` (`defaultTier: deep`, Builder and Collaboration)
- `researcher` (`defaultTier: standard`, Builder and Collaboration; includes Brave-backed web research guidance)
- `codex-plugin` (`defaultTier: standard`, Builder-only; used for scoped `@Codex` plugin turns)

Older builtin handles are rewritten for compatibility: `backend`, `frontend`, and `cursor-builder` become `fast`; `doc-writer` becomes `standard`; `scout` becomes `light`; `web-researcher` becomes `standard:researcher`; `planner`, `architect`, `code-reviewer`, `code-reviewer-2`, `researcher`, and `codex-plugin` map to their default tier plus lens. Legacy `collab-*` handles map to the shared lenses or bare tiers.

## Available Models

| Model ID | Display Name | Provider | Supported Reasoning Levels |
|---|---|---|---|
| `gpt-5.5` | GPT-5.5 | OpenAI Codex | none, low, medium, high, xhigh |
| `gpt-5.3-codex-spark` | GPT-5.3 Codex Spark | OpenAI Codex | none, low, medium, high, xhigh |
| `gpt-5.4` | GPT-5.4 | OpenAI Codex | none, low, medium, high, xhigh |
| `gpt-5.4-mini` | GPT-5.4 Mini | OpenAI Codex | none, low, medium, high, xhigh |
| `claude-opus-4-8` | Claude Opus 4.8 | Anthropic | low, medium, high |
| `claude-opus-4-6` | Claude Opus 4.6 | Anthropic | low, medium, high |
| `claude-sonnet-5` | Claude Sonnet 5 | Anthropic | low, medium, high |
| `claude-sonnet-4-5-20250929` | Claude Sonnet 4.5 | Anthropic | low, medium, high |
| `claude-sonnet-5` | Claude Sonnet 5 (SDK) | Claude SDK (`provider: claude-sdk`) | low, medium, high |
| `claude-sonnet-4-5-20250929` | Claude Sonnet 4.5 (SDK) | Claude SDK (`provider: claude-sdk`) | low, medium, high |
| `claude-haiku-4-5-20251001` | Claude Haiku 4.5 | Anthropic | low, medium, high |
| `composer-2.5` | Composer 2.5 | Cursor SDK | low, medium, high |
| `grok-4` | Grok 4 | xAI | none, low, medium, high, xhigh |
| `grok-4-fast` | Grok 4 Fast | xAI | none, low, medium, high, xhigh |
| `grok-4.20-0309-reasoning` | Grok 4.20 Reasoning | xAI | none, low, medium, high, xhigh |
| `grok-4.20-0309-non-reasoning` | Grok 4.20 Non-Reasoning | xAI | none, low, medium, high, xhigh |

**Notes:**
- The table above shows models currently available in the Forge catalog. Some models listed in upstream Pi releases may not yet be curated into Forge.
- For the authoritative, up-to-date model list with availability status, see **Settings → Models** in the UI.
- Anthropic Pi managers/workers use the `anthropic` provider. Claude Agent SDK variants reuse the same `modelId` strings but require `provider: claude-sdk` in specialist frontmatter or exact manager selection so Forge routes to the native SDK runtime instead of Pi.
- Manager and specialist selectors expose dedicated presets: `pi-sonnet` for Anthropic Sonnet and `sdk-sonnet` for Claude SDK Sonnet. Choosing the preset selects Sonnet 5 by default; Sonnet 4.5 remains available as a variant.
- xAI models require `XAI_API_KEY` to be configured (see Settings → Authentication).
- Cursor SDK models are tier/specialist-only. The default `fast` tier targets Composer 2.5 with a Codex fallback. Manager selectors do not offer Cursor SDK models. Runtime containment is provider-local and fail-closed: attributed transient transport or throttle failures can retry once before output, auth/permission/cancel/user-state failures are contained and projected without retry, and unattributed/generic/protocol/config failures remain fatal. Usage is captured from turn-ended deltas into session custom entries, then included in stats/token analytics/telemetry provider inference and omitted from forks.
- To audit model catalog drift against Pi upstream, run `pnpm model-catalog:audit`.

## System Prompt

The markdown body below the frontmatter is the specialist's **full standalone system prompt**. It is not layered on top of other prompts — each specialist owns its complete prompt. Use the worker base prompt as a starting template:

```
You are a worker agent in a swarm.
- You can list agents and send messages to other agents.
- Use coding tools (read/bash/edit/write) to execute implementation tasks.
- Report progress and outcomes back to the manager using send_message_to_agent.
- You are not user-facing.
- End users see only manager-owned user-visible outputs: final web/session replies projected from plain assistant text as `assistant_output`, direct-web progress projected as `assistant_progress`, explicit routed `speak_to_user` deliveries for non-web or exceptional cases, and structured choice UI.
- Incoming messages prefixed with "SYSTEM:" are internal control/context updates, not direct end-user chat.
- Persistent memory for this runtime is at ${SWARM_MEMORY_FILE} and is auto-loaded into context.
- Workers read their owning manager's memory file.
- Only write memory when explicitly asked to remember/update/forget durable information.
- Follow the memory skill workflow before editing the memory file, and never store secrets in memory.
```

Then add specialist-specific instructions below.

## Example

```markdown
---
displayName: Planner
color: "#7c3aed"
enabled: true
whenToUse: Architecture planning, design docs, implementation sequencing, risk analysis
defaultTier: deep
---
You are a worker agent in a swarm.
[...base worker prompt...]

Planning specialist focus:
- You produce structured implementation plans with clear sequencing dependencies.
- Identify risks, migration complexity, and breakage potential for each step.
- Write for AI coding agents, not humans — skip timelines, focus on technical specifics.
```

## Managing Specialists

### Settings UI

Go to **Settings → Specialists** to manage your roster:

- **Global scope**: View and edit shared specialists. Create new global specialists. Builtins are editable but cannot be deleted.
- **Profile scope**: View inherited specialists and create profile-specific overrides or new profile-only specialists.
- **Tiers**: Edit the five global effort-tier model and fallback settings.

Click any specialist card to expand and edit it. Changes are saved per-file.

**Actions:**
- **Clone**: Duplicate a specialist to create a new variant with different settings
- **Edit handle**: Rename the specialist's handle (kebab-case identifier)
- **Pin**: Pin frequently-used specialists to the top of the list
- **Color picker**: Click the color swatch to choose a custom badge color

### Fallback Models

Each tier, and each direct custom specialist with its own model, can optionally define a fallback model. If the primary model is unavailable (rate limited, auth error, capacity), fallback happens transparently inside worker/runtime recovery rather than as a manager-level retry.

Only exhausted fallback failures surface upward.

**Cross-provider fallback is fully supported**: You can use a model from a different provider as your fallback (e.g., primary `grok-4`, fallback `gpt-5.5`). This is exercised silently inside runtime recovery and is useful for provider outages or rate limit mitigation.

`codex-plugin` is a contextual built-in specialist. It appears only when a user turn includes an active `@Codex` plugin selector, and Forge binds that worker to the server-stored selector scope. Normal scoped plugin tools return bounded preview/metadata only. Full connector exports, such as Fireflies transcripts or summaries, must use the scoped export artifact tool, which writes redacted JSON artifacts under the session and returns only path/metadata plus a bounded preview. If that scoped worker is stopped or fails, Forge can authorize retry only for an explicit retry/continuation turn that refers to the same Codex/plugin context; unrelated turns require a fresh selector tag.

### Resolution Order

When resolving the roster for a Builder profile:
1. Profile-specific specialists whose `TargetSpace` includes `builder` (in `~/.forge/profiles/<profileId>/specialists/`)
2. Workspace specialists whose `TargetSpace` includes `builder` and either introduce a new handle or explicitly override a non-builtin global specialist with `forgePrecedence: override` (in `<repo>/.forge/specialists/`)
3. Global specialists whose `TargetSpace` includes `builder` (in `~/.forge/shared/specialists/`)

When resolving a collaboration channel roster:
1. Channel-local specialists (in `~/.forge/profiles/_collaboration/sessions/<sessionId>/specialists/`)
2. Selected global specialists whose `TargetSpace` includes `collaboration` (in `~/.forge/shared/specialists/`)

Profile or channel-local files shadow global files with the same handle. Workspace specialists are Builder-only passive project resources and do not override builtins. Collaboration category defaults select global handles for newly created channels only; existing channels keep their own selected-handle list in SQLite.
