The Prompts pane lets you browse and edit the system prompts that shape how agents behave. Prompts are scoped to a profile, so different managers can have different prompts.

## How prompt resolution works

Forge resolves prompts in three layers:

1. **Profile override** — a prompt you edited for a specific profile (highest priority)
2. **Repo prompt** — a project-level prompt from the repo
3. **Builtin default** — the prompt that ships with Forge (lowest priority)

When you edit a prompt here, you're creating a profile override. If you delete the override, Forge falls back to the next layer.

## Browsing prompts

1. Select a **profile** from the dropdown (if you have more than one).
2. Pick a **category**: Archetypes (persona-level prompts) or Operational (task-specific prompts).
3. Select a **prompt** from the list.

The editor shows the current prompt text with a source indicator showing where it came from.

## Cortex surfaces

If Cortex is enabled, a third category appears: **Cortex Surfaces**. These are grouped into system templates, seed templates, live files, and scratch surfaces. Cortex surfaces are managed separately because capture checks and entry consolidation can update Cortex-managed files while Knowledge v2 is on.

When viewing the Cortex profile, the category picker is hidden and all items are shown in a single grouped dropdown.

## Preview

Click the **Preview** button (eye icon) to see the complete runtime context a new session would receive. The preview shows every section: system prompt, memory, AGENTS.md content, loaded skills, and more. This is useful for understanding exactly what an agent sees when it starts.
