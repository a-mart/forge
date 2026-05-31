Specialists are named worker templates that tell the manager which model, reasoning level, and system prompt to use for different kinds of tasks. Instead of a single generic worker, you can have a backend specialist running Codex and a frontend specialist running GPT-5.5 at medium reasoning, each with tailored instructions.

Forge also ships collaboration-focused builtins such as `collab-planner`, `collab-reviewer`, `collab-doc-writer`, `collab-scout`, and `collab-researcher` for channel work that needs project-context aware roles.

## Global vs. profile scope

Use the scope dropdown to switch between:

- **Global** — specialists shared across all profiles. Builtin specialists live here.
- **Per-profile** — overrides that apply to one profile only, taking priority over global definitions.

## Builder vs. Collaboration visibility

Specialists are TargetSpace-aware. The Builder roster shows the local Builder set, while Collaboration mode shows the collaboration set for the active channel or server context. That keeps channel-only helpers out of the Builder roster and keeps Builder-only definitions out of Collab views.

## Collaboration scopes

Collab Settings supports three scopes:

- **Global** — shared collaboration specialists available to all channels.
- **Category** — the default specialists selected for new channels in that category.
- **Channel** — the active selected specialists for one channel session, plus channel-local specialist CRUD.

Channel-local specialists live at `profiles/_collaboration/sessions/<channelSessionId>/specialists/<handle>.md` and shadow any global specialist with the same handle inside that channel.

Skill selection (all/custom mode per category or channel) is managed on the **Skills** settings page, not here.

## Filtering the roster

When you have disabled specialists, a **Hide disabled** checkbox appears next to the toolbar buttons. Check it to filter disabled specialists from all sections. The preference persists across sessions.

## Enabling specialists

The global toggle at the top turns the specialist system on or off. When disabled, the manager uses legacy model routing guidance instead. Leave it enabled unless you have a specific reason to turn it off.

## Creating a specialist

1. Click **New Specialist**.
2. Enter a handle (kebab-case identifier) and display name.
3. Click **Create**. The specialist opens in edit mode with a default prompt.
4. Set the model, reasoning level, color, and "when to use" description.
5. Edit the prompt body to describe this specialist's focus.
6. Click **Save**.

## Project agent session creation

If a project agent has the **Can create sessions** toggle enabled in its settings, it can create new manager sessions in the same profile. Those created sessions can show creator attribution in the sidebar, and the creator keeps using the normal messaging path.

## Model and fallback

Each specialist has a primary model and reasoning level. You can also set a fallback model that takes over if the primary is unavailable or rate-limited. Recoverable failures are retried silently inside worker/runtime fallback replay or handoff before the manager sees an error, and successful fallback is invisible to the manager and user. Only exhausted fallback failures bubble up. Built-in specialists generally use cross-vendor fallbacks when practical. The built-in `web-researcher` follows normal fallback/model config semantics and uses Brave-backed research guidance on OpenAI Codex `gpt-5.4-mini`. Expand the fallback section to configure it.

## Specialist web research

Forge's current production web research path is the built-in `web-researcher`, which uses Brave-backed research guidance. xAI native web/X search is not a current production path unless a future adapter enables it.

## Pinning

Builtin specialists are updated when Forge updates. If you customize a builtin, enable **Pin customizations** to prevent your changes from being overwritten. Without pinning, Forge warns you before saving.

## Profile overrides

When viewing a profile scope, inherited specialists appear below your overrides. Click an inherited specialist to create a profile-specific copy you can customize. Use **Revert** to delete the override and return to the inherited version.

## Roster prompt

In profile scope, click **Roster Prompt** to see the specialist roster block that gets injected into the manager's system prompt. This shows exactly what the manager knows about its available specialists.
