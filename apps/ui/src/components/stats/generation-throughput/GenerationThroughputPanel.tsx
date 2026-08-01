import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertCircle, BarChart3, ChevronRight, RefreshCw } from 'lucide-react'
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type {
  GenerationThroughputCall,
  GenerationThroughputCallsPage,
  GenerationThroughputQuery,
  GenerationThroughputSnapshot,
} from '@forge/protocol'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { StatCard } from '../cards/StatCard'
import { StatsLayout } from '../StatsLayout'
import type { StatsTab } from '@/hooks/index-page/use-route-state'
import { cn } from '@/lib/utils'
import { GenerationThroughputApiError, fetchGenerationCalls } from './generation-throughput-api'
import { GenerationThroughputFilters, type GenerationThroughputFilterState } from './GenerationThroughputFilters'
import { useGenerationThroughput } from './use-generation-throughput'

type TrendMetric = 'weighted' | 'p50' | 'ttft'

export function GenerationThroughputPanel({
  wsUrl,
  onBack,
  activeTab,
  onTabChange,
}: {
  wsUrl: string
  onBack: () => void
  activeTab?: StatsTab
  onTabChange?: (tab: StatsTab) => void
}) {
  const [filters, setFilters] = useState<GenerationThroughputFilterState>({ rangePreset: '7d', quality: 'all_measured' })
  const [trendMetric, setTrendMetric] = useState<TrendMetric>('weighted')
  const query = useMemo<GenerationThroughputQuery>(() => ({ ...filters }), [filters])
  const { snapshot, isLoading, isRefreshing, isSwitchingQuery, error, refresh } = useGenerationThroughput(wsUrl, query)
  const back = useCallback(() => onTabChange ? onTabChange('overview') : onBack(), [onBack, onTabChange])

  return (
    <StatsLayout
      onBack={back}
      computedAt={snapshot?.computedAt}
      isRefreshing={isRefreshing}
      onRefresh={refresh}
      activeTab={activeTab}
      onTabChange={onTabChange}
      hideRangeSelector
    >
      {isLoading && !snapshot ? <ThroughputSkeleton /> : null}
      {error && !snapshot ? <ThroughputError error={error} onRetry={refresh} /> : null}
      {snapshot ? (
        <div className={cn('space-y-4 transition-opacity duration-200', (isRefreshing || isSwitchingQuery) && 'opacity-60')}>
          <GenerationThroughputFilters filters={filters} availableFilters={snapshot.availableFilters} onFiltersChange={setFilters} />
          <CoverageNotice snapshot={snapshot} />
          {snapshot.totals.measuredCallCount === 0 ? (
            <ThroughputEmpty filtered={hasFilters(filters)} />
          ) : (
            <>
              <HeadlineCards snapshot={snapshot} />
              <RoleSummary snapshot={snapshot} />
              <TrendChart snapshot={snapshot} metric={trendMetric} onMetricChange={setTrendMetric} />
              <ModelTable snapshot={snapshot} />
              <RecentCalls wsUrl={wsUrl} query={query} />
            </>
          )}
        </div>
      ) : null}
    </StatsLayout>
  )
}

function ThroughputSkeleton() {
  return <div className="space-y-4"><div className="flex gap-2"><Skeleton className="h-8 w-28" /><Skeleton className="h-8 w-28" /></div><div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">{Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-28" />)}</div><Skeleton className="h-64" /></div>
}

function ThroughputError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const unsupported = error instanceof GenerationThroughputApiError && error.status === 404
  return <div className="flex flex-col items-center justify-center py-20 text-center"><div className="mb-4 flex size-14 items-center justify-center rounded-full bg-muted/50"><AlertCircle className="size-7 text-muted-foreground" /></div><h2 className="mb-1 text-sm font-medium text-foreground">{unsupported ? 'Throughput is unavailable on this Forge backend' : 'Failed to load throughput'}</h2><p className="mb-4 max-w-sm text-xs text-muted-foreground">{unsupported ? 'Update the connected Forge backend to view generation throughput.' : error instanceof Error ? error.message : 'Try again in a moment.'}</p><Button variant="outline" size="sm" onClick={onRetry}>Try again</Button></div>
}

