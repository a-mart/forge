import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, Clock, FileWarning, Loader2, RefreshCw, Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { resolveApiEndpoint } from '@/lib/api-endpoint'
import { cn } from '@/lib/utils'

interface ReviewStatusPanelProps {
  wsUrl: string
  refreshKey?: number
  onTriggerReview: (message: string) => void
}

interface ScanSession {
  profileId: string
  sessionId: string
  deltaBytes: number
  totalBytes: number
  reviewedBytes: number
  reviewedAt: string | null
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
  files?: {
    commonKnowledge: string
    cortexNotes: string
  }
}

type ScanState = 'idle' | 'loading' | 'error'
type ReviewDisplayStatus = 'needs-review' | 'never-reviewed' | 'up-to-date' | 'compacted'

function formatBytes(bytes: number): string {
  const absoluteBytes = Math.abs(bytes)
  if (absoluteBytes < 1024) return `${bytes} B`
  if (absoluteBytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function getSessionStatus(result: ScanSession): ReviewDisplayStatus {
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

  return reasons
}

function buildReviewRequest(result: ScanSession): string {
  const axes: string[] = []

  if (result.deltaBytes !== 0) axes.push('transcript')
  if (result.memoryDeltaBytes !== 0) axes.push('memory')
  if (result.feedbackDeltaBytes !== 0 || result.feedbackTimestampDrift) axes.push('feedback')

  if (axes.length === 0) {
    return `Review session ${result.profileId}/${result.sessionId}`
  }

  return `Review session ${result.profileId}/${result.sessionId} (${axes.join(', ')} freshness)`
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
  }
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

export function ReviewStatusPanel({ wsUrl, refreshKey = 0, onTriggerReview }: ReviewStatusPanelProps) {
  const [scanState, setScanState] = useState<ScanState>('idle')
  const [scanData, setScanData] = useState<CortexScanResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const doScan = useCallback(() => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setScanState('loading')
    setError(null)

    void fetchScanData(wsUrl, controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return
        setScanData(data)
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

  const handleReviewSession = useCallback(
    (session: ScanSession) => {
      onTriggerReview(buildReviewRequest(session))
    },
    [onTriggerReview],
  )

  const handleReviewAll = useCallback(() => {
    onTriggerReview('Review all sessions that need attention')
  }, [onTriggerReview])

  const allSessions = scanData ? scanData.scan.sessions : []
  const grouped = groupByProfile(allSessions)
  const needsReviewCount = scanData?.scan.summary.needsReview ?? 0
  const upToDateCount = scanData?.scan.summary.upToDate ?? 0
  const transcriptTotalBytes = scanData?.scan.summary.transcriptTotalBytes ?? 0
  const transcriptReviewedBytes = scanData?.scan.summary.transcriptReviewedBytes ?? 0
  const transcriptProgressPct =
    transcriptTotalBytes > 0 ? Math.min(100, Math.round((transcriptReviewedBytes / transcriptTotalBytes) * 100)) : 0
  const attentionBytes = scanData?.scan.summary.attentionBytes ?? 0

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
        <h3 className="text-xs font-semibold text-foreground">Review Status</h3>
        <div className="flex items-center gap-1">
          {scanData && needsReviewCount > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-2 text-[10px] font-medium text-primary hover:text-primary"
              onClick={handleReviewAll}
            >
              <Send className="size-2.5" />
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

      {scanState === 'loading' && !scanData ? (
        <div className="flex flex-1 items-center justify-center py-12">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            Scanning sessions…
          </div>
        </div>
      ) : scanState === 'error' && !scanData ? (
        <div className="flex flex-1 flex-col items-center justify-center px-4 py-12 text-center">
          <p className="text-xs text-muted-foreground">Failed to load scan data</p>
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
            <div className="space-y-0.5 p-2">
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

                      return (
                        <div
                          key={`${session.profileId}/${session.sessionId}`}
                          className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent/50"
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
                          {status !== 'up-to-date' ? (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-6 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-primary group-hover:opacity-100"
                              onClick={() => handleReviewSession(session)}
                              aria-label={`Review session ${session.sessionId}`}
                            >
                              <Send className="size-3" />
                            </Button>
                          ) : null}
                        </div>
                      )
                    })}
                    <Separator className="my-1 bg-border/40" />
                  </div>
                ))
              )}
            </div>
          </ScrollArea>
        </>
      ) : null}
    </div>
  )
}
