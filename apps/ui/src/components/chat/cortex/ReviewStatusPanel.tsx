import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  ExternalLink,
  FileWarning,
  Loader2,
  RefreshCw,
  Send,
  SquareStack,
} from 'lucide-react'
import type { CortexReviewControlAction, CortexReviewRunAxis, CortexReviewRunRecord, CortexReviewRunScope } from '@forge/protocol'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { resolveApiEndpoint } from '@/lib/api-endpoint'
import { cn } from '@/lib/utils'

interface ReviewStatusPanelProps {
  wsUrl: string
  refreshKey?: number
  onOpenSession: (agentId: string) => void
}

interface ScanSession {
  profileId: string
  sessionId: string
  deltaBytes: number
  totalBytes: number
  reviewedBytes: number
  reviewedAt: string | null
  reviewExcluded: boolean
  reviewExcludedAt: string | null
  memoryDeltaBytes: number
  memoryTotalBytes: number
  memoryReviewedBytes: number
  memoryReviewedAt: string | null
  feedbackDeltaBytes: number
  feedbackTotalBytes: number
  feedbackReviewedBytes: number
  feedbackReviewedAt: string | null
  lastFeedbackAt: string | null
  feedbackTimestampDrift: boolean
  status: 'never-reviewed' | 'needs-review' | 'up-to-date'
}

interface CortexScanResponse {
  scan: {
    sessions: ScanSession[]
    summary: {
      needsReview: number
      upToDate: number
      excluded: number
      totalBytes: number
      reviewedBytes: number
      transcriptTotalBytes: number
      transcriptReviewedBytes: number
      memoryTotalBytes: number
      memoryReviewedBytes: number
      feedbackTotalBytes: number
      feedbackReviewedBytes: number
      attentionBytes: number
      sessionsWithTranscriptDrift: number
      sessionsWithMemoryDrift: number
      sessionsWithFeedbackDrift: number
    }
  }
}

interface CortexReviewRunsResponse {
  runs: CortexReviewRunRecord[]
}

type ScanState = 'idle' | 'loading' | 'error'
type ReviewDisplayStatus = 'needs-review' | 'never-reviewed' | 'up-to-date' | 'compacted' | 'excluded'

