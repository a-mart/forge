# Local context for `apps/ui/src/components/settings`

Keep settings changes modular. The settings surfaces rely on hook-driven state and small presentational pieces, so avoid collapsing logic into large monolithic components.

## SettingsSpecialists

`SettingsSpecialists.tsx` is the main entry point. It is assembled from submodules in `specialists/` and hook logic in `specialists/hooks/`.

Common building blocks include:
- `SpecialistCard`
- `NewSpecialistForm`
- `FallbackModelSection`
- `RosterPromptDialog`
- `PendingSaveDialog`
- supporting field and picker components in `specialists/`

State management is hook-based. Do not introduce external state libraries for this area.

The scope-reset effect ordering in `useSpecialistsData` is deliberate. The reset effect for `selectedScope` must stay declared before the load effect so the request id is bumped before `loadSpecialists` captures it. Reordering those effects can reintroduce stale loads.

Key test:
- `apps/ui/src/components/settings/SettingsSpecialists.test.tsx`

## General

Prefer small presentational components and focused hooks over widening shared state across the settings pages.