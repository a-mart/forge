import { useState } from 'react'
import { AlertCircle, BarChart3 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Card } from '@/components/ui/card'
import { useStats } from './use-stats'
import { StatsLayout } from './StatsLayout'
import { TokenUsageCards } from './cards/TokenUsageCards'
import { CacheMetricsCards } from './cards/CacheMetricsCards'
import { StatCard } from './cards/StatCard'
import { WorkerStatsCards } from './cards/WorkerStatsCards'
import { DailyUsageChart } from './charts/DailyUsageChart'
import { ModelDistribution } from './sections/ModelDistribution'
import type { StatsRange } from '@forge/protocol'
import { cn } from '@/lib/utils'

interface StatsPanelProps {
  wsUrl: string
  onBack: () => void
}

function StatsSkeleton() {
  return (
    <div className="space-y-4">
      {/* Token usage row */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Card key={i} className="border-border/50 bg-card/80 p-3">
            <Skeleton className="mb-2 h-3 w-20" />
            <Skeleton className="mb-1 h-7 w-16" />
            <Skeleton className="h-3 w-32" />
          </Card>
        ))}
      </div>
      {/* Secondary row */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i} className="border-border/50 bg-card/80 p-3">
            <Skeleton className="mb-2 h-3 w-24" />
            <Skeleton className="mb-1 h-7 w-14" />
            <Skeleton className="h-3 w-28" />
          </Card>
        ))}
      </div>
      {/* Chart skeleton */}
      <Card className="border-border/50 bg-card/80 p-3">
        <Skeleton className="mb-3 h-4 w-36" />
        <Skeleton className="h-[200px] w-full rounded-md" />
      </Card>
      {/* Activity row */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <Card key={i} className="border-border/50 bg-card/80 p-3">
            <Skeleton className="mb-2 h-3 w-28" />
            <Skeleton className="mb-1 h-7 w-20" />
            <Skeleton className="h-3 w-36" />
          </Card>
        ))}
      </div>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="mb-4 flex size-14 items-center justify-center rounded-full bg-muted/50">
        <BarChart3 className="size-7 text-muted-foreground" />
      </div>
      <h2 className="mb-1 text-sm font-medium text-foreground">
        No usage data yet
      </h2>
      <p className="max-w-sm text-xs text-muted-foreground">
        Start a session and send some messages to see your usage statistics here.
      </p>
    </div>
  )
}

function ErrorState({
  error,
  onRetry,
}: {
  error: string
  onRetry: () => void
}) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="mb-4 flex size-14 items-center justify-center rounded-full bg-destructive/10">
        <AlertCircle className="size-7 text-destructive" />
      </div>
      <h2 className="mb-1 text-sm font-medium text-foreground">
        Failed to load stats
      </h2>
      <p className="mb-4 max-w-sm text-xs text-muted-foreground">{error}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  )
}

function isEmptyStats(tokens: { today: number; last7Days: number; allTime: number }): boolean {
  return tokens.today === 0 && tokens.last7Days === 0 && tokens.allTime === 0
}

export function StatsPanel({ wsUrl, onBack }: StatsPanelProps) {
  const [range, setRange] = useState<StatsRange>('7d')
  const { stats, isLoading, error, isRefreshing, isSwitchingRange, refresh } = useStats(wsUrl, range)
  const isUpdating = isRefreshing || isSwitchingRange

  return (
    <StatsLayout
      onBack={onBack}
      computedAt={stats?.computedAt}
      isRefreshing={isRefreshing}
      isSwitchingRange={isSwitchingRange}
      onRefresh={refresh}
      range={range}
      onRangeChange={setRange}
    >
      {isLoading && !stats ? (
        <StatsSkeleton />
      ) : error && !stats ? (
        <ErrorState error={error} onRetry={refresh} />
      ) : stats && isEmptyStats(stats.tokens) ? (
        <EmptyState />
      ) : stats ? (
        <div className={cn('space-y-4 transition-opacity duration-200', isUpdating && 'opacity-60')}>
          {/* Token usage: 5-card row */}
          <TokenUsageCards tokens={stats.tokens} />

          {/* Secondary metrics: 3-card row */}
          <CacheMetricsCards
            cache={stats.cache}
            workers={stats.workers}
            activity={stats.activity}
          />

          {/* Daily usage chart: full width */}
          <DailyUsageChart data={stats.dailyUsage} />

          {/* Activity + session overview: 4-card row */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              title="Longest Streak"
              value={`${stats.activity.longestStreak} days`}
              subtitle={stats.activity.streakLabel}
            />
            <StatCard
              title="Active Days"
              value={`${stats.activity.activeDays} / ${stats.activity.totalDaysInRange}`}
              subtitle={`${stats.activity.activeDaysInRange} / ${stats.activity.totalDaysInRange} in current range`}
            />
            <StatCard
              title="Sessions"
              value={String(stats.sessions.totalSessions)}
              subtitle={`${stats.sessions.activeSessions} active`}
            />
            <StatCard
              title="Messages Sent"
              value={stats.sessions.totalMessagesSent.toLocaleString()}
              subtitle={stats.sessions.totalMessagesPeriod}
            />
          </div>

          {/* Worker stats */}
          <WorkerStatsCards workers={stats.workers} />

          {/* Model distribution badges */}
          <ModelDistribution models={stats.models} />
        </div>
      ) : null}
    </StatsLayout>
  )
}
