import { useEffect, useMemo, useState } from 'react'
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { abbreviateNumber } from './chart-utils'
import type { DailyUsageBucket } from '@forge/protocol'

const PAGE_SIZE = 7

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
}

export function DailyUsageChart({ data }: DailyUsageChartProps) {
  const totalPages = Math.max(1, Math.ceil(data.length / PAGE_SIZE))
  const [page, setPage] = useState(totalPages - 1) // Start at the latest page

  useEffect(() => {
    setPage(Math.max(0, Math.ceil(data.length / PAGE_SIZE) - 1))
  }, [data.length])

  const pageData = useMemo(() => {
    const start = page * PAGE_SIZE
    return data.slice(start, start + PAGE_SIZE)
  }, [data, page])

  const dateRange = useMemo(() => {
    if (pageData.length === 0) return ''
    if (pageData.length === 1) return pageData[0].dateLabel
    return `${pageData[0].dateLabel} to ${pageData[pageData.length - 1].dateLabel}`
  }, [pageData])

  const canGoBack = page > 0
  const canGoForward = page < totalPages - 1

  if (data.length === 0) {
    return (
      <Card className="border-border/50 bg-card/80 p-4 backdrop-blur-sm">
        <div className="flex h-[200px] items-center justify-center text-sm text-muted-foreground">
          No daily usage data available
        </div>
      </Card>
    )
  }

  return (
    <Card className="border-border/50 bg-card/80 p-4 backdrop-blur-sm">
      <div className="mb-4 flex items-center justify-between">
        <span className="text-sm text-muted-foreground">{dateRange}</span>
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
      </div>
      <ChartContainer config={chartConfig} className="h-[200px] w-full">
        <BarChart data={pageData} barCategoryGap="20%">
          <CartesianGrid
            vertical={false}
            stroke="var(--border)"
            strokeOpacity={0.3}
          />
          <XAxis
            dataKey="dateLabel"
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