function ThroughputEmpty({ filtered }: { filtered: boolean }) {
  return <div className="flex flex-col items-center justify-center py-20 text-center"><div className="mb-4 flex size-14 items-center justify-center rounded-full bg-muted/50"><BarChart3 className="size-7 text-muted-foreground" /></div><h2 className="mb-1 text-sm font-medium text-foreground">{filtered ? 'No throughput calls match the current filters' : 'No throughput data yet'}</h2><p className="max-w-md text-xs text-muted-foreground">{filtered ? 'Try adjusting the range or filters.' : 'Throughput is available for generations recorded after this Forge update.'}</p></div>
}

function CoverageNotice({ snapshot }: { snapshot: GenerationThroughputSnapshot }) {
  const { totals } = snapshot
  if (totals.terminalCallCount === 0) return null
  const lowCoverage = totals.coverage < 0.8
  const hiddenReasoning = totals.hiddenReasoningBoundaryCallCount > 0
  if (!lowCoverage && !hiddenReasoning && snapshot.diagnostics.incompleteCallCount === 0) return null
  return <Card className="border-border/50 bg-muted/30 p-3 text-xs text-muted-foreground"><strong className="text-foreground">Coverage note.</strong>{lowCoverage ? ` ${formatPercent(totals.coverage)} of terminal calls have provider-final tokens and usable generation boundaries.` : ''}{hiddenReasoning ? ` ${totals.hiddenReasoningBoundaryCallCount} call${totals.hiddenReasoningBoundaryCallCount === 1 ? '' : 's'} may include hidden reasoning without an observed boundary.` : ''}{snapshot.diagnostics.incompleteCallCount ? ` ${snapshot.diagnostics.incompleteCallCount} started call${snapshot.diagnostics.incompleteCallCount === 1 ? '' : 's'} did not reach a terminal record.` : ''}</Card>
}

function HeadlineCards({ snapshot }: { snapshot: GenerationThroughputSnapshot }) {
  const { totals } = snapshot
  return <><p className="text-xs text-muted-foreground">Provider output tok/s includes provider-reported reasoning tokens when available. Rates span one Pi agent model call; agent retries are separate calls, while provider-internal retries and Codex WebSocket replays are not timed as separate rates.</p><div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"><StatCard title="Provider output tok/s" value={formatRate(totals.weightedTokensPerSecond)} subtitle="Token-weighted across selected calls" variant="accent" /><StatCard title="p50 call tok/s" value={formatRate(totals.p50TokensPerSecond)} subtitle={`p90 ${formatRate(totals.p90TokensPerSecond)} tok/s`} /><StatCard title="p50 TTFT" value={formatDuration(totals.p50TimeToFirstOutputMs)} subtitle={`${formatPercent(totals.timeToFirstOutputCoverage)} exact TTFT coverage`} /><StatCard title="Measured calls" value={String(totals.measuredCallCount)} subtitle={`${formatPercent(totals.coverage)} of ${totals.terminalCallCount} terminal calls`} /></div></>
}

function RoleSummary({ snapshot }: { snapshot: GenerationThroughputSnapshot }) {
  return <Card className="border-border/50 bg-card/80 p-4"><h2 className="mb-3 text-sm font-semibold">Manager vs worker</h2><div className="grid gap-3 sm:grid-cols-2">{snapshot.byRole.map((role) => <div key={role.role} className="rounded-md border border-border/50 bg-muted/20 p-3"><div className="mb-2 text-xs font-medium capitalize text-muted-foreground">{role.role}</div><div className="flex items-baseline justify-between gap-3"><span className="font-mono text-xl font-bold">{formatRate(role.weightedTokensPerSecond)} <span className="text-xs font-medium text-muted-foreground">tok/s</span></span><span className="text-xs text-muted-foreground">p50 {formatRate(role.p50TokensPerSecond)}</span></div><div className="mt-2 text-xs text-muted-foreground">{role.measuredCallCount} measured · {formatTokens(role.outputTokens)} output · {formatPercent(role.coverage)} coverage</div></div>)}</div></Card>
}

