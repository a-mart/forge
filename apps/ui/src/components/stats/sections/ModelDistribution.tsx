import { useMemo } from 'react'
import { Card } from '@/components/ui/card'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import type { ModelDistributionEntry } from '@forge/protocol'

// Extend the entry type to handle optional reasoning breakdown from backend
interface ModelEntryWithReasoning extends ModelDistributionEntry {
  reasoningBreakdown?: Record<string, number>
}

interface ModelDistributionProps {
  models: ModelDistributionEntry[]
}

const SEGMENT_COLORS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
]

// Slightly lighter/darker variants for reasoning sub-segments
const REASONING_OPACITY: Record<string, number> = {
  none: 0.5,
  low: 0.7,
  medium: 0.85,
  high: 1.0,
  xhigh: 1.0,
}

function formatTokens(count: number): string {
  if (count >= 1_000_000_000) return `${(count / 1_000_000_000).toFixed(1)}b`
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}m`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`
  return count.toLocaleString()
}

export function ModelDistribution({ models }: ModelDistributionProps) {
  const sortedModels = useMemo(
    () => [...models].sort((a, b) => b.percentage - a.percentage),
    [models],
  )

  if (sortedModels.length === 0) {
    return null
  }

  const hasReasoning = sortedModels.some(
    (m) => (m as ModelEntryWithReasoning).reasoningBreakdown != null,
  )

  return (
    <div>
      <h3 className="mb-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        Top Models
      </h3>
      <Card className="border-border/50 bg-card/80 p-4 backdrop-blur-sm">
        {/* Stacked bar */}
        <TooltipProvider delayDuration={100}>
          <div className="flex h-8 w-full overflow-hidden rounded-md">
            {sortedModels.map((model, i) => {
              const color = SEGMENT_COLORS[i % SEGMENT_COLORS.length]
              const entry = model as ModelEntryWithReasoning
              const breakdown = entry.reasoningBreakdown

              if (hasReasoning && breakdown) {
                // Sub-stack for reasoning levels within this model segment
                const totalForModel = Object.values(breakdown).reduce(
                  (s, v) => s + v,
                  0,
                )
                return (
                  <Tooltip key={model.modelId}>
                    <TooltipTrigger asChild>
                      <div
                        className="flex h-full cursor-default"
                        style={{ width: `${model.percentage}%` }}
                      >
                        {Object.entries(breakdown).map(
                          ([level, tokens]) => {
                            const subPct =
                              totalForModel > 0
                                ? (tokens / totalForModel) * 100
                                : 0
                            return (
                              <div
                                key={level}
                                className="h-full transition-all duration-300"
                                style={{
                                  width: `${subPct}%`,
                                  backgroundColor: color,
                                  opacity:
                                    REASONING_OPACITY[level] ?? 0.8,
                                }}
                              />
                            )
                          },
                        )}
                      </div>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="text-xs">
                      <p className="font-medium">{model.displayName}</p>
                      <p className="text-muted-foreground">
                        {model.percentage.toFixed(1)}% ·{' '}
                        {formatTokens(model.tokenCount)} tokens
                      </p>
                      {Object.entries(breakdown).map(([level, tokens]) => (
                        <p
                          key={level}
                          className="text-muted-foreground"
                        >
                          {level}: {formatTokens(tokens)}
                        </p>
                      ))}
                    </TooltipContent>
                  </Tooltip>
                )
              }

              // Simple single-color segment
              return (
                <Tooltip key={model.modelId}>
                  <TooltipTrigger asChild>
                    <div
                      className="h-full cursor-default transition-all duration-300"
                      style={{
                        width: `${model.percentage}%`,
                        backgroundColor: color,
                      }}
                    />
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="text-xs">
                    <p className="font-medium">{model.displayName}</p>
                    <p className="text-muted-foreground">
                      {model.percentage.toFixed(1)}% ·{' '}
                      {formatTokens(model.tokenCount)} tokens
                    </p>
                  </TooltipContent>
                </Tooltip>
              )
            })}
          </div>
        </TooltipProvider>

        {/* Legend */}
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
          {sortedModels.map((model, i) => (
            <div key={model.modelId} className="flex items-center gap-1.5">
              <div
                className="size-2.5 shrink-0 rounded-[3px]"
                style={{
                  backgroundColor:
                    SEGMENT_COLORS[i % SEGMENT_COLORS.length],
                }}
              />
              <span className="text-xs text-foreground/90">
                {model.displayName}
              </span>
              <span className="text-xs text-muted-foreground">
                {model.percentage.toFixed(1)}%
              </span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}
