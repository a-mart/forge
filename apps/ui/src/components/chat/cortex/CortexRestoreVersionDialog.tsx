import type { GitDiffResult, GitLogEntry } from '@forge/protocol'
import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Loader2, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { resolveApiEndpoint } from '@/lib/api-endpoint'
import { DiffPane } from '@/components/diff-viewer/DiffPane'
import { formatCommitSummary } from '@/components/diff-viewer/formatCommitSummary'

interface CortexRestoreVersionDialogProps {
  open: boolean
  wsUrl: string
  agentId: string | null | undefined
  absolutePath: string | null | undefined
  gitPath: string | null | undefined
  documentLabel: string | null | undefined
  selectedCommit: GitLogEntry | null
  onOpenChange: (open: boolean) => void
  onRestoreSuccess?: () => void
}

interface ReadFileResult {
  path: string
  content: string
}

interface RestorePreviewState {
  currentContent: string
  selectedContent: string
}

export function CortexRestoreVersionDialog({
  open,
  wsUrl,
  agentId,
  absolutePath,
  gitPath,
  documentLabel,
  selectedCommit,
  onOpenChange,
  onRestoreSuccess,
}: CortexRestoreVersionDialogProps) {
  const [preview, setPreview] = useState<RestorePreviewState | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isRestoring, setIsRestoring] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !selectedCommit?.sha || !absolutePath || !gitPath) {
      setPreview(null)
      setIsLoading(false)
      setIsRestoring(false)
      setError(null)
      return
    }

    const abortController = new AbortController()
    setPreview(null)
    setIsLoading(true)
    setIsRestoring(false)
    setError(null)

    void Promise.all([
      fetchCommitContent(wsUrl, agentId, selectedCommit.sha, gitPath, abortController.signal),
      readFileContent(wsUrl, absolutePath, agentId, abortController.signal),
    ])
      .then(([historicalDiff, currentFile]) => {
        if (abortController.signal.aborted) {
          return
        }

        setPreview({
          currentContent: currentFile.content,
          selectedContent: historicalDiff.newContent,
        })
      })
      .catch((loadError: unknown) => {
        if (abortController.signal.aborted) {
          return
        }
        setError(loadError instanceof Error ? loadError.message : 'Failed to load restore preview')
      })
      .finally(() => {
        if (abortController.signal.aborted) {
          return
        }
        setIsLoading(false)
      })

    return () => abortController.abort()
  }, [absolutePath, agentId, gitPath, open, selectedCommit?.sha, wsUrl])

  const title = useMemo(() => {
    if (!selectedCommit) {
      return 'Restore this version'
    }

    return `Restore ${documentLabel ?? gitPath ?? 'this document'}`
  }, [documentLabel, gitPath, selectedCommit])

  const handleConfirm = async () => {
    if (!absolutePath || !preview) {
      return
    }

    setIsRestoring(true)
    setError(null)
    const abortController = new AbortController()

    try {
      await writeFileContent(wsUrl, absolutePath, preview.selectedContent, abortController.signal, 'api-write-file-restore')
      onRestoreSuccess?.()
      onOpenChange(false)
    } catch (restoreError) {
      setError(restoreError instanceof Error ? restoreError.message : 'Failed to restore this version')
    } finally {
      setIsRestoring(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!max-w-5xl p-0 overflow-hidden" data-testid="cortex-restore-version-dialog">
        <DialogHeader className="border-b border-border/60 px-6 py-4">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {selectedCommit
              ? `Compare the live file with ${formatCommitSummary(selectedCommit)} before restoring.`
              : 'Compare the live file with the selected historical version before restoring.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 px-6 py-4">
          {selectedCommit ? (
            <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground">
              <div className="font-medium text-foreground">{formatCommitSummary(selectedCommit)}</div>
              <div className="mt-1 font-mono text-[10px]">{selectedCommit.shortSha} • {formatTimestamp(selectedCommit.date)}</div>
            </div>
          ) : null}

          {error ? (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          ) : null}

          <div className="overflow-hidden rounded-lg border border-border/60" data-testid="cortex-restore-diff-preview">
            <div className="border-b border-border/60 bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground">
              Current live content on the left, selected historical version on the right.
            </div>
            <div className="h-[420px]">
              <DiffPane
                fileName={documentLabel ?? gitPath ?? 'Selected document'}
                oldContent={preview?.currentContent ?? null}
                newContent={preview?.selectedContent ?? null}
                isLoading={isLoading}
                error={error}
                markdownLayoutMode="sidebar"
              />
            </div>
          </div>
        </div>

        <DialogFooter className="border-t border-border/60 px-6 py-4">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isRestoring}>
            Cancel
          </Button>
          <Button
            variant="default"
            className="gap-1.5"
            onClick={() => void handleConfirm()}
            disabled={isLoading || isRestoring || !preview}
            data-testid="cortex-confirm-restore"
          >
            {isRestoring ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
            Restore this version
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

async function fetchCommitContent(
  wsUrl: string,
  agentId: string | null | undefined,
  sha: string,
  file: string,
  signal: AbortSignal,
): Promise<GitDiffResult> {
  const searchParams = new URLSearchParams({
    agentId: agentId?.trim() || '',
    repoTarget: 'versioning',
    sha,
    file,
  })
  const url = resolveApiEndpoint(wsUrl, `/api/git/commit-diff?${searchParams.toString()}`)
  const response = await fetch(url, { signal })
  const payload = await response.json().catch(() => null)

  if (!response.ok) {
    throw new Error(resolveErrorMessage(payload, response.status, 'Failed to load the selected version'))
  }

  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid commit diff response.')
  }

  return payload as GitDiffResult
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
  signal: AbortSignal,
  versioningSource: 'api-write-file-restore',
): Promise<void> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/write-file')
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: filePath, content, versioningSource }),
    signal,
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
