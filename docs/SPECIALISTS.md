# Named Specialists

Named specialists are configurable worker spawn templates that let you define specialized worker personas with specific models, reasoning levels, and system prompts. The manager uses the specialist roster to decide which worker profile to use for each task.

## How It Works

Each specialist is a **markdown file with YAML frontmatter**. The filename (without `.md`) becomes the specialist's handle (kebab-case). The manager sees the full roster in its prompt and can spawn workers using any enabled specialist.

## File Locations

- **Global specialists** (shared across all profiles): `~/.forge/shared/specialists/<handle>.md`
- **Profile-specific specialists**: `~/.forge/profiles/<profileId>/specialists/<handle>.md`
- **Collaboration channel-local specialists**: `~/.forge/profiles/_collaboration/sessions/<sessionId>/specialists/<handle>.md`

Profile specialists shadow global ones with the same filename. Forge ships with builtin specialists that are seeded to the global directory on startup. Collaboration servers seed both Builder built-ins and `collab-` prefixed Collaboration built-ins into the shared directory; each surface filters the roster by `TargetSpace`.

## Frontmatter Fields

```yaml
---
displayName: Backend Engineer        # Required — human-readable name shown in UI and badges
color: "#2563eb"                     # Required — hex color (click color swatch in UI to pick)
handle: backend-engineer             # Optional — specialist handle (defaults to filename without .md)
enabled: true                        # Required — whether the manager can use this specialist
whenToUse: >-                        # Required — guidance for the manager on when to pick this specialist
  Backend/core implementation, TypeScript refactors, debugging server routes
modelId: gpt-5.5              # Required — the model ID to use
reasoningLevel: high                 # Optional — defaults to model preset default
fallbackModelId: gpt-5.5             # Optional — model if primary is unavailable (can be cross-provider)
fallbackReasoningLevel: medium       # Optional — reasoning for fallback (defaults to primary)
pin: true                            # Optional — pin to top of sidebar list
TargetSpace: builder                 # Optional — builder, collaboration, or [builder, collaboration]
builtin: true                        # Internal — marks Forge-shipped specialists (do not set manually)
---
```

`TargetSpace` is the canonical frontmatter key and is case-sensitive when Forge writes files. Use `builder` for normal Builder managers, `collaboration` for collaboration channel managers, or `[builder, collaboration]` for a shared definition available in both surfaces. Files without `TargetSpace` default to Builder-only for legacy compatibility. Collaboration channel-local specialist files are always treated as collaboration-scoped.

## Available Models

| Model ID | Display Name | Provider | Supported Reasoning Levels |
|---|---|---|---|
| `gpt-5.5` | GPT-5.5 | OpenAI Codex | none, low, medium, high, xhigh |
| `gpt-5.3-codex-spark` | GPT-5.3 Codex Spark | OpenAI Codex | none, low, medium, high, xhigh |
| `gpt-5.4` | GPT-5.4 | OpenAI Codex | none, low, medium, high, xhigh |
| `gpt-5.4-mini` | GPT-5.4 Mini | OpenAI Codex | none, low, medium, high, xhigh |
| `claude-opus-4-8` | Claude Opus 4.8 | Anthropic | low, medium, high |
| `claude-opus-4-6` | Claude Opus 4.6 | Anthropic | low, medium, high |
| `claude-sonnet-4-5-20250929` | Claude Sonnet 4.5 | Anthropic | low, medium, high |
| `claude-haiku-4-5-20251001` | Claude Haiku 4.5 | Anthropic | low, medium, high |
| `composer-2.5` | Composer 2.5 | Cursor SDK | low, medium, high |
| `grok-4` | Grok 4 | xAI | none, low, medium, high, xhigh |
| `grok-4-fast` | Grok 4 Fast | xAI | none, low, medium, high, xhigh |
| `grok-4.20-0309-reasoning` | Grok 4.20 Reasoning | xAI | none, low, medium, high, xhigh |
| `grok-4.20-0309-non-reasoning` | Grok 4.20 Non-Reasoning | xAI | none, low, medium, high, xhigh |

