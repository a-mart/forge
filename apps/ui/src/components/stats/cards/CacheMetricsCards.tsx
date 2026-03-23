import { StatCard } from './StatCard'
import { abbreviateNumber, formatTokenCount } from '../charts/chart-utils'
import type { CacheStats, WorkerStats, ActivityStats } from '../stats-types'

interface CacheMetricsCardsProps {
  cache: CacheStats
  workers: WorkerStats
  activity: ActivityStats
}

export function CacheMetricsCards({ cache, workers, activity }: CacheMetricsCardsProps) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <StatCard
        title="Cached Tokens"
        value={abbreviateNumber(cache.cachedTokensSaved)}
        unit="saved"
        subtitle={`${cache.cachedTokensPercentOfPrompt.toFixed(1)}% of prompt tokens`}
      />
      <StatCard
        title="Avg / Run"
        value={abbreviateNumber(workers.averageTokensPerRun)}
        unit="tokens"
        subtitle={`${workers.totalWorkersRun} runs in ${workers.totalWorkersRunPeriod.toLowerCase()}`}
      />
      <StatCard
        title="Peak Day"
        value={activity.peakDay || '—'}
        subtitle={activity.peakDayTokens > 0 ? `${formatTokenCount(activity.peakDayTokens)} tokens` : 'No data'}
      />
    </div>
  )
}
