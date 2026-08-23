# Adding or Updating Models

Forge treats the checked-in model catalog as the source of truth. Adding a model affects shared metadata, runtime resolution, selector eligibility, and sometimes deliberate fallback policy. Do not add a UI-only or provider-local model list.

## 1. Define the catalog entry

Start in [`packages/protocol/src/model-catalog-data.ts`](../packages/protocol/src/model-catalog-data.ts). It contains the checked-in provider, family, and concrete-model records. [`model-catalog-types.ts`](../packages/protocol/src/model-catalog-types.ts) defines the contract, and [`model-catalog.ts`](../packages/protocol/src/model-catalog.ts) is the public export surface.

For an existing provider, add the concrete model record and place it in the correct family. For a new family, define the family default and explicit visibility flags. Record only verified values for:

- provider and exact model ID;
- family/default membership and selector visibility;
- reasoning options and default;
- context and output limits;
- input modes and web-search capability; and
- any intentional divergence from upstream metadata.

Do not invent variants or capabilities. Keep a model unavailable by default when its provider/auth/runtime path is not ready.

## 2. Audit runtime and policy seams

A catalog entry makes a model selectable only where its visibility and provider state allow it. Audit these consumers and update only the policies that genuinely need the new model:

- [`apps/backend/src/swarm/catalog/`](../apps/backend/src/swarm/catalog/) for catalog merging, projection, request behavior, and local overrides;
- [`apps/backend/src/swarm/swarm-manager-utils.ts`](../apps/backend/src/swarm/swarm-manager-utils.ts) for the synthetic Pi bridge and OpenAI Codex capacity fallback chain;
- [`apps/backend/src/swarm/project-agent-coordinator.ts`](../apps/backend/src/swarm/project-agent-coordinator.ts) for the bounded project-agent-analysis candidate policy; and
- [`apps/backend/src/swarm/agents/specialists/`](../apps/backend/src/swarm/agents/specialists/) and delegation presets for explicit model/fallback choices.

Do not retune all specialists simply because a stronger model exists. A roster specialist is an explicit execution policy; change its primary, availability fallback, or escalation route only when the product decision calls for it. Preserve existing persisted descriptors and compatibility aliases unless the migration explicitly replaces them.

### User-added OpenRouter overlays

OpenRouter models added by a user are persisted overlays, not checked-in catalog entries. They are manager-eligible only when live OpenRouter metadata verifies `supportsTools: true`, the per-model manager override is explicitly enabled with the exact `openrouter:<model-id>` key, and an OpenRouter credential is configured. The default is manager-off; no family or preset fallback is created. When OpenRouter settings load, Forge automatically reconciles legacy rows against current live tool metadata; rows that cannot be matched or refreshed remain non-manager rows until a later retry succeeds. OpenRouter manager eligibility is separate from compaction, and retired OpenRouter IDs fail closed rather than being migrated across providers.

## 3. Handle models that Pi has not shipped yet

Pi-backed models normally resolve through Pi's registry. If Forge must support a checked-in model before Pi does, add a narrow synthetic blueprint entry in `SYNTHETIC_PI_MODEL_BLUEPRINTS` in `swarm-manager-utils.ts`, based on a verified compatible Pi model. The exact runtime resolver overlays Forge's catalog metadata on that blueprint.

This is a temporary compatibility seam, not a second catalog. Remove the synthetic entry once the installed Pi registry supports the exact model, after confirming projection and request behavior still match.

Native providers such as Cursor SDK do not use a Pi synthetic bridge. Their records must instead match the provider runtime's verified model IDs and supported parameters.

## 4. Validate the complete path

Run the focused catalog and backend tests first, then the repository validation appropriate to the change:

```bash
pnpm model-catalog:audit
(cd packages/protocol && pnpm exec vitest run src/__tests__/model-catalog.test.ts)
(cd apps/backend && pnpm exec vitest run src/swarm/__tests__/model-catalog-projection.test.ts)
pnpm quality:changed
```

Add or update targeted tests for the model entry, projection/availability behavior, and any explicit fallback or specialist policy you changed. If the protocol package was changed, build it before backend tests that consume its built export:

```bash
(cd packages/protocol && pnpm build)
```

Also verify selector behavior with the relevant provider credentials or entitlement state. Catalog availability, provider authentication, and manager/specialist visibility are separate gates.

## Related references

- [Model Catalog](MODEL_CATALOG.md) — catalog architecture, override semantics, and audit output
- [Specialists](SPECIALISTS.md) — delegation presets, roster specialists, and fallback policy
- [Quality](QUALITY.md) — supported validation tiers
