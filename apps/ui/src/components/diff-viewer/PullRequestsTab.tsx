import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  Clock3,
  Copy,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  Loader2,
  XCircle,
} from 'lucide-react'
import type { GitPullRequestDetail, GitPullRequestSummary } from '@forge/protocol'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { MergePullRequestDialog } from './MergePullRequestDialog'
import {
  invalidateGitCaches,
  mergeGitPullRequest,
  useGitPullRequestDetail,
  type GitPullRequestsQueryResult,
} from './use-diff-queries'

interface PullRequestsTabProps {
  wsUrl: string
  agentId: string | null
  repoTarget: 'workspace' | 'versioning'
  worktreeId?: string | null
  currentBranch: string | null
  pullRequestsQuery: GitPullRequestsQueryResult
  onMergeComplete?: () => void
}

function formatRelativeTimestamp(value: string | null | undefined): string {
  if (!value) {
    return 'Unknown'
  }

  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) {
    return value
  }

  const deltaMs = Date.now() - parsed
  const minutes = Math.round(deltaMs / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return `${days}d ago`
}

function stateBadgeVariant(state: GitPullRequestSummary['state']): 'default' | 'secondary' | 'outline' {
  if (state === 'open') return 'default'
  if (state === 'merged') return 'secondary'
  return 'outline'
}

function checkStatusLabel(status: GitPullRequestSummary['checkStatus']): string {
  switch (status) {
    case 'success':
      return 'Checks passed'
    case 'failure':
      return 'Checks failing'
    case 'pending':
      return 'Checks pending'
    case 'neutral':
      return 'Checks neutral'
    default:
      return 'Checks unknown'
  }
}

function CheckStatusIcon({ status }: { status: GitPullRequestSummary['checkStatus'] }) {
  if (status === 'success') {
    return <CheckCircle2 className="size-3.5 text-emerald-500" />
  }

  if (status === 'failure') {
    return <XCircle className="size-3.5 text-red-500" />
  }

  if (status === 'pending') {
    return <Clock3 className="size-3.5 text-amber-500" />
  }

  return <AlertCircle className="size-3.5 text-muted-foreground" />
}

function PullRequestCard({
  pullRequest,
  active,
  onClick,
}: {
  pullRequest: GitPullRequestSummary
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-full rounded-lg border border-border/70 bg-card/60 p-3 text-left transition-colors hover:bg-accent/40',
        active && 'border-primary/40 bg-primary/5',
        pullRequest.isCurrentBranch && !active && 'border-emerald-500/30',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <GitPullRequest className="size-4 shrink-0 text-muted-foreground" />
            <span className="font-mono text-xs text-muted-foreground">#{pullRequest.number}</span>
            <span className="truncate text-sm font-medium text-foreground">{pullRequest.title}</span>
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {pullRequest.headRef} → {pullRequest.baseRef} · {pullRequest.author} · updated{' '}
            {formatRelativeTimestamp(pullRequest.updatedAt)}
          </p>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Badge variant={stateBadgeVariant(pullRequest.state)} className="h-5 rounded-sm px-1.5 text-[10px] capitalize">
          {pullRequest.state}
        </Badge>
        {pullRequest.isDraft ? (
          <Badge variant="outline" className="h-5 rounded-sm px-1.5 text-[10px]">
            Draft
          </Badge>
        ) : null}
        {pullRequest.isCurrentBranch ? (
          <Badge variant="outline" className="h-5 rounded-sm border-emerald-500/40 px-1.5 text-[10px] text-emerald-600 dark:text-emerald-400">
            Current branch PR
          </Badge>
        ) : null}
        {pullRequest.checkStatus ? (
          <Badge variant="outline" className="h-5 gap-1 rounded-sm px-1.5 text-[10px]">
            <CheckStatusIcon status={pullRequest.checkStatus} />
            {checkStatusLabel(pullRequest.checkStatus)}
          </Badge>
        ) : null}
      </div>
    </button>
  )
}

