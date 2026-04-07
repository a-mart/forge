import { useState, useCallback, useEffect, useRef } from 'react'
import { ChevronDown, ChevronUp, ChevronRight, Loader2 } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { abbreviateNumber } from '../charts/chart-utils'
import { cn } from '@/lib/utils'
import { WorkerRunEventsPanel } from './WorkerRunEventsPanel'
import type {
  TokenAnalyticsWorkerRunSummary,
  TokenAnalyticsWorkerSort,
  TokenAnalyticsSortDirection,
  TokenAnalyticsQuery,
} from '@forge/protocol'
import { fetchTokenWorkers } from './token-analytics-api'

function formatCost(value: number): string {
  if (value >= 100) return `$${value.toFixed(0)}`
  if (value >= 1) return `$${value.toFixed(2)}`
  if (value >= 0.01) return `$${value.toFixed(3)}`
  if (value > 0) return `$${value.toFixed(4)}`
  return '—'
}

function formatDuration(ms: number | null): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = Math.round(seconds % 60)
  return `${minutes}m ${remainingSeconds}s`
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

function shortWorkerId(workerId: string): string {
  if (workerId.length <= 12) return workerId
  return `${workerId.slice(0, 4)}…${workerId.slice(-4)}`
}

interface SortableHeaderProps {
  label: string
  field: TokenAnalyticsWorkerSort
  currentSort: TokenAnalyticsWorkerSort
  currentDir: TokenAnalyticsSortDirection
  onSort: (field: TokenAnalyticsWorkerSort) => void
  className?: string
}

function SortableHeader({ label, field, currentSort, currentDir, onSort, className }: SortableHeaderProps) {
  const isActive = currentSort === field
  return (
    <TableHead className={cn('cursor-pointer select-none', className)} onClick={() => onSort(field)}>
      <span className="inline-flex items-center gap-1">
        {label}
        {isActive ? (
          currentDir === 'desc' ? (
            <ChevronDown className="size-3" />
          ) : (
            <ChevronUp className="size-3" />
          )
        ) : null}
      </span>
    </TableHead>
  )
}

interface WorkerRunsTableProps {
  wsUrl: string
  query: TokenAnalyticsQuery
}

