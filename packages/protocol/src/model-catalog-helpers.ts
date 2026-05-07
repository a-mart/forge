import { FORGE_MODEL_CATALOG } from './model-catalog-data.js'
import type {
  ForgeFamilyDefinition,
  ForgeModelDefinition,
  ForgeProviderCredentialSummary,
  ForgeServiceTier,
  ForgeProviderDefinition,
  ModelOverrideEntry,
  SessionFastModePolicy,
} from './model-catalog-types.js'

const CATALOG_PROVIDERS = FORGE_MODEL_CATALOG.providers as Record<string, ForgeProviderDefinition>
const CATALOG_FAMILIES = FORGE_MODEL_CATALOG.families as Record<string, ForgeFamilyDefinition>
const CATALOG_MODELS = FORGE_MODEL_CATALOG.models as Record<string, ForgeModelDefinition>

export function normalizeForgeServiceTier(value: unknown): ForgeServiceTier | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const normalized = value.trim().toLowerCase()
  if (normalized === 'priority') {
    return 'priority'
  }
  if (normalized === 'default' || normalized === '') {
    return 'default'
  }
  return undefined
}

export function getEffectiveForgeServiceTier(descriptor?: { serviceTier?: unknown } | null): ForgeServiceTier {
  const normalized = normalizeForgeServiceTier(descriptor?.serviceTier)
  return normalized === 'priority' ? 'priority' : 'default'
}

export function normalizeSessionFastModePolicy(value: unknown): SessionFastModePolicy | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const record = value as Record<string, unknown>
  if (typeof record.enabled !== 'boolean') {
    return undefined
  }
  return {
    enabled: record.enabled,
    ...(typeof record.updatedAt === 'string' && record.updatedAt.trim() ? { updatedAt: record.updatedAt } : {}),
  }
}

export function isSessionFastModeEnabled(policy?: SessionFastModePolicy | null): boolean {
  return policy?.enabled === true
}

export function isFastModeServiceTier(tier: unknown): boolean {
  return normalizeForgeServiceTier(tier) === 'priority'
}

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
export function getCatalogContextWindow(modelId: string, provider?: string): number | undefined {
  return getCatalogModel(modelId, provider)?.contextWindow
}

export function getModelServiceTierCapability(modelId: string, provider?: string) {
  return getCatalogModel(modelId, provider)?.serviceTierCapability
}

export function isServiceTierSupportedForModel(
  model: { provider: string; modelId: string },
  tier: ForgeServiceTier,
): boolean {
  if (tier === 'default') {
    return true
  }
  const capability = getModelServiceTierCapability(model.modelId, model.provider)
  return capability?.supportedTiers.includes(tier) === true
}

export function getServiceTierCostMultiplier(
  model: { provider: string; modelId: string },
  tier: ForgeServiceTier,
): number | undefined {
  const normalizedTier = normalizeForgeServiceTier(tier)
  if (!normalizedTier) {
    return undefined
  }
  if (normalizedTier === 'default') {
    return 1
  }
  return getModelServiceTierCapability(model.modelId, model.provider)?.costMultipliers[normalizedTier]
}

export function isOpenAICodexChatGptAuthAvailable(summary?: ForgeProviderCredentialSummary | null): boolean {
  return summary?.configured === true && (
    summary.chatgptAuthAvailable === true || summary.authTypes.includes('oauth')
  )
}

export type ManagerModelSurface = 'create' | 'change'

function isCatalogModelGloballyEnabled(
  model: ForgeModelDefinition,
  override: ModelOverrideEntry | undefined,
): boolean {
  return override?.enabled ?? model.enabledByDefault
}

/** Check whether a catalog model's family supports the requested manager selector surface. */
export function isCatalogModelManagerSupported(
  model: ForgeModelDefinition,
  surface: ManagerModelSurface,
): boolean {
  const family = getCatalogFamily(model.familyId)
  if (!family) {
    return false
  }

  return surface === 'create' ? family.visibleInCreateManager : family.visibleInChangeManager
}

/** Compute the default manager-enabled state for a catalog model on the requested surface. */
export function getDefaultManagerEnabled(
  model: ForgeModelDefinition,
  surface: ManagerModelSurface,
): boolean {
  return isCatalogModelManagerSupported(model, surface) && model.enabledByDefault
}

/** Compute the effective manager-enabled state for a catalog model on the requested surface. */
export function getEffectiveManagerEnabled(
  model: ForgeModelDefinition,
  override: ModelOverrideEntry | undefined,
  surface: ManagerModelSurface,
): boolean {
  const globallyEnabled = isCatalogModelGloballyEnabled(model, override)
  if (!globallyEnabled) {
    return false
  }

  if (!isCatalogModelManagerSupported(model, surface)) {
    return false
  }

  return override?.managerEnabled ?? getDefaultManagerEnabled(model, surface)
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
