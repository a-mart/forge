import type { ModelCacheObservationEntry } from '@/lib/ws-state'
import type { ModelCacheStatus } from '@forge/protocol'

/** Minimum cached-ratio decline between consecutive observations to count as a UI-derived drop. */
export const MODEL_CACHE_RECENT_DROP_RATIO_DELTA = 0.2

export interface ModelCacheRecentDrop {
  observationId: string
  timestamp: string
  previousRatio: number
  currentRatio: number
  deltaRatio: number
}

export interface ModelCacheHeaderSummary {
  chipLabel: string
  latestStatus: ModelCacheStatus
  counts: Record<ModelCacheStatus, number>
  observationCount: number
  averageCachedRatio: number
  totalPromptInputTokens: number
  totalCachedInputTokens: number
  recentDrops: ModelCacheRecentDrop[]
  latestObservation: ModelCacheObservationEntry
}

export function formatModelCacheChipLabel(observation: ModelCacheObservationEntry): string {
  const status = observation.classification.status
  const percent = Math.round(observation.classification.cachedRatio * 100)

  if (status === 'hit') {
    return `Prompt cache ${percent}%`
  }
  if (status === 'partial') {
    return `Prompt cache partial ${percent}%`
  }
  return 'Prompt cache miss'
}

export function deriveModelCacheRecentDrops(
  observations: ModelCacheObservationEntry[],
  maxDrops = 3,
): ModelCacheRecentDrop[] {
  const drops: ModelCacheRecentDrop[] = []

  for (let index = 1; index < observations.length; index += 1) {
    const previous = observations[index - 1]
    const current = observations[index]
    const previousRatio = previous.classification.cachedRatio
    const currentRatio = current.classification.cachedRatio
    const statusWorsened =
      (previous.classification.status === 'hit' && current.classification.status !== 'hit') ||
      (previous.classification.status === 'partial' && current.classification.status === 'miss')
    const ratioDropped = previousRatio - currentRatio >= MODEL_CACHE_RECENT_DROP_RATIO_DELTA

    if (!statusWorsened && !ratioDropped) {
      continue
    }

    drops.push({
      observationId: current.id ?? `observation-${index}`,
      timestamp: current.timestamp,
      previousRatio,
      currentRatio,
      deltaRatio: currentRatio - previousRatio,
    })
  }

  return drops.slice(-maxDrops).reverse()
}

export function buildModelCacheHeaderSummary(options: {
  enabled: boolean
  observations: ModelCacheObservationEntry[]
}): ModelCacheHeaderSummary | null {
  if (!options.enabled || options.observations.length === 0) {
    return null
  }

  const counts: Record<ModelCacheStatus, number> = { hit: 0, partial: 0, miss: 0 }
  let totalPromptInputTokens = 0
  let totalCachedInputTokens = 0
  let ratioSum = 0

  for (const observation of options.observations) {
    counts[observation.classification.status] += 1
    totalPromptInputTokens += observation.tokens.promptInputTokens
    totalCachedInputTokens += observation.tokens.cachedInputTokens
    ratioSum += observation.classification.cachedRatio
  }

  const latestObservation = options.observations[options.observations.length - 1]

  return {
    chipLabel: formatModelCacheChipLabel(latestObservation),
    latestStatus: latestObservation.classification.status,
    counts,
    observationCount: options.observations.length,
    averageCachedRatio: ratioSum / options.observations.length,
    totalPromptInputTokens,
    totalCachedInputTokens,
    recentDrops: deriveModelCacheRecentDrops(options.observations),
    latestObservation,
  }
}
