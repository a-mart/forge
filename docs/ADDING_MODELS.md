# Adding a new OpenAI Codex model

Forge treats the model catalog as the source of truth. Adding a new Pi-side OpenAI Codex model is not a one-file change. In practice you update the catalog first, then the prompt instructions, then the backend fallbacks that assume a known set of Codex models.

This guide is the minimal path for adding a new model like GPT-5.5.

## 1. Update the catalog in `packages/protocol/src/model-catalog-data.ts`

Start here.

Add a new family entry and the new model entries under `FORGE_MODEL_CATALOG`.

For GPT-5.5, the family is:

```ts
'pi-5.5': {
  familyId: 'pi-5.5',
  displayName: 'GPT-5.5',
  provider: 'openai-codex',
  defaultModelId: 'gpt-5.5',
  defaultReasoningLevel: 'xhigh',
  visibleInCreateManager: true,
  visibleInChangeManager: true,
  visibleInSpawnPreset: true,
  visibleInSpecialists: true,
},
```

Then add model entries such as:

```ts
'gpt-5.5': {
  modelId: 'gpt-5.5',
  provider: 'openai-codex',
  familyId: 'pi-5.5',
  displayName: 'GPT-5.5',
  isFamilyDefault: true,
  supportsReasoning: true,
  supportedReasoningLevels: ['none', 'low', 'medium', 'high', 'xhigh'],
  defaultReasoningLevel: 'xhigh',
  contextWindow: 272_000,
  maxOutputTokens: 128_000,
  inputModes: ['text', 'image'],
  webSearchCapability: 'none',
  enabledByDefault: true,
  piUpstreamId: 'gpt-5.5',
  intentionalDivergenceNotes: null,
},
'gpt-5.5-mini': {
  modelId: 'gpt-5.5-mini',
  provider: 'openai-codex',
  familyId: 'pi-5.5',
  displayName: 'GPT-5.5 Mini',
  isFamilyDefault: false,
  supportsReasoning: true,
  supportedReasoningLevels: ['none', 'low', 'medium', 'high', 'xhigh'],
  defaultReasoningLevel: 'high',
  contextWindow: 272_000,
  maxOutputTokens: 128_000,
  inputModes: ['text', 'image'],
  webSearchCapability: 'none',
  enabledByDefault: true,
  piUpstreamId: 'gpt-5.5-mini',
  intentionalDivergenceNotes: null,
},
```

A few practical notes:

- The family entry controls UI visibility and defaults. That is what makes the model family show up in create/change manager flows, spawn presets, and specialist selection.
- The model entries define the actual spec shape: context window, max output tokens, supported reasoning levels, input modes, and `piUpstreamId`.
- Mirror an existing same-provider model when you are unsure about shape or defaults. For GPT-5.5, GPT-5.4 is the closest template.
- Keep the catalog entry consistent with the rest of the provider family. If the upstream model is a new top-tier Codex option, the default reasoning level usually stays `xhigh`.

## 2. Update model-specific prompt instructions in `packages/protocol/src/model-prompt-instructions.ts`

Add the new family ID to the GPT-5 instruction check.

The built-in GPT-5 instruction block is selected with a `normalizedFamilyId.startsWith(...)` condition. Make sure the new family is included there, for example:

```ts
if (
  normalizedFamilyId.startsWith('pi-codex') ||
  normalizedFamilyId.startsWith('pi-5.4') ||
  normalizedFamilyId.startsWith('pi-5.5')
) {
  return GPT5_MODEL_SPECIFIC_INSTRUCTIONS;
}
```

This keeps the runtime prompt guidance aligned with the new family.

## 3. Update project-agent analysis fallbacks in `apps/backend/src/swarm/swarm-manager.ts`

Project-agent analysis has a hard-coded candidate list and a hard-coded error message.

Add the new Codex model to the candidate list in priority order. For GPT-5.5, the list should now include both GPT-5.4 and GPT-5.5, with GPT-5.5 after GPT-5.4.

Also update the fallback error text so it matches the new tried chain. Otherwise failures will report stale model names.

## 4. Update Codex capacity fallback ordering in `apps/backend/src/swarm/swarm-manager-utils.ts`

Add the new model to `OPENAI_CODEX_CAPACITY_FALLBACK_CHAIN`.

That chain drives the capacity fallback path for OpenAI Codex models. If you add a model to the catalog but forget this chain, fallback logic can stop at the wrong model or skip the new one entirely.

## 5. Update specialist preset routing in `apps/backend/src/swarm/agents/specialists/specialist-registry.ts`

If the new model is the new top-tier Codex option, update the `complexCodingPreset` family reference.

The current guidance points complex coding work at `pi-5.5` when it exists, with a fallback to the string literal. When the next top-tier family arrives, move that reference to the new family so specialist routing stays current.

## Runtime bridge for models not yet in Pi upstream

Pi has its own built-in model registry, and Forge normally resolves models through that registry first.

If the new model is not in Pi upstream yet, Forge still has a synthetic resolution bridge in the backend runtime path. The relevant helper is `resolveExactModel()` in `apps/backend/src/swarm/swarm-manager-utils.ts`, and it is used by `apps/backend/src/swarm/runtime/runtime-factory.ts` when a runtime needs an exact Pi model.

The bridge works by:

- looking up a known blueprint model in Pi, such as GPT-5.4 for GPT-5.5
- copying the blueprint model object
- replacing the id, name, reasoning flag, input modes, context window, and max tokens with the Forge catalog values

This unblocks runtime use before Pi ships native support. Once upstream adds the model, clean up the synthetic bridge and let the native Pi registry resolve it directly.

## What does not need to change

Do not add or edit specialist `.md` files just to expose the model. Specialist configs are catalog-driven, so the new family becomes available automatically once the catalog is updated.

Do not touch UI code for model selectors. The selectors read from the catalog.

Do not change the Codex app-server SDK path. That is a separate runtime path.

Do not widen protocol types for `familyId`. `packages/protocol/src/model-catalog-types.ts` already uses `string`, not a union.

## Validation checklist

Run the standard checks after the change:

```bash
pnpm lint
pnpm exec knip
pnpm test
cd apps/backend && pnpm exec tsc -p tsconfig.build.json --noEmit
cd apps/ui && pnpm exec tsc --noEmit
```

If the protocol package changed, rebuild it too:

```bash
cd packages/protocol && pnpm build
```

Backend tests resolve the built `dist` export, so skipping the protocol build can make the test run look broken even when the source change is correct.

## Test coverage to update

These are the test files that usually need an update when a new model is added:

- `packages/protocol/src/__tests__/model-catalog.test.ts`
- `packages/protocol/src/__tests__/model-prompt-instructions.test.ts`
- `apps/backend/src/swarm/__tests__/swarm-manager-utils.test.ts`
- `apps/backend/src/swarm/__tests__/model-presets.test.ts`
- any snapshot or registry tests that enumerate the full model list

If a test asserts the exact set or order of model ids, add the new model there as well. Those tests are usually the first place a missed catalog entry shows up.
