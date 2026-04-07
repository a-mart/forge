import { useState, useMemo, useCallback } from 'react'
import { AlertCircle, BarChart3, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { StatsLayout } from '../StatsLayout'
import { TokenAnalyticsFilters, type TokenAnalyticsFilterState } from './TokenAnalyticsFilters'
import { TokenAnalyticsHeaderCards } from './TokenAnalyticsHeaderCards'
import { SpecialistAttributionCards } from './SpecialistAttributionCards'
import { SpecialistBreakdownTable } from './SpecialistBreakdownTable'
import { WorkerRunsTable } from './WorkerRunsTable'
import { useTokenAnalytics } from './use-token-analytics'
import { cn } from '@/lib/utils'
import type { StatsTab } from '@/hooks/index-page/use-route-state'
import type { TokenAnalyticsQuery } from '@forge/protocol'

interface TokenAnalyticsPanelProps {
  wsUrl: string
  onBack: () => void
  activeTab?: StatsTab
  onTabChange?: (tab: StatsTab) => void
}

function TokenAnalyticsSkeleton() {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-24 rounded-md" />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="border-border/50 bg-card/80 p-3">
            <Skeleton className="mb-2 h-3 w-20" />
            <Skeleton className="mb-1 h-7 w-16" />
            <Skeleton className="h-3 w-32" />
          </Card>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <Card key={i} className="border-border/50 bg-card/80 p-3">
            <Skeleton className="mb-2 h-3 w-32" />
            <Skeleton className="h-6 w-full rounded" />
          </Card>
        ))}
      </div>
      <Card className="border-border/50 bg-card/80 p-3">
        <Skeleton className="mb-3 h-4 w-36" />
        <Skeleton className="h-[120px] w-full rounded-md" />
      </Card>
    </div>
  )
}

function EmptyState({ hasActiveFilters, onClearFilters }: { hasActiveFilters: boolean; onClearFilters: () => void }) {
  if (hasActiveFilters) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <div className="mb-4 flex size-14 items-center justify-center rounded-full bg-muted/50">
          <BarChart3 className="size-7 text-muted-foreground" />
        </div>
        <h2 className="mb-1 text-sm font-medium text-foreground">
          No results match the current filters
        </h2>
        <p className="mb-4 max-w-sm text-xs text-muted-foreground">
          Try adjusting or clearing your filters to see token data.
        </p>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={onClearFilters}
        >
          <X className="size-3" />
          Clear filters
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="mb-4 flex size-14 items-center justify-center rounded-full bg-muted/50">
        <BarChart3 className="size-7 text-muted-foreground" />
      </div>
      <h2 className="mb-1 text-sm font-medium text-foreground">
        No token data yet
      </h2>
      <p className="max-w-sm text-xs text-muted-foreground">
        Run some worker tasks to see token analytics here.
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
        Failed to load token analytics
      </h2>
      <p className="mb-4 max-w-sm text-xs text-muted-foreground">{error}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  )
}

export function TokenAnalyticsPanel({
  wsUrl,
  onBack,
  activeTab,
  onTabChange,
}: TokenAnalyticsPanelProps) {
  const [filters, setFilters] = useState<TokenAnalyticsFilterState>({
    rangePreset: '7d',
  })

  const query: TokenAnalyticsQuery = useMemo(
    () => ({
      rangePreset: filters.rangePreset,
      startDate: filters.startDate,
      endDate: filters.endDate,
      profileId: filters.profileId,
      provider: filters.provider,
      modelId: filters.modelId,
      attribution: filters.attribution,
      specialistId: filters.specialistId,
    }),
    [filters],
  )

  const { snapshot, isLoading, error, isRefreshing, isSwitchingQuery, refresh } = useTokenAnalytics(wsUrl, query)

  const handleSpecialistClick = useCallback(
    (specialistId: string | null) => {
      if (specialistId) {
        setFilters((prev) => ({
          ...prev,
          attribution: 'specialist',
          specialistId,
        }))
      }
    },
    [],
  )

  const isEmpty = snapshot && snapshot.totals.runCount === 0 && snapshot.totals.usage.total === 0

  const hasActiveFilters = Boolean(
    filters.profileId ||
      filters.provider ||
      filters.modelId ||
      (filters.attribution && filters.attribution !== 'all') ||
      filters.specialistId,
  )

  const handleClearFilters = useCallback(() => {
    setFilters((prev) => ({
      rangePreset: prev.rangePreset,
      startDate: prev.startDate,
      endDate: prev.endDate,
    }))
  }, [])

  // When on Token Analytics, back goes to Stats Overview instead of chat
  const handleBack = useCallback(() => {
    if (onTabChange) {
      onTabChange('overview')
    } else {
      onBack()
    }
  }, [onBack, onTabChange])

  const isUpdating = isRefreshing || isSwitchingQuery

  return (
    <StatsLayout
      onBack={handleBack}
      computedAt={snapshot?.computedAt}
      isRefreshing={isRefreshing}
      onRefresh={refresh}
      activeTab={activeTab}
      onTabChange={onTabChange}
      hideRangeSelector
    >
      {isLoading && !snapshot ? (
        <TokenAnalyticsSkeleton />
      ) : error && !snapshot ? (
        <ErrorState error={error} onRetry={refresh} />
      ) : snapshot ? (
        <div className={cn('space-y-4 transition-opacity duration-200', isUpdating && 'opacity-60')}>
          {/* Filter bar — always visible so user can adjust/clear filters */}
          <TokenAnalyticsFilters
            filters={filters}
            availableFilters={snapshot.availableFilters}
            onFiltersChange={setFilters}
          />

          {isEmpty ? (
            <EmptyState hasActiveFilters={hasActiveFilters} onClearFilters={handleClearFilters} />
          ) : (
            <>
              {/* Headline cards */}
              <TokenAnalyticsHeaderCards
                totals={snapshot.totals}
                attribution={snapshot.attribution}
              />

              {/* Attribution composition */}
              <SpecialistAttributionCards attribution={snapshot.attribution} />

              {/* Specialist breakdown */}
              <SpecialistBreakdownTable
                breakdown={snapshot.specialistBreakdown}
                onSpecialistClick={handleSpecialistClick}
              />

              {/* Worker runs */}
              <WorkerRunsTable wsUrl={wsUrl} query={query} />
            </>
          )}
        </div>
      ) : null}
    </StatsLayout>
  )
}
