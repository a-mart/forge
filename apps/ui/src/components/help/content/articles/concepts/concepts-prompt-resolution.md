The prompt system controls what instructions agents receive when they start working. Forge resolves prompts through three layers, checked in order.

## The three layers

1. **Profile** — Custom prompts you save for a specific profile. These live in your profile's prompt directory and take highest priority.
2. **Repo** — Prompts stored in the project repository (like `AGENTS.md`). These apply to anyone working in that repo.
3. **Builtin** — Default prompts that ship with Forge. These are the fallback when no profile or repo override exists.

Forge checks profile first. If it finds a matching prompt there, it uses it and stops looking. Otherwise it checks the repo layer, then falls back to builtins.

## What this means in practice

Say the builtin manager prompt works for most of your projects, but one project needs specific instructions about its deployment process. You save a profile-level prompt override for that project's profile. Other profiles keep using the builtin. If you later want to go back to the default, delete the profile override.

## Prompt preview

Open the system prompt viewer in chat to see the full prompt an agent is actually using. This shows the resolved result — not just the raw template, but the complete context including memory, project guidance, and any loaded skills. Use this when you want to understand exactly what instructions the agent is following.

## Archetypes

Archetypes are prompt templates for different agent roles — the default manager, Cortex, and others. Each archetype defines the base behavior for that kind of agent. Profile overrides layer on top of the archetype, so you can customize without replacing the whole prompt.

You can browse and edit prompts in **Settings > Prompts**.
