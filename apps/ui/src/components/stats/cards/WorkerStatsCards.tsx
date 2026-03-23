import { StatCard } from './StatCard'
import { abbreviateNumber } from '../charts/chart-utils'
import type { WorkerStats } from '../stats-types'

interface WorkerStatsCardsProps {
  workers: WorkerStats
}

export function WorkerStatsCards({ workers }: WorkerStatsCardsProps) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <StatCard
        title="Workers Run"
        value={String(workers.totalWorkersRun)}
        subtitle={workers.totalWorkersRunPeriod}
      />
      <StatCard
        title="Avg Tokens / Run"
        value={abbreviateNumber(workers.averageTokensPerRun)}
        unit="tokens"
        subtitle="Per worker execution"
      />
      <StatCard
        title="Currently Active"
        value={String(workers.currentlyActive)}
        subtitle="Workers running now"
      />
    </div>
  )
}
