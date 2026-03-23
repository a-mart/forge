import { StatCard } from './StatCard'
import type { ActivityStats } from '../stats-types'

interface ActivityCardsProps {
  activity: ActivityStats
}

export function ActivityCards({ activity }: ActivityCardsProps) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <StatCard
        title="Longest Streak"
        value={`${activity.longestStreak} days`}
        subtitle={activity.streakLabel}
      />
      <StatCard
        title="Active Days"
        value={`${activity.activeDays} / ${activity.totalDaysInRange}`}
        subtitle={`${activity.activeDaysInRange} / ${activity.totalDaysInRange} in current range`}
      />
    </div>
  )
}
