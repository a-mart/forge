The prompt system controls what instructions agents receive when they start working. Forge resolves prompts through three layers, checked in order.

## The three layers

1. **Profile** — Custom prompts you save for a specific profile. These live in your profile's prompt directory and take highest priority.
2. **Repo** — Prompts stored in the project repository (like `AGENTS.md`). These apply to anyone working in that repo.
3. **Builtin** — Default prompts that ship with Forge. These are the fallback when no profile or repo override exists.

Forge checks profile first. If it finds a matching prompt there, it uses it and stops looking. Otherwise it checks the repo layer, then falls back to builtins.

## What this means in practice

Say the builtin manager prompt works for most of your projects, but one project needs specific instructions about its deployment process. You save a profile-level prompt override for that project's profile. Other profiles keep using the builtin. If you later want to go back to the default, delete the profile override.

## Prompt inspection

Open the **Initial Model Input** viewer from the wide chat header's **All** view to inspect the retained provider-independent context for a session's first Pi model request. Its default **Prompt** view shows that request's resolved prompt as provenance-labeled sections and renders structured tool definitions; switch to **Raw JSON** to inspect the complete captured record, including provider-independent messages and safe request metadata. It is not a live preview of a later or current prompt. Use it to understand what was sent on that first request; use **Settings > Prompts** to inspect or change prompt sources.

## Archetypes

Archetypes are prompt templates for different agent roles — the default manager, Cortex, and others. Each archetype defines the base behavior for that kind of agent. Profile overrides layer on top of the archetype, so you can customize without replacing the whole prompt.

You can browse and edit prompts in **Settings > Prompts**.
