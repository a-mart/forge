# Named Specialists

Named specialists are configurable worker spawn templates that let you define specialized worker personas with specific models, reasoning levels, and system prompts. The manager uses the specialist roster to decide which worker profile to use for each task.

## How It Works

Each specialist is a **markdown file with YAML frontmatter**. The filename (without `.md`) becomes the specialist's handle (kebab-case). The manager sees the full roster in its prompt and can spawn workers using any enabled specialist.

## File Locations

- **Global specialists** (shared across all profiles): `~/.forge/shared/specialists/<handle>.md`
- **Profile-specific specialists**: `~/.forge/profiles/<profileId>/specialists/<handle>.md`

Profile specialists shadow global ones with the same filename. Forge ships with builtin specialists that are seeded to the global directory on startup.

## Frontmatter Fields

```yaml
---
displayName: Backend Engineer        # Required — human-readable name shown in UI and badges
color: "#2563eb"                     # Required — hex color (click color swatch in UI to pick)
handle: backend-engineer             # Optional — specialist handle (defaults to filename without .md)
enabled: true                        # Required — whether the manager can use this specialist
whenToUse: >-                        # Required — guidance for the manager on when to pick this specialist
  Backend/core implementation, TypeScript refactors, debugging server routes
modelId: gpt-5.3-codex              # Required — the model ID to use
reasoningLevel: high                 # Optional — defaults to model preset default
fallbackModelId: claude-sonnet-4-5-20250929  # Optional — model if primary is unavailable (can be cross-provider)
fallbackReasoningLevel: medium       # Optional — reasoning for fallback (defaults to primary)
pin: true                            # Optional — pin to top of sidebar list
builtin: true                        # Internal — marks Forge-shipped specialists (do not set manually)
---
```

## Available Models

| Model ID | Display Name | Provider | Supported Reasoning Levels |
|---|---|---|---|
| `gpt-5.3-codex` | GPT-5.3 Codex | OpenAI Codex | none, low, medium, high, xhigh |
| `gpt-5.3-codex-spark` | GPT-5.3 Codex Spark | OpenAI Codex | none, low, medium, high, xhigh |
| `gpt-5.4` | GPT-5.4 | OpenAI Codex | none, low, medium, high, xhigh |
| `gpt-5.4-mini` | GPT-5.4 Mini | OpenAI Codex | none, low, medium, high, xhigh |
| `claude-opus-4-6` | Claude Opus 4.6 | Anthropic | low, medium, high |
| `claude-sonnet-4-5-20250929` | Claude Sonnet 4.5 | Anthropic | low, medium, high |
| `claude-haiku-4-5-20251001` | Claude Haiku 4.5 | Anthropic | low, medium, high |
| `grok-4` | Grok 4 | xAI | none, low, medium, high, xhigh |
| `grok-4-fast` | Grok 4 Fast | xAI | none, low, medium, high, xhigh |
| `grok-4.20-0309-reasoning` | Grok 4.20 Reasoning | xAI | none, low, medium, high, xhigh |
| `grok-4.20-0309-non-reasoning` | Grok 4.20 Non-Reasoning | xAI | none, low, medium, high, xhigh |

**Notes:**
- The table above shows models currently available in the Forge catalog. Some models listed in upstream Pi releases may not yet be curated into Forge.
- For the authoritative, up-to-date model list with availability status, see **Settings → Models** in the UI.
- xAI models require `XAI_API_KEY` to be configured (see Settings → Authentication).
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
fallbackModelId: claude-opus-4-6
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

**Built-in specialists intentionally pair across vendors when practical** for resilience: OpenAI-primary builtins generally fall back to Anthropic, and Anthropic-primary builtins generally fall back to OpenAI. Specialists with defining provider-native capabilities, like `web-researcher`, may intentionally stay on the same provider.

**Cross-provider fallback is fully supported**: You can use a model from a different provider as your fallback (e.g., primary `grok-4`, fallback `claude-sonnet-4-5-20250929`). This is exercised silently inside runtime recovery and is useful for provider outages or rate limit mitigation.

### Resolution Order

When resolving the roster for a profile:
1. Profile-specific specialists (in `~/.forge/profiles/<profileId>/specialists/`)
2. Global specialists (in `~/.forge/shared/specialists/`)

Profile files shadow global files with the same handle.
