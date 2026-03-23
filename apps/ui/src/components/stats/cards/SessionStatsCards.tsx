import { StatCard } from './StatCard'
import type { SessionStats, WorkerStats } from '../stats-types'

interface SessionStatsCardsProps {
  sessions: SessionStats
  workers: WorkerStats
}

export function SessionStatsCards({ sessions, workers }: SessionStatsCardsProps) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <StatCard
        title="Sessions"
        value={String(sessions.totalSessions)}
        subtitle={`${sessions.activeSessions} active`}
      />
      <StatCard
        title="Messages Sent"
        value={sessions.totalMessagesSent.toLocaleString()}
        subtitle={sessions.totalMessagesPeriod}
      />
      <StatCard
        title="Active Workers"
        value={String(workers.currentlyActive)}
        subtitle={`${workers.totalWorkersRun} total runs`}
      />
    </div>
  )
}
