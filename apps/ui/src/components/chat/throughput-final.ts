import type { GenerationThroughputLiveMeasurement } from '@forge/protocol'

/** Returns response throughput only when the sender proves request-wall semantics. */
export function finalThroughputRate(
  measurement: GenerationThroughputLiveMeasurement | undefined,
): number | null {
  const rate = measurement?.responseThroughputTokensPerSecond
  return measurement?.phase === 'completed'
    && measurement.valueKind === 'provider_final'
    && measurement.responseThroughputDurationBasis === 'request_wall_monotonic'
    && measurement.outputTokens !== null
    && typeof rate === 'number'
    && Number.isFinite(rate)
    && rate >= 0
    ? rate
    : null
}
