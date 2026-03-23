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

// Opacity levels for reasoning sub-segments within each bar
const REASONING_OPACITY: Record<string, number> = {
  none: 0.4,
  low: 0.6,
  medium: 0.8,
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

  // Find the max percentage to scale bars relatively
  const maxPercentage = sortedModels[0]?.percentage ?? 100

  return (
    <div>
      <h3 className="mb-2.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        Top Models
      </h3>
      <Card className="border-border/50 bg-card/80 p-3 backdrop-blur-sm">
        <TooltipProvider delayDuration={100}>
          <div className="space-y-2">
            {sortedModels.map((model, i) => {
              const color = SEGMENT_COLORS[i % SEGMENT_COLORS.length]
              const breakdown = getReasoningBreakdown(model)
              const barWidth = (model.percentage / maxPercentage) * 100

              return (
                <div key={model.modelId} className="flex items-center gap-2">
                  {/* Model name */}
                  <div className="w-32 shrink-0 truncate text-xs text-foreground/90">
                    {model.displayName}
                  </div>

                  {/* Horizontal bar */}
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div
                          className="flex h-6 min-w-0 overflow-hidden rounded-md transition-all duration-300"
                          style={{ width: `${barWidth}%` }}
                        >
                          {breakdown.length > 0 ? (
                            // Show reasoning breakdown as sub-segments
                            breakdown.map((segment) => (
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
                            ))
                          ) : (
                            // Single solid bar if no reasoning breakdown
                            <div
                              className="h-full w-full transition-all duration-300"
                              style={{ backgroundColor: color }}
                            />
                          )}
                        </div>
                      </TooltipTrigger>
                      <TooltipContent 
                        side="bottom" 
                        className="bg-background text-foreground border border-border/50 shadow-xl text-xs"
                      >
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

                    {/* Percentage label */}
                    <div className="w-12 shrink-0 text-right text-xs text-muted-foreground">
                      {model.percentage.toFixed(1)}%
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </TooltipProvider>
      </Card>
    </div>
  )
}