function formatBytes(bytes: number): string {
  const absoluteBytes = Math.abs(bytes)
  if (absoluteBytes < 1024) return `${bytes} B`
  if (absoluteBytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatTimestamp(timestamp: string): string {
  const parsed = new Date(timestamp)
  if (Number.isNaN(parsed.getTime())) {
    return timestamp
  }

  return parsed.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function truncateMiddle(text: string, maxLength = 180): string {
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength - 1)}…`
}

function getSessionStatus(result: ScanSession): ReviewDisplayStatus {
  if (result.reviewExcluded) {
    return 'excluded'
  }

  if (result.deltaBytes < 0 || result.memoryDeltaBytes < 0 || result.feedbackDeltaBytes < 0) {
    return 'compacted'
  }

  if (result.status === 'up-to-date') {
    return 'up-to-date'
  }

  if (result.status === 'never-reviewed') {
    return 'never-reviewed'
  }

  return 'needs-review'
}

function buildSessionReasonPills(result: ScanSession): string[] {
  const reasons: string[] = []

  if (result.deltaBytes < 0) reasons.push('transcript compacted')
  else if (result.deltaBytes > 0) reasons.push(`${formatBytes(result.deltaBytes)} transcript`)

  if (result.memoryDeltaBytes < 0) reasons.push('memory compacted')
  else if (result.memoryDeltaBytes > 0) reasons.push(`${formatBytes(result.memoryDeltaBytes)} memory`)

  if (result.feedbackDeltaBytes < 0) reasons.push('feedback compacted')
  else if (result.feedbackDeltaBytes > 0) reasons.push(`${formatBytes(result.feedbackDeltaBytes)} feedback`)
  else if (result.feedbackTimestampDrift) reasons.push('feedback updated')

  if (reasons.length === 0 && result.status === 'never-reviewed') {
    reasons.push('never reviewed')
  }

  if (result.reviewExcluded && result.reviewExcludedAt) {
    reasons.push(`excluded ${formatTimestamp(result.reviewExcludedAt)}`)
  }

  return reasons
}

function buildReviewScope(result: ScanSession): CortexReviewRunScope {
  const axes: CortexReviewRunAxis[] = []

  if (result.deltaBytes !== 0) axes.push('transcript')
  if (result.memoryDeltaBytes !== 0) axes.push('memory')
  if (result.feedbackDeltaBytes !== 0 || result.feedbackTimestampDrift) axes.push('feedback')

  return axes.length > 0
    ? { mode: 'session', profileId: result.profileId, sessionId: result.sessionId, axes }
    : { mode: 'session', profileId: result.profileId, sessionId: result.sessionId }
}

function StatusBadge({ status }: { status: ReviewDisplayStatus }) {
  switch (status) {
    case 'up-to-date':
      return (
        <Badge variant="outline" className="h-5 gap-1 border-emerald-500/30 bg-emerald-500/10 px-1.5 text-[10px] font-medium text-emerald-500">
          <CheckCircle2 className="size-2.5" />
          Up to date
        </Badge>
      )
    case 'needs-review':
      return (
        <Badge variant="outline" className="h-5 gap-1 border-amber-500/30 bg-amber-500/10 px-1.5 text-[10px] font-medium text-amber-500">
          <Clock className="size-2.5" />
          Needs review
        </Badge>
      )
    case 'never-reviewed':
      return (
        <Badge variant="outline" className="h-5 gap-1 border-red-500/30 bg-red-500/10 px-1.5 text-[10px] font-medium text-red-500">
          <AlertCircle className="size-2.5" />
          Never reviewed
        </Badge>
      )
    case 'compacted':
      return (
        <Badge variant="outline" className="h-5 gap-1 border-blue-500/30 bg-blue-500/10 px-1.5 text-[10px] font-medium text-blue-500">
          <FileWarning className="size-2.5" />
          Re-review
        </Badge>
      )
    case 'excluded':
      return (
        <Badge variant="outline" className="h-5 gap-1 border-muted-foreground/30 bg-muted/60 px-1.5 text-[10px] font-medium text-muted-foreground">
          <AlertCircle className="size-2.5" />
          Excluded
        </Badge>
      )
  }
}

function ReviewRunStatusBadge({ run }: { run: CortexReviewRunRecord }) {
  switch (run.status) {
    case 'queued':
      return (
        <Badge variant="outline" className="h-5 gap-1 border-amber-500/30 bg-amber-500/10 px-1.5 text-[10px] font-medium text-amber-500">
          <Clock className="size-2.5" />
          {run.queuePosition ? `Queued #${run.queuePosition}` : 'Queued'}
        </Badge>
      )
    case 'running':
      return (
        <Badge variant="outline" className="h-5 gap-1 border-blue-500/30 bg-blue-500/10 px-1.5 text-[10px] font-medium text-blue-500">
          <Loader2 className="size-2.5 animate-spin" />
          Running
        </Badge>
      )
    case 'blocked':
      return (
        <Badge variant="outline" className="h-5 gap-1 border-amber-500/30 bg-amber-500/10 px-1.5 text-[10px] font-medium text-amber-500">
          <AlertCircle className="size-2.5" />
          Blocked
        </Badge>
      )
    case 'stopped':
      return (
        <Badge variant="outline" className="h-5 gap-1 border-red-500/30 bg-red-500/10 px-1.5 text-[10px] font-medium text-red-500">
          <FileWarning className="size-2.5" />
          Stopped
        </Badge>
      )
    case 'completed':
      return (
        <Badge variant="outline" className="h-5 gap-1 border-emerald-500/30 bg-emerald-500/10 px-1.5 text-[10px] font-medium text-emerald-500">
          <CheckCircle2 className="size-2.5" />
          Completed
        </Badge>
      )
  }
}

function TriggerBadge({ trigger }: { trigger: CortexReviewRunRecord['trigger'] }) {
  return (
    <Badge variant="outline" className="h-5 border-border/60 px-1.5 text-[10px] text-muted-foreground">
      {trigger === 'scheduled' ? 'Scheduled' : 'Manual'}
    </Badge>
  )
}

function groupByProfile(results: ScanSession[]): Map<string, ScanSession[]> {
  const groups = new Map<string, ScanSession[]>()
  for (const result of results) {
    const existing = groups.get(result.profileId)
    if (existing) {
      existing.push(result)
    } else {
      groups.set(result.profileId, [result])
    }
  }
  return groups
}

