export type ModelCacheRuntimeType = 'pi'

export const MODEL_CACHE_PROVIDERS = ['openai', 'openai-codex'] as const
export type ModelCacheProvider = (typeof MODEL_CACHE_PROVIDERS)[number]

export const MODEL_CACHE_STATUSES = ['hit', 'partial', 'miss'] as const
export type ModelCacheStatus = (typeof MODEL_CACHE_STATUSES)[number]

export const MODEL_CACHE_TOKEN_NORMALIZATIONS = [
  'raw_input_tokens_total',
  'normalized_components',
] as const
export type ModelCacheTokenNormalization = (typeof MODEL_CACHE_TOKEN_NORMALIZATIONS)[number]

export const MODEL_CACHE_ELIGIBILITY_THRESHOLD_TOKENS = 1024
export const MODEL_CACHE_HIT_RATIO_THRESHOLD = 0.8
export const MODEL_CACHE_CLASSIFICATION_VERSION = 1 as const

export interface ModelCacheTokenFacts {
  /** Total input tokens for the model request. Denominator for cachedRatio. */
  promptInputTokens: number
  /** Provider-reported cached input tokens. */
  cachedInputTokens: number
  /** Provider/Pi cache-write tokens when available, otherwise 0. */
  cacheWriteInputTokens: number
  /** Best-effort uncached input tokens, never negative. */
  uncachedInputTokens: number
  outputTokens: number
  totalTokens: number
  /** Explains denominator normalization so readers do not double-count cached tokens. */
  normalization: ModelCacheTokenNormalization
}

export interface ModelCacheClassification {
  version: typeof MODEL_CACHE_CLASSIFICATION_VERSION
  status: ModelCacheStatus
  cachedRatio: number
  thresholdTokens: typeof MODEL_CACHE_ELIGIBILITY_THRESHOLD_TOKENS
  hitRatioThreshold: typeof MODEL_CACHE_HIT_RATIO_THRESHOLD
}

export interface ModelCacheObservationEvent {
  type: 'model_cache_observation'
  agentId: string
  id?: string
  timestamp: string
  runtimeType: ModelCacheRuntimeType
  provider: ModelCacheProvider
  modelId: string
  api?: string
  turnId?: string
  tokens: ModelCacheTokenFacts
  classification: ModelCacheClassification
}

export interface ModelCacheVisualizationSettings {
  enabled: boolean
  updatedAt: string | null
}
