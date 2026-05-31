When you launch Forge for the first time, Cortex runs an onboarding step before any manager session is created. This captures a few basics so your managers can communicate in a way that fits you.

## What it asks

The onboarding form collects three things:

- **Your name** — Used in conversation so managers address you naturally.
- **Technical level** — Developer, technical non-developer, semi-technical, or non-technical. This adjusts how much managers explain and what assumptions they make.
- **Additional preferences** — Free text for anything else: whether you prefer concise or detailed responses, how much explanation you want, communication style, or any other instruction.

## Where preferences go

Your onboarding preferences are saved to the common knowledge file under a managed section. Every manager session across all profiles reads these on startup. This means a new manager already knows your name and how to adjust its communication — no repeat introductions.

The preferences are stored as structured facts in the knowledge base, not as raw form data. Cortex renders them into the common knowledge markdown alongside other cross-profile facts.

## Updating preferences later

You can change your onboarding preferences at any time from **Settings > General** under "Welcome preferences." Changes are saved to common knowledge immediately and apply to new sessions going forward. Existing sessions keep whatever context they started with.

## Skipping onboarding

If you skip onboarding on first launch, Forge moves straight to manager creation. You can fill in preferences later from Settings. Managers will still work — they just won't have your name or communication style until you add them.