function TrendChart({ snapshot, metric, onMetricChange }: { snapshot: GenerationThroughputSnapshot; metric: TrendMetric; onMetricChange: (metric: TrendMetric) => void }) {
  const data = useMemo(() => {
    const byDate = new Map<string, Record<string, string | number>>()
    snapshot.trends.forEach((trend, trendIndex) => trend.points.forEach((point) => {
      const entry = byDate.get(point.date) ?? { date: point.date, label: point.dateLabel }
      entry[`m${trendIndex}`] = metric === 'weighted' ? point.weightedTokensPerSecond ?? 0 : metric === 'p50' ? point.p50TokensPerSecond ?? 0 : point.p50TimeToFirstOutputMs ?? 0
      byDate.set(point.date, entry)
    }))
    return Array.from(byDate.values()).sort((left, right) => String(left.date).localeCompare(String(right.date)))
  }, [metric, snapshot.trends])
  const title = metric === 'weighted' ? 'Weighted tok/s' : metric === 'p50' ? 'p50 tok/s' : 'p50 TTFT (ms)'
  return <Card className="border-border/50 bg-card/80 p-4"><div className="mb-3 flex flex-wrap items-center justify-between gap-2"><div><h2 className="text-sm font-semibold">Model performance trends</h2><p className="text-xs text-muted-foreground">Daily {title}; up to eight models by measured output.</p></div><div className="flex gap-1">{([['weighted', 'Weighted'], ['p50', 'p50'], ['ttft', 'TTFT']] as const).map(([value, label]) => <Button key={value} type="button" size="sm" variant={metric === value ? 'secondary' : 'ghost'} className="h-7 text-xs" onClick={() => onMetricChange(value)}>{label}</Button>)}</div></div>{data.length ? <div className="h-56"><ResponsiveContainer width="100%" height="100%"><LineChart data={data}><CartesianGrid vertical={false} stroke="var(--border)" strokeOpacity={0.3} /><XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }} /><YAxis tickLine={false} axisLine={false} tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }} width={48} /><Tooltip formatter={(value) => typeof value === 'number' ? metric === 'ttft' ? `${Math.round(value)} ms` : `${value.toFixed(1)} tok/s` : String(value)} /><Legend formatter={(value) => snapshot.trends.find((_trend, index) => `m${index}` === String(value))?.displayName ?? 'Model'} />{snapshot.trends.map((trend, index) => <Line key={`${trend.provider}/${trend.modelId}`} type="monotone" dataKey={`m${index}`} stroke={`var(--chart-${(index % 5) + 1})`} dot={false} strokeWidth={2} connectNulls />)}</LineChart></ResponsiveContainer></div> : <div className="flex h-56 items-center justify-center text-sm text-muted-foreground">No measured trend points in this range.</div>}</Card>
}

function ModelTable({ snapshot }: { snapshot: GenerationThroughputSnapshot }) {
  return <Card className="overflow-hidden border-border/50 bg-card/80"><div className="border-b border-border/50 px-4 py-3"><h2 className="text-sm font-semibold">Model performance</h2><p className="text-xs text-muted-foreground">Provider output tok/s uses final provider output tokens.</p></div><div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead className="bg-muted/30 text-muted-foreground"><tr><th className="px-4 py-2 font-medium">Model</th><th className="px-3 py-2 font-medium">Calls</th><th className="px-3 py-2 font-medium">Output</th><th className="px-3 py-2 font-medium">Weighted</th><th className="px-3 py-2 font-medium">p50 / p90</th><th className="px-3 py-2 font-medium">TTFT</th><th className="px-3 py-2 font-medium">Coverage</th></tr></thead><tbody>{snapshot.models.map((model) => <tr key={`${model.provider}/${model.modelId}`} className="border-t border-border/40"><td className="px-4 py-2"><div className="font-medium text-foreground">{model.displayName}</div><div className="text-muted-foreground">{model.provider}</div></td><td className="px-3 py-2">{model.measuredCallCount}</td><td className="px-3 py-2">{formatTokens(model.outputTokens)}</td><td className="px-3 py-2 font-mono">{formatRate(model.weightedTokensPerSecond)}</td><td className="px-3 py-2">{formatRate(model.p50TokensPerSecond)} / {formatRate(model.p90TokensPerSecond)}</td><td className="px-3 py-2">{formatDuration(model.p50TimeToFirstOutputMs)}</td><td className="px-3 py-2">{formatPercent(model.coverage)}</td></tr>)}</tbody></table></div>{snapshot.modelTableTruncated ? <p className="border-t border-border/50 px-4 py-2 text-xs text-muted-foreground">Showing the top 100 models by measured output.</p> : null}</Card>
}