function PullRequestDetailPane({
  pullRequest,
  detail,
  detailLoading,
  detailError,
  currentBranch,
  mergeDisabledReason,
  mergeSuccessMessage,
  onOpenMergeDialog,
}: {
  pullRequest: GitPullRequestSummary | null
  detail: GitPullRequestDetail | null
  detailLoading: boolean
  detailError: string | null
  currentBranch: string | null
  mergeDisabledReason: string | null
  mergeSuccessMessage: string | null
  onOpenMergeDialog: () => void
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')

  useEffect(() => {
    setCopyState('idle')
  }, [pullRequest?.number])

  const handleCopyUrl = useCallback(async () => {
    if (!pullRequest?.providerUrl) {
      return
    }

    try {
      await navigator.clipboard.writeText(pullRequest.providerUrl)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
  }, [pullRequest?.providerUrl])

  if (!pullRequest) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        Select a pull request to view details.
      </div>
    )
  }

  const display = detail ?? pullRequest
  const canShowMergeButton = display.state === 'open' && !display.isDraft

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border/60 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h2 className="text-base font-semibold text-foreground">
              #{pullRequest.number} {pullRequest.title}
            </h2>
            <p className="text-xs text-muted-foreground">
              {pullRequest.headRef} into {pullRequest.baseRef} · {pullRequest.author}
            </p>
            <p className="text-xs text-muted-foreground">
              Updated {formatRelativeTimestamp(pullRequest.updatedAt)}
              {pullRequest.mergedAt ? ` · merged ${formatRelativeTimestamp(pullRequest.mergedAt)}` : null}
              {pullRequest.closedAt && !pullRequest.mergedAt
                ? ` · closed ${formatRelativeTimestamp(pullRequest.closedAt)}`
                : null}
            </p>
            {currentBranch && pullRequest.isCurrentBranch ? (
              <p className="text-xs text-emerald-600 dark:text-emerald-400">
                This pull request matches the current branch ({currentBranch}).
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {canShowMergeButton ? (
              <Button
                size="sm"
                className="h-8 gap-1.5 text-xs"
                disabled={!!mergeDisabledReason || detailLoading}
                title={mergeDisabledReason ?? undefined}
                onClick={onOpenMergeDialog}
              >
                <GitMerge className="size-3.5" />
                Merge…
              </Button>
            ) : null}
            {pullRequest.providerUrl ? (
              <>
                <a
                  href={pullRequest.providerUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-xs font-medium hover:bg-accent hover:text-accent-foreground"
                >
                  <ExternalLink className="size-3.5" />
                  Open in browser
                </a>
                <Button size="sm" variant="ghost" onClick={() => void handleCopyUrl()}>
                  <Copy className="size-3.5" />
                  {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy URL'}
                </Button>
              </>
            ) : null}
          </div>
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1 overflow-hidden">
        <div className="space-y-4 p-4 text-sm">
          {mergeSuccessMessage ? (
            <section className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-900 dark:text-emerald-100">
              {mergeSuccessMessage}
            </section>
          ) : null}
          {detailLoading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              Loading latest pull request details…
            </div>
          ) : null}
          {detailError ? (
            <section className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {detailError}
            </section>
          ) : null}
          <section className="space-y-2">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Status</h3>
            <div className="flex flex-wrap gap-2">
              <Badge variant={stateBadgeVariant(display.state)} className="capitalize">
                {display.state}
              </Badge>
              {display.reviewDecision ? (
                <Badge variant="outline">Review: {display.reviewDecision.toLowerCase()}</Badge>
              ) : null}
              {display.checkStatus ? (
                <Badge variant="outline" className="gap-1">
                  <CheckStatusIcon status={display.checkStatus} />
                  {checkStatusLabel(display.checkStatus)}
                </Badge>
              ) : null}
              {detail?.mergeable === false ? (
                <Badge variant="outline" className="border-red-500/40 text-red-600 dark:text-red-400">
                  Not mergeable
                </Badge>
              ) : null}
            </div>
            {detail?.mergeBlockedReason ? (
              <p className="text-xs text-muted-foreground">{detail.mergeBlockedReason}</p>
            ) : null}
          </section>
          {detail?.checks && detail.checks.length > 0 ? (
            <section className="space-y-2">
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Checks</h3>
              <ul className="space-y-1.5">
                {detail.checks.map((check) => (
                  <li
                    key={check.name}
                    className="flex items-center justify-between gap-2 rounded-md border border-border/60 px-2 py-1.5 text-xs"
                  >
                    <span className="flex items-center gap-1.5">
                      <CheckStatusIcon status={check.status} />
                      {check.name}
                    </span>
                    {check.url ? (
                      <a
                        href={check.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary hover:underline"
                      >
                        Details
                      </a>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {detail ? (
            <section className="space-y-2">
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Changes</h3>
              <p className="text-xs text-muted-foreground">
                {detail.changedFiles} files · +{detail.additions} / -{detail.deletions}
              </p>
              {detail.headSha ? (
                <p className="font-mono text-[11px] text-muted-foreground">Head SHA: {detail.headSha}</p>
              ) : null}
            </section>
          ) : null}
          {detail?.body ? (
            <section className="space-y-2">
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Description</h3>
              <p className="whitespace-pre-wrap text-xs text-muted-foreground">{detail.body}</p>
            </section>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  )
}

export function PullRequestsTab({
  wsUrl,
  agentId,
  repoTarget,
  worktreeId,
  currentBranch,
  pullRequestsQuery,
  onMergeComplete,
}: PullRequestsTabProps) {
  const { data, isLoading, error, refetch } = pullRequestsQuery
  const [selectedNumber, setSelectedNumber] = useState<number | null>(null)
  const [mergeDialogOpen, setMergeDialogOpen] = useState(false)
  const [isMerging, setIsMerging] = useState(false)
  const [mergeError, setMergeError] = useState<string | null>(null)
  const [mergeSuccessMessage, setMergeSuccessMessage] = useState<string | null>(null)

  const detailQuery = useGitPullRequestDetail(
    wsUrl,
    agentId,
    repoTarget,
    selectedNumber,
    worktreeId,
    { enabled: !!agentId && selectedNumber != null },
  )

  const allPullRequests = useMemo(
    () => [...(data?.open ?? []), ...(data?.recentlyClosed ?? [])],
    [data?.open, data?.recentlyClosed],
  )

  useEffect(() => {
    if (allPullRequests.length === 0) {
      setSelectedNumber(null)
      return
    }

    const preferred =
      data?.currentBranchPullRequest?.number ??
      allPullRequests.find((entry) => entry.isCurrentBranch)?.number ??
      allPullRequests[0]?.number ??
      null

    setSelectedNumber((previous) => {
      if (previous != null && allPullRequests.some((entry) => entry.number === previous)) {
        return previous
      }

      return preferred
    })
  }, [allPullRequests, data?.currentBranchPullRequest?.number])

  useEffect(() => {
    setMergeSuccessMessage(null)
    setMergeError(null)
  }, [selectedNumber])

  const selectedPullRequest =
    allPullRequests.find((entry) => entry.number === selectedNumber) ?? data?.currentBranchPullRequest ?? null

  const mergeDisabledReason = useMemo(() => {
    if (repoTarget === 'versioning') {
      return 'Pull request merge is unavailable for the versioning repository.'
    }
    if (!detailQuery.data) {
      return detailQuery.isLoading ? 'Loading latest pull request details…' : 'Latest pull request details are required before merge.'
    }
    if (detailQuery.data.state !== 'open') {
      return 'Only open pull requests can be merged.'
    }
    if (detailQuery.data.isDraft) {
      return 'Draft pull requests cannot be merged.'
    }
    if (detailQuery.data.mergeable === false) {
      return detailQuery.data.mergeBlockedReason ?? 'Pull request is not mergeable.'
    }
    return null
  }, [detailQuery.data, detailQuery.isLoading, repoTarget])

  const handleConfirmMerge = useCallback(
    async (options: {
      method: 'squash' | 'merge' | 'rebase'
      acknowledgeCheckFailures: boolean
    }) => {
      if (!agentId || !detailQuery.data || selectedNumber == null) {
        return
      }

      setIsMerging(true)
      setMergeError(null)

      try {
        const result = await mergeGitPullRequest(wsUrl, selectedNumber, {
          agentId,
          repoTarget,
          worktreeId: worktreeId ?? undefined,
          method: options.method,
          expectedHeadSha: detailQuery.data.headSha,
          acknowledgeCheckFailures: options.acknowledgeCheckFailures,
        })

        if (result.submitted && !result.success) {
          setMergeDialogOpen(false)
          setMergeSuccessMessage(
            `Merge request submitted for pull request #${result.number} using ${options.method}. GitHub reports it is still open.`,
          )
          invalidateGitCaches({ agentId, repoTarget })
          await Promise.all([refetch(), detailQuery.refetch()])
          onMergeComplete?.()
          return
        }

        if (!result.success) {
          const message =
            result.errors.join(' ') ||
            result.warnings.join(' ') ||
            'Pull request merge failed.'
          setMergeError(message)
          if (result.detail) {
            await detailQuery.refetch()
          }
          return
        }

        setMergeDialogOpen(false)
        setMergeSuccessMessage(
          `Merged pull request #${result.number} using ${options.method}.`,
        )
        invalidateGitCaches({ agentId, repoTarget })
        await Promise.all([refetch(), detailQuery.refetch()])
        onMergeComplete?.()
      } catch (mergeFailure) {
        setMergeError(mergeFailure instanceof Error ? mergeFailure.message : 'Pull request merge failed.')
      } finally {
        setIsMerging(false)
      }
    },
    [agentId, detailQuery, onMergeComplete, refetch, repoTarget, selectedNumber, worktreeId, wsUrl],
  )

  if (!agentId) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        Select a session to view pull requests.
      </div>
    )
  }

  if (isLoading && !data) {
    return (
      <div className="flex h-full items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Loading pull requests…
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-destructive">
        {error}
      </div>
    )
  }

  const providerStatus = data?.providerStatus
  const providerReady =
    providerStatus?.provider === 'github' &&
    providerStatus.available &&
    providerStatus.authenticated

  if (!providerReady) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-md space-y-3 rounded-lg border border-border/70 bg-card/60 p-4 text-sm">
          <div className="flex items-center gap-2 font-medium text-foreground">
            <AlertCircle className="size-4 text-amber-500" />
            GitHub pull requests unavailable
          </div>
          <p className="text-muted-foreground">
            {providerStatus?.message ??
              'Install and authenticate GitHub CLI (`gh auth login`) to browse pull requests for GitHub remotes.'}
          </p>
          {providerStatus?.remoteUrl ? (
            <p className="truncate font-mono text-xs text-muted-foreground">{providerStatus.remoteUrl}</p>
          ) : null}
        </div>
      </div>
    )
  }

  if (data?.listError) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-md space-y-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
          <div className="flex items-center gap-2 font-medium text-foreground">
            <AlertCircle className="size-4 text-destructive" />
            Could not load pull requests
          </div>
          <p className="text-muted-foreground">{data.listError.message}</p>
          <p className="text-xs text-muted-foreground">
            GitHub CLI is configured, but the pull request list request failed. Try refresh or check GitHub access.
          </p>
        </div>
      </div>
    )
  }

  const hasAnyPullRequests = (data?.open.length ?? 0) > 0 || (data?.recentlyClosed.length ?? 0) > 0

  return (
    <>
      <div className="grid h-full min-h-0 grid-cols-1 lg:grid-cols-[minmax(280px,360px)_minmax(0,1fr)]">
        <div className="flex min-h-0 flex-col border-b border-border/60 lg:border-b-0 lg:border-r">
          <div className="border-b border-border/60 px-4 py-3">
            <h3 className="text-sm font-medium text-foreground">Pull Requests</h3>
            <p className="text-xs text-muted-foreground">Open and recently closed for this repository</p>
          </div>
          <ScrollArea className="min-h-0 flex-1 overflow-hidden">
            <div className="space-y-4 p-3">
              {!hasAnyPullRequests ? (
                <div className="rounded-lg border border-dashed border-border/70 p-4 text-center text-sm text-muted-foreground">
                  No pull requests found for this repository.
                </div>
              ) : null}
              {(data?.open.length ?? 0) > 0 ? (
                <section className="space-y-2">
                  <p className="px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Open</p>
                  {data?.open.map((pullRequest) => (
                    <PullRequestCard
                      key={pullRequest.number}
                      pullRequest={pullRequest}
                      active={selectedNumber === pullRequest.number}
                      onClick={() => setSelectedNumber(pullRequest.number)}
                    />
                  ))}
                </section>
              ) : null}
              {(data?.recentlyClosed.length ?? 0) > 0 ? (
                <section className="space-y-2">
                  <p className="px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    Recently closed
                  </p>
                  {data?.recentlyClosed.map((pullRequest) => (
                    <PullRequestCard
                      key={pullRequest.number}
                      pullRequest={pullRequest}
                      active={selectedNumber === pullRequest.number}
                      onClick={() => setSelectedNumber(pullRequest.number)}
                    />
                  ))}
                </section>
              ) : null}
            </div>
          </ScrollArea>
        </div>
        <PullRequestDetailPane
          pullRequest={selectedPullRequest}
          detail={detailQuery.data}
          detailLoading={detailQuery.isLoading}
          detailError={detailQuery.error}
          currentBranch={currentBranch}
          mergeDisabledReason={mergeDisabledReason}
          mergeSuccessMessage={mergeSuccessMessage}
          onOpenMergeDialog={() => {
            setMergeError(null)
            setMergeDialogOpen(true)
          }}
        />
      </div>
      <MergePullRequestDialog
        key={`${selectedNumber ?? 'none'}-${detailQuery.data?.headSha ?? 'loading'}`}
        open={mergeDialogOpen}
        pullRequest={detailQuery.data}
        isSubmitting={isMerging}
        mergeError={mergeError}
        onConfirm={(options) => void handleConfirmMerge(options)}
        onCancel={() => {
          if (!isMerging) {
            setMergeDialogOpen(false)
            setMergeError(null)
          }
        }}
      />
    </>
  )
}
