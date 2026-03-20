# Onboarding Form Report

## Summary
Replaced the conversational Cortex onboarding flow with a simple welcome form and simplified onboarding persistence.

## What changed
- Added a first-launch welcome form with:
  - required name
  - technical level dropdown
  - optional additional preferences textarea with placeholder text
- Added settings support so the same preferences can be edited later.
- Simplified onboarding state to a direct JSON shape stored at `shared/knowledge/onboarding-state.json`.
- Kept onboarding preference injection into manager memory via `buildOnboardingSnapshotMemoryBlock()`.
- Kept managed `<!-- BEGIN/END MANAGED:ONBOARDING -->` rendering in `common.md`.
- Removed conversational onboarding prompt mode, greeting, extractor flow, onboarding tools, and onboarding-specific model preference resolution.
- Removed operational prompt metadata/definitions for the deleted onboarding prompts.
- Added legacy state migration support so old completed conversational onboarding is treated as completed in the new shape.

## Backend
- `GET /api/onboarding/state` now returns the simple state.
- Added `POST /api/onboarding/preferences` for save/skip.
- Removed the old onboarding status mutation flow.

## UI
- `OnboardingCallout.tsx` now renders the welcome form / ready state / settings editor.
- First launch now shows the form instead of routing into a Cortex onboarding conversation.
- Skip now writes `status: "skipped"`.

## Validation
- Backend typecheck: passed
- UI typecheck: passed
- Full test suite: passed

## Notes
- Deleted:
  - `apps/backend/src/swarm/operational/cortex-onboarding.md`
  - `apps/backend/src/swarm/operational/onboarding-extractor.md`
