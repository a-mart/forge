import { useCallback, useEffect, useMemo, useState } from 'react'
import { Clock3, Edit3, ExternalLink, Loader2, RefreshCw, Save, X } from 'lucide-react'
import type { CortexDocumentEntry, CortexFileReviewHistoryEntry } from '@forge/protocol'
import type { ArtifactReference } from '@/lib/artifacts'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'
import { resolveApiEndpoint } from '@/lib/api-endpoint'
import { cn } from '@/lib/utils'
import { MarkdownMessage } from '../MarkdownMessage'
import { CortexDocumentMetaStrip } from './CortexDocumentMetaStrip'
import { useCortexFileReviewHistory, useGitFileLog } from './use-cortex-history'

export type CortexDocumentDescriptor = Pick<
  CortexDocumentEntry,
  'absolutePath' | 'gitPath' | 'label' | 'description' | 'surface' | 'editable'
>

interface CortexDocumentViewerShellProps {
  wsUrl: string
  document: CortexDocumentDescriptor | null
  documents?: CortexDocumentEntry[]
  agentId?: string | null
  refreshKey?: number
  onArtifactClick?: (artifact: ArtifactReference) => void
  onOpenSession?: (agentId: string) => void
  canOpenSession?: (agentId: string) => boolean
}

type ViewerState = 'loading' | 'rendered' | 'editing' | 'saving' | 'error'
type ViewerMode = 'content' | 'history'

interface ReadFileResult {
  path: string
  content: string
}

async function readFileContent(
  wsUrl: string,
  filePath: string,
  agentId: string | null | undefined,
  signal: AbortSignal,
): Promise<ReadFileResult> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/read-file')
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: filePath, agentId: agentId?.trim() || undefined }),
    signal,
  })

  const payload = await response.json().catch(() => null)

  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && typeof (payload as { error?: string }).error === 'string'
        ? (payload as { error: string }).error
        : `File read failed (${response.status})`
    throw new Error(message)
  }

  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid file read response.')
  }

  const result = payload as { path?: string; content?: string }
  return {
    path: typeof result.path === 'string' ? result.path : filePath,
    content: typeof result.content === 'string' ? result.content : '',
  }
}

async function writeFileContent(wsUrl: string, filePath: string, content: string, signal: AbortSignal): Promise<void> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/write-file')
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: filePath, content }),
    signal,
  })

  if (!response.ok) {
    const payload = await response.json().catch(() => null)
    const message =
      payload && typeof payload === 'object' && typeof (payload as { error?: string }).error === 'string'
        ? (payload as { error: string }).error
        : `File write failed (${response.status})`
    throw new Error(message)
  }
}

