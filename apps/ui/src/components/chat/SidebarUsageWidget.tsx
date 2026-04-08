import { useEffect, useRef } from 'react'
import type { ProviderAccountUsage, ProviderUsagePace, ProviderUsageStats, ProviderUsageWindow } from '@forge/protocol'
import { RefreshCw } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

interface ProviderRowConfig {
  key: string
  label: string
  iconSrc: string
  iconClassName?: string
  usage?: ProviderAccountUsage
}

type PaceStage =
  | 'onTrack'
  | 'slightlyAhead'
  | 'ahead'
  | 'farAhead'
  | 'slightlyBehind'
  | 'behind'
  | 'farBehind'

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

function formatCountdownDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'now'

  const totalMinutes = Math.max(1, Math.ceil(seconds / 60))
  const days = Math.floor(totalMinutes / (24 * 60))
  const hours = Math.floor(totalMinutes / 60) % 24
  const minutes = totalMinutes % 60

  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  }
  return `${totalMinutes}m`
}

function formatDeltaPercent(value: number): string {
  return `${Math.round(Math.abs(value))}`
}

function roundRiskPercent(probability: number): number {
  return Math.round(clamp(probability, 0, 1) * 20) * 5
}

function getPaceStage(deltaPercent: number): PaceStage {
  const absDelta = Math.abs(deltaPercent)
  if (absDelta <= 2) return 'onTrack'
  if (absDelta <= 6) return deltaPercent >= 0 ? 'slightlyAhead' : 'slightlyBehind'
  if (absDelta <= 12) return deltaPercent >= 0 ? 'ahead' : 'behind'
  return deltaPercent >= 0 ? 'farAhead' : 'farBehind'
}

function getPaceLabel(stage: PaceStage): string {
  switch (stage) {
    case 'onTrack':
      return 'On pace'
    case 'slightlyAhead':
      return 'Slight deficit'
    case 'ahead':
      return 'Deficit'
    case 'farAhead':
      return 'Far in deficit'
    case 'slightlyBehind':
      return 'Slight reserve'
    case 'behind':
      return 'Reserve'
    case 'farBehind':
      return 'Far in reserve'
  }
}

function formatPaceSummary(stage: PaceStage, deltaPercent: number): string {
  if (stage === 'onTrack') {
    return 'On pace'
  }
  return `${formatDeltaPercent(deltaPercent)}% in ${deltaPercent >= 0 ? 'deficit' : 'reserve'}`
}

function formatRunoutLabelFromPace(pace: Pick<ProviderUsagePace, 'etaSeconds' | 'willLastToReset' | 'runOutProbability'>): string {
  let label = 'Runout unavailable'

  if (pace.willLastToReset) {
    label = 'Lasts until reset'
  } else if (typeof pace.etaSeconds === 'number') {
    const etaText = formatCountdownDuration(pace.etaSeconds)
    label = etaText === 'now' ? 'Runs out now' : `Runs out in ${etaText}`
  }

  if (typeof pace.runOutProbability === 'number') {
    const riskLabel = `≈ ${roundRiskPercent(pace.runOutProbability)}% run-out risk`
    return label === 'Runout unavailable' ? riskLabel : `${label} · ${riskLabel}`
  }

  return label
}

function getDeterministicUsageMetrics(window: ProviderUsageWindow, nowMs: number): UsageMetrics | null {
  if (typeof window.resetAtMs !== 'number' || typeof window.windowSeconds !== 'number' || window.windowSeconds <= 0) {
    return null
  }

  const durationSeconds = window.windowSeconds
  const timeUntilResetSeconds = (window.resetAtMs - nowMs) / 1000
  if (timeUntilResetSeconds <= 0 || timeUntilResetSeconds > durationSeconds) {
    return null
  }

  const elapsedSeconds = clamp(durationSeconds - timeUntilResetSeconds, 0, durationSeconds)
  const actualPercent = clamp(window.percent, 0, 100)
  if (elapsedSeconds === 0 && actualPercent > 0) {
    return null
  }

  const expectedPercent = clamp((elapsedSeconds / durationSeconds) * 100, 0, 100)
  const deltaPercent = actualPercent - expectedPercent
  const stage = getPaceStage(deltaPercent)

  let willLastToReset = false
  let etaSeconds: number | undefined

  if (elapsedSeconds > 0 && actualPercent > 0) {
    const rate = actualPercent / elapsedSeconds
    if (rate > 0) {
      const remainingPercent = Math.max(0, 100 - actualPercent)
      const candidateEtaSeconds = remainingPercent / rate
      if (candidateEtaSeconds >= timeUntilResetSeconds) {
        willLastToReset = true
      } else {
        etaSeconds = candidateEtaSeconds
      }
    }
  } else if (elapsedSeconds > 0 && actualPercent === 0) {
    willLastToReset = true
  }

  return {
    paceLabel: getPaceLabel(stage),
    paceSummary: formatPaceSummary(stage, deltaPercent),
    runoutLabel: formatRunoutLabelFromPace({ etaSeconds, willLastToReset }),
    deltaPercent,
  }
}

