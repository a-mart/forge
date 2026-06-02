import {
  MODEL_CACHE_CLASSIFICATION_VERSION,
  MODEL_CACHE_ELIGIBILITY_THRESHOLD_TOKENS,
  MODEL_CACHE_HIT_RATIO_THRESHOLD,
  MODEL_CACHE_PROVIDERS,
  type ModelCacheClassification,
  type ModelCacheObservationEvent,
  type ModelCacheProvider,
  type ModelCacheRuntimeType,
  type ModelCacheStatus,
  type ModelCacheTokenFacts,
  type ModelCacheTokenNormalization,
} from '@forge/protocol'
import type { AgentDescriptor } from '../types.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readNonNegativeInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null
  }
  return Math.round(value)
}

function readNestedCachedTokens(details: unknown): number | null {
  if (!isRecord(details)) {
    return null
  }
  return readNonNegativeInt(details.cached_tokens)
}

export function isSupportedModelCacheProvider(provider: string): provider is ModelCacheProvider {
  return (MODEL_CACHE_PROVIDERS as readonly string[]).includes(provider)
}

export function normalizeModelCacheProvider(provider: string): ModelCacheProvider | null {
  const normalized = provider.trim().toLowerCase()
  if (normalized === 'openai' || normalized === 'openai-codex') {
    return normalized
  }
  return null
}

export function extractModelCacheTokenFacts(usageValue: unknown): ModelCacheTokenFacts | null {
  const usage = isRecord(usageValue) ? usageValue : null
  if (!usage) {
    return null
  }

  const cachedInputTokens =
    readNonNegativeInt(usage.cacheRead) ??
    readNonNegativeInt(usage.cache_read_input_tokens) ??
    readNonNegativeInt(usage.cached_tokens) ??
    readNestedCachedTokens(usage.input_tokens_details) ??
    readNestedCachedTokens(usage.prompt_tokens_details) ??
    0

  const cacheWriteInputTokens =
    readNonNegativeInt(usage.cacheWrite) ??
    readNonNegativeInt(usage.cache_creation_input_tokens) ??
    readNonNegativeInt(usage.cache_write_tokens) ??
    0

  const rawTotalInput =
    readNonNegativeInt(usage.input_tokens) ??
    readNonNegativeInt(usage.prompt_tokens) ??
    readNonNegativeInt(usage.inputTokens)

  let promptInputTokens: number
  let normalization: ModelCacheTokenNormalization
  let uncachedInputTokens: number

  if (rawTotalInput !== null) {
    promptInputTokens = rawTotalInput
    normalization = 'raw_input_tokens_total'
    uncachedInputTokens = Math.max(0, promptInputTokens - cachedInputTokens - cacheWriteInputTokens)
  } else {
    const inputComponent = readNonNegativeInt(usage.input) ?? 0
    promptInputTokens = inputComponent + cachedInputTokens + cacheWriteInputTokens
    normalization = 'normalized_components'
    uncachedInputTokens = inputComponent
  }

  const outputTokens =
    readNonNegativeInt(usage.output) ??
    readNonNegativeInt(usage.output_tokens) ??
    readNonNegativeInt(usage.completion_tokens) ??
    0

  const totalTokens =
    readNonNegativeInt(usage.totalTokens) ??
    readNonNegativeInt(usage.total_tokens) ??
    readNonNegativeInt(usage.total) ??
    promptInputTokens + outputTokens

  if (promptInputTokens < MODEL_CACHE_ELIGIBILITY_THRESHOLD_TOKENS) {
    return null
  }

  if (
    cachedInputTokens > promptInputTokens ||
    cacheWriteInputTokens > promptInputTokens ||
    uncachedInputTokens > promptInputTokens
  ) {
    return null
  }

  return {
    promptInputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    uncachedInputTokens,
    outputTokens,
    totalTokens,
    normalization,
  }
}

export function classifyModelCache(tokens: ModelCacheTokenFacts): ModelCacheClassification | null {
  if (tokens.promptInputTokens <= 0) {
    return null
  }

  const cachedRatio = tokens.cachedInputTokens / tokens.promptInputTokens
  if (!Number.isFinite(cachedRatio) || cachedRatio < 0 || cachedRatio > 1) {
    return null
  }

  let status: ModelCacheStatus
  if (tokens.cachedInputTokens === 0) {
    status = 'miss'
  } else if (cachedRatio >= MODEL_CACHE_HIT_RATIO_THRESHOLD) {
    status = 'hit'
  } else {
    status = 'partial'
  }

  return {
    version: MODEL_CACHE_CLASSIFICATION_VERSION,
    status,
    cachedRatio,
    thresholdTokens: MODEL_CACHE_ELIGIBILITY_THRESHOLD_TOKENS,
    hitRatioThreshold: MODEL_CACHE_HIT_RATIO_THRESHOLD,
  }
}

export function extractModelCacheModelFacts(
  message: unknown,
  descriptor: AgentDescriptor,
): { provider: ModelCacheProvider; modelId: string; api?: string } | null {
  const record = isRecord(message) ? message : null
  const providerRaw =
    (record && typeof record.provider === 'string' ? record.provider : undefined) ??
    descriptor.model?.provider
  const modelIdRaw =
    (record && typeof record.modelId === 'string' ? record.modelId : undefined) ??
    (record && typeof record.model === 'string' ? record.model : undefined) ??
    descriptor.model?.modelId

  if (!providerRaw || !modelIdRaw) {
    return null
  }

  const provider = normalizeModelCacheProvider(providerRaw)
  if (!provider) {
    return null
  }

  const api =
    record && typeof record.api === 'string' && record.api.trim().length > 0
      ? record.api.trim()
      : undefined

  return { provider, modelId: modelIdRaw, api }
}

export function buildModelCacheObservation(options: {
  agentId: string
  timestamp: string
  runtimeType: ModelCacheRuntimeType
  provider: ModelCacheProvider
  modelId: string
  api?: string
  turnId?: string
  tokens: ModelCacheTokenFacts
  classification: ModelCacheClassification
  id?: string
}): ModelCacheObservationEvent {
  return {
    type: 'model_cache_observation',
    agentId: options.agentId,
    id: options.id,
    timestamp: options.timestamp,
    runtimeType: options.runtimeType,
    provider: options.provider,
    modelId: options.modelId,
    api: options.api,
    turnId: options.turnId,
    tokens: options.tokens,
    classification: options.classification,
  }
}

export function buildModelCacheObservationFromMessageEnd(options: {
  agentId: string
  timestamp: string
  descriptor: AgentDescriptor
  message: unknown
  turnId?: string
  runtimeType?: ModelCacheRuntimeType
}): ModelCacheObservationEvent | null {
  const runtimeType = options.runtimeType ?? 'pi'
  if (runtimeType !== 'pi') {
    return null
  }

  const message = isRecord(options.message) ? options.message : null
  if (!message || message.role !== 'assistant') {
    return null
  }

  const modelFacts = extractModelCacheModelFacts(message, options.descriptor)
  if (!modelFacts) {
    return null
  }

  const usage = message.usage ?? message.tokenUsage
  const tokens = extractModelCacheTokenFacts(usage)
  if (!tokens) {
    return null
  }

  const classification = classifyModelCache(tokens)
  if (!classification) {
    return null
  }

  return buildModelCacheObservation({
    agentId: options.agentId,
    timestamp: options.timestamp,
    runtimeType,
    provider: modelFacts.provider,
    modelId: modelFacts.modelId,
    api: modelFacts.api,
    turnId: options.turnId,
    tokens,
    classification,
  })
}
