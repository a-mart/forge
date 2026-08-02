import type { GenerationThroughputLiveMeasurement } from '@forge/protocol'

/** Returns a numeric rate only for the authoritative provider-final transition. */
export function finalThroughputRate(
  measurement: GenerationThroughputLiveMeasurement | undefined,
): number | null {
  const rate = measurement?.generationAverageTokensPerSecond
  return measurement?.phase === 'completed'
    && measurement.valueKind === 'provider_final'
    && measurement.outputTokens !== null
    && typeof rate === 'number'
    && Number.isFinite(rate)
    && rate >= 0
    ? rate
    : null
}
