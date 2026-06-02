import { Database, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import type { ModelCacheHeaderSummary } from './model-cache-summary'

interface ModelCacheHeaderIndicatorProps {
  summary: ModelCacheHeaderSummary
  className?: string
}

function statusAccentClass(status: ModelCacheHeaderSummary['latestStatus']): string {
  switch (status) {
    case 'hit':
      return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
    case 'partial':
      return 'border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300'
    case 'miss':
      return 'border-rose-500/30 bg-rose-500/10 text-rose-800 dark:text-rose-300'
  }
}

function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`
}

function formatTokenCount(value: number): string {
  return value.toLocaleString()
}

export function ModelCacheHeaderIndicator({ summary, className }: ModelCacheHeaderIndicatorProps) {
  const latest = summary.latestObservation

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn(
            'inline-flex h-7 max-w-44 shrink-0 gap-1.5 rounded-md border px-2 text-xs font-medium hover:bg-accent/70 hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground md:max-w-56',
            statusAccentClass(summary.latestStatus),
            className,
          )}
          aria-label="Open prompt cache details"
        >
          <Database className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">{summary.chipLabel}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="p-0"
        style={{ width: 'min(28rem, calc(100vw - 1rem))' }}
        aria-label="Prompt cache details"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border/60 p-3">
          <div className="min-w-0 space-y-1">
            <p className="text-sm font-semibold text-foreground">{summary.chipLabel}</p>
            <p className="text-xs text-muted-foreground">
              {latest.provider} · {latest.modelId}
            </p>
          </div>
          <PopoverClose asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="-m-1 size-7 shrink-0 text-muted-foreground hover:bg-accent/70 hover:text-foreground"
              aria-label="Close prompt cache details"
            >
              <X className="size-3.5" aria-hidden="true" />
            </Button>
          </PopoverClose>
        </div>
        <div
          className="space-y-3 overflow-y-auto p-3 text-xs text-muted-foreground [scrollbar-width:thin]"
          style={{ maxHeight: 'min(24rem, calc(100vh - 7rem))' }}
        >
          <dl className="grid grid-cols-2 gap-x-3 gap-y-2">
            <div>
              <dt className="text-[11px] uppercase tracking-wide text-muted-foreground/80">Loaded turns</dt>
              <dd className="font-medium text-foreground">{summary.observationCount}</dd>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-wide text-muted-foreground/80">Avg cached ratio</dt>
              <dd className="font-medium text-foreground">{formatPercent(summary.averageCachedRatio)}</dd>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-wide text-muted-foreground/80">Hits</dt>
              <dd className="font-medium text-foreground">{summary.counts.hit}</dd>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-wide text-muted-foreground/80">Partial</dt>
              <dd className="font-medium text-foreground">{summary.counts.partial}</dd>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-wide text-muted-foreground/80">Misses</dt>
              <dd className="font-medium text-foreground">{summary.counts.miss}</dd>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-wide text-muted-foreground/80">Prompt input</dt>
              <dd className="font-medium text-foreground">{formatTokenCount(summary.totalPromptInputTokens)}</dd>
            </div>
            <div className="col-span-2">
              <dt className="text-[11px] uppercase tracking-wide text-muted-foreground/80">Cached input (provider-reported)</dt>
              <dd className="font-medium text-foreground">{formatTokenCount(summary.totalCachedInputTokens)}</dd>
            </div>
          </dl>

          {summary.recentDrops.length > 0 ? (
            <div>
              <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-foreground/90">
                Recent drops (UI-derived)
              </p>
              <ul className="space-y-1">
                {summary.recentDrops.map((drop) => (
                  <li key={`${drop.observationId}-${drop.timestamp}`}>
                    {formatPercent(drop.previousRatio)} → {formatPercent(drop.currentRatio)} (
                    {drop.deltaRatio >= 0 ? '+' : ''}
                    {formatPercent(Math.abs(drop.deltaRatio))} change)
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <p className="text-[11px] leading-relaxed text-muted-foreground/90">
            Cached token counts are reported by the provider from loaded session observations only. OpenAI does not
            report specific miss or drop causes.
          </p>
        </div>
      </PopoverContent>
    </Popover>
  )
}
