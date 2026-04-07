import { ArrowLeft, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { timeAgo } from './charts/chart-utils'
import type { StatsRange } from '@forge/protocol'
import type { StatsTab } from '@/hooks/index-page/use-route-state'

const RANGE_OPTIONS: { value: StatsRange; label: string }[] = [
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: 'all', label: 'All time' },
]

const TAB_OPTIONS: { value: StatsTab; label: string }[] = [
  { value: 'overview', label: 'Overview' },
  { value: 'tokens', label: 'Token Analytics' },
]

interface StatsLayoutProps {
  onBack?: () => void
  computedAt?: string
  isRefreshing?: boolean
  isSwitchingRange?: boolean
  onRefresh?: () => void
  range?: StatsRange
  onRangeChange?: (range: StatsRange) => void
  activeTab?: StatsTab
  onTabChange?: (tab: StatsTab) => void
  /** When true, the range selector row is hidden (token analytics manages its own filters) */
  hideRangeSelector?: boolean
  children: React.ReactNode
}

export function StatsLayout({
  onBack,
  computedAt,
  isRefreshing,
  isSwitchingRange,
  onRefresh,
  range,
  onRangeChange,
  activeTab = 'overview',
  onTabChange,
  hideRangeSelector,
  children,
}: StatsLayoutProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      {/* Header */}
      <header className="flex h-[62px] shrink-0 items-center border-b border-border/80 bg-card/80 px-2 backdrop-blur md:px-4">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {onBack ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-9 w-9 shrink-0 text-muted-foreground hover:bg-accent/70 hover:text-foreground"
              onClick={onBack}
              aria-label={activeTab === 'tokens' ? 'Back to overview' : 'Back to chat'}
            >
              <ArrowLeft className="size-4" />
            </Button>
          ) : null}
          <h1 className="truncate text-sm font-semibold text-foreground">
            Stats
          </h1>
        </div>
        <div className="flex items-center gap-2">
          {computedAt ? (
            <span className="hidden text-xs text-muted-foreground sm:block">
              Updated {timeAgo(computedAt)}
            </span>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-9 w-9 text-muted-foreground hover:bg-accent/70 hover:text-foreground"
            onClick={onRefresh}
            disabled={isRefreshing}
            aria-label="Refresh stats"
          >
            <RefreshCw
              className={cn('size-4', isRefreshing && 'animate-spin')}
            />
          </Button>
        </div>
      </header>

      {/* Tab row */}
      {onTabChange ? (
        <div className="flex shrink-0 items-center gap-1 border-b border-border/60 bg-card/30 px-3 py-2 md:px-5">
          {TAB_OPTIONS.map((tab) => {
            const isActive = activeTab === tab.value
            return (
              <button
                key={tab.value}
                type="button"
                onClick={() => onTabChange(tab.value)}
                className={cn(
                  'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                  isActive
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
                )}
              >
                {tab.label}
              </button>
            )
          })}
        </div>
      ) : null}

      {/* Range selector (overview only) */}
      {!hideRangeSelector && range && onRangeChange ? (
        <div className="flex shrink-0 items-center gap-1 border-b border-border/60 bg-card/30 px-3 py-2 md:px-5">
          <span className="mr-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            View
          </span>
          {RANGE_OPTIONS.map((option) => {
            const isActive = range === option.value
            const isLoadingThis = isActive && isSwitchingRange
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => onRangeChange(option.value)}
                disabled={isSwitchingRange}
                className={cn(
                  'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                  isActive
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
                  isSwitchingRange && !isActive && 'opacity-50',
                )}
              >
                {isLoadingThis && (
                  <Loader2 className="size-3 animate-spin" />
                )}
                {option.label}
              </button>
            )
          })}
        </div>
      ) : null}

      {/* Scrollable content */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl px-4 py-4 md:px-6">
          {children}
        </div>
      </div>
    </div>
  )
}
