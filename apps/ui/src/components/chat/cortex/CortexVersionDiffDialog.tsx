import type { GitLogEntry } from '@forge/protocol'
import { useEffect, useMemo, useState } from 'react'
import { Loader2, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { DiffPane } from '@/components/diff-viewer/DiffPane'
import { useGitCommitDiff } from '@/components/diff-viewer/use-diff-queries'
import { resolveApiEndpoint } from '@/lib/api-endpoint'
import { CortexVersionList } from './CortexVersionList'
import { describeTimelineContext, formatRelativeTimeCompact, formatTimestampWithTime } from './history-format'

interface CortexVersionDiffDialogProps {
  open: boolean
  wsUrl: string
  agentId: string | null | undefined
  absolutePath: string | null | undefined
  gitPath: string | null | undefined
  documentLabel: string | null | undefined
  commits: GitLogEntry[]
  totalEdits?: number | null
  selectedCommit: GitLogEntry | null
  selectedVersionNumber: number | null
  comparisonVersionNumber: number | null
  currentVersionNumber: number | null
  hasMoreVersions: boolean
  isLoadingVersions: boolean
  isLoadingMoreVersions: boolean
  onSelectCommit: (sha: string) => void
  onLoadMoreVersions: () => void
  onOpenChange: (open: boolean) => void
  onRestoreSuccess?: () => void
}

interface ReadFileResult {
  path: string
  content: string
}

export function CortexVersionDiffDialog({
  open,
  wsUrl,
  agentId,
  absolutePath,
  gitPath,
  documentLabel,
  commits,
  totalEdits,
  selectedCommit,
  selectedVersionNumber,
  comparisonVersionNumber,
  currentVersionNumber,
  hasMoreVersions,
  isLoadingVersions,
  isLoadingMoreVersions,
  onSelectCommit,
  onLoadMoreVersions,
  onOpenChange,
  onRestoreSuccess,
}: CortexVersionDiffDialogProps) {
  const [compareWithCurrent, setCompareWithCurrent] = useState(false)
  const [currentContent, setCurrentContent] = useState<string | null>(null)
  const [currentContentError, setCurrentContentError] = useState<string | null>(null)
  const [isReadingCurrent, setIsReadingCurrent] = useState(false)
  const [isRestoring, setIsRestoring] = useState(false)
  const commitDiffQuery = useGitCommitDiff(wsUrl, agentId ?? null, 'versioning', open ? (selectedCommit?.sha ?? null) : null, gitPath ?? null)

  useEffect(() => {
    setCompareWithCurrent(false)
    setCurrentContent(null)
    setCurrentContentError(null)
    setIsReadingCurrent(false)
  }, [open, selectedCommit?.sha])

  useEffect(() => {
    if (!open || !compareWithCurrent || !absolutePath) {
      return
    }

    const abortController = new AbortController()
    setIsReadingCurrent(true)
    setCurrentContent(null)
    setCurrentContentError(null)

    void readFileContent(wsUrl, absolutePath, agentId, abortController.signal)
      .then((result) => {
        if (abortController.signal.aborted) {
          return
        }
        setCurrentContent(result.content)
      })
      .catch((error: unknown) => {
        if (abortController.signal.aborted) {
          return
        }
        setCurrentContentError(error instanceof Error ? error.message : 'Failed to load current file')
      })
      .finally(() => {
        if (abortController.signal.aborted) {
          return
        }
        setIsReadingCurrent(false)
      })

    return () => abortController.abort()
  }, [absolutePath, agentId, compareWithCurrent, open, wsUrl])

  const diffError = compareWithCurrent ? currentContentError || commitDiffQuery.error : commitDiffQuery.error
  const diffIsLoading = compareWithCurrent ? commitDiffQuery.isLoading || isReadingCurrent : commitDiffQuery.isLoading
  const oldContent = compareWithCurrent ? commitDiffQuery.data?.newContent ?? null : commitDiffQuery.data?.oldContent ?? null
  const newContent = compareWithCurrent ? currentContent : commitDiffQuery.data?.newContent ?? null

  const title = useMemo(() => {
    if (compareWithCurrent) {
      return `Version diff — Current content compared to ${formatVersionLabel(selectedVersionNumber)}`
    }

    if (selectedVersionNumber === 1) {
      return 'Version diff — v1 introduced'
    }

    if (selectedVersionNumber != null && currentVersionNumber != null && selectedVersionNumber === currentVersionNumber) {
      return `Version diff — Current (${formatVersionLabel(selectedVersionNumber)}) compared to ${formatVersionLabel(comparisonVersionNumber)}`
    }

    return `Version diff — ${formatVersionLabel(selectedVersionNumber)} compared to ${formatVersionLabel(comparisonVersionNumber)}`
  }, [compareWithCurrent, comparisonVersionNumber, currentVersionNumber, selectedVersionNumber])

  const description = useMemo(() => {
    if (!selectedCommit) {
      return 'Inspect the selected version before restoring it.'
    }

    const parts = [
      formatVersionLabel(selectedVersionNumber),
      formatRelativeTimeCompact(selectedCommit.date),
      describeTimelineContext(selectedCommit),
      `by ${selectedCommit.author}`,
    ]

    return parts.filter(Boolean).join(' • ')
  }, [selectedCommit, selectedVersionNumber])

  const handleConfirmRestore = async () => {
    if (!absolutePath || !commitDiffQuery.data?.newContent) {
      return
    }

    setIsRestoring(true)

    try {
      await writeFileContent(wsUrl, absolutePath, commitDiffQuery.data.newContent, 'api-write-file-restore')
      onRestoreSuccess?.()
      onOpenChange(false)
    } catch (error) {
      setCurrentContentError(error instanceof Error ? error.message : 'Failed to restore this version')
    } finally {
      setIsRestoring(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!max-w-6xl max-h-[90vh] flex flex-col overflow-hidden p-0" data-testid="cortex-version-diff-dialog">
        <DialogHeader className="border-b border-border/60 px-6 py-4">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 grid-cols-[240px_minmax(0,1fr)]">
          <aside className="flex min-h-0 flex-col border-r border-border/60 bg-muted/10">
            <div className="border-b border-border/60 px-3 py-2 text-[11px] font-medium text-foreground">Versions</div>
            <CortexVersionList
              commits={commits}
              selectedSha={selectedCommit?.sha ?? null}
              totalEdits={totalEdits}
              currentVersionNumber={currentVersionNumber}
              hasMore={hasMoreVersions}
              isLoading={isLoadingVersions}
              isLoadingMore={isLoadingMoreVersions}
              showCurrentBadge
              ariaLabel="Versions in diff dialog"
              dataTestId="cortex-version-diff-sidebar"
              onSelectCommit={onSelectCommit}
              onLoadMore={onLoadMoreVersions}
            />
          </aside>

          <div className="min-h-0 flex flex-col">
            <div className="flex items-center justify-between gap-3 border-b border-border/60 px-6 py-3">
              <div className="text-[11px] text-muted-foreground">
                {selectedCommit ? `${selectedCommit.shortSha} • ${formatTimestampWithTime(selectedCommit.date)}` : 'No version selected'}
              </div>
              <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <Switch
                  size="sm"
                  checked={compareWithCurrent}
                  disabled={!selectedCommit || !absolutePath}
                  onCheckedChange={setCompareWithCurrent}
                  aria-label="Compare with current"
                />
                Compare with current
              </label>
            </div>

            <div className="min-h-0 flex-1">
              <DiffPane
                fileName={documentLabel ?? gitPath ?? 'Selected document'}
                oldContent={oldContent}
                newContent={newContent}
                isLoading={diffIsLoading}
                error={diffError}
                truncated={commitDiffQuery.data?.truncated}
                truncatedReason={commitDiffQuery.data?.reason}
                markdownLayoutMode="sidebar"
              />
            </div>
          </div>
        </div>

        <DialogFooter className="border-t border-border/60 px-6 py-4">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isRestoring}>
            Close
          </Button>
          <Button
            variant="default"
            className="gap-1.5"
            onClick={() => void handleConfirmRestore()}
            disabled={isRestoring || commitDiffQuery.isLoading || !commitDiffQuery.data?.newContent || !absolutePath}
            data-testid="cortex-version-diff-restore"
          >
            {isRestoring ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
            Restore this version
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
    throw new Error(resolveErrorMessage(payload, response.status, 'Failed to load the current file'))
  }

  return {
    path: typeof (payload as { path?: unknown })?.path === 'string' ? (payload as { path: string }).path : filePath,
    content: typeof (payload as { content?: unknown })?.content === 'string' ? (payload as { content: string }).content : '',
  }
}

async function writeFileContent(
  wsUrl: string,
  filePath: string,
  content: string,
  versioningSource: 'api-write-file-restore',
): Promise<void> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/write-file')
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: filePath, content, versioningSource }),
  })

  if (!response.ok) {
    const payload = await response.json().catch(() => null)
    throw new Error(resolveErrorMessage(payload, response.status, 'Restore failed'))
  }
}

function resolveErrorMessage(payload: unknown, status: number, fallback: string): string {
  if (payload && typeof payload === 'object' && typeof (payload as { error?: string }).error === 'string') {
    return (payload as { error: string }).error
  }

  return `${fallback} (${status})`
}

function formatVersionLabel(versionNumber: number | null): string {
  return versionNumber ? `v${versionNumber}` : 'selected version'
}