async function fetchScanData(wsUrl: string, signal: AbortSignal): Promise<CortexScanResponse> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/cortex/scan')
  const response = await fetch(endpoint, { signal })

  if (!response.ok) {
    const payload = await response.json().catch(() => null)
    const message =
      payload && typeof payload === 'object' && typeof (payload as { error?: string }).error === 'string'
        ? (payload as { error: string }).error
        : `Scan failed (${response.status})`
    throw new Error(message)
  }

  return (await response.json()) as CortexScanResponse
}

async function fetchReviewRuns(wsUrl: string, signal: AbortSignal): Promise<CortexReviewRunsResponse> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/cortex/review-runs')
  const response = await fetch(endpoint, { signal })

  if (!response.ok) {
    const payload = await response.json().catch(() => null)
    const message =
      payload && typeof payload === 'object' && typeof (payload as { error?: string }).error === 'string'
        ? (payload as { error: string }).error
        : `Review runs failed (${response.status})`
    throw new Error(message)
  }

  return (await response.json()) as CortexReviewRunsResponse
}

async function startReviewRun(wsUrl: string, scope: CortexReviewRunScope): Promise<CortexReviewRunRecord> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/cortex/review-runs')
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope }),
  })

  const payload = (await response.json().catch(() => null)) as { error?: string; run?: CortexReviewRunRecord } | null
  if (!response.ok || !payload?.run) {
    throw new Error(payload?.error ?? `Unable to start review run (${response.status})`)
  }

  return payload.run
}

async function updateReviewControl(
  wsUrl: string,
  payload: { profileId: string; sessionId: string; action: CortexReviewControlAction },
): Promise<void> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/cortex/review-controls')
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  const body = (await response.json().catch(() => null)) as { error?: string; ok?: boolean } | null
  if (!response.ok || !body?.ok) {
    throw new Error(body?.error ?? `Unable to update review control (${response.status})`)
  }
}

