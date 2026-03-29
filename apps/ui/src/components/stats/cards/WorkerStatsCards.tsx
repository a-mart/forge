import { StatCard } from './StatCard'
import { abbreviateNumber } from '../charts/chart-utils'
import type { WorkerStats, CodeStats } from '@forge/protocol'
import { Card } from '@/components/ui/card'

interface WorkerStatsCardsProps {
  workers: WorkerStats
  code: CodeStats
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

export function WorkerStatsCards({ workers, code }: WorkerStatsCardsProps) {
  const netChange = code.linesAdded - code.linesDeleted
  const netChangeFormatted = netChange >= 0 
    ? `+${abbreviateNumber(netChange)}` 
    : `-${abbreviateNumber(Math.abs(netChange))}`

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
        subtitle="Per completed worker run"
      />
      <StatCard
        title="Avg Runtime"
        value={formatRuntime(workers.averageRuntimeMs)}
        subtitle="Completed worker duration"
      />
      <Card className="border-border/50 bg-card/80 p-3 backdrop-blur-sm">
        <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Code Changes
        </div>
        <div className="mt-1 flex items-baseline gap-2 font-mono text-lg font-bold leading-none">
          <span className="text-emerald-500">+{abbreviateNumber(code.linesAdded)}</span>
          <span className="text-muted-foreground/40">/</span>
          <span className="text-rose-500">-{abbreviateNumber(code.linesDeleted)}</span>
        </div>
        <div className="mt-1 text-xs text-muted-foreground/80">
          {netChangeFormatted} net · {code.commits.toLocaleString()} commits
        </div>
      </Card>
    </div>
  )
}
