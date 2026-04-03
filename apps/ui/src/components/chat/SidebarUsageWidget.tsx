import { useEffect, useRef } from 'react'
import type { ProviderAccountUsage, ProviderUsageStats, ProviderUsageWindow } from '@forge/protocol'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

interface ProviderRowConfig {
  key: 'anthropic' | 'openai'
  label: string
  iconSrc: string
  iconClassName?: string
  usage?: ProviderAccountUsage
}

interface UsageMetrics {
  paceLabel: string
  paceSummary: string
  runoutLabel: string
  deltaPercent: number
}

function getTextTone(percent: number | null | undefined): string {
  if (typeof percent !== 'number') return 'text-muted-foreground/50'
  if (percent >= 90) return 'text-blue-300'
  if (percent >= 70) return 'text-blue-400/80'
  return 'text-muted-foreground'
}

function getDeltaTone(deltaPercent: number): string {
  const absDelta = Math.abs(deltaPercent)
  if (absDelta <= 2) return 'text-muted-foreground'
  return deltaPercent > 0 ? 'text-orange-400' : 'text-emerald-400'
}

function stripResetPrefix(resetInfo: string): string {
  return resetInfo.replace(/^Resets?\s*in\s*/i, '')
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function formatCompactDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'now'
  if (seconds < 60 * 60) return `${Math.max(1, Math.round(seconds / 60))}m`
  if (seconds < 48 * 60 * 60) return `${(seconds / 3600).toFixed(1)}h`
  return `${(seconds / (24 * 3600)).toFixed(1)}d`
}

function formatDeltaPercent(value: number): string {
  const absValue = Math.abs(value)
  const rounded = absValue < 10 ? Math.round(absValue * 10) / 10 : Math.round(absValue)
  return Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(1)
}

function getPaceLabel(deltaPercent: number): string {
  const absDelta = Math.abs(deltaPercent)
  if (absDelta <= 2) return 'On pace'
  if (absDelta <= 6) return deltaPercent > 0 ? 'Slightly ahead' : 'Slightly behind'
  if (absDelta <= 12) return deltaPercent > 0 ? 'Ahead' : 'Behind'
  return deltaPercent > 0 ? 'Far ahead' : 'Behind'
}

function getUsageMetrics(window: ProviderUsageWindow | null | undefined, nowMs: number): UsageMetrics | null {
  if (!window || typeof window.resetAtMs !== 'number' || typeof window.windowSeconds !== 'number' || window.windowSeconds <= 0) {
    return null
  }

  const resetRemainingSeconds = Math.max(0, (window.resetAtMs - nowMs) / 1000)
  const elapsedSeconds = Math.max(0, window.windowSeconds - resetRemainingSeconds)
  const expectedPercent = clamp((elapsedSeconds / window.windowSeconds) * 100, 0, 100)
  const deltaPercent = window.percent - expectedPercent
  const paceLabel = getPaceLabel(deltaPercent)

  let paceSummary = 'On pace'
  if (Math.abs(deltaPercent) > 2) {
    paceSummary = `${formatDeltaPercent(deltaPercent)}% in ${deltaPercent > 0 ? 'deficit' : 'reserve'}`
  }

  let runoutLabel = 'Runout unavailable'
  if (window.percent >= 100) {
    runoutLabel = 'Runs out now'
  } else if (window.percent <= 0) {
    runoutLabel = 'Lasts until reset'
  } else if (elapsedSeconds > 0) {
    const rate = window.percent / elapsedSeconds
    const remainingPercent = 100 - window.percent
    const etaSeconds = remainingPercent / rate
    runoutLabel = etaSeconds >= resetRemainingSeconds ? 'Lasts until reset' : `Runs out in ${formatCompactDuration(etaSeconds)}`
  }

  return { paceLabel, paceSummary, runoutLabel, deltaPercent }
}

/* ─── Mini bar gauge (two stacked horizontal bars) ─── */

const BAR_WIDTH = 28
const BAR_HEIGHT = 4
const BAR_GAP = 3
const WARNING_THRESHOLD = 80

function getBarFill(warning: boolean): string {
  return warning ? 'bg-red-400/60' : 'bg-blue-400/50'
}

function getBarTrack(warning: boolean): string {
  return warning ? 'bg-red-400/10' : 'bg-blue-400/10'
}

interface MiniBarGaugeProps {
  sessionPercent: number | null
  weeklyPercent: number | null
  label: string
}

function MiniBarGauge({ sessionPercent, weeklyPercent, label }: MiniBarGaugeProps) {
  const sp = typeof sessionPercent === 'number' ? clamp(sessionPercent, 0, 100) : 0
  const wp = typeof weeklyPercent === 'number' ? clamp(weeklyPercent, 0, 100) : 0
  const sessionWarn = typeof sessionPercent === 'number' && sessionPercent >= WARNING_THRESHOLD
  const weeklyWarn = typeof weeklyPercent === 'number' && weeklyPercent >= WARNING_THRESHOLD

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex flex-col" style={{ width: BAR_WIDTH, gap: BAR_GAP }}>
          {/* Top bar: session */}
          <div
            className={cn('w-full overflow-hidden rounded-full', getBarTrack(sessionWarn))}
            style={{ height: BAR_HEIGHT }}
          >
            <div
              className={cn('h-full rounded-full transition-all duration-700', getBarFill(sessionWarn))}
              style={{ width: `${sp}%` }}
            />
          </div>
          {/* Bottom bar: weekly */}
          <div
            className={cn('w-full overflow-hidden rounded-full', getBarTrack(weeklyWarn))}
            style={{ height: BAR_HEIGHT }}
          >
            <div
              className={cn('h-full rounded-full transition-all duration-700', getBarFill(weeklyWarn))}
              style={{ width: `${wp}%` }}
            />
          </div>
        </div>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6} className="bg-popover text-popover-foreground border border-border shadow-md text-[10px]">
        <p className="font-medium">{label}</p>
        <p className="text-muted-foreground">Session: {sessionPercent ?? '—'}% · Weekly: {weeklyPercent ?? '—'}%</p>
      </TooltipContent>
    </Tooltip>
  )
}