export function CortexDocumentViewerShell({
  wsUrl,
  document,
  agentId,
  refreshKey = 0,
  onArtifactClick,
  onOpenSession,
  canOpenSession,
}: CortexDocumentViewerShellProps) {
  const [viewerState, setViewerState] = useState<ViewerState>('loading')
  const [viewerMode, setViewerMode] = useState<ViewerMode>('content')
  const [content, setContent] = useState('')
  const [editContent, setEditContent] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isEmpty, setIsEmpty] = useState(false)
  const [latestRunSessionAvailable, setLatestRunSessionAvailable] = useState<boolean | null>(null)

  const fileLogQuery = useGitFileLog(wsUrl, agentId, document?.gitPath ?? null, 1, 0)
  const reviewHistoryQuery = useCortexFileReviewHistory(wsUrl, document?.gitPath ?? null, 1)

  const latestRun = reviewHistoryQuery.data?.latestRun ?? null
  const isDirty = viewerState === 'editing' && editContent !== content
  const historyToggleDisabled = viewerState === 'saving' || isDirty

  const canOpenLatestRunSession = useMemo(() => {
    if (!latestRun?.sessionAgentId) {
      return false
    }

    if (canOpenSession) {
      return canOpenSession(latestRun.sessionAgentId)
    }

    return latestRunSessionAvailable === true
  }, [canOpenSession, latestRun?.sessionAgentId, latestRunSessionAvailable])

  const fetchFile = useCallback(
    (signal: AbortSignal) => {
      if (!document?.absolutePath) {
        setViewerState('rendered')
        setContent('')
        setIsEmpty(true)
        return
      }

      setViewerState('loading')
      setError(null)
      setIsEmpty(false)

      void readFileContent(wsUrl, document.absolutePath, agentId, signal)
        .then((result) => {
          if (signal.aborted) return
          setContent(result.content)
          setIsEmpty(result.content.trim().length === 0)
          setViewerState('rendered')
        })
        .catch((fetchError: unknown) => {
          if (signal.aborted) return
          const message = fetchError instanceof Error ? fetchError.message : 'Failed to load file'
          if (message.includes('not found') || message.includes('404')) {
            setContent('')
            setIsEmpty(true)
            setViewerState('rendered')
            return
          }
          setError(message)
          setViewerState('error')
        })
    },
    [agentId, document?.absolutePath, wsUrl],
  )

  useEffect(() => {
    const abortController = new AbortController()
    fetchFile(abortController.signal)
    return () => {
      abortController.abort()
    }
  }, [fetchFile, refreshKey])

  useEffect(() => {
    setViewerMode('content')
    setEditContent('')
  }, [document?.absolutePath, document?.gitPath])

  useEffect(() => {
    if (!latestRun?.sessionAgentId) {
      setLatestRunSessionAvailable(null)
      return
    }

    if (canOpenSession) {
      setLatestRunSessionAvailable(canOpenSession(latestRun.sessionAgentId))
      return
    }

    const abortController = new AbortController()
    setLatestRunSessionAvailable(null)

    const endpoint = resolveApiEndpoint(
      wsUrl,
      `/api/agents/${encodeURIComponent(latestRun.sessionAgentId)}/system-prompt`,
    )

    void fetch(endpoint, { signal: abortController.signal })
      .then((response) => {
        if (abortController.signal.aborted) return
        setLatestRunSessionAvailable(response.ok)
      })
      .catch(() => {
        if (abortController.signal.aborted) return
        setLatestRunSessionAvailable(false)
      })

    return () => {
      abortController.abort()
    }
  }, [canOpenSession, latestRun?.sessionAgentId, wsUrl])

  const handleRefresh = useCallback(() => {
    const abortController = new AbortController()
    fetchFile(abortController.signal)
    fileLogQuery.refetch()
    reviewHistoryQuery.refetch()
  }, [fetchFile, fileLogQuery, reviewHistoryQuery])

  const handleStartEditing = useCallback(() => {
    setViewerMode('content')
    setEditContent(content)
    setViewerState('editing')
  }, [content])

  const handleCancelEditing = useCallback(() => {
    setEditContent('')
    setViewerState('rendered')
  }, [])

  const handleSave = useCallback(() => {
    if (!document?.absolutePath) return

    const abortController = new AbortController()
    setViewerState('saving')
    setError(null)

    void writeFileContent(wsUrl, document.absolutePath, editContent, abortController.signal)
      .then(() => {
        if (abortController.signal.aborted) return
        setContent(editContent)
        setIsEmpty(editContent.trim().length === 0)
        setEditContent('')
        setViewerState('rendered')
        fileLogQuery.refetch()
        reviewHistoryQuery.refetch()
      })
      .catch((saveError: unknown) => {
        if (abortController.signal.aborted) return
        const message = saveError instanceof Error ? saveError.message : 'Failed to save file'
        setError(message)
        setViewerState('editing')
      })
  }, [document?.absolutePath, editContent, fileLogQuery, reviewHistoryQuery, wsUrl])

  const handleToggleHistoryMode = useCallback(() => {
    if (historyToggleDisabled) {
      return
    }

    setViewerMode((current) => (current === 'history' ? 'content' : 'history'))
  }, [historyToggleDisabled])

  const handleOpenRun = useCallback(() => {
    if (!latestRun?.sessionAgentId || !canOpenLatestRunSession) {
      return
    }

    onOpenSession?.(latestRun.sessionAgentId)
  }, [canOpenLatestRunSession, latestRun?.sessionAgentId, onOpenSession])

  const label = document?.label ?? 'Document unavailable'
  const description = document?.description ?? 'This Cortex document is not available.'
  const editable = document?.editable ?? false
  const showRecentChangeBanner =
    viewerMode === 'content' &&
    viewerState !== 'editing' &&
    viewerState !== 'saving' &&
    !!document?.gitPath &&
    !!latestRun &&
    latestRun.changedFiles.includes(document.gitPath)

  return (
    <div
      className="flex h-full flex-col"
      data-testid="cortex-document-viewer-shell"
      data-surface={document?.surface ?? 'unknown'}
      data-mode={viewerMode}
    >
      <div className="flex shrink-0 items-start justify-between gap-2 border-b border-border/60 px-3 py-2">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-xs font-semibold text-foreground">{label}</h3>
          {viewerMode === 'content' ? (
            <div className="mt-0.5">
              <CortexDocumentMetaStrip
                stats={fileLogQuery.data?.stats}
                isLoading={!!document?.gitPath && fileLogQuery.isLoading}
                notInitialized={fileLogQuery.data?.notInitialized === true}
              />
            </div>
          ) : null}
          <p className="mt-0.5 truncate text-[10px] text-muted-foreground">{description}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground hover:text-foreground"
            onClick={handleToggleHistoryMode}
            disabled={historyToggleDisabled}
            aria-label={viewerMode === 'history' ? 'View content' : 'View history'}
            aria-pressed={viewerMode === 'history'}
            title={historyToggleDisabled ? 'Save or discard your draft before opening history.' : undefined}
            data-testid="cortex-history-toggle"
          >
            <Clock3 className="size-3" />
          </Button>

          {viewerState === 'editing' || viewerState === 'saving' ? (
            <>
              <Button
                variant="ghost"
                size="icon"
                className="size-6 text-muted-foreground hover:text-foreground"
                onClick={handleCancelEditing}
                disabled={viewerState === 'saving'}
                aria-label="Cancel editing"
              >
                <X className="size-3" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-6 text-emerald-500 hover:text-emerald-400"
                onClick={handleSave}
                disabled={viewerState === 'saving'}
                aria-label="Save file"
              >
                {viewerState === 'saving' ? <Loader2 className="size-3 animate-spin" /> : <Save className="size-3" />}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                size="icon"
                className="size-6 text-muted-foreground hover:text-foreground"
                onClick={handleRefresh}
                disabled={viewerState === 'loading'}
                aria-label="Refresh"
              >
                <RefreshCw className={cn('size-3', viewerState === 'loading' && 'animate-spin')} />
              </Button>
              {editable && document?.absolutePath && viewerMode === 'content' ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6 text-muted-foreground hover:text-foreground"
                  onClick={handleStartEditing}
                  disabled={viewerState === 'loading'}
                  aria-label="Edit file"
                >
                  <Edit3 className="size-3" />
                </Button>
              ) : null}
            </>
          )}
        </div>
      </div>

      {error ? (
        <div className="shrink-0 border-b border-destructive/20 bg-destructive/10 px-3 py-1.5 text-[11px] text-destructive">
          {error}
        </div>
      ) : null}

      {showRecentChangeBanner ? (
        <div className="shrink-0 border-b border-emerald-500/20 bg-emerald-500/10 px-3 py-2" data-testid="cortex-recent-change-banner">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[11px] font-medium text-emerald-300">Latest Cortex review touched this file.</p>
              <p className="mt-0.5 text-[10px] text-emerald-100/80">{formatLatestRunSummary(latestRun)}</p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button variant="ghost" size="sm" className="h-6 px-2 text-[10px]" onClick={() => setViewerMode('history')}>
                View changes
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-2 text-[10px]"
                onClick={handleOpenRun}
                disabled={!canOpenLatestRunSession}
              >
                <ExternalLink className="size-3" />
                Open run
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="min-h-0 flex-1">
        {viewerState === 'loading' ? (
          <div className="flex items-center justify-center py-12">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              Loading…
            </div>
          </div>
        ) : viewerState === 'error' ? (
          <div className="flex flex-col items-center justify-center px-4 py-12 text-center">
            <p className="text-xs text-muted-foreground">Failed to load file</p>
            <Button variant="ghost" size="sm" className="mt-2 h-7 text-[11px]" onClick={handleRefresh}>
              Retry
            </Button>
          </div>
        ) : viewerMode === 'history' ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted-foreground">
            Inline history mode is available in the next step of this series.
          </div>
        ) : viewerState === 'editing' || viewerState === 'saving' ? (
          <Textarea
            className="h-full min-h-0 resize-none rounded-none border-0 bg-transparent font-mono text-xs leading-relaxed focus-visible:ring-0"
            value={editContent}
            onChange={(event) => setEditContent(event.target.value)}
            disabled={viewerState === 'saving'}
            placeholder="Enter content…"
          />
        ) : isEmpty ? (
          <div className="flex flex-col items-center justify-center px-4 py-12 text-center">
            <p className="text-xs text-muted-foreground">No content yet</p>
            <p className="mt-1 text-[10px] text-muted-foreground/70">
              {editable ? 'Click the edit button to add content.' : 'This document has no tracked content yet.'}
            </p>
          </div>
        ) : (
          <ScrollArea
            className={cn(
              'h-full',
              '[&>[data-slot=scroll-area-scrollbar]]:w-1.5',
              '[&>[data-slot=scroll-area-scrollbar]>[data-slot=scroll-area-thumb]]:bg-transparent',
              'hover:[&>[data-slot=scroll-area-scrollbar]>[data-slot=scroll-area-thumb]]:bg-border',
            )}
          >
            <div className="px-3 py-3">
              <MarkdownMessage
                content={content}
                variant="document"
                artifactSourceAgentId={agentId}
                onArtifactClick={onArtifactClick}
              />
            </div>
          </ScrollArea>
        )}
      </div>
    </div>
  )
}

function formatLatestRunSummary(run: CortexFileReviewHistoryEntry | null): string {
  if (!run) {
    return 'No recent review context available.'
  }

  const pieces = [
    run.scopeLabel || formatTimestamp(run.recordedAt),
    `recorded ${formatTimestamp(run.recordedAt)}`,
  ]

  if (run.trigger === 'scheduled') {
    pieces.push(run.scheduleName ? `scheduled via ${run.scheduleName}` : 'scheduled review')
  } else if (run.trigger === 'manual') {
    pieces.push('manual review')
  }

  return pieces.join(' • ')
}

function formatTimestamp(isoString: string): string {
  const parsed = Date.parse(isoString)
  if (!Number.isFinite(parsed)) {
    return 'unknown time'
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(parsed))
}
