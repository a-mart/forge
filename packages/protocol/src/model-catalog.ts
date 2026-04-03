/**
 * Forge Model Catalog — authoritative source of truth for all supported models.
 *
 * Add or update supported models here. Do not add model metadata in UI fallbacks,
 * ad-hoc route helpers, or provider-specific extensions.
 *
 * Schema: providers → families → models (model-centric first, families are a manager UX projection).
 */

export type ForgeProviderAvailabilityMode = 'managed-auth' | 'external'
export type ForgePiProjectionMode = 'built-in-overrides' | 'custom-provider-merge' | 'none'
export type ForgeProjectionScope = 'catalog-only' | 'full-upstream-provider'
export type ForgeRequestBehaviorId = 'xai-responses' | null
export type ForgeWebSearchCapability = 'none' | 'native'
export type ForgeInputMode = 'text' | 'image'
export type ForgeReasoningLevel = 'none' | 'low' | 'medium' | 'high' | 'xhigh'
export type ForgeModelApiProtocol =
  | 'openai-codex-responses'
  | 'openai-responses'
  | 'openai-completions'
  | 'anthropic'
  | null

export interface ForgeProviderDefinition {
  providerId: string
  displayName: string
  availabilityMode: ForgeProviderAvailabilityMode
  piProjectionMode: ForgePiProjectionMode
  /** Whether Pi projection emits only Forge-curated models or the provider's full upstream Pi inventory. */
  projectionScope: ForgeProjectionScope
  requestBehaviorId: ForgeRequestBehaviorId
  /** Base URL override for Pi projection custom providers */
  piBaseUrl?: string
  /** API key env var name for Pi projection custom providers */
  piApiKeyEnvVar?: string
  /** API protocol override for Pi projection */
  piApiProtocol?: Exclude<ForgeModelApiProtocol, null>
}

export interface ForgeFamilyDefinition {
  familyId: string
  displayName: string
  provider: string
  defaultModelId: string
  defaultReasoningLevel: ForgeReasoningLevel
  visibleInCreateManager: boolean
  visibleInChangeManager: boolean
  visibleInSpawnPreset: boolean
  visibleInSpecialists: boolean
}

export interface ForgeModelDefinition {
  modelId: string
  provider: string
  familyId: string
  displayName: string
  isFamilyDefault: boolean
  supportsReasoning: boolean
  supportedReasoningLevels: readonly ForgeReasoningLevel[]
  defaultReasoningLevel: ForgeReasoningLevel
  contextWindow: number
  maxOutputTokens: number
  inputModes: readonly ForgeInputMode[]
  webSearchCapability: ForgeWebSearchCapability
  enabledByDefault: boolean
  /** Pi upstream source metadata for audit; null for synthetic entries */
  piUpstreamId: string | null
  /** Notes when Forge intentionally diverges from Pi metadata */
  intentionalDivergenceNotes: string | null
}

export interface ForgeModelCatalog {
  providers: Record<string, ForgeProviderDefinition>
  families: Record<string, ForgeFamilyDefinition>
  models: Record<string, ForgeModelDefinition>
}

export interface ModelOverrideEntry {
  enabled?: boolean
  contextWindowCap?: number
}

export interface ModelOverridesFile {
  version: 1
  overrides: Record<string, ModelOverrideEntry>
}

export interface OpenRouterModelEntry {
  modelId: string
  displayName: string
  contextWindow: number
  maxOutputTokens: number
  supportsReasoning: boolean
  supportedReasoningLevels: readonly ForgeReasoningLevel[]
  inputModes: readonly ForgeInputMode[]
  addedAt: string
}

export interface OpenRouterModelsFile {
  version: 1
  models: Record<string, OpenRouterModelEntry>
}

export interface AvailableOpenRouterModel {
  modelId: string
  displayName: string
  upstreamProvider: string
  contextWindow: number
  maxOutputTokens: number
  supportsReasoning: boolean
  supportsTools: boolean
  inputModes: string[]
  pricing: {
    inputPerMillion: number
    outputPerMillion: number
  } | null
}

