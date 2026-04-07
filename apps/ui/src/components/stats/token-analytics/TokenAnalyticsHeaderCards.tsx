import { StatCard } from '../cards/StatCard'
import { abbreviateNumber } from '../charts/chart-utils'
import type { TokenAnalyticsTotals, TokenAnalyticsAttributionSummary } from '@forge/protocol'

function formatDuration(ms: number | null): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = Math.round(seconds % 60)
  return `${minutes}m ${remainingSeconds}s`
}

interface TokenAnalyticsHeaderCardsProps {
  totals: TokenAnalyticsTotals
  attribution: TokenAnalyticsAttributionSummary
}

export function TokenAnalyticsHeaderCards({
  totals,
  attribution,
}: TokenAnalyticsHeaderCardsProps) {
  const cacheRead = totals.usage.cacheRead
  const inputSideTokens = cacheRead + totals.usage.input
  const cacheHitRate = inputSideTokens > 0
    ? (cacheRead / inputSideTokens) * 100
    : 0

  const specialistRunPct = totals.runCount > 0
    ? attribution.specialist.runPercentage
    : 0
  const specialistTokenPct = totals.usage.total > 0
    ? attribution.specialist.tokenPercentage
    : 0

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard
        title="Total Tokens"
        value={abbreviateNumber(totals.usage.total)}
        unit="tokens"
        subtitle={
          <div>
            <div>{abbreviateNumber(totals.usage.input)} in · {abbreviateNumber(totals.usage.output)} out</div>
            <div>{abbreviateNumber(totals.usage.cacheRead)} cache read</div>
          </div>
        }
        variant="accent"
      />
      <StatCard
        title="Cache Hit Rate"
        value={inputSideTokens > 0 ? `${cacheHitRate.toFixed(1)}%` : '—'}
        subtitle={`${abbreviateNumber(cacheRead)} cache read tokens`}
        variant="accent"
      />
      <StatCard
        title="Worker Runs"
        value={totals.runCount.toLocaleString()}
        subtitle={
          <div>
            <div>Avg {abbreviateNumber(totals.averageTokensPerRun)} tokens/run</div>
            <div>Avg {formatDuration(totals.averageDurationMs)} / run</div>
          </div>
        }
        variant="accent"
      />
      <StatCard
        title="Specialist Adoption"
        value={`${specialistRunPct.toFixed(0)}%`}
        unit="of runs"
        subtitle={
          <div>
            <div>{specialistTokenPct.toFixed(1)}% of tokens via specialists</div>
            <div>{attribution.specialist.runCount} specialist runs</div>
          </div>
        }
        variant="accent"
      />
    </div>
  )
}
