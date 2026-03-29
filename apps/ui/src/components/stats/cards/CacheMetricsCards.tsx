import { StatCard } from './StatCard'
import { abbreviateNumber } from '../charts/chart-utils'
import type { CacheStats, WorkerStats, ActivityStats } from '@forge/protocol'

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
        subtitle={`${cache.hitRate.toFixed(1)}% hit rate in ${cache.hitRatePeriod.toLowerCase()}`}
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
        subtitle={activity.peakDayTokens > 0 ? `${abbreviateNumber(activity.peakDayTokens)} tokens` : 'No data'}
      />
    </div>
  )
}
