import { useEffect, useMemo, useState } from 'react'
import type { CortexDocumentEntry } from '@forge/protocol'
import { ArrowRightLeft, Files, Loader2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { DiffPane } from '@/components/diff-viewer/DiffPane'
import { classifyKnowledgeSurface } from '@/components/diff-viewer/knowledge-surface'
import { useGitCommitDetail, useGitCommitDiff } from '@/components/diff-viewer/use-diff-queries'
import { Switch } from '@/components/ui/switch'
import { resolveApiEndpoint } from '@/lib/api-endpoint'

interface CortexInlineHistoryDiffProps {
  wsUrl: string
  agentId: string | null | undefined
  absolutePath: string | null | undefined
  currentFilePath: string | null | undefined
  fileLabel: string | null | undefined
  selectedSha: string | null
  documents: CortexDocumentEntry[]
  notInitialized?: boolean
  onSelectDocument?: (documentId: string) => void
}

interface ReadFileResult {
  path: string
  content: string
}

export function CortexInlineHistoryDiff({
  wsUrl,
  agentId,
  absolutePath,
  currentFilePath,
  fileLabel,
  selectedSha,
  documents,
  notInitialized = false,
  onSelectDocument,
}: CortexInlineHistoryDiffProps) {
  const [compareWithCurrent, setCompareWithCurrent] = useState(false)
  const [liveContent, setLiveContent] = useState<string | null>(null)
  const [liveError, setLiveError] = useState<string | null>(null)
  const [isReadingCurrent, setIsReadingCurrent] = useState(false)

  const commitDiffQuery = useGitCommitDiff(wsUrl, agentId ?? null, 'versioning', selectedSha, currentFilePath ?? null)
  const commitDetailQuery = useGitCommitDetail(wsUrl, agentId ?? null, 'versioning', selectedSha)

  useEffect(() => {
    setCompareWithCurrent(false)
    setLiveContent(null)
    setLiveError(null)
    setIsReadingCurrent(false)
  }, [absolutePath, currentFilePath, selectedSha])

  useEffect(() => {
    if (!compareWithCurrent || !absolutePath) {
      return
    }

    const abortController = new AbortController()
    setIsReadingCurrent(true)
    setLiveError(null)

    void readFileContent(wsUrl, absolutePath, agentId, abortController.signal)
      .then((result) => {
        if (abortController.signal.aborted) {
          return
        }
        setLiveContent(result.content)
      })
      .catch((error: unknown) => {
        if (abortController.signal.aborted) {
          return
        }
        setLiveError(error instanceof Error ? error.message : 'Failed to load current file')
      })
      .finally(() => {
        if (abortController.signal.aborted) {
          return
        }
        setIsReadingCurrent(false)
      })

    return () => abortController.abort()
  }, [absolutePath, agentId, compareWithCurrent, wsUrl])

  const siblingFiles = useMemo(
    () => (commitDetailQuery.data?.files ?? []).filter((file) => file.path !== currentFilePath),
    [commitDetailQuery.data?.files, currentFilePath],
  )

  const diffError = compareWithCurrent ? liveError || commitDiffQuery.error : commitDiffQuery.error
  const diffIsLoading = compareWithCurrent ? commitDiffQuery.isLoading || isReadingCurrent : commitDiffQuery.isLoading
  const oldContent = compareWithCurrent ? (commitDiffQuery.data?.newContent ?? null) : (commitDiffQuery.data?.oldContent ?? null)
  const newContent = compareWithCurrent ? liveContent : commitDiffQuery.data?.newContent ?? null
  const comparisonLabel = compareWithCurrent ? `${fileLabel ?? currentFilePath ?? 'Selected file'} (historical ↔ current)` : fileLabel ?? currentFilePath ?? null

  if (notInitialized) {
    return (
      <section className="rounded-lg border border-border/60 bg-card/70" data-testid="cortex-inline-history-diff">
        <div className="border-b border-border/60 px-3 py-2">
          <div className="flex items-center gap-2 text-[11px] font-medium text-foreground">
            <ArrowRightLeft className="size-3.5 text-muted-foreground" />
            Inline diff
          </div>
        </div>
        <div className="px-3 py-4 text-[11px] text-muted-foreground">Versioning history is not initialized for this workspace.</div>
      </section>
    )
  }

  return (
    <section className="overflow-hidden rounded-lg border border-border/60 bg-card/70" data-testid="cortex-inline-history-diff">
      <div className="border-b border-border/60 px-3 py-2">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-[11px] font-medium text-foreground">
              <ArrowRightLeft className="size-3.5 text-muted-foreground" />
              Inline diff
            </div>
            <p className="mt-1 text-[10px] text-muted-foreground">
              {selectedSha ? 'Inspect the selected commit inline without leaving the sidebar.' : 'Select a commit above to inspect its changes.'}
            </p>
          </div>
          <label className="flex items-center gap-2 text-[10px] text-muted-foreground">
            <Switch
              size="sm"
              checked={compareWithCurrent}
              disabled={!selectedSha || !absolutePath}
              onCheckedChange={setCompareWithCurrent}
              aria-label="Compare with current"
            />
            Compare with current
          </label>
        </div>
      </div>

      {selectedSha && siblingFiles.length > 0 ? (
        <div className="border-b border-border/60 bg-muted/10 px-3 py-2" data-testid="cortex-history-sibling-files">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            <Files className="size-3" />
            Changed together with
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {siblingFiles.map((file) => {
              const surface = classifyKnowledgeSurface(file.path)
              const matchingDocument = documents.find((document) => document.gitPath === file.path)
              const selectable = !!matchingDocument && !!onSelectDocument
              return selectable ? (
                <button
                  key={file.path}
                  type="button"
                  className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/70 px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  onClick={() => onSelectDocument?.(matchingDocument.id)}
                >
                  <Badge variant="outline" className="h-4 border-border/60 bg-muted/30 px-1 py-0 text-[9px] text-muted-foreground">
                    {surface.label}
                  </Badge>
                  <span>{file.path}</span>
                </button>
              ) : (
                <div
                  key={file.path}
                  className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/70 px-2 py-1 text-[10px] text-muted-foreground"
                >
                  <Badge variant="outline" className="h-4 border-border/60 bg-muted/30 px-1 py-0 text-[9px] text-muted-foreground">
                    {surface.label}
                  </Badge>
                  <span>{file.path}</span>
                </div>
              )
            })}
          </div>
        </div>
      ) : null}

      <div className="h-[420px] min-h-[280px]">
        <DiffPane
          fileName={comparisonLabel}
          oldContent={oldContent}
          newContent={newContent}
          isLoading={diffIsLoading}
          error={diffError}
          truncated={commitDiffQuery.data?.truncated}
          truncatedReason={commitDiffQuery.data?.reason}
          markdownLayoutMode="sidebar"
        />
      </div>

      {compareWithCurrent && diffIsLoading ? (
        <div className="border-t border-border/60 px-3 py-2 text-[10px] text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <Loader2 className="size-3 animate-spin" />
            Loading the current file for comparison…
          </span>
        </div>
      ) : null}
    </section>
  )
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
