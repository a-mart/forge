import { useEffect, useMemo, useState } from 'react'
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { abbreviateNumber } from './chart-utils'
import type { DailyUsageBucket, StatsRange } from '@forge/protocol'

const PAGE_SIZE = 7
const WEEKLY_BUCKET_THRESHOLD_DAYS = 90
const DAY_MS = 24 * 60 * 60 * 1000

const chartConfig: ChartConfig = {
  tokens: {
    label: 'Tokens',
    color: 'var(--chart-1)',
  },
  cachedTokens: {
    label: 'Cached',
    color: 'var(--chart-3)',
  },
}

interface DailyUsageChartProps {
  data: DailyUsageBucket[]
  range: StatsRange
}

interface ChartBucket {
  key: string
  label: string
  startDate: string
  endDate: string
  tokens: number
  inputTokens: number
  outputTokens: number
  cachedTokens: number
}

export function DailyUsageChart({ data, range }: DailyUsageChartProps) {
  const aggregationMode = useMemo<'daily' | 'weekly' | 'monthly'>(() => {
    if (range !== 'all') {
      return 'daily'
    }

    return data.length <= WEEKLY_BUCKET_THRESHOLD_DAYS ? 'weekly' : 'monthly'
  }, [data.length, range])

  const chartData = useMemo(() => {
    if (aggregationMode === 'weekly') {
      return aggregateByWeek(data)
    }

    if (aggregationMode === 'monthly') {
      return aggregateByMonth(data)
    }

    return toDailyBuckets(data)
  }, [aggregationMode, data])

  const showPagination = range !== '7d'
  const pages = useMemo(() => {
    if (chartData.length === 0) {
      return [[]] as ChartBucket[][]
    }

    if (!showPagination) {
      return [chartData]
    }

    return paginateFromEnd(chartData, PAGE_SIZE)
  }, [chartData, showPagination])

  const totalPages = pages.length
  const [page, setPage] = useState(Math.max(0, totalPages - 1))

  useEffect(() => {
    setPage(Math.max(0, totalPages - 1))
  }, [totalPages, range])

  const pageData = useMemo(
    () => pages[Math.min(page, totalPages - 1)] ?? [],
    [pages, page, totalPages],
  )

  const headerLabel = useMemo(() => {
    if (range === 'all') {
      return aggregationMode === 'weekly' ? 'Weekly Usage' : 'Monthly Usage'
    }

    if (pageData.length === 0) {
      return ''
    }

    if (pageData.length === 1) {
      return pageData[0].label
    }

    return `${pageData[0].label} to ${pageData[pageData.length - 1].label}`
  }, [aggregationMode, pageData, range])

  const canGoBack = page > 0
  const canGoForward = page < totalPages - 1
  const showPaginationControls = showPagination && totalPages > 1

  if (chartData.length === 0) {
    return (
      <Card className="border-border/50 bg-card/80 p-3 backdrop-blur-sm">
        <div className="flex h-[200px] items-center justify-center text-sm text-muted-foreground">
          No daily usage data available
        </div>
      </Card>
    )
  }

  return (
    <Card className="border-border/50 bg-card/80 p-3 backdrop-blur-sm">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-sm text-muted-foreground">{headerLabel}</span>
        {showPaginationControls ? (
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={!canGoBack}
              aria-label="Previous date range"
            >
              <ChevronLeft className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={!canGoForward}
              aria-label="Next date range"
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        ) : null}
      </div>
      <ChartContainer config={chartConfig} className="h-[200px] w-full">
        <BarChart data={pageData} barCategoryGap="20%">
          <CartesianGrid
            vertical={false}
            stroke="var(--border)"
            strokeOpacity={0.3}
          />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            tick={{ fill: 'var(--muted-foreground)', fontSize: 12 }}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            tick={{ fill: 'var(--muted-foreground)', fontSize: 12 }}
            tickFormatter={(value: number) => abbreviateNumber(value)}
            width={50}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                formatter={(value) => {
                  if (typeof value === 'number') {
                    return value.toLocaleString()
                  }
                  return String(value)
                }}
              />
            }
          />
          <Bar
            dataKey="tokens"
            fill="var(--chart-1)"
            radius={[4, 4, 0, 0]}
          />
        </BarChart>
      </ChartContainer>
    </Card>
  )
}

function toDailyBuckets(data: DailyUsageBucket[]): ChartBucket[] {
  return data
    .slice()
    .sort((left, right) => left.date.localeCompare(right.date))
    .map((bucket) => ({
      key: bucket.date,
      label: bucket.dateLabel,
      startDate: bucket.date,
      endDate: bucket.date,
      tokens: bucket.tokens,
      inputTokens: bucket.inputTokens,
      outputTokens: bucket.outputTokens,
      cachedTokens: bucket.cachedTokens,
    }))
}

