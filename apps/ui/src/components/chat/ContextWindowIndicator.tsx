import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

interface ContextWindowIndicatorProps {
  usedTokens?: number
  contextWindow: number
  compactionCount?: number
  isUpdating?: boolean
}

const RING_RADIUS = 7
const RING_STROKE_WIDTH = 1.75
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

function formatTokens(value: number): string {
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    compactDisplay: 'short',
    maximumFractionDigits: 1,
  }).format(Math.max(0, Math.round(value)))
}

export function ContextWindowIndicator({
  usedTokens = 0,
  contextWindow,
  compactionCount,
  isUpdating = false,
}: ContextWindowIndicatorProps) {
  if (contextWindow <= 0) return null

  const fillRatio = isUpdating ? 0 : usedTokens / contextWindow
  const clampedFillRatio = Math.min(Math.max(fillRatio, 0), 1)
  const percentFull = isUpdating
    ? null
    : Math.min(Math.max(Math.round(fillRatio * 100), 0), 100)
  const progressOffset = RING_CIRCUMFERENCE * (1 - clampedFillRatio)

  const progressColorClass = isUpdating
    ? 'stroke-muted-foreground/50'
    : fillRatio >= 0.95
      ? 'stroke-red-500'
      : fillRatio >= 0.8
        ? 'stroke-amber-500'
        : 'stroke-emerald-500'

  const ariaLabel = isUpdating
    ? 'Context window usage updating'
    : `Context window ${percentFull}% full, ${formatTokens(usedTokens)} of ${formatTokens(contextWindow)} tokens used`

  return (
    <TooltipProvider delayDuration={200}>
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 text-muted-foreground hover:bg-accent/70 hover:text-foreground"
          aria-label={ariaLabel}
        >
          <svg
            viewBox="0 0 20 20"
            className="size-4 -rotate-90"
            role="img"
            aria-hidden="true"
          >
            <circle
              cx="10"
              cy="10"
              r={RING_RADIUS}
              strokeWidth={RING_STROKE_WIDTH}
              fill="none"
              className="stroke-muted-foreground/25"
            />
            <circle
              cx="10"
              cy="10"
              r={RING_RADIUS}
              strokeWidth={RING_STROKE_WIDTH}
              strokeLinecap="round"
              fill="none"
              className={progressColorClass}
              strokeDasharray={RING_CIRCUMFERENCE}
              strokeDashoffset={isUpdating ? RING_CIRCUMFERENCE : progressOffset}
            />
          </svg>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="end" sideOffset={6} className="px-3 py-2 text-xs">
        {isUpdating ? (
          <>
            <p className="opacity-70">Context window usage updating</p>
            <p className="font-medium">Waiting for refreshed runtime usage</p>
          </>
        ) : (
          <>
            <p className="opacity-70">Context window {percentFull}% full</p>
            <p className="font-medium">
              {formatTokens(usedTokens)} / {formatTokens(contextWindow)} tokens used
            </p>
          </>
        )}
        {compactionCount != null && compactionCount > 0 && (
          <p className="opacity-50 mt-0.5">
            Compacted {compactionCount} {compactionCount === 1 ? 'time' : 'times'}
          </p>
        )}
      </TooltipContent>
    </Tooltip>
    </TooltipProvider>
  )
}
