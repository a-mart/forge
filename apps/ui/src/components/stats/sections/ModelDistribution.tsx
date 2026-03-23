import { useMemo } from 'react'
import { Card } from '@/components/ui/card'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import type {
  ModelDistributionEntry,
  ModelReasoningBreakdownEntry,
} from '@forge/protocol'

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

function getReasoningBreakdown(
  model: ModelDistributionEntry,
): ModelReasoningBreakdownEntry[] {
  return Array.isArray(model.reasoningBreakdown)
    ? model.reasoningBreakdown
    : []
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
    (model) => getReasoningBreakdown(model).length > 0,
  )

  return (
    <div>
      <h3 className="mb-2.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        Top Models
      </h3>
      <Card className="border-border/50 bg-card/80 p-3 backdrop-blur-sm">
        {/* Stacked bar */}
        <TooltipProvider delayDuration={100}>
          <div className="flex h-8 w-full overflow-hidden rounded-md bg-muted/40">
            {sortedModels.map((model, i) => {
              const color = SEGMENT_COLORS[i % SEGMENT_COLORS.length]
              const breakdown = getReasoningBreakdown(model)

              if (hasReasoning && breakdown.length > 0) {
                return (
                  <Tooltip key={model.modelId}>
                    <TooltipTrigger asChild>
                      <div
                        className="flex h-full min-w-0 cursor-default"
                        style={{ width: `${model.percentage}%` }}
                      >
                        {breakdown.map((segment) => (
                          <div
                            key={segment.level}
                            className="h-full transition-all duration-300"
                            style={{
                              width: `${segment.percentage}%`,
                              backgroundColor: color,
                              opacity:
                                REASONING_OPACITY[segment.level] ?? 0.8,
                            }}
                          />
                        ))}
                      </div>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="text-xs">
                      <p className="font-medium">{model.displayName}</p>
                      <p className="text-muted-foreground">
                        {model.percentage.toFixed(1)}% ·{' '}
                        {formatTokens(model.tokenCount)} tokens
                      </p>
                      {breakdown.map((segment) => (
                        <p
                          key={segment.level}
                          className="text-muted-foreground"
                        >
                          {segment.level}: {formatTokens(segment.tokenCount)}
                        </p>
                      ))}
                    </TooltipContent>
                  </Tooltip>
                )
              }

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
        <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1.5">
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