export const FORGE_MODEL_CATALOG = {
  providers: {
    'openai-codex': {
      providerId: 'openai-codex',
      displayName: 'OpenAI Codex',
      availabilityMode: 'managed-auth',
      piProjectionMode: 'built-in-overrides',
      projectionScope: 'catalog-only',
      requestBehaviorId: null,
    },
    anthropic: {
      providerId: 'anthropic',
      displayName: 'Anthropic',
      availabilityMode: 'managed-auth',
      piProjectionMode: 'built-in-overrides',
      projectionScope: 'catalog-only',
      requestBehaviorId: null,
    },
    xai: {
      providerId: 'xai',
      displayName: 'xAI',
      availabilityMode: 'managed-auth',
      piProjectionMode: 'custom-provider-merge',
      projectionScope: 'full-upstream-provider',
      requestBehaviorId: 'xai-responses',
      piBaseUrl: 'https://api.x.ai/v1',
      piApiKeyEnvVar: 'XAI_API_KEY',
      piApiProtocol: 'openai-responses',
    },
    openrouter: {
      providerId: 'openrouter',
      displayName: 'OpenRouter',
      availabilityMode: 'external',
      piProjectionMode: 'custom-provider-merge',
      projectionScope: 'catalog-only',
      requestBehaviorId: null,
      piBaseUrl: 'https://openrouter.ai/api/v1',
      piApiKeyEnvVar: 'OPENROUTER_API_KEY',
      piApiProtocol: 'openai-completions',
    },
    'openai-codex-app-server': {
      providerId: 'openai-codex-app-server',
      displayName: 'Codex App Runtime',
      availabilityMode: 'external',
      piProjectionMode: 'none',
      projectionScope: 'catalog-only',
      requestBehaviorId: null,
    },
  },

  families: {
    'pi-codex': {
      familyId: 'pi-codex',
      displayName: 'GPT-5.3 Codex',
      provider: 'openai-codex',
      defaultModelId: 'gpt-5.3-codex',
      defaultReasoningLevel: 'xhigh',
      visibleInCreateManager: true,
      visibleInChangeManager: true,
      visibleInSpawnPreset: true,
      visibleInSpecialists: true,
    },
    'pi-5.4': {
      familyId: 'pi-5.4',
      displayName: 'GPT-5.4',
      provider: 'openai-codex',
      defaultModelId: 'gpt-5.4',
      defaultReasoningLevel: 'xhigh',
      visibleInCreateManager: true,
      visibleInChangeManager: true,
      visibleInSpawnPreset: true,
      visibleInSpecialists: true,
    },
    'pi-opus': {
      familyId: 'pi-opus',
      displayName: 'Claude Opus 4.6',
      provider: 'anthropic',
      defaultModelId: 'claude-opus-4-6',
      defaultReasoningLevel: 'high',
      visibleInCreateManager: true,
      visibleInChangeManager: true,
      visibleInSpawnPreset: true,
      visibleInSpecialists: true,
    },
    'pi-grok': {
      familyId: 'pi-grok',
      displayName: 'Grok 4',
      provider: 'xai',
      defaultModelId: 'grok-4',
      defaultReasoningLevel: 'high',
      visibleInCreateManager: false,
      visibleInChangeManager: false,
      visibleInSpawnPreset: true,
      visibleInSpecialists: true,
    },
    'codex-app': {
      familyId: 'codex-app',
      displayName: 'Codex App Runtime',
      provider: 'openai-codex-app-server',
      defaultModelId: 'default',
      defaultReasoningLevel: 'xhigh',
      visibleInCreateManager: false,
      visibleInChangeManager: false,
      visibleInSpawnPreset: true,
      visibleInSpecialists: false,
    },
  },

  models: {
    // ── OpenAI Codex models ────────────────────────────────
    'gpt-5.3-codex': {
      modelId: 'gpt-5.3-codex',
      provider: 'openai-codex',
      familyId: 'pi-codex',
      displayName: 'GPT-5.3 Codex',
      isFamilyDefault: true,
      supportsReasoning: true,
      supportedReasoningLevels: ['none', 'low', 'medium', 'high', 'xhigh'],
      defaultReasoningLevel: 'xhigh',
      contextWindow: 272_000,
      maxOutputTokens: 128_000,
      inputModes: ['text', 'image'],
      webSearchCapability: 'none',
      enabledByDefault: true,
      piUpstreamId: 'gpt-5.3-codex',
      intentionalDivergenceNotes: null,
    },
    'gpt-5.3-codex-spark': {
      modelId: 'gpt-5.3-codex-spark',
      provider: 'openai-codex',
      familyId: 'pi-codex',
      displayName: 'GPT-5.3 Codex Spark',
      isFamilyDefault: false,
      supportsReasoning: true,
      supportedReasoningLevels: ['none', 'low', 'medium', 'high', 'xhigh'],
      defaultReasoningLevel: 'low',
      contextWindow: 128_000,
      maxOutputTokens: 128_000,
      inputModes: ['text'],
      webSearchCapability: 'none',
      enabledByDefault: true,
      piUpstreamId: 'gpt-5.3-codex-spark',
      intentionalDivergenceNotes: null,
    },
    'gpt-5.4': {
      modelId: 'gpt-5.4',
      provider: 'openai-codex',
      familyId: 'pi-5.4',
      displayName: 'GPT-5.4',
      isFamilyDefault: true,
      supportsReasoning: true,
      supportedReasoningLevels: ['none', 'low', 'medium', 'high', 'xhigh'],
      defaultReasoningLevel: 'xhigh',
      contextWindow: 272_000,
      maxOutputTokens: 128_000,
      inputModes: ['text', 'image'],
      webSearchCapability: 'none',
      enabledByDefault: true,
      piUpstreamId: 'gpt-5.4',
      intentionalDivergenceNotes: null,
    },
    'gpt-5.4-mini': {
      modelId: 'gpt-5.4-mini',
      provider: 'openai-codex',
      familyId: 'pi-5.4',
      displayName: 'GPT-5.4 Mini',
      isFamilyDefault: false,
      supportsReasoning: true,
      supportedReasoningLevels: ['none', 'low', 'medium', 'high', 'xhigh'],
      defaultReasoningLevel: 'high',
      contextWindow: 272_000,
      maxOutputTokens: 128_000,
      inputModes: ['text', 'image'],
      webSearchCapability: 'none',
      enabledByDefault: true,
      piUpstreamId: 'gpt-5.4-mini',
      intentionalDivergenceNotes: null,
    },

    // ── Anthropic models ────────────────────────────────
    'claude-opus-4-6': {
      modelId: 'claude-opus-4-6',
      provider: 'anthropic',
      familyId: 'pi-opus',
      displayName: 'Claude Opus 4.6',
      isFamilyDefault: true,
      supportsReasoning: true,
      supportedReasoningLevels: ['low', 'medium', 'high'],
      defaultReasoningLevel: 'high',
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      inputModes: ['text', 'image'],
      webSearchCapability: 'none',
      enabledByDefault: true,
      piUpstreamId: 'claude-opus-4-6',
      intentionalDivergenceNotes: null,
    },
    'claude-sonnet-4-5-20250929': {
      modelId: 'claude-sonnet-4-5-20250929',
      provider: 'anthropic',
      familyId: 'pi-opus',
      displayName: 'Claude Sonnet 4.5',
      isFamilyDefault: false,
      supportsReasoning: true,
      supportedReasoningLevels: ['low', 'medium', 'high'],
      defaultReasoningLevel: 'medium',
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      inputModes: ['text', 'image'],
      webSearchCapability: 'none',
      enabledByDefault: true,
      piUpstreamId: 'claude-sonnet-4-5-20250929',
      intentionalDivergenceNotes: null,
    },
    'claude-haiku-4-5-20251001': {
      modelId: 'claude-haiku-4-5-20251001',
      provider: 'anthropic',
      familyId: 'pi-opus',
      displayName: 'Claude Haiku 4.5',
      isFamilyDefault: false,
      supportsReasoning: true,
      supportedReasoningLevels: ['low', 'medium', 'high'],
      defaultReasoningLevel: 'low',
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      inputModes: ['text', 'image'],
      webSearchCapability: 'none',
      enabledByDefault: true,
      piUpstreamId: 'claude-haiku-4-5-20251001',
      intentionalDivergenceNotes: null,
    },

    // ── xAI models ────────────────────────────────
    'grok-4': {
      modelId: 'grok-4',
      provider: 'xai',
      familyId: 'pi-grok',
      displayName: 'Grok 4',
      isFamilyDefault: true,
      supportsReasoning: true,
      supportedReasoningLevels: ['none', 'low', 'medium', 'high', 'xhigh'],
      defaultReasoningLevel: 'high',
      contextWindow: 256_000,
      maxOutputTokens: 64_000,
      inputModes: ['text'],
      webSearchCapability: 'native',
      enabledByDefault: true,
      piUpstreamId: 'grok-4',
      intentionalDivergenceNotes:
        "Forge overrides Pi's built-in openai-completions API to openai-responses via xai-responses behavior adapter",
    },
    'grok-4-fast': {
      modelId: 'grok-4-fast',
      provider: 'xai',
      familyId: 'pi-grok',
      displayName: 'Grok 4 Fast',
      isFamilyDefault: false,
      supportsReasoning: true,
      supportedReasoningLevels: ['none', 'low', 'medium', 'high', 'xhigh'],
      defaultReasoningLevel: 'medium',
      contextWindow: 2_000_000,
      maxOutputTokens: 30_000,
      inputModes: ['text'],
      webSearchCapability: 'native',
      enabledByDefault: true,
      piUpstreamId: 'grok-4-fast',
      intentionalDivergenceNotes:
        'API overridden to openai-responses; Forge keeps this model text-only even though Pi upstream currently advertises image input',
    },
    'grok-4.20-0309-reasoning': {
      modelId: 'grok-4.20-0309-reasoning',
      provider: 'xai',
      familyId: 'pi-grok',
      displayName: 'Grok 4.20 Reasoning',
      isFamilyDefault: false,
      supportsReasoning: true,
      supportedReasoningLevels: ['none', 'low', 'medium', 'high', 'xhigh'],
      defaultReasoningLevel: 'high',
      contextWindow: 2_000_000,
      maxOutputTokens: 30_000,
      inputModes: ['text'],
      webSearchCapability: 'native',
      enabledByDefault: true,
      piUpstreamId: 'grok-4.20-0309-reasoning',
      intentionalDivergenceNotes:
        'API overridden to openai-responses; Forge keeps this model text-only even though Pi upstream currently advertises image input',
    },
    'grok-4.20-0309-non-reasoning': {
      modelId: 'grok-4.20-0309-non-reasoning',
      provider: 'xai',
      familyId: 'pi-grok',
      displayName: 'Grok 4.20 Non-Reasoning',
      isFamilyDefault: false,
      supportsReasoning: false,
      supportedReasoningLevels: ['none'],
      defaultReasoningLevel: 'none',
      contextWindow: 2_000_000,
      maxOutputTokens: 30_000,
      inputModes: ['text'],
      webSearchCapability: 'native',
      enabledByDefault: true,
      piUpstreamId: 'grok-4.20-0309-non-reasoning',
      intentionalDivergenceNotes:
        'API overridden to openai-responses; reasoning: false per Pi upstream; Forge keeps this model text-only even though Pi upstream currently advertises image input',
    },

    // ── Codex App Runtime (synthetic, no Pi upstream) ────────────────────────────────
    default: {
      modelId: 'default',
      provider: 'openai-codex-app-server',
      familyId: 'codex-app',
      displayName: 'Codex App Runtime',
      isFamilyDefault: true,
      supportsReasoning: true,
      supportedReasoningLevels: ['none', 'low', 'medium', 'high', 'xhigh'],
      defaultReasoningLevel: 'xhigh',
      contextWindow: 1_048_576,
      maxOutputTokens: 128_000,
      inputModes: ['text'],
      webSearchCapability: 'none',
      enabledByDefault: true,
      piUpstreamId: null,
      intentionalDivergenceNotes:
        'Synthetic entry — Codex App Server is not a Pi-managed runtime',
    },
  },
} as const satisfies ForgeModelCatalog

