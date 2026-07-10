When you launch Forge for the first time, Cortex asks for a few basics before manager creation so managers can communicate in a way that fits you.

## What it asks

- **Your name** — Helps managers address you naturally.
- **Technical level** — Developer, technical non-developer, semi-technical, or non-technical.
- **Additional preferences** — Free text for response detail, explanation level, communication style, or other instructions.

## Where preferences go

Forge always stores the structured onboarding state. Where it renders those preferences depends on the separate Knowledge v2 switch:

- With v2 OFF, Forge renders and updates a managed preferences block in legacy `shared/knowledge/common.md`, which is part of the legacy common + profile + session prompt context.
- With v2 ON, Forge upserts global v2 preference entries instead of updating that legacy block. Prompts use global/profile v2 indexes plus session memory; legacy `common.md` is preserved during normal switching, while canonical profile memory continues to be maintained, but neither is prompt-injected.

## Updating preferences later

Change onboarding preferences from **Settings > General** under **Welcome preferences**. Forge updates the structured onboarding state, then applies the preferences through the active knowledge mode: the managed legacy block while v2 is OFF, or global v2 preference entries while v2 is ON. The active store supplies those preferences to future manager sessions.

## Knowledge v2 onboarding

The separate **Try the new Cortex** prompt does not perform migration. A successful guarded migration commits a valid manifest and immediately activates v2. If activation persistence fails, or if you later disable v2, that manifest authorizes an ordinary enable action; without it, onboarding sends no activation request.

Normal switching preserves both stores. Disabling v2 restores legacy prompt sources while the original legacy files remain. Explicit confirmed cleanup archives and removes those originals, after which OFF alone cannot restore their prior content.

## Skipping onboarding

If you skip the welcome form, Forge moves to manager creation. You can fill in preferences later from Settings. Managers still work without those optional details.