export function ReviewStatusPanel({ wsUrl, refreshKey = 0, onOpenSession }: ReviewStatusPanelProps) {
  const [scanState, setScanState] = useState<ScanState>('idle')
  const [scanData, setScanData] = useState<CortexScanResponse | null>(null)
  const [reviewRuns, setReviewRuns] = useState<CortexReviewRunRecord[]>([])
  const [error, setError] = useState<string | null>(null)
  const [launchError, setLaunchError] = useState<string | null>(null)
  const [launchingKey, setLaunchingKey] = useState<string | null>(null)
  const [recentRunsExpanded, setRecentRunsExpanded] = useState(true)
  const abortRef = useRef<AbortController | null>(null)

  const doScan = useCallback(() => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setScanState('loading')
    setError(null)

    void Promise.all([
      fetchScanData(wsUrl, controller.signal),
      fetchReviewRuns(wsUrl, controller.signal),
    ])
      .then(([scan, runs]) => {
        if (controller.signal.aborted) return
        setScanData(scan)
        setReviewRuns(runs.runs)
        setScanState('idle')
      })
      .catch((scanError: unknown) => {
        if (controller.signal.aborted) return
        const message = scanError instanceof Error ? scanError.message : 'Scan failed'
        setError(message)
        setScanState('error')
      })
  }, [wsUrl])

  useEffect(() => {
    doScan()
    return () => {
      abortRef.current?.abort()
    }
  }, [doScan, refreshKey])

  useEffect(() => {
    const timer = window.setInterval(() => {
      doScan()
    }, 8000)

    return () => {
      window.clearInterval(timer)
    }
  }, [doScan])

  const handleLaunchReview = useCallback(
    async (scope: CortexReviewRunScope, launchKey: string) => {
      setLaunchError(null)
      setLaunchingKey(launchKey)
      try {
        const run = await startReviewRun(wsUrl, scope)
        setReviewRuns((current) => [run, ...current.filter((entry) => entry.runId !== run.runId)])
        doScan()
      } catch (launchRunError) {
        setLaunchError(launchRunError instanceof Error ? launchRunError.message : 'Unable to start review run')
      } finally {
        setLaunchingKey(null)
      }
    },
    [doScan, wsUrl],
  )

  const handleReviewSession = useCallback(
    (session: ScanSession, actionKey = `${session.profileId}/${session.sessionId}:review`) => {
      void handleLaunchReview(buildReviewScope(session), actionKey)
    },
    [handleLaunchReview],
  )

  const handleReviewControl = useCallback(
    async (session: ScanSession, action: CortexReviewControlAction) => {
      const actionKey = `${session.profileId}/${session.sessionId}:${action}`
      setLaunchError(null)
      setLaunchingKey(actionKey)
      try {
        await updateReviewControl(wsUrl, {
          profileId: session.profileId,
          sessionId: session.sessionId,
          action,
        })
        doScan()
      } catch (controlError) {
        setLaunchError(controlError instanceof Error ? controlError.message : 'Unable to update review control')
      } finally {
        setLaunchingKey(null)
      }
    },
    [doScan, wsUrl],
  )

  const handleReviewAll = useCallback(() => {
    void handleLaunchReview({ mode: 'all' }, 'all')
  }, [handleLaunchReview])

  const allSessions = scanData ? scanData.scan.sessions : []
  const grouped = groupByProfile(allSessions)
  const needsReviewCount = scanData?.scan.summary.needsReview ?? 0
  const upToDateCount = scanData?.scan.summary.upToDate ?? 0
  const excludedCount = scanData?.scan.summary.excluded ?? 0
  const transcriptTotalBytes = scanData?.scan.summary.transcriptTotalBytes ?? 0
  const transcriptReviewedBytes = scanData?.scan.summary.transcriptReviewedBytes ?? 0
  const transcriptProgressPct =
    transcriptTotalBytes > 0 ? Math.min(100, Math.round((transcriptReviewedBytes / transcriptTotalBytes) * 100)) : 0
  const attentionBytes = scanData?.scan.summary.attentionBytes ?? 0
  const runningRunCount = reviewRuns.filter((run) => run.status === 'running').length
  const queuedRunCount = reviewRuns.filter((run) => run.status === 'queued').length

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
        <div>
          <h3 className="text-xs font-semibold text-foreground">Review Runs</h3>
          <p className="text-[10px] text-muted-foreground">
            Fresh Cortex review sessions per run, with recent activity tracked here.
          </p>
        </div>
        <div className="flex items-center gap-1">
          {scanData && needsReviewCount > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-2 text-[10px] font-medium text-primary hover:text-primary"
              onClick={handleReviewAll}
              disabled={launchingKey !== null}
            >
              {launchingKey === 'all' ? <Loader2 className="size-2.5 animate-spin" /> : <Send className="size-2.5" />}
              Review All
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground hover:text-foreground"
            onClick={doScan}
            disabled={scanState === 'loading'}
            aria-label="Refresh scan"
          >
            <RefreshCw className={cn('size-3', scanState === 'loading' && 'animate-spin')} />
          </Button>
        </div>
      </div>

      {error ? (
        <div className="shrink-0 border-b border-destructive/20 bg-destructive/10 px-3 py-1.5 text-[11px] text-destructive">
          {error}
        </div>
      ) : null}

      {launchError ? (
        <div className="shrink-0 border-b border-destructive/20 bg-destructive/10 px-3 py-1.5 text-[11px] text-destructive">
          {launchError}
        </div>
      ) : null}

      {scanState === 'loading' && !scanData ? (
        <div className="flex flex-1 items-center justify-center py-12">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            Loading review dashboard…
          </div>
        </div>
      ) : scanState === 'error' && !scanData ? (
        <div className="flex flex-1 flex-col items-center justify-center px-4 py-12 text-center">
          <p className="text-xs text-muted-foreground">Failed to load review dashboard</p>
          <Button variant="ghost" size="sm" className="mt-2 h-7 text-[11px]" onClick={doScan}>
            Retry
          </Button>
        </div>
      ) : scanData ? (
        <>
          <div className="shrink-0 space-y-2 border-b border-border/60 px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-2 text-[11px]">
              <span className="text-muted-foreground">
                <span className="font-semibold text-foreground">{needsReviewCount}</span> need review
              </span>
              <span className="text-muted-foreground/40">·</span>
              <span className="text-muted-foreground">
                <span className="font-semibold text-foreground">{upToDateCount}</span> up to date
              </span>
              <span className="text-muted-foreground/40">·</span>
              <span className="text-muted-foreground">
                <span className="font-semibold text-foreground">{excludedCount}</span> excluded
              </span>
              <span className="text-muted-foreground/40">·</span>
              <span className="text-muted-foreground">{formatBytes(attentionBytes)} pending bytes</span>
            </div>

            <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
              <Badge variant="outline" className="h-5 border-border/60 px-1.5 text-[10px] text-muted-foreground">
                Transcript drift {scanData.scan.summary.sessionsWithTranscriptDrift}
              </Badge>
              <Badge variant="outline" className="h-5 border-border/60 px-1.5 text-[10px] text-muted-foreground">
                Memory drift {scanData.scan.summary.sessionsWithMemoryDrift}
              </Badge>
              <Badge variant="outline" className="h-5 border-border/60 px-1.5 text-[10px] text-muted-foreground">
                Feedback drift {scanData.scan.summary.sessionsWithFeedbackDrift}
              </Badge>
            </div>

            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                <span>Transcript coverage</span>
                <span>{formatBytes(transcriptReviewedBytes)} / {formatBytes(transcriptTotalBytes)}</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted/60">
                  <div
                    className="h-full rounded-full bg-emerald-500 transition-all duration-300"
                    style={{ width: `${transcriptProgressPct}%` }}
                  />
                </div>
                <span className="shrink-0 text-[10px] font-medium text-muted-foreground">
                  {transcriptProgressPct}%
                </span>
              </div>
            </div>
          </div>

          <ScrollArea
            className={cn(
              'min-h-0 flex-1',
              '[&>[data-slot=scroll-area-scrollbar]]:w-1.5',
              '[&>[data-slot=scroll-area-scrollbar]>[data-slot=scroll-area-thumb]]:bg-transparent',
              'hover:[&>[data-slot=scroll-area-scrollbar]>[data-slot=scroll-area-thumb]]:bg-border',
            )}
          >
            <div className="space-y-3 p-2">
              <section className="rounded-md border border-border/60 bg-card/60">
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-2 py-2 text-left transition-colors hover:text-foreground"
                  onClick={() => setRecentRunsExpanded((current) => !current)}
                  aria-expanded={recentRunsExpanded}
                  aria-controls="cortex-review-recent-runs"
                >
                  {recentRunsExpanded ? (
                    <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden="true" />
                  ) : (
                    <ChevronRight className="size-3.5 text-muted-foreground" aria-hidden="true" />
                  )}
                  <SquareStack className="size-3.5 text-muted-foreground" />
                  <h4 className="text-[11px] font-semibold text-foreground">Recent Runs</h4>
                  {runningRunCount > 0 ? (
                    <Badge variant="outline" className="h-5 border-blue-500/30 bg-blue-500/10 px-1.5 text-[10px] text-blue-500">
                      {runningRunCount} running
                    </Badge>
                  ) : null}
                  {queuedRunCount > 0 ? (
                    <Badge variant="outline" className="h-5 border-amber-500/30 bg-amber-500/10 px-1.5 text-[10px] text-amber-500">
                      {queuedRunCount} queued
                    </Badge>
                  ) : null}
                </button>
                {recentRunsExpanded ? (
                  <div id="cortex-review-recent-runs" className="border-t border-border/50 px-2 pb-2 pt-2">
                    {reviewRuns.length === 0 ? (
                      <p className="text-[11px] text-muted-foreground">No review runs recorded yet.</p>
                    ) : (
                      <div className="space-y-2">
                        {reviewRuns.slice(0, 8).map((run) => (
                          <div key={run.runId} className="rounded-md border border-border/50 bg-background/70 px-2 py-2">
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <ReviewRunStatusBadge run={run} />
                                  <TriggerBadge trigger={run.trigger} />
                                  {run.activeWorkerCount > 0 ? (
                                    <Badge variant="outline" className="h-5 border-border/60 px-1.5 text-[10px] text-muted-foreground">
                                      {run.activeWorkerCount} worker{run.activeWorkerCount === 1 ? '' : 's'}
                                    </Badge>
                                  ) : null}
                                </div>
                                <p className="mt-1 truncate text-xs font-medium text-foreground">{run.scopeLabel}</p>
                                <p className="mt-0.5 text-[10px] text-muted-foreground">Started {formatTimestamp(run.requestedAt)}</p>
                                {run.blockedReason ? (
                                  <p className="mt-1 text-[10px] text-amber-500">{run.blockedReason}</p>
                                ) : run.status === 'queued' ? (
                                  <p className="mt-1 text-[10px] text-muted-foreground">
                                    {run.queuePosition ? `Waiting in queue (#${run.queuePosition}).` : 'Waiting in queue.'} Starts automatically after the active review finishes.
                                  </p>
                                ) : run.latestCloseout ? (
                                  <p className="mt-1 text-[10px] text-muted-foreground">{truncateMiddle(run.latestCloseout)}</p>
                                ) : null}
                              </div>
                              {run.sessionAgentId ? (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-6 gap-1 px-2 text-[10px]"
                                  onClick={() => onOpenSession(run.sessionAgentId!)}
                                >
                                  <ExternalLink className="size-3" />
                                  Open
                                </Button>
                              ) : null}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : null}
              </section>

              <section>
                {allSessions.length === 0 ? (
                  <div className="flex flex-col items-center justify-center px-4 py-8 text-center">
                    <CheckCircle2 className="mb-2 size-8 text-muted-foreground/40" aria-hidden="true" />
                    <p className="text-xs text-muted-foreground">No sessions found</p>
                  </div>
                ) : (
                  Array.from(grouped.entries()).map(([profileId, sessions]) => (
                    <div key={profileId}>
                      <div className="px-2 pb-1 pt-2">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                          {profileId}
                        </p>
                      </div>
                      {sessions.map((session) => {
                        const status = getSessionStatus(session)
                        const reasonPills = buildSessionReasonPills(session)
                        const reviewActionKey = `${session.profileId}/${session.sessionId}:review`
                        const excludeActionKey = `${session.profileId}/${session.sessionId}:exclude`
                        const resumeActionKey = `${session.profileId}/${session.sessionId}:resume`
                        const isReviewedSession =
                          session.reviewedAt !== null || session.memoryReviewedAt !== null || session.feedbackReviewedAt !== null
                        const canReview = status === 'needs-review' || status === 'never-reviewed' || status === 'compacted'
                        const canExclude =
                          status === 'needs-review' || status === 'never-reviewed' || status === 'compacted'
                        const canResume = status === 'excluded'
                        const canReprocess = status === 'up-to-date' && isReviewedSession

                        return (
                          <div
                            key={`${session.profileId}/${session.sessionId}`}
                            className={cn(
                              'group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent/50',
                              status === 'excluded' && 'opacity-80',
                            )}
                          >
                            <div className="min-w-0 flex-1 space-y-1">
                              <p className="truncate text-xs font-medium text-foreground">
                                {session.sessionId}
                              </p>
                              <div className="flex flex-wrap items-center gap-1.5">
                                <StatusBadge status={status} />
                                {reasonPills.map((reason) => (
                                  <span
                                    key={reason}
                                    className="rounded-sm bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                                  >
                                    {reason}
                                  </span>
                                ))}
                              </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-1">
                              {canReview ? (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="size-6 text-muted-foreground opacity-100 transition-opacity hover:text-primary md:opacity-0 md:group-hover:opacity-100"
                                  onClick={() => handleReviewSession(session, reviewActionKey)}
                                  disabled={launchingKey !== null}
                                  aria-label={`Review session ${session.sessionId}`}
                                >
                                  {launchingKey === reviewActionKey ? <Loader2 className="size-3 animate-spin" /> : <Send className="size-3" />}
                                </Button>
                              ) : null}
                              {canExclude ? (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-6 px-2 text-[10px]"
                                  onClick={() => void handleReviewControl(session, 'exclude')}
                                  disabled={launchingKey !== null}
                                  aria-label={`Exclude session ${session.sessionId} from review`}
                                >
                                  {launchingKey === excludeActionKey ? <Loader2 className="size-3 animate-spin" /> : 'Exclude'}
                                </Button>
                              ) : null}
                              {canResume ? (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-6 px-2 text-[10px]"
                                  onClick={() => void handleReviewControl(session, 'resume')}
                                  disabled={launchingKey !== null}
                                  aria-label={`Resume review for session ${session.sessionId}`}
                                >
                                  {launchingKey === resumeActionKey ? <Loader2 className="size-3 animate-spin" /> : 'Resume review'}
                                </Button>
                              ) : null}
                              {canReprocess ? (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-6 px-2 text-[10px]"
                                  onClick={() => handleReviewSession(session, reviewActionKey)}
                                  disabled={launchingKey !== null}
                                  aria-label={`Reprocess session ${session.sessionId}`}
                                >
                                  {launchingKey === reviewActionKey ? <Loader2 className="size-3 animate-spin" /> : 'Reprocess'}
                                </Button>
                              ) : null}
                            </div>
                          </div>
                        )
                      })}
                      <Separator className="my-1 bg-border/40" />
                    </div>
                  ))
                )}
              </section>
            </div>
          </ScrollArea>
        </>
      ) : null}
    </div>
  )
}