export function WorkerRunsTable({ wsUrl, query }: WorkerRunsTableProps) {
  const [items, setItems] = useState<TokenAnalyticsWorkerRunSummary[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [hasLoaded, setHasLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sort, setSort] = useState<TokenAnalyticsWorkerSort>('startedAt')
  const [direction, setDirection] = useState<TokenAnalyticsSortDirection>('desc')
  const [expandedWorkerId, setExpandedWorkerId] = useState<string | null>(null)

  // Reset all table state when query filters change so stale data/cursors don't leak
  const queryKey = JSON.stringify({
    rangePreset: query.rangePreset,
    startDate: query.startDate,
    endDate: query.endDate,
    profileId: query.profileId,
    provider: query.provider,
    modelId: query.modelId,
    attribution: query.attribution,
    specialistId: query.specialistId,
  })
  const prevQueryKeyRef = useRef(queryKey)

  useEffect(() => {
    if (prevQueryKeyRef.current !== queryKey) {
      prevQueryKeyRef.current = queryKey
      setItems([])
      setTotalCount(0)
      setNextCursor(null)
      setHasLoaded(false)
      setExpandedWorkerId(null)
      setError(null)
    }
  }, [queryKey])

  const loadWorkers = useCallback(async (
    sortOverride?: TokenAnalyticsWorkerSort,
    dirOverride?: TokenAnalyticsSortDirection,
    cursor?: string,
  ) => {
    const isMore = Boolean(cursor)
    if (isMore) {
      setIsLoadingMore(true)
    } else {
      setIsLoading(true)
    }
    setError(null)
    try {
      const page = await fetchTokenWorkers(wsUrl, {
        ...query,
        limit: 20,
        cursor,
        sort: sortOverride ?? sort,
        direction: dirOverride ?? direction,
      })
      if (isMore) {
        setItems((prev) => [...prev, ...page.items])
      } else {
        setItems(page.items)
      }
      setTotalCount(page.totalCount)
      setNextCursor(page.nextCursor)
      setHasLoaded(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load workers')
    } finally {
      setIsLoading(false)
      setIsLoadingMore(false)
    }
  }, [wsUrl, query, sort, direction])

  const handleSort = (field: TokenAnalyticsWorkerSort) => {
    let newDir: TokenAnalyticsSortDirection = 'desc'
    if (sort === field) {
      newDir = direction === 'desc' ? 'asc' : 'desc'
    }
    setSort(field)
    setDirection(newDir)
    setExpandedWorkerId(null)
    void loadWorkers(field, newDir)
  }

  const handleLoadInitial = () => {
    void loadWorkers()
  }

  const handleLoadMore = () => {
    if (nextCursor) {
      void loadWorkers(sort, direction, nextCursor)
    }
  }

  const toggleExpand = (workerId: string) => {
    setExpandedWorkerId((prev) => (prev === workerId ? null : workerId))
  }

  if (!hasLoaded) {
    return (
      <Card className="border-border/50 bg-card/80 p-3 backdrop-blur-sm">
        <div className="flex items-center justify-between">
          <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Worker Runs
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={handleLoadInitial}
            disabled={isLoading}
          >
            {isLoading ? <Loader2 className="mr-1.5 size-3 animate-spin" /> : null}
            Load worker runs
          </Button>
        </div>
      </Card>
    )
  }

  return (
    <Card className="border-border/50 bg-card/80 backdrop-blur-sm">
      <div className="p-3 pb-0">
        <div className="flex items-center justify-between">
          <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Worker Runs
            <span className="ml-1.5 text-muted-foreground/60">({totalCount.toLocaleString()})</span>
          </div>
        </div>
      </div>

      {error ? (
        <div className="p-3 text-xs text-destructive">{error}</div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="border-border/30 hover:bg-transparent">
                  <TableHead className="w-8" />
                  <TableHead>Worker</TableHead>
                  <TableHead>Project</TableHead>
                  <TableHead>Specialist</TableHead>
                  <TableHead>Model(s)</TableHead>
                  <SortableHeader label="Started" field="startedAt" currentSort={sort} currentDir={direction} onSort={handleSort} />
                  <SortableHeader label="Duration" field="durationMs" currentSort={sort} currentDir={direction} onSort={handleSort} className="text-right" />
                  <SortableHeader label="Tokens" field="totalTokens" currentSort={sort} currentDir={direction} onSort={handleSort} className="text-right" />
                  <SortableHeader label="Cost" field="cost" currentSort={sort} currentDir={direction} onSort={handleSort} className="text-right" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((worker) => {
                  const isExpanded = expandedWorkerId === worker.workerId
                  const primaryModel = worker.modelsUsed[0]
                  return (
                    <WorkerRow
                      key={worker.workerId}
                      worker={worker}
                      primaryModel={primaryModel}
                      isExpanded={isExpanded}
                      onToggle={() => toggleExpand(worker.workerId)}
                      wsUrl={wsUrl}
                    />
                  )
                })}
                {items.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={9} className="py-8 text-center text-xs text-muted-foreground">
                      No worker runs found
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>

          {nextCursor ? (
            <div className="flex justify-center border-t border-border/20 p-3">
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={handleLoadMore}
                disabled={isLoadingMore}
              >
                {isLoadingMore ? <Loader2 className="mr-1.5 size-3 animate-spin" /> : null}
                Load more ({items.length} of {totalCount})
              </Button>
            </div>
          ) : null}
        </>
      )}
    </Card>
  )
}

interface WorkerRowProps {
  worker: TokenAnalyticsWorkerRunSummary
  primaryModel: { modelId: string; provider: string; totalTokens: number } | undefined
  isExpanded: boolean
  onToggle: () => void
  wsUrl: string
}

function WorkerRow({ worker, primaryModel, isExpanded, onToggle, wsUrl }: WorkerRowProps) {
  const specialistLabel = worker.specialistDisplayName
    ?? (worker.attributionKind === 'ad_hoc' ? 'Ad-hoc' : worker.attributionKind === 'unknown' ? 'Unknown' : '—')

  return (
    <>
      <TableRow
        className={cn(
          'border-border/20 cursor-pointer',
          isExpanded && 'bg-muted/20',
        )}
        onClick={onToggle}
      >
        <TableCell className="w-8 px-2">
          <ChevronRight
            className={cn(
              'size-3.5 text-muted-foreground transition-transform',
              isExpanded && 'rotate-90',
            )}
          />
        </TableCell>
        <TableCell className="font-mono text-xs">
          {shortWorkerId(worker.workerId)}
        </TableCell>
        <TableCell className="text-xs text-muted-foreground">
          {worker.profileDisplayName}
        </TableCell>
        <TableCell className="text-xs">
          <span className="inline-flex items-center gap-1.5">
            {worker.specialistColor ? (
              <span
                className="inline-block size-2 shrink-0 rounded-full"
                style={{ backgroundColor: worker.specialistColor }}
              />
            ) : null}
            {specialistLabel}
          </span>
        </TableCell>
        <TableCell className="text-xs text-muted-foreground">
          {primaryModel ? primaryModel.modelId : '—'}
          {worker.modelsUsed.length > 1 ? (
            <span className="ml-1 text-muted-foreground/50">
              +{worker.modelsUsed.length - 1}
            </span>
          ) : null}
        </TableCell>
        <TableCell className="text-xs text-muted-foreground">
          {formatTimestamp(worker.startedAt)}
        </TableCell>
        <TableCell className="text-right font-mono text-xs">
          {formatDuration(worker.durationMs)}
        </TableCell>
        <TableCell className="text-right font-mono text-xs">
          {abbreviateNumber(worker.usage.total)}
        </TableCell>
        <TableCell className="text-right font-mono text-xs">
          {formatCost(worker.cost.totals?.total ?? 0)}
        </TableCell>
      </TableRow>
      {isExpanded ? (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={9} className="bg-muted/10 p-0">
            <WorkerRunEventsPanel
              wsUrl={wsUrl}
              profileId={worker.profileId}
              sessionId={worker.sessionId}
              workerId={worker.workerId}
              worker={worker}
            />
          </TableCell>
        </TableRow>
      ) : null}
    </>
  )
}
