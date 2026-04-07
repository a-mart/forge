import { Card } from '@/components/ui/card'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { TokenAnalyticsAttributionSummary } from '@forge/protocol'

const ATTRIBUTION_COLORS: Record<string, string> = {
  specialist: '#8b5cf6', // violet
  adHoc: '#3b82f6',     // blue
  unknown: '#6b7280',    // gray
}

const ATTRIBUTION_LABELS: Record<string, string> = {
  specialist: 'Specialist',
  adHoc: 'Ad-hoc',
  unknown: 'Unknown',
}

interface BarSegment {
  key: string
  label: string
  value: number
  percentage: number
  color: string
}

function HorizontalStackedBar({ segments }: { segments: BarSegment[] }) {
  const total = segments.reduce((sum, s) => sum + s.value, 0)
  if (total === 0) {
    return (
      <div className="h-6 rounded bg-muted/30" />
    )
  }

  return (
    <TooltipProvider>
      <div className="flex h-6 overflow-hidden rounded">
        {segments.map((segment) => {
          if (segment.percentage < 0.5) return null
          return (
            <Tooltip key={segment.key}>
              <TooltipTrigger asChild>
                <div
                  className="flex items-center justify-center transition-all hover:opacity-80"
                  style={{
                    width: `${Math.max(segment.percentage, 2)}%`,
                    backgroundColor: segment.color,
                  }}
                >
                  {segment.percentage >= 10 ? (
                    <span className="text-[10px] font-medium text-white">
                      {segment.percentage.toFixed(0)}%
                    </span>
                  ) : null}
                </div>
              </TooltipTrigger>
              <TooltipContent>
                <p className="text-xs">
                  {segment.label}: {segment.value.toLocaleString()} ({segment.percentage.toFixed(1)}%)
                </p>
              </TooltipContent>
            </Tooltip>
          )
        })}
      </div>
    </TooltipProvider>
  )
}

function Legend({ segments }: { segments: BarSegment[] }) {
  return (
    <div className="mt-2 flex flex-wrap gap-3">
      {segments.map((segment) => (
        <div key={segment.key} className="flex items-center gap-1.5">
          <span
            className="inline-block size-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: segment.color }}
          />
          <span className="text-[11px] text-muted-foreground">
            {segment.label} — {segment.value.toLocaleString()} ({segment.percentage.toFixed(1)}%)
          </span>
        </div>
      ))}
    </div>
  )
}

interface SpecialistAttributionCardsProps {
  attribution: TokenAnalyticsAttributionSummary
}

export function SpecialistAttributionCards({
  attribution,
}: SpecialistAttributionCardsProps) {
  const runSegments: BarSegment[] = [
    {
      key: 'specialist',
      label: ATTRIBUTION_LABELS.specialist,
      value: attribution.specialist.runCount,
      percentage: attribution.specialist.runPercentage,
      color: ATTRIBUTION_COLORS.specialist,
    },
    {
      key: 'adHoc',
      label: ATTRIBUTION_LABELS.adHoc,
      value: attribution.adHoc.runCount,
      percentage: attribution.adHoc.runPercentage,
      color: ATTRIBUTION_COLORS.adHoc,
    },
    {
      key: 'unknown',
      label: ATTRIBUTION_LABELS.unknown,
      value: attribution.unknown.runCount,
      percentage: attribution.unknown.runPercentage,
      color: ATTRIBUTION_COLORS.unknown,
    },
  ]

  const tokenSegments: BarSegment[] = [
    {
      key: 'specialist',
      label: ATTRIBUTION_LABELS.specialist,
      value: attribution.specialist.usage.total,
      percentage: attribution.specialist.tokenPercentage,
      color: ATTRIBUTION_COLORS.specialist,
    },
    {
      key: 'adHoc',
      label: ATTRIBUTION_LABELS.adHoc,
      value: attribution.adHoc.usage.total,
      percentage: attribution.adHoc.tokenPercentage,
      color: ATTRIBUTION_COLORS.adHoc,
    },
    {
      key: 'unknown',
      label: ATTRIBUTION_LABELS.unknown,
      value: attribution.unknown.usage.total,
      percentage: attribution.unknown.tokenPercentage,
      color: ATTRIBUTION_COLORS.unknown,
    },
  ]

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Card className="border-border/50 bg-card/80 p-3 backdrop-blur-sm">
        <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Worker Origin (by runs)
        </div>
        <HorizontalStackedBar segments={runSegments} />
        <Legend segments={runSegments} />
      </Card>
      <Card className="border-border/50 bg-card/80 p-3 backdrop-blur-sm">
        <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Token Attribution (by tokens)
        </div>
        <HorizontalStackedBar segments={tokenSegments} />
        <Legend segments={tokenSegments} />
      </Card>
    </div>
  )
}