/* ─── Mini bars trigger (goes in the toolbar) ─── */

export function SidebarUsageRings({ providers, onToggle }: { providers: ProviderUsageStats | null; onToggle: () => void }) {
  const rows = buildRows(providers)
  const availableRows = rows.filter((row) => row.usage?.available)
  if (availableRows.length === 0) return null

  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onToggle() }}
      className="inline-flex items-center gap-3 rounded-md px-1.5 py-1 transition-colors hover:bg-sidebar-accent/50"
      aria-label="Provider usage"
    >
      {availableRows.map((row) => (
        <MiniBarGauge
          key={row.key}
          sessionPercent={row.usage?.sessionUsage?.percent ?? null}
          weeklyPercent={row.usage?.weeklyUsage?.percent ?? null}
          label={row.label}
        />
      ))}
    </button>
  )
}

/* ─── Detail row for popover ─── */

function DetailRow({ label, usageWindow, showPace = true }: { label: string; usageWindow?: ProviderUsageWindow; showPace?: boolean }) {
  const p = typeof usageWindow?.percent === 'number' ? usageWindow.percent : null
  const clampedWidth = p !== null ? Math.max(0, Math.min(p, 100)) : 0
  const resetTime = usageWindow?.resetInfo ? stripResetPrefix(usageWindow.resetInfo) : null
  const metrics = getUsageMetrics(usageWindow, Date.now())

  return (
    <div className="rounded-md border border-border/50 bg-muted/20 p-2 space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] text-muted-foreground">{label}</span>
        <span className={cn('text-[11px] font-mono tabular-nums', getTextTone(p))}>
          {p !== null ? `${p}% used` : '—'}
        </span>
      </div>

      <div className="h-1.5 overflow-hidden rounded-full bg-blue-400/10">
        <div
          className="h-full rounded-full bg-blue-400/60 transition-all duration-700"
          style={{ width: `${clampedWidth}%` }}
        />
      </div>

      {showPace ? (
        <div className="flex items-center justify-between gap-2 text-[10px]">
          <span className={cn('font-medium', metrics ? getDeltaTone(metrics.deltaPercent) : 'text-muted-foreground')}>
            {metrics?.paceLabel ?? 'Pace unavailable'}
          </span>
          <span className={cn('tabular-nums', metrics ? getDeltaTone(metrics.deltaPercent) : 'text-muted-foreground/70')}>
            {metrics?.paceSummary ?? '—'}
          </span>
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground/70">
        <span>{metrics?.runoutLabel ?? 'Runout unavailable'}</span>
        <span className="tabular-nums">{resetTime ? `Resets in ${resetTime}` : 'Reset unavailable'}</span>
      </div>
    </div>
  )
}

/* ─── Provider detail section ─── */

function ProviderDetail({ usage, label, iconSrc, iconClassName }: { usage: ProviderAccountUsage; label: string; iconSrc: string; iconClassName?: string }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <img src={iconSrc} alt="" aria-hidden="true" className={cn('size-3 opacity-80 shrink-0', iconClassName)} />
        <span className="text-[11px] font-medium text-foreground">{label}</span>
      </div>
      <div className="space-y-1.5">
        <DetailRow label="Session" usageWindow={usage.sessionUsage} showPace={false} />
        <DetailRow label="Weekly" usageWindow={usage.weeklyUsage} />
      </div>
    </div>
  )
}

/* ─── Detail panel (rendered directly inside sidebar, above toolbar) ─── */

export function SidebarUsagePanel({ providers, open, onClose }: { providers: ProviderUsageStats | null; open: boolean; onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      const target = e.target as Node
      if (panelRef.current?.contains(target)) return
      // Close on any click outside the panel (trigger handles its own toggle via stopPropagation)
      onClose()
    }
    // Use click (not mousedown) so the trigger's stopPropagation on mousedown doesn't interfere
    document.addEventListener('click', handleClick)
    return () => document.removeEventListener('click', handleClick)
  }, [open, onClose])

  if (!open) return null

  const rows = buildRows(providers)
  const availableRows = rows.filter((row) => row.usage?.available)

  return (
    <div ref={panelRef} className="shrink-0 border-t border-sidebar-border bg-sidebar p-3">
      <div className="space-y-3">
        {availableRows.map((row) =>
          row.usage ? (
            <ProviderDetail key={row.key} usage={row.usage} label={row.label} iconSrc={row.iconSrc} iconClassName={row.iconClassName} />
          ) : null,
        )}
      </div>
    </div>
  )
}

function buildRows(providers: ProviderUsageStats | null): ProviderRowConfig[] {
  return [
    {
      key: 'anthropic',
      label: 'Anthropic',
      iconSrc: '/agents/claude-logo.svg',
      usage: providers?.anthropic,
    },
    {
      key: 'openai',
      label: 'OpenAI',
      iconSrc: '/agents/codex-logo.svg',
      iconClassName: 'dark:invert',
      usage: providers?.openai,
    },
  ]
}
