import { Check, ChevronRight } from 'lucide-react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import type { GenerationThroughputLiveMeasurement } from '@forge/protocol'
import { formatThroughputRate } from './throughput-format'

interface ThroughputPulseProps {
  /** Current model-call lifecycle, if one is active or awaiting cleanup. */
  measurement?: GenerationThroughputLiveMeasurement
  /** Retained by the WebSocket state after terminal cleanup and reconnect. */
  latestFinal?: GenerationThroughputLiveMeasurement
}

/**
 * Fixed-width manager header telemetry for eligible local Pi sessions.
 * Streaming only changes the restrained pulse; numeric throughput appears once
 * provider-final output usage and timing make it exact.
 */
export function ThroughputPulse({ measurement, latestFinal }: ThroughputPulseProps) {
  // The WebSocket state retains this anchor through terminal cleanup and
  // reconnect; a current terminal event takes precedence in the same render.
  const latest = exactFinal(measurement) ?? exactFinal(latestFinal)
  const generating = measurement?.phase === 'starting' || measurement?.phase === 'generating'
  const rate = latest?.responseThroughputTokensPerSecond ?? null
  const compactRate = formatCompactThroughputRate(rate)
  const label = accessibleLabel(generating, rate)

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="throughput-pulse"
          data-throughput-state={generating ? 'generating' : latest ? 'final' : 'empty'}
          className="inline-flex h-[30px] w-[104px] shrink-0 items-center rounded-md border border-border/60 bg-muted/30 px-1.5 text-[10px] font-medium text-muted-foreground hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 sm:w-[116px]"
          aria-label={label}
          title={titleFor(generating, rate)}
        >
          <span className="sr-only" aria-live="polite">
            {latest ? `Final response throughput ${formatThroughputRate(rate)} tokens per second.` : ''}
          </span>
          <span
            data-throughput-pulse
            className={cn(
              'inline-flex size-4 shrink-0 items-center justify-center',
              generating && 'motion-safe:animate-[pulse_1.6s_ease-in-out_infinite] motion-reduce:animate-none',
            )}
            aria-hidden="true"
          >
            {latest && !generating ? (
              <span className="inline-flex size-4 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-300">
                <Check className="size-3" />
              </span>
            ) : (
              <span className={cn('size-2 rounded-full bg-muted-foreground/70', generating && 'bg-emerald-500')} />
            )}
          </span>
          <span
            data-throughput-value
            className={cn('min-w-0 flex-1 truncate px-1 text-right tabular-nums', generating && 'opacity-55')}
          >
            {compactRate}
          </span>
          <span className="w-[27px] shrink-0 text-left">tok/s</span>
          <ChevronRight className="size-3 shrink-0 opacity-45" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="bottom" sideOffset={6} className="w-72 p-3">
        <div className="mb-2 flex h-4 items-center justify-between gap-3">
          <span className="text-xs font-medium">Response throughput</span>
          <span className="text-[11px] text-muted-foreground">
            {generating ? 'Generating' : latest ? 'Latest final' : 'No final result'}
          </span>
        </div>
        <div className="space-y-1 text-xs text-muted-foreground">
          <PopoverRow label="Latest response TPS" value={`${formatThroughputRate(rate)} tok/s · final`} />
          <PopoverRow label="Request duration" value={formatDuration(latest?.responseDurationMs)} />
          <PopoverRow label="TTFT" value={formatDuration(latest?.timeToFirstOutputMs)} />
          <PopoverRow label="Output tokens" value={formatTokens(latest?.outputTokens)} />
          <PopoverRow label="Model / provider" value={latest ? `${latest.modelId} · ${latest.provider}` : '—'} />
        </div>
        <p className="mt-2 border-t pt-2 text-[11px] text-muted-foreground">
          Provider-final output tokens divided by the complete request-start-to-terminal duration determine the final rate.
        </p>
      </PopoverContent>
    </Popover>
  )
}

function PopoverRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid h-5 grid-cols-[108px_minmax(0,1fr)] items-center gap-2">
      <span>{label}</span>
      <span className="truncate text-right font-medium text-foreground" title={value}>{value}</span>
    </div>
  )
}

function exactFinal(
  measurement: GenerationThroughputLiveMeasurement | undefined,
): GenerationThroughputLiveMeasurement | undefined {
  const rate = measurement?.responseThroughputTokensPerSecond
  if (
    measurement?.phase !== 'completed'
    || measurement.valueKind !== 'provider_final'
    || measurement.responseThroughputDurationBasis !== 'request_wall_monotonic'
    || measurement.outputTokens === null
    || typeof rate !== 'number'
    || !Number.isFinite(rate)
    || rate < 0
  ) return undefined
  return measurement
}

function formatCompactThroughputRate(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}m`
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`
  return formatThroughputRate(value)
}

function formatDuration(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? `${(value / 1_000).toFixed(1)} s`
    : '—'
}

function formatTokens(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value.toLocaleString()
    : '—'
}

function accessibleLabel(generating: boolean, rate: number | null): string {
  if (generating) {
    return rate === null
      ? 'Generating; no final response throughput yet'
      : `Generating; showing last final response throughput ${formatThroughputRate(rate)} tokens per second`
  }
  return rate === null
    ? 'No final response throughput yet'
    : `Latest final response throughput ${formatThroughputRate(rate)} tokens per second`
}

function titleFor(generating: boolean, rate: number | null): string {
  if (generating) {
    return rate === null
      ? 'Generating · waiting for provider-final response throughput'
      : `Generating · last final response ${formatThroughputRate(rate)} tok/s`
  }
  return rate === null ? 'No final response throughput yet' : `Latest response · ${formatThroughputRate(rate)} tok/s final`
}