export function getUsageMetrics(window: ProviderUsageWindow | null | undefined, nowMs: number): UsageMetrics | null {
  if (!window) {
    return null
  }

  if (window.pace) {
    const stage = getPaceStage(window.pace.deltaPercent)
    return {
      paceLabel: getPaceLabel(stage),
      paceSummary: formatPaceSummary(stage, window.pace.deltaPercent),
      runoutLabel: formatRunoutLabelFromPace(window.pace),
      deltaPercent: window.pace.deltaPercent,
    }
  }

  return getDeterministicUsageMetrics(window, nowMs)
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
  weeklyDeltaPercent: number | null
  label: string
}

function MiniBarGauge({ sessionPercent, weeklyPercent, weeklyDeltaPercent, label }: MiniBarGaugeProps) {
  const sp = typeof sessionPercent === 'number' ? clamp(sessionPercent, 0, 100) : 0
  const wp = typeof weeklyPercent === 'number' ? clamp(weeklyPercent, 0, 100) : 0
  const sessionWarn = typeof sessionPercent === 'number' && sessionPercent >= WARNING_THRESHOLD
  // Weekly bar: use pace deficit status when available, fall back to raw % threshold
  const weeklyWarn = typeof weeklyDeltaPercent === 'number'
    ? weeklyDeltaPercent > 2 // in deficit (slightlyAhead or worse)
    : typeof weeklyPercent === 'number' && weeklyPercent >= WARNING_THRESHOLD

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
      {availableRows.map((row) => {
        const weeklyMetrics = getUsageMetrics(row.usage?.weeklyUsage, Date.now())
        return (
          <MiniBarGauge
            key={row.key}
            sessionPercent={row.usage?.sessionUsage?.percent ?? null}
            weeklyPercent={row.usage?.weeklyUsage?.percent ?? null}
            weeklyDeltaPercent={weeklyMetrics?.deltaPercent ?? null}
            label={row.label}
          />
        )
      })}
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

export function SidebarUsagePanel({ providers, open, onClose, loading, onRefresh }: { providers: ProviderUsageStats | null; open: boolean; onClose: () => void; loading?: boolean; onRefresh?: () => void }) {
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
        {onRefresh && (
          <div className="flex justify-end">
            <button
              type="button"
              onClick={onRefresh}
              disabled={loading}
              className="inline-flex items-center justify-center rounded-sm p-0.5 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
              aria-label="Refresh usage"
            >
              <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
            </button>
          </div>
        )}
        {availableRows.map((row) =>
          row.usage ? (
            <ProviderDetail key={row.key} usage={row.usage} label={row.label} iconSrc={row.iconSrc} iconClassName={row.iconClassName} />
          ) : null,
        )}
      </div>
    </div>
  )
}

export function getAccountLabel(providerName: string, account: ProviderAccountUsage, index: number, total: number): string {
  if (total <= 1) return providerName
  const suffix = account.accountLabel || account.accountEmail || account.accountId || `Account ${index + 1}`
  return `${providerName} — ${suffix}`
}

function buildRows(providers: ProviderUsageStats | null): ProviderRowConfig[] {
  const rows: ProviderRowConfig[] = []

  const anthropicAccounts = providers?.anthropic
  if (anthropicAccounts && anthropicAccounts.length > 0) {
    for (let i = 0; i < anthropicAccounts.length; i++) {
      rows.push({
        key: `anthropic-${anthropicAccounts[i].accountId ?? i}`,
        label: getAccountLabel('Anthropic', anthropicAccounts[i], i, anthropicAccounts.length),
        iconSrc: '/agents/claude-logo.svg',
        usage: anthropicAccounts[i],
      })
    }
  }

  const openaiAccounts = providers?.openai
  if (openaiAccounts && openaiAccounts.length > 0) {
    for (let i = 0; i < openaiAccounts.length; i++) {
      rows.push({
        key: `openai-${openaiAccounts[i].accountId ?? i}`,
        label: getAccountLabel('OpenAI', openaiAccounts[i], i, openaiAccounts.length),
        iconSrc: '/agents/codex-logo.svg',
        iconClassName: 'dark:invert',
        usage: openaiAccounts[i],
      })
    }
  }

  return rows
}
