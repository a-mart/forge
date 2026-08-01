import { Check, ChevronRight } from 'lucide-react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import type {
  GenerationThroughputLiveMeasurement,
  GenerationThroughputSessionSummary,
} from '@forge/protocol'
import type { GenerationRateSample } from '@/lib/ws-state'
import { formatThroughputRate } from './throughput-format'

interface ThroughputPulseProps {
  measurement?: GenerationThroughputLiveMeasurement
  samples?: GenerationRateSample[]
  sessionSummary?: GenerationThroughputSessionSummary | null
}

type PulseMode = 'measuring' | 'estimated' | 'final' | 'session'

/**
 * Compact Builder header telemetry. It deliberately consumes only cumulative
 * server counts/rates; it never reads or tokenizes transcript text.
 */
export function ThroughputPulse({
  measurement,
  samples = [],
  sessionSummary = null,
}: ThroughputPulseProps) {
  const mode = resolveMode(measurement, sessionSummary)
  if (!mode) return null

  const activeEstimate = measurement?.instantaneousTokensPerSecond ?? null
  const callAverage = measurement?.generationAverageTokensPerSecond ?? null
  const finalRate = mode === 'final' ? callAverage : null
  const sessionRate = sessionSummary?.weightedTokensPerSecond ?? null
  const sparklineSamples = mode === 'session'
    ? (sessionSummary?.samples ?? []).map((sample) => ({
        sampledAt: sample.completedAt,
        tokensPerSecond: sample.tokensPerSecond,
      }))
    : samples
  const label = accessibleLabel(mode, activeEstimate, finalRate, sessionRate)
  const announcement = phaseAnnouncement(mode)

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="throughput-pulse"
          className={cn(
            'group inline-flex h-[30px] w-[116px] shrink-0 items-center gap-1.5 rounded-md border border-border/60 bg-muted/30 px-1.5 text-[10px] font-medium text-muted-foreground hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70',
            mode === 'estimated' && 'border-emerald-500/35 text-emerald-700 dark:text-emerald-300',
            mode === 'final' && 'border-emerald-500/30 text-foreground',
          )}
          aria-label={label}
        >
          <span className="sr-only" aria-live="polite">{announcement}</span>
          {mode === 'measuring' ? (
            <span className="inline-flex h-4 w-7 items-center justify-center gap-0.5" aria-hidden="true">
              <span className="size-1 rounded-full bg-muted-foreground/70 motion-safe:animate-pulse motion-reduce:animate-none" />
              <span className="size-1 rounded-full bg-muted-foreground/70 motion-safe:animate-pulse motion-reduce:animate-none [animation-delay:150ms]" />
              <span className="size-1 rounded-full bg-muted-foreground/70 motion-safe:animate-pulse motion-reduce:animate-none [animation-delay:300ms]" />
            </span>
          ) : mode === 'final' ? (
            <span className="inline-flex size-4 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-300" aria-hidden="true">
              <Check className="size-3" />
            </span>
          ) : (
            <ThroughputSparkline samples={sparklineSamples} />
          )}
          <span className="min-w-0 flex-1 truncate text-right tabular-nums">
            {mode === 'measuring'
              ? 'Measuring…'
              : mode === 'estimated'
                ? `≈${formatThroughputRate(activeEstimate)} tok/s`
                : mode === 'final'
                  ? `${formatThroughputRate(finalRate)} tok/s`
                  : `Session ${formatThroughputRate(sessionRate)} t/s`}
          </span>
          <ChevronRight className="size-3 shrink-0 opacity-45" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="bottom" sideOffset={6} className="w-64 p-3">
        <div className="mb-2 flex items-center justify-between gap-3">
          <span className="text-xs font-medium">Generation throughput</span>
          <ThroughputSparkline samples={sparklineSamples} className="w-16" />
        </div>
        {mode === 'measuring' ? (
          <p className="text-xs text-muted-foreground">Measuring streamed output…</p>
        ) : null}
        {mode === 'estimated' ? (
          <div className="space-y-1 text-xs text-muted-foreground">
            <p><span className="font-medium text-foreground">Now (estimated)</span> · ≈{formatThroughputRate(activeEstimate)} tok/s</p>
            <p>This generation (average) · ≈{formatThroughputRate(callAverage)} tok/s</p>
            <p className="pt-1 text-[11px]">Estimated from streamed content; final provider usage replaces this value.</p>
          </div>
        ) : null}
        {mode === 'final' ? (
          <div className="space-y-1 text-xs text-muted-foreground">
            <p><span className="font-medium text-foreground">This generation (final)</span> · {formatThroughputRate(finalRate)} tok/s</p>
            <p>Provider output includes reported reasoning tokens.</p>
          </div>
        ) : null}
        {sessionSummary && sessionRate !== null ? (
          <p className={cn('text-xs text-muted-foreground', mode !== 'session' && 'mt-2 border-t pt-2')}>
            <span className="font-medium text-foreground">Session, last 20 generations</span> · {formatThroughputRate(sessionRate)} tok/s · last {sessionSummary.measuredGenerationCount}
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

export function ThroughputSparkline({
  samples,
  className,
}: {
  samples: GenerationRateSample[]
  className?: string
}) {
  const values = samples.slice(-20).map((sample) => sample.tokensPerSecond).filter((value) => Number.isFinite(value) && value >= 0)
  if (values.length === 0) {
    return <span className={cn('inline-block h-4 w-7 rounded-sm bg-muted-foreground/10', className)} aria-hidden="true" />
  }
  const max = Math.max(...values, 1)
  const min = Math.min(...values)
  const range = Math.max(max - min, max * 0.2, 1)
  const points = values.map((value, index) => {
    const x = values.length === 1 ? 12 : index * 24 / (values.length - 1)
    const y = 14 - ((value - min) / range) * 10
    return `${x.toFixed(2)},${y.toFixed(2)}`
  }).join(' ')

  return (
    <svg
      viewBox="0 0 24 16"
      className={cn('h-4 w-7 shrink-0 overflow-visible', className)}
      role="img"
      aria-label={`${values.length} throughput samples`}
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="opacity-80"
      />
      <circle cx={points.split(' ').at(-1)?.split(',')[0]} cy={points.split(' ').at(-1)?.split(',')[1]} r="1.2" fill="currentColor" />
    </svg>
  )
}

function resolveMode(
  measurement: GenerationThroughputLiveMeasurement | undefined,
  sessionSummary: GenerationThroughputSessionSummary | null,
): PulseMode | null {
  if (measurement?.phase === 'starting') return 'measuring'
  if (measurement?.phase === 'generating') {
    return measurement.instantaneousTokensPerSecond === null ? 'measuring' : 'estimated'
  }
  if (measurement?.phase === 'completed' && measurement.generationAverageTokensPerSecond !== null) return 'final'
  if (sessionSummary?.weightedTokensPerSecond !== null && sessionSummary?.weightedTokensPerSecond !== undefined) return 'session'
  return null
}

function accessibleLabel(
  mode: PulseMode,
  estimated: number | null,
  finalRate: number | null,
  sessionRate: number | null,
): string {
  switch (mode) {
    case 'measuring': return 'Measuring generation throughput'
    case 'estimated': return `Now estimated ${formatThroughputRate(estimated)} tokens per second`
    case 'final': return `This generation final ${formatThroughputRate(finalRate)} tokens per second`
    case 'session': return `Session last 20 generations ${formatThroughputRate(sessionRate)} tokens per second`
  }
}

function phaseAnnouncement(mode: PulseMode): string {
  switch (mode) {
    case 'measuring': return 'Measuring generation throughput.'
    case 'estimated': return 'Estimated generation throughput available.'
    case 'final': return 'Final generation throughput available.'
    case 'session': return 'Session generation throughput available.'
  }
}
