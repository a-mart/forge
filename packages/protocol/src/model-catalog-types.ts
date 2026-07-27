import type { OpenAIBrokerDegradedReason } from './openai-auth-broker.js'

export type ForgeProviderAvailabilityMode = 'managed-auth' | 'external'
export type ForgePiProjectionMode = 'built-in-overrides' | 'custom-provider-merge' | 'none'
export type ForgeProjectionScope = 'catalog-only' | 'approved-provider-models'
export type ForgeRequestBehaviorId = 'xai-responses' | null
export type ForgeWebSearchCapability = 'none' | 'native'
export type ForgeInputMode = 'text' | 'image'
export type ForgeReasoningLevel = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'
export type ForgeThinkingLevelMap = Partial<Record<'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max', string | null>>
export type ForgeProviderCredentialAuthType = 'api_key' | 'oauth' | 'unknown'
export type ForgeProviderCredentialSource = 'auth_file' | 'env' | 'secrets' | 'pool' | 'central_broker'

export interface ForgeProviderCredentialSummary {
  configured: boolean
  authTypes: readonly ForgeProviderCredentialAuthType[]
  sources: readonly ForgeProviderCredentialSource[]
  pooled?: boolean
  centralBroker?: {
    configured: boolean
    reachable?: boolean
    degraded?: OpenAIBrokerDegradedReason
    availableAccounts?: number
    totalAccounts?: number
    detail?: string
  }
}
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
  /** Stable catalog key used for overrides/settings. Defaults to modelId when omitted. */
  catalogId?: string
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
  /** Output modalities advertised by the provider. Text-only when omitted by legacy rows. */
  outputModes?: readonly ForgeInputMode[]
  /** Provider capability metadata used by discovered catalogs and capability-aware UIs. */
  supportsTools?: boolean
  supportsStructuredOutput?: boolean
  /** OAuth-scoped rows are entitlement-gated and must never be exposed for API-key auth. */
  authScope?: 'any' | 'oauth'
  /** True when metadata came from authenticated provider discovery rather than the checked-in baseline. */
  discovered?: boolean
  webSearchCapability: ForgeWebSearchCapability
  thinkingLevelMap?: ForgeThinkingLevelMap
  enabledByDefault: boolean
  /** Pi upstream source metadata for audit; null for synthetic entries */
  piUpstreamId: string | null
  /** Notes when Forge intentionally diverges from Pi metadata. Prefix with "Pending Pi upstream" for curated built-in models ahead of installed Pi upstream. */
  intentionalDivergenceNotes: string | null
}

export interface ForgeModelCatalog {
  providers: Record<string, ForgeProviderDefinition>
  families: Record<string, ForgeFamilyDefinition>
  models: Record<string, ForgeModelDefinition>
}

export interface ModelOverrideEntry {
  enabled?: boolean
  managerEnabled?: boolean
  contextWindowCap?: number
  modelSpecificInstructions?: string
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