const CATALOG_PROVIDERS = FORGE_MODEL_CATALOG.providers as Record<string, ForgeProviderDefinition>
const CATALOG_FAMILIES = FORGE_MODEL_CATALOG.families as Record<string, ForgeFamilyDefinition>
const CATALOG_MODELS = FORGE_MODEL_CATALOG.models as Record<string, ForgeModelDefinition>

/** All family IDs, derived from the catalog. Replaces the manual MANAGER_MODEL_PRESETS tuple. */
export const CATALOG_FAMILY_IDS = Object.keys(CATALOG_FAMILIES) as readonly string[]

/** Lookup a model by modelId. Returns undefined if not in catalog. */
export function getCatalogModel(modelId: string): ForgeModelDefinition | undefined {
  const trimmedModelId = modelId.trim()
  if (!trimmedModelId) {
    return undefined
  }

  return CATALOG_MODELS[trimmedModelId] ?? CATALOG_MODELS[trimmedModelId.toLowerCase()]
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
  return Object.values(FORGE_MODEL_CATALOG.models).filter((model) => model.familyId === familyId)
}

/** Get the family a model belongs to. */
export function getCatalogFamilyForModel(modelId: string): ForgeFamilyDefinition | undefined {
  const model = getCatalogModel(modelId)
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
  const model = getCatalogModel(normalizedModelId)

  if (model && model.provider === normalizedProvider) {
    return model.familyId
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
