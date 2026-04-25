import { FORGE_MODEL_CATALOG } from './model-catalog-data.js'
import type {
  ForgeFamilyDefinition,
  ForgeModelDefinition,
  ForgeProviderDefinition,
} from './model-catalog-types.js'

const CATALOG_PROVIDERS = FORGE_MODEL_CATALOG.providers as Record<string, ForgeProviderDefinition>
const CATALOG_FAMILIES = FORGE_MODEL_CATALOG.families as Record<string, ForgeFamilyDefinition>
const CATALOG_MODELS = FORGE_MODEL_CATALOG.models as Record<string, ForgeModelDefinition>

/** Return the stable catalog key for a model definition. */
export function getCatalogModelKey(model: ForgeModelDefinition): string {
  return model.catalogId ?? model.modelId
}

/** Lookup a model by catalog key or by provider + modelId. Returns undefined if not in catalog. */
export function getCatalogModel(modelId: string, provider?: string): ForgeModelDefinition | undefined {
  const trimmedModelId = modelId.trim()
  if (!trimmedModelId) {
    return undefined
  }

  const normalizedProvider = provider?.trim().toLowerCase()
  const exactMatch = CATALOG_MODELS[trimmedModelId] ?? CATALOG_MODELS[trimmedModelId.toLowerCase()]
  if (exactMatch && (!normalizedProvider || exactMatch.provider === normalizedProvider)) {
    return exactMatch
  }

  const normalizedModelId = trimmedModelId.toLowerCase()
  const matches = Object.values(CATALOG_MODELS).filter(
    (model) => model.modelId.toLowerCase() === normalizedModelId,
  )

  if (normalizedProvider) {
    return matches.find((model) => model.provider === normalizedProvider)
  }

  if (exactMatch) {
    return exactMatch
  }

  const providerScopedMatches = matches.filter((model) => model.catalogId && model.catalogId !== model.modelId)
  if (providerScopedMatches.length > 0) {
    return undefined
  }

  return matches[0]
}

/** Lookup a family by familyId. */
export function getCatalogFamily(familyId: string): ForgeFamilyDefinition | undefined {
  return CATALOG_FAMILIES[familyId]
}

/** Lookup a provider by providerId. */
export function getCatalogProvider(providerId: string): ForgeProviderDefinition | undefined {
  return CATALOG_PROVIDERS[providerId]
}

/** Get all models belonging to a family. */
export function getCatalogModelsByFamily(familyId: string): ForgeModelDefinition[] {
  const familyModels = Object.values(FORGE_MODEL_CATALOG.models).filter((model) => model.familyId === familyId)
  if (familyModels.length > 0) {
    return familyModels
  }

  const family = getCatalogFamily(familyId)
  if (!family) {
    return []
  }

  const fallbackDefaultModel = getCatalogModel(family.defaultModelId, family.provider)
  return fallbackDefaultModel ? [fallbackDefaultModel] : []
}

/** Get the family a model belongs to. */
export function getCatalogFamilyForModel(modelId: string, provider?: string): ForgeFamilyDefinition | undefined {
  const model = getCatalogModel(modelId, provider)
  return model ? getCatalogFamily(model.familyId) : undefined
}

/** Check if a model ID exists in the catalog. */
export function isCatalogModelId(modelId: string): boolean {
  return getCatalogModel(modelId) !== undefined
}

/** Infer provider from a catalog model ID. Returns null if not in catalog. */
export function inferCatalogProvider(modelId: string): string | null {
  return getCatalogModel(modelId)?.provider ?? null
}

/** Infer family from a model descriptor (provider + modelId). */
export function inferCatalogFamily(provider: string, modelId: string): string | undefined {
  const normalizedProvider = provider.trim().toLowerCase()
  const normalizedModelId = modelId.trim().toLowerCase()

  if (normalizedProvider === 'claude-sdk' && normalizedModelId === 'claude-sonnet-4-5-20250929') {
    return 'sdk-sonnet'
  }

  const model = getCatalogModel(normalizedModelId, normalizedProvider)
  if (model && model.provider === normalizedProvider) {
    return model.familyId
  }

  if (normalizedProvider === 'claude-sdk' && normalizedModelId.startsWith('claude-')) {
    return 'sdk-opus'
  }

  if (normalizedProvider === 'xai' && normalizedModelId.startsWith('grok-')) {
    return 'pi-grok'
  }

  return undefined
}

/** Get context window for a specific model ID. Returns undefined if unknown. */
export function getCatalogContextWindow(modelId: string): number | undefined {
  return getCatalogModel(modelId)?.contextWindow
}

/** Get families visible in manager create selector. */
export function getCreateManagerFamilies(): ForgeFamilyDefinition[] {
  return Object.values(FORGE_MODEL_CATALOG.families).filter((family) => family.visibleInCreateManager)
}

/** Get families visible in manager change-model selector. */
export function getChangeManagerFamilies(): ForgeFamilyDefinition[] {
  return Object.values(FORGE_MODEL_CATALOG.families).filter((family) => family.visibleInChangeManager)
}

/** Get families visible in spawn_agent preset schema. */
export function getSpawnPresetFamilies(): ForgeFamilyDefinition[] {
  return Object.values(FORGE_MODEL_CATALOG.families).filter((family) => family.visibleInSpawnPreset)
}

/** Get families visible in specialist model selectors. */
export function getSpecialistFamilies(): ForgeFamilyDefinition[] {
  return Object.values(FORGE_MODEL_CATALOG.families).filter((family) => family.visibleInSpecialists)
}
