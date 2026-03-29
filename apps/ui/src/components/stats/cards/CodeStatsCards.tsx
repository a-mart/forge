import { StatCard } from './StatCard'
import { abbreviateNumber } from '../charts/chart-utils'
import type { CodeStats } from '@forge/protocol'
import { cn } from '@/lib/utils'

interface CodeStatsCardsProps {
  code: CodeStats
}

function formatSigned(value: number): string {
  const abs = abbreviateNumber(Math.abs(value))
  if (value > 0) {
    return `+${abs}`
  }
  if (value < 0) {
    return `-${abs}`
  }
  return '0'
}

export function CodeStatsCards({ code }: CodeStatsCardsProps) {
  const netChange = code.linesAdded - code.linesDeleted

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard
        title="Lines Added"
        value={`+${abbreviateNumber(code.linesAdded)}`}
        subtitle="Git additions in range"
        className="border-emerald-500/30 bg-emerald-500/5"
      />
      <StatCard
        title="Lines Deleted"
        value={`-${abbreviateNumber(code.linesDeleted)}`}
        subtitle="Git deletions in range"
        className="border-rose-500/30 bg-rose-500/5"
      />
      <StatCard
        title="Net Change"
        value={formatSigned(netChange)}
        subtitle="Added minus deleted"
        className={cn(
          netChange > 0 && 'border-emerald-500/30 bg-emerald-500/5',
          netChange < 0 && 'border-rose-500/30 bg-rose-500/5',
        )}
      />
      <StatCard
        title="Commits"
        value={code.commits.toLocaleString()}
        subtitle={`${code.repos} repos contributed`}
      />
    </div>
  )
}
