# Onboarding Static Greeting Report

## Summary
Implemented a static first-turn Cortex onboarding greeting so the opening message no longer invokes the LLM.

## Findings
1. `apps/backend/src/swarm/swarm-manager.ts`
   - Replaced the onboarding bootstrap prompt path with a direct `publishToUser(..., "speak_to_user", ...)` call.
   - Uses the exact fixed greeting text requested.
   - Preserves target channel metadata and still marks `firstPromptSentAt` after emission.
2. `apps/backend/src/swarm/operational/cortex-onboarding.md`
   - Updated onboarding instructions so the model starts only after the user responds.
   - Added explicit guidance not to repeat the greeting or re-ask for name / technical angle when already provided.
   - Removed obsolete opening examples and opening-shape guidance.
3. Validation
   - Backend typecheck passed: `cd apps/backend && pnpm exec tsc -p tsconfig.build.json --noEmit`

## Commit
- Commit message: `Make Cortex onboarding greeting static`

## Blockers
None.
