import { StatCard } from './StatCard'
import { abbreviateNumber } from '../charts/chart-utils'
import type { WorkerStats } from '@forge/protocol'

interface WorkerStatsCardsProps {
  workers: WorkerStats
}

function formatRuntime(valueMs: number): string {
  if (valueMs <= 0) {
    return '0s'
  }

  const totalSeconds = Math.round(valueMs / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60

  if (minutes <= 0) {
    return `${seconds}s`
  }

  return `${minutes}m ${seconds}s`
}

export function WorkerStatsCards({ workers }: WorkerStatsCardsProps) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
        title="Avg Runtime"
        value={formatRuntime(workers.averageRuntimeMs)}
        subtitle="Worker duration"
      />
      <StatCard
        title="Currently Active"
        value={String(workers.currentlyActive)}
        subtitle="Workers running now"
      />
    </div>
  )
}
