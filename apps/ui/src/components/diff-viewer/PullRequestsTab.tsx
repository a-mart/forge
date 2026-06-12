import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  Clock3,
  Copy,
  ExternalLink,
  GitPullRequest,
  Loader2,
  XCircle,
} from 'lucide-react'
import type { GitPullRequestSummary } from '@forge/protocol'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import type { GitPullRequestsQueryResult } from './use-diff-queries'

interface PullRequestsTabProps {
  agentId: string | null
  currentBranch: string | null
  pullRequestsQuery: GitPullRequestsQueryResult
  onSelectPullRequest?: (pullRequest: GitPullRequestSummary) => void
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
  currentBranch,
}: {
  pullRequest: GitPullRequestSummary | null
  currentBranch: string | null
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
          <section className="space-y-2">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Status</h3>
            <div className="flex flex-wrap gap-2">
              <Badge variant={stateBadgeVariant(pullRequest.state)} className="capitalize">
                {pullRequest.state}
              </Badge>
              {pullRequest.reviewDecision ? (
                <Badge variant="outline">Review: {pullRequest.reviewDecision.toLowerCase()}</Badge>
              ) : null}
              {pullRequest.checkStatus ? (
                <Badge variant="outline" className="gap-1">
                  <CheckStatusIcon status={pullRequest.checkStatus} />
                  {checkStatusLabel(pullRequest.checkStatus)}
                </Badge>
              ) : null}
            </div>
          </section>
          <section className="rounded-lg border border-border/60 bg-muted/20 p-3 text-xs text-muted-foreground">
            Pull request comments and merge actions are read-only in this phase. Use Open in browser for full GitHub
            review workflows.
          </section>
        </div>
      </ScrollArea>
    </div>
  )
}

export function PullRequestsTab({
  agentId,
  currentBranch,
  pullRequestsQuery,
}: PullRequestsTabProps) {
  const { data, isLoading, error } = pullRequestsQuery
  const [selectedNumber, setSelectedNumber] = useState<number | null>(null)

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

  const selectedPullRequest =
    allPullRequests.find((entry) => entry.number === selectedNumber) ?? data?.currentBranchPullRequest ?? null

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
      <PullRequestDetailPane pullRequest={selectedPullRequest} currentBranch={currentBranch} />
    </div>
  )
}
