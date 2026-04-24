# Forge Model Catalog

Forge keeps its supported model metadata in one checked-in source of truth:

- `packages/protocol/src/model-catalog.ts`

That file defines the catalog in three layers:

- **providers**: runtime/provider behavior
- **families**: manager-facing preset groupings like `pi-codex`
- **models**: concrete model metadata used by runtime and UI

## Source of truth rules

When adding or updating supported models:

1. Edit `packages/protocol/src/model-catalog.ts`
2. Run the catalog tests
3. Run the audit script against Pi upstream
4. Update any intentional divergence notes if needed

Do **not** add model metadata in frontend fallback constants, ad-hoc backend maps, or provider-specific extensions.

## Runtime flow

Forge owns model metadata end-to-end:

1. The checked-in catalog defines the baseline model metadata.
2. Optional local user overrides are stored in `~/.forge/shared/config/model-overrides.json`.
3. Backend merges catalog + overrides.
4. Backend generates a Pi-compatible projection at `~/.forge/shared/cache/generated/pi-models.json`.
5. Every Pi `ModelRegistry` is constructed with that generated projection path.
6. Request-time provider quirks (currently xAI Responses shaping + native search injection) are handled by `apps/backend/src/swarm/model-catalog-request-behaviors.ts`.

## Override semantics

Local overrides are intentionally narrow and safe.

Supported fields:

- `enabled`: control whether a model can appear in manager-facing selectors, including create-session, change-default, and per-session override flows
- `contextWindowCap`: cap the effective context window

### Context window cap semantics

Caps are applied with `min`, not replacement.

- catalog context window: `1_000_000`
- override cap: `300_000`
- effective context window: `300_000`

Overrides can reduce limits, but never increase them above the checked-in catalog value.

## Audit workflow

When upgrading Pi model dependencies, run:

```bash
pnpm model-catalog:audit
```

The audit reports:

- curated Forge models missing upstream
- upstream models not yet curated by Forge
- metadata drift for curated models
- intentional divergences recorded in the catalog

## Common maintenance tasks

### Add a routine model under an existing provider

Usually this is a one-file change in `packages/protocol/src/model-catalog.ts`.

Checklist:

1. Add/update the model entry
2. Confirm family membership and default selection
3. Confirm reasoning/input/web-search metadata
4. Run `pnpm model-catalog:audit`
5. Run typechecks and tests

### Add a new provider behavior

This usually requires more than a catalog edit. You may also need to update:

- request behavior adapters
- auth/settings UI
- runtime projection logic
- provider availability checks

## Files involved

- Shared catalog: `packages/protocol/src/model-catalog.ts`
- Backend catalog service: `apps/backend/src/swarm/model-catalog-service.ts`
- Pi projection generator: `apps/backend/src/swarm/model-catalog-projection.ts`
- Request behavior adapters: `apps/backend/src/swarm/model-catalog-request-behaviors.ts`
- Local overrides persistence: `apps/backend/src/swarm/model-overrides.ts`
- Audit script: `scripts/model-catalog-audit.mjs`
