import { StatCard } from './StatCard'
import type { SessionStats } from '@forge/protocol'

interface SessionStatsCardsProps {
  sessions: SessionStats
}

export function SessionStatsCards({ sessions }: SessionStatsCardsProps) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
    </div>
  )
}
