import { useCallback, useEffect, useRef, useState } from 'react'
import { Edit3, Loader2, RefreshCw, Save, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'
import { resolveApiEndpoint } from '@/lib/api-endpoint'
import { cn } from '@/lib/utils'
import { MarkdownMessage } from '../MarkdownMessage'
import type { ArtifactReference } from '@/lib/artifacts'

interface KnowledgeFileViewerProps {
  wsUrl: string
  filePath: string | null
  label: string
  description?: string
  refreshKey?: number
  editable?: boolean
  onArtifactClick?: (artifact: ArtifactReference) => void
}

type ViewerState = 'loading' | 'rendered' | 'editing' | 'saving' | 'error'

interface ReadFileResult {
  path: string
  content: string
}

async function readFileContent(wsUrl: string, filePath: string, signal: AbortSignal): Promise<ReadFileResult> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/read-file')
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: filePath }),
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

export function KnowledgeFileViewer({
  wsUrl,
  filePath,
  label,
  description,
  refreshKey = 0,
  editable = false,
  onArtifactClick,
}: KnowledgeFileViewerProps) {
  const [viewerState, setViewerState] = useState<ViewerState>('loading')
  const [content, setContent] = useState('')
  const [editContent, setEditContent] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isEmpty, setIsEmpty] = useState(false)
  const fetchCountRef = useRef(0)

  const fetchFile = useCallback(
    (signal: AbortSignal) => {
      if (!filePath) {
        setViewerState('rendered')
        setContent('')
        setIsEmpty(true)
        return
      }

      setViewerState('loading')
      setError(null)
      setIsEmpty(false)

      void readFileContent(wsUrl, filePath, signal)
        .then((result) => {
          if (signal.aborted) return
          setContent(result.content)
          setIsEmpty(result.content.trim().length === 0)
          setViewerState('rendered')
        })
        .catch((fetchError: unknown) => {
          if (signal.aborted) return
          const message = fetchError instanceof Error ? fetchError.message : 'Failed to load file'
          // Treat 404 as empty file
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
    [wsUrl, filePath],
  )

  useEffect(() => {
    const abortController = new AbortController()
    fetchCountRef.current += 1
    fetchFile(abortController.signal)
    return () => {
      abortController.abort()
    }
  }, [fetchFile, refreshKey])

  const handleRefresh = useCallback(() => {
    const abortController = new AbortController()
    fetchCountRef.current += 1
    fetchFile(abortController.signal)
    // Note: no cleanup here since it's a manual action — next fetch or unmount will supersede
  }, [fetchFile])

  const handleStartEditing = useCallback(() => {
    setEditContent(content)
    setViewerState('editing')
  }, [content])

  const handleCancelEditing = useCallback(() => {
    setEditContent('')
    setViewerState('rendered')
  }, [])

  const handleSave = useCallback(() => {
    if (!filePath) return

    const abortController = new AbortController()
    setViewerState('saving')
    setError(null)

    void writeFileContent(wsUrl, filePath, editContent, abortController.signal)
      .then(() => {
        if (abortController.signal.aborted) return
        setContent(editContent)
        setIsEmpty(editContent.trim().length === 0)
        setEditContent('')
        setViewerState('rendered')
      })
      .catch((saveError: unknown) => {
        if (abortController.signal.aborted) return
        const message = saveError instanceof Error ? saveError.message : 'Failed to save file'
        setError(message)
        setViewerState('editing')
      })
  }, [wsUrl, filePath, editContent])

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
        <div className="min-w-0">
          <h3 className="truncate text-xs font-semibold text-foreground">{label}</h3>
          {description ? (
            <p className="truncate text-[10px] text-muted-foreground">{description}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
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
                {viewerState === 'saving' ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Save className="size-3" />
                )}
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
              {editable && filePath ? (
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

      {/* Error banner */}
      {error ? (
        <div className="shrink-0 border-b border-destructive/20 bg-destructive/10 px-3 py-1.5 text-[11px] text-destructive">
          {error}
        </div>
      ) : null}

      {/* Content */}
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
            <Button
              variant="ghost"
              size="sm"
              className="mt-2 h-7 text-[11px]"
              onClick={handleRefresh}
            >
              Retry
            </Button>
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
              {editable
                ? 'Click the edit button to add content.'
                : 'This file will be populated as Cortex reviews sessions.'}
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
                onArtifactClick={onArtifactClick}
              />
            </div>
          </ScrollArea>
        )}
      </div>
    </div>
  )
}
