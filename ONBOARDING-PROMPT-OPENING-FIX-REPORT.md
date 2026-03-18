# Onboarding Prompt Opening Fix Report

## Summary
Updated the Cortex onboarding prompt opening guidance in `apps/backend/src/swarm/operational/cortex-onboarding.md` to make the first message more concrete, more personalized, and lower-friction.

## Changes
- Replaced the old generic opening guidance with explicit instructions to:
  - ask for the user's name first
  - ask one concrete calibration follow-up
  - keep skip available without leading with it
  - avoid vague, open-ended fishing prompts
- Replaced the opening examples with direct name-first examples matching the desired tone.
- Updated the example conversations so the assistant asks for the user's name in the opening instead of treating it as an afterthought.

## Validation
- Backend typecheck: `cd apps/backend && pnpm exec tsc -p tsconfig.build.json --noEmit`
- UI typecheck: `cd apps/ui && pnpm exec tsc --noEmit`

## Artifacts
- Updated prompt: `apps/backend/src/swarm/operational/cortex-onboarding.md`