**Notes:**
- The table above shows models currently available in the Forge catalog. Some models listed in upstream Pi releases may not yet be curated into Forge.
- For the authoritative, up-to-date model list with availability status, see **Settings → Models** in the UI.
- xAI models require `XAI_API_KEY` to be configured (see Settings → Authentication).
- Cursor SDK models are specialist-only. The built-in `cursor-builder` specialist targets Composer 2.5, ships disabled by default, manager selectors do not offer Cursor SDK models, and runtime containment is provider-local and fail-closed: attributed transient transport or throttle failures can retry once before output, auth/permission/cancel/user-state failures are contained and projected without retry, and unattributed/generic/protocol/config failures remain fatal. Usage is captured from turn-ended deltas into session custom entries, then included in stats/token analytics/telemetry provider inference and omitted from forks.
- To audit model catalog drift against Pi upstream, run `pnpm model-catalog:audit`.

## System Prompt

The markdown body below the frontmatter is the specialist's **full standalone system prompt**. It is not layered on top of other prompts — each specialist owns its complete prompt. Use the worker base prompt as a starting template:

```
You are a worker agent in a swarm.
- You can list agents and send messages to other agents.
- Use coding tools (read/bash/edit/write) to execute implementation tasks.
- Report progress and outcomes back to the manager using send_message_to_agent.
- You are not user-facing.
- End users only see messages they send and manager speak_to_user outputs.
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
modelId: gpt-5.5
reasoningLevel: high
fallbackModelId: gpt-5.5
fallbackReasoningLevel: medium
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

Click any specialist card to expand and edit it. Changes are saved per-file.

**Actions:**
- **Clone**: Duplicate a specialist to create a new variant with different settings
- **Edit handle**: Rename the specialist's handle (kebab-case identifier)
- **Pin**: Pin frequently-used specialists to the top of the list
- **Color picker**: Click the color swatch to choose a custom badge color

### Fallback Models

Each specialist can optionally define a fallback model. If the primary model is unavailable (rate limited, auth error, capacity), fallback happens transparently inside worker/runtime recovery rather than as a manager-level retry.

Only exhausted fallback failures surface upward.

**Built-in specialists default to OpenAI Codex fallbacks** for current shipped Builder and Collaboration specialists. Built-in `web-researcher` is an exception because it has no fallback by default and follows normal fallback/model config semantics.


**Cross-provider fallback is fully supported**: You can use a model from a different provider as your fallback (e.g., primary `grok-4`, fallback `gpt-5.5`). This is exercised silently inside runtime recovery and is useful for provider outages or rate limit mitigation.

`cursor-builder` is the built-in Cursor SDK specialist. It targets Composer 2.5, ships disabled by default, and is intended for opt-in implementation work rather than manager sessions; runtime containment is provider-local and fail-closed, with one pre-output retry only for attributed transient transport or throttle failures.

`codex-plugin` is a contextual built-in specialist. It appears only when a user turn includes an active `@Codex` plugin selector, and Forge binds that worker to the server-stored selector scope. Normal scoped plugin tools return bounded preview/metadata only. Full connector exports, such as Fireflies transcripts or summaries, must use the scoped export artifact tool, which writes redacted JSON artifacts under the session and returns only path/metadata plus a bounded preview. If that scoped worker is stopped or fails, Forge can authorize retry only for an explicit retry/continuation turn that refers to the same Codex/plugin context; unrelated turns require a fresh selector tag.

### Resolution Order

When resolving the roster for a Builder profile:
1. Profile-specific specialists whose `TargetSpace` includes `builder` (in `~/.forge/profiles/<profileId>/specialists/`)
2. Global specialists whose `TargetSpace` includes `builder` (in `~/.forge/shared/specialists/`)

When resolving a collaboration channel roster:
1. Channel-local specialists (in `~/.forge/profiles/_collaboration/sessions/<sessionId>/specialists/`)
2. Selected global specialists whose `TargetSpace` includes `collaboration` (in `~/.forge/shared/specialists/`)

Profile or channel-local files shadow global files with the same handle. Collaboration category defaults select global handles for newly created channels only; existing channels keep their own selected-handle list in SQLite.