function aggregateByWeek(data: DailyUsageBucket[]): ChartBucket[] {
  const totalsByWeek = new Map<string, ChartBucket>()

  for (const bucket of data) {
    const date = parseDayKey(bucket.date)
    const weekStart = getIsoWeekStart(date)
    const weekStartKey = toDayKey(weekStart)
    const weekEnd = addUtcDays(weekStart, 6)

    const existing = totalsByWeek.get(weekStartKey)
    if (!existing) {
      totalsByWeek.set(weekStartKey, {
        key: weekStartKey,
        label: formatWeekLabel(weekStart, weekEnd),
        startDate: weekStartKey,
        endDate: toDayKey(weekEnd),
        tokens: bucket.tokens,
        inputTokens: bucket.inputTokens,
        outputTokens: bucket.outputTokens,
        cachedTokens: bucket.cachedTokens,
      })
      continue
    }

    existing.tokens += bucket.tokens
    existing.inputTokens += bucket.inputTokens
    existing.outputTokens += bucket.outputTokens
    existing.cachedTokens += bucket.cachedTokens
  }

  return Array.from(totalsByWeek.values()).sort((left, right) => left.startDate.localeCompare(right.startDate))
}

function aggregateByMonth(data: DailyUsageBucket[]): ChartBucket[] {
  const totalsByMonth = new Map<string, ChartBucket>()
  const years = new Set<number>()

  for (const bucket of data) {
    const date = parseDayKey(bucket.date)
    years.add(date.getUTCFullYear())
    const year = date.getUTCFullYear()
    const month = date.getUTCMonth() + 1
    const monthKey = `${year}-${String(month).padStart(2, '0')}`

    const existing = totalsByMonth.get(monthKey)
    if (!existing) {
      const monthStart = new Date(Date.UTC(year, month - 1, 1))
      const monthEnd = new Date(Date.UTC(year, month, 0))

      totalsByMonth.set(monthKey, {
        key: monthKey,
        label: formatMonthLabel(monthStart, years.size > 1),
        startDate: toDayKey(monthStart),
        endDate: toDayKey(monthEnd),
        tokens: bucket.tokens,
        inputTokens: bucket.inputTokens,
        outputTokens: bucket.outputTokens,
        cachedTokens: bucket.cachedTokens,
      })
      continue
    }

    existing.tokens += bucket.tokens
    existing.inputTokens += bucket.inputTokens
    existing.outputTokens += bucket.outputTokens
    existing.cachedTokens += bucket.cachedTokens
  }

  const includeYear = years.size > 1
  return Array.from(totalsByMonth.values())
    .sort((left, right) => left.startDate.localeCompare(right.startDate))
    .map((bucket) => ({
      ...bucket,
      label: formatMonthLabel(parseDayKey(bucket.startDate), includeYear),
    }))
}

function paginateFromEnd<T>(items: T[], pageSize: number): T[][] {
  if (items.length === 0) {
    return [[]]
  }

  const pages: T[][] = []
  for (let end = items.length; end > 0; end -= pageSize) {
    const start = Math.max(0, end - pageSize)
    pages.unshift(items.slice(start, end))
  }

  return pages
}

function parseDayKey(dayKey: string): Date {
  const [yearRaw, monthRaw, dayRaw] = dayKey.split('-')
  const year = Number.parseInt(yearRaw ?? '', 10)
  const month = Number.parseInt(monthRaw ?? '', 10)
  const day = Number.parseInt(dayRaw ?? '', 10)

  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return new Date(0)
  }

  return new Date(Date.UTC(year, month - 1, day))
}

function toDayKey(date: Date): string {
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function addUtcDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS)
}

function getIsoWeekStart(date: Date): Date {
  const day = date.getUTCDay()
  const diffToMonday = day === 0 ? -6 : 1 - day
  return addUtcDays(date, diffToMonday)
}

function formatWeekLabel(start: Date, end: Date): string {
  const sameMonth = start.getUTCFullYear() === end.getUTCFullYear() && start.getUTCMonth() === end.getUTCMonth()

  const startMonth = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(start)

  if (sameMonth) {
    return `${startMonth}-${end.getUTCDate()}`
  }

  const endMonth = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(end)

  return `${startMonth}-${endMonth}`
}

function formatMonthLabel(date: Date, includeYear: boolean): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    ...(includeYear ? { year: 'numeric' as const } : {}),
    timeZone: 'UTC',
  }).format(date)
}