function RecentCalls({ wsUrl, query }: { wsUrl: string; query: GenerationThroughputQuery }) {
  const [page, setPage] = useState<GenerationThroughputCallsPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [cursor, setCursor] = useState<string | undefined>()
  const queryKey = JSON.stringify(query)
  useEffect(() => { setCursor(undefined) }, [queryKey])
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetchGenerationCalls(wsUrl, { ...query, cursor, limit: 25 }).then((next) => { if (!cancelled) setPage(next) }).catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : 'Failed to load calls') }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [cursor, query, queryKey, wsUrl])
  return <Card className="overflow-hidden border-border/50 bg-card/80"><div className="flex items-center justify-between border-b border-border/50 px-4 py-3"><div><h2 className="text-sm font-semibold">Recent generations</h2><p className="text-xs text-muted-foreground">Per-provider calls, not agent-run duration.</p></div>{loading ? <RefreshCw className="size-4 animate-spin text-muted-foreground" /> : null}</div>{error ? <p className="p-4 text-xs text-destructive">{error}</p> : <CallsTable calls={page?.items ?? []} />}{page?.nextCursor ? <div className="border-t border-border/50 p-2 text-right"><Button variant="ghost" size="sm" className="gap-1 text-xs" onClick={() => setCursor(page.nextCursor ?? undefined)}>Load more <ChevronRight className="size-3" /></Button></div> : null}</Card>
}

function CallsTable({ calls }: { calls: GenerationThroughputCall[] }) {
  return <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead className="bg-muted/30 text-muted-foreground"><tr><th className="px-4 py-2 font-medium">Completed</th><th className="px-3 py-2 font-medium">Session / agent</th><th className="px-3 py-2 font-medium">Model</th><th className="px-3 py-2 font-medium">Output</th><th className="px-3 py-2 font-medium">Duration</th><th className="px-3 py-2 font-medium">tok/s</th><th className="px-3 py-2 font-medium">Quality</th></tr></thead><tbody>{calls.map((call) => <tr key={call.measurementId} className="border-t border-border/40"><td className="px-4 py-2 text-muted-foreground">{call.completedAt ? new Date(call.completedAt).toLocaleString() : '—'}</td><td className="px-3 py-2"><div>{call.sessionLabel}</div><div className="text-muted-foreground">{call.role}{call.specialistDisplayName ? ` · ${call.specialistDisplayName}` : ''}</div></td><td className="px-3 py-2"><div>{call.modelId}</div><div className="text-muted-foreground">{call.provider}</div></td><td className="px-3 py-2">{call.outputTokens === null ? '—' : formatTokens(call.outputTokens)}</td><td className="px-3 py-2">{formatDuration(call.generationDurationMs)}</td><td className="px-3 py-2 font-mono">{formatRate(call.tokensPerSecond)}</td><td className="px-3 py-2"><span className={cn('rounded px-1.5 py-0.5', call.quality.boundarySource === 'content_delta_to_stream_end' ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-muted text-muted-foreground')}>{call.quality.boundarySource === 'content_delta_to_stream_end' ? 'Strict' : call.tokensPerSecond === null ? 'Unmeasured' : 'Proxy'}</span></td></tr>)}{calls.length === 0 ? <tr><td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">No recent calls for these filters.</td></tr> : null}</tbody></table></div>
}

function hasFilters(filters: GenerationThroughputFilterState): boolean { return Boolean(filters.profileId || filters.role && filters.role !== 'all' || filters.provider || filters.modelId || filters.specialistId || filters.attribution && filters.attribution !== 'all') }
function formatRate(value: number | null): string { return value === null ? '—' : value.toFixed(1) }
function formatDuration(value: number | null): string { if (value === null) return '—'; return value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}s` : `${Math.round(value)}ms` }
function formatTokens(value: number): string { return Math.round(value).toLocaleString() }
function formatPercent(value: number): string { return `${Math.round(value * 100)}%` }
