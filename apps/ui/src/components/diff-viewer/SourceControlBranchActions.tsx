import type { GitBranchSummary } from '@forge/protocol'
import { ArrowDown, ChevronDown, GitBranch, Plus, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { GitMutationConfirmDialog } from './GitMutationConfirmDialog'
import {
  createGitBranch,
  fetchGitOrigin,
  fetchMutationPreflight,
  invalidateGitCaches,
  pullGitFfOnly,
  switchGitBranch,
  type GitBranchesQueryResult,
} from './use-diff-queries'
import { invalidateFileBrowserCaches } from '@/components/file-browser/use-file-browser-queries'
import {
  buildSourceControlAutoFetchKey,
  isSourceControlAutoFetchEligible,
  markOriginFetchCompleted,
  shouldAutoFetchOrigin,
} from './source-control-auto-fetch'

type PendingMutation =
  | { kind: 'switch'; branch: string }
  | { kind: 'create'; branch: string; startPoint?: string }
  | { kind: 'pull' }

interface SourceControlBranchActionsProps {
  wsUrl: string
  agentId: string | null
  repoTarget: 'workspace' | 'versioning'
  worktreeId?: string | null
  selectedWorktreePath?: string | null
  branchesQuery: GitBranchesQueryResult
  isDirty: boolean
  sourceControlActive?: boolean
  onMutationComplete: () => void
  onRequestMutation?: (
    mutation: 'switch-branch' | 'create-branch' | 'pull-ff-only',
    target: { agentId: string; worktreeId: string | null },
    run: () => void,
  ) => void
}

export function SourceControlBranchActions({
  wsUrl,
  agentId,
  repoTarget,
  worktreeId,
  selectedWorktreePath,
  branchesQuery,
  isDirty,
  sourceControlActive = true,
  onMutationComplete,
  onRequestMutation,
}: SourceControlBranchActionsProps) {
  const [branchMenuOpen, setBranchMenuOpen] = useState(false)
  const [newBranchName, setNewBranchName] = useState('')
  const [createFromRemote, setCreateFromRemote] = useState<string | null>(null)
  const [pendingMutation, setPendingMutation] = useState<PendingMutation | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [fetchState, setFetchState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [preflightWarnings, setPreflightWarnings] = useState<string[]>([])
  const [preflightBlockedReasons, setPreflightBlockedReasons] = useState<string[]>([])
  const [actionWarning, setActionWarning] = useState<string | null>(null)
  const autoFetchInFlightKeyRef = useRef<string | null>(null)

  const branchData = branchesQuery.data
  const mutationsDisabled = repoTarget === 'versioning' || !agentId || !branchData?.currentHead || !branchData.statusHash

  const currentBranch = branchData?.currentBranch ?? null
  const aheadBehind = useMemo(() => {
    const current = branchData?.branches.find((branch) => branch.kind === 'current')
    return {
      ahead: current?.ahead ?? 0,
      behind: current?.behind ?? 0,
    }
  }, [branchData?.branches])

  const localBranches = useMemo(
    () => branchData?.branches.filter((branch) => branch.kind === 'local' || branch.kind === 'current') ?? [],
    [branchData?.branches],
  )
  const remoteBranches = useMemo(
    () => branchData?.branches.filter((branch) => branch.kind === 'remote') ?? [],
    [branchData?.branches],
  )

  const pullBlockedReasons = useMemo(() => {
    const reasons: string[] = []
    if (isDirty) {
      reasons.push('The worktree has uncommitted changes.')
    }
    if (aheadBehind.behind === 0) {
      reasons.push('The current branch is not behind its upstream.')
    }
    if (!branchData?.remotes.includes('origin')) {
      reasons.push('No origin remote is configured.')
    }
    return reasons
  }, [aheadBehind.behind, branchData?.remotes, isDirty])

  useEffect(() => {
    if (!pendingMutation || !agentId) {
      setPreflightWarnings([])
      setPreflightBlockedReasons([])
      return
    }

    const action =
      pendingMutation.kind === 'switch'
        ? 'switch-branch'
        : pendingMutation.kind === 'create'
          ? 'create-branch'
          : 'pull-ff-only'

    let cancelled = false
    void fetchMutationPreflight(wsUrl, {
      agentId,
      repoTarget,
      worktreeId: worktreeId ?? undefined,
      action,
      targetBranch:
        pendingMutation.kind === 'switch'
          ? pendingMutation.branch
          : pendingMutation.kind === 'create'
            ? pendingMutation.branch
            : undefined,
      startPoint: pendingMutation.kind === 'create' ? pendingMutation.startPoint : undefined,
      remote: pendingMutation.kind === 'pull' ? 'origin' : undefined,
    })
      .then((preflight) => {
        if (cancelled) {
          return
        }

        setPreflightWarnings(
          preflight.issues
            .filter((issue) => issue.severity === 'warn')
            .map((issue) => issue.message),
        )
        setPreflightBlockedReasons(
          preflight.issues
            .filter((issue) => issue.severity === 'block')
            .map((issue) => issue.message),
        )
      })
      .catch(() => {
        if (!cancelled) {
          setPreflightWarnings([])
          setPreflightBlockedReasons([])
        }
      })

    return () => {
      cancelled = true
    }
  }, [agentId, pendingMutation, repoTarget, worktreeId, wsUrl])

  const invalidateAfterMutation = useCallback(() => {
    invalidateGitCaches({ agentId, repoTarget })
    invalidateFileBrowserCaches()
    onMutationComplete()
  }, [agentId, onMutationComplete, repoTarget])

  const autoFetchKey = useMemo(() => {
    if (!agentId) {
      return null
    }
    return buildSourceControlAutoFetchKey({
      agentId,
      repoTarget,
      worktreeId,
      remote: 'origin',
    })
  }, [agentId, repoTarget, worktreeId])

  const handleFetch = useCallback(async (options?: { source?: 'manual' | 'auto' }) => {
    const source = options?.source ?? 'manual'
    if (!agentId || !branchData?.currentHead || !branchData.statusHash) {
      return
    }

    setFetchState('loading')
    if (source === 'manual') {
      setActionError(null)
      setActionWarning(null)
    }

    try {
      const result = await fetchGitOrigin(wsUrl, {
        agentId,
        repoTarget,
        worktreeId: worktreeId ?? undefined,
        remote: 'origin',
        expectedHead: branchData.currentHead,
        expectedStatusHash: branchData.statusHash,
      })

      if (!result.success) {
        if (source === 'manual') {
          setFetchState('error')
          setActionError(result.errors.join(' ') || 'Fetch failed.')
        } else {
          setFetchState('idle')
        }
        return
      }

      if (autoFetchKey) {
        markOriginFetchCompleted(autoFetchKey)
      }

      if (source === 'manual') {
        setFetchState('success')
      } else {
        setFetchState('idle')
      }

      if (source === 'manual' && result.warnings.length > 0) {
        setActionWarning(result.warnings.join(' '))
      }
      invalidateAfterMutation()
    } catch (error) {
      if (source === 'manual') {
        setFetchState('error')
        setActionError(error instanceof Error ? error.message : 'Fetch failed.')
      } else {
        setFetchState('idle')
      }
    }
  }, [agentId, autoFetchKey, branchData, invalidateAfterMutation, repoTarget, worktreeId, wsUrl])

  useEffect(() => {
    if (!sourceControlActive || !autoFetchKey || !branchData) {
      return
    }

    if (
      !isSourceControlAutoFetchEligible({
        repoTarget,
        agentId,
        currentHead: branchData.currentHead,
        statusHash: branchData.statusHash,
        remotes: branchData.remotes,
      })
    ) {
      return
    }

    if (!shouldAutoFetchOrigin(autoFetchKey) || autoFetchInFlightKeyRef.current === autoFetchKey) {
      return
    }

    autoFetchInFlightKeyRef.current = autoFetchKey
    void handleFetch({ source: 'auto' }).finally(() => {
      if (autoFetchInFlightKeyRef.current === autoFetchKey) {
        autoFetchInFlightKeyRef.current = null
      }
    })
  }, [agentId, autoFetchKey, branchData, handleFetch, repoTarget, sourceControlActive])

  const requestMutationGuard = useCallback((
    mutation: 'switch-branch' | 'create-branch' | 'pull-ff-only',
    run: () => void,
  ) => {
    if (!agentId) return
    if (onRequestMutation) {
      onRequestMutation(mutation, { agentId, worktreeId: worktreeId ?? null }, run)
      return
    }
    run()
  }, [agentId, onRequestMutation, worktreeId])

  const openSwitchConfirmation = useCallback((branch: GitBranchSummary) => {
    if (branch.kind === 'current') {
      return
    }

    requestMutationGuard('switch-branch', () => {
      setActionError(null)
      setActionWarning(null)
      setPendingMutation({ kind: 'switch', branch: branch.name })
      setBranchMenuOpen(false)
    })
  }, [requestMutationGuard])

  const openCreateConfirmation = useCallback(() => {
    const trimmed = newBranchName.trim()
    if (trimmed.length === 0) {
      return
    }

    requestMutationGuard('create-branch', () => {
      setActionError(null)
      setActionWarning(null)
      setPendingMutation({
        kind: 'create',
        branch: trimmed,
        startPoint: createFromRemote ?? undefined,
      })
      setBranchMenuOpen(false)
    })
  }, [createFromRemote, newBranchName, requestMutationGuard])

  const confirmMutation = useCallback(async () => {
    if (!pendingMutation || !agentId || !branchData?.currentHead || !branchData.statusHash) {
      return
    }

    setIsSubmitting(true)
    setActionError(null)
    setActionWarning(null)

    const baseRequest = {
      agentId,
      repoTarget,
      worktreeId: worktreeId ?? undefined,
      expectedHead: branchData.currentHead,
      expectedStatusHash: branchData.statusHash,
    }

    try {
      let result:
        | Awaited<ReturnType<typeof switchGitBranch>>
        | Awaited<ReturnType<typeof createGitBranch>>
        | Awaited<ReturnType<typeof pullGitFfOnly>>

      if (pendingMutation.kind === 'switch') {
        result = await switchGitBranch(wsUrl, {
          ...baseRequest,
          branch: pendingMutation.branch,
        })
      } else if (pendingMutation.kind === 'create') {
        result = await createGitBranch(wsUrl, {
          ...baseRequest,
          branch: pendingMutation.branch,
          startPoint: pendingMutation.startPoint,
        })
      } else {
        result = await pullGitFfOnly(wsUrl, {
          ...baseRequest,
          remote: 'origin',
        })
      }

      if (!result.success) {
        setActionError(result.errors.join(' ') || 'Git action failed.')
        return
      }

      if (result.warnings.length > 0) {
        setActionWarning(result.warnings.join(' '))
      }

      setPendingMutation(null)
      setNewBranchName('')
      setCreateFromRemote(null)
      setPreflightWarnings([])
      setPreflightBlockedReasons([])
      invalidateAfterMutation()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Git action failed.')
    } finally {
      setIsSubmitting(false)
    }
  }, [agentId, branchData, invalidateAfterMutation, pendingMutation, repoTarget, worktreeId, wsUrl])

  const pendingDialog = useMemo(() => {
    if (!pendingMutation || !branchData) {
      return null
    }

    const worktreeCopy = selectedWorktreePath
      ? `Selected worktree: ${selectedWorktreePath}. Chat session CWD stays unchanged.`
      : 'This action applies to the session workspace repository.'

    if (pendingMutation.kind === 'switch') {
      return {
        title: `Switch to ${pendingMutation.branch}?`,
        description: `${worktreeCopy} Forge will switch only when the worktree is clean and no active agents block the operation.`,
        confirmLabel: 'Switch branch',
        blockedReasons: uniqueStrings([
          ...(isDirty ? ['The worktree has uncommitted changes.'] : []),
          ...(branchData.branches.find((branch) => branch.name === pendingMutation.branch)?.isCheckedOutInAnotherWorktree
            ? [`${pendingMutation.branch} is checked out in another worktree.`]
            : []),
          ...preflightBlockedReasons,
          ...(actionError ? [actionError] : []),
        ]),
        warnings: preflightWarnings,
      }
    }

    if (pendingMutation.kind === 'create') {
      return {
        title: `Create branch ${pendingMutation.branch}?`,
        description: pendingMutation.startPoint
          ? `${worktreeCopy} A new local branch will be created from ${pendingMutation.startPoint}.`
          : `${worktreeCopy} A new local branch will be created from the current HEAD.`,
        confirmLabel: 'Create branch',
        blockedReasons: uniqueStrings([
          ...(isDirty ? ['The worktree has uncommitted changes.'] : []),
          ...preflightBlockedReasons,
          ...(actionError ? [actionError] : []),
        ]),
        warnings: preflightWarnings,
      }
    }

    return {
      title: 'Fast-forward pull?',
      description: `${worktreeCopy} Forge will fetch origin and merge only when a fast-forward is possible. Merge commits and autostash are never used.`,
      confirmLabel: 'Pull fast-forward',
      blockedReasons: uniqueStrings([
        ...pullBlockedReasons,
        ...preflightBlockedReasons,
        ...(actionError ? [actionError] : []),
      ]),
      warnings: preflightWarnings,
    }
  }, [
    actionError,
    branchData,
    isDirty,
    pendingMutation,
    preflightBlockedReasons,
    preflightWarnings,
    pullBlockedReasons,
    selectedWorktreePath,
  ])

  if (mutationsDisabled) {
    return null
  }

  return (
    <>
      <div className="flex items-center gap-1.5">
        <Popover open={branchMenuOpen} onOpenChange={setBranchMenuOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1 px-2 text-xs"
              disabled={branchesQuery.isLoading}
            >
              <GitBranch className="size-3.5" />
              <span className="max-w-28 truncate">{currentBranch ?? 'Branch'}</span>
              {aheadBehind.ahead > 0 ? (
                <span className="text-emerald-500">+{aheadBehind.ahead}</span>
              ) : null}
              {aheadBehind.behind > 0 ? (
                <span className="text-amber-500">-{aheadBehind.behind}</span>
              ) : null}
              <ChevronDown className="size-3 opacity-60" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80 p-0">
            <div className="border-b border-border/60 px-3 py-2 text-xs font-medium text-foreground">
              Switch branch
            </div>
            <div className="max-h-48 overflow-auto p-1">
              {localBranches.map((branch) => (
                <button
                  key={branch.name}
                  type="button"
                  className={cn(
                    'flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted/60',
                    branch.kind === 'current' && 'bg-muted/50 font-medium',
                  )}
                  onClick={() => openSwitchConfirmation(branch)}
                  disabled={branch.kind === 'current' || branch.isCheckedOutInAnotherWorktree}
                >
                  <span className="truncate">{branch.name}</span>
                  {branch.isCheckedOutInAnotherWorktree ? (
                    <span className="ml-2 shrink-0 text-[10px] text-muted-foreground">in use</span>
                  ) : null}
                </button>
              ))}
            </div>
            <div className="space-y-2 border-t border-border/60 p-3">
              <p className="text-[11px] font-medium text-foreground">Create branch</p>
              <Input
                value={newBranchName}
                onChange={(event) => setNewBranchName(event.target.value)}
                placeholder="feature/my-branch"
                className="h-8 text-xs"
              />
              {remoteBranches.length > 0 ? (
                <select
                  className="h-8 w-full rounded-md border border-border/60 bg-background px-2 text-xs"
                  value={createFromRemote ?? ''}
                  onChange={(event) => setCreateFromRemote(event.target.value || null)}
                >
                  <option value="">From current HEAD</option>
                  {remoteBranches.map((branch) => (
                    <option key={branch.name} value={branch.name}>
                      From {branch.name}
                    </option>
                  ))}
                </select>
              ) : null}
              <Button
                size="sm"
                className="h-7 w-full gap-1 text-xs"
                onClick={openCreateConfirmation}
                disabled={newBranchName.trim().length === 0 || isDirty}
              >
                <Plus className="size-3.5" />
                Create branch
              </Button>
              {isDirty ? (
                <p className="text-[11px] text-muted-foreground">
                  Commit, stash, or discard changes in a terminal before creating or switching branches.
                </p>
              ) : null}
            </div>
          </PopoverContent>
        </Popover>

        <Button
          variant="outline"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={() => void handleFetch({ source: 'manual' })}
          disabled={fetchState === 'loading'}
        >
          <RefreshCw className={cn('mr-1 size-3.5', fetchState === 'loading' && 'animate-spin')} />
          Fetch origin
        </Button>

        <Button
          variant="outline"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={() => {
            requestMutationGuard('pull-ff-only', () => {
              setActionError(null)
              setActionWarning(null)
              setPendingMutation({ kind: 'pull' })
            })
          }}
          disabled={pullBlockedReasons.length > 0}
          title={pullBlockedReasons[0]}
        >
          <ArrowDown className="mr-1 size-3.5" />
          Pull FF only
        </Button>
      </div>

      {actionError ? (
        <span className="hidden max-w-48 truncate text-[11px] text-red-500 lg:inline" title={actionError}>
          {actionError}
        </span>
      ) : actionWarning ? (
        <span className="hidden max-w-48 truncate text-[11px] text-amber-600 lg:inline" title={actionWarning}>
          {actionWarning}
        </span>
      ) : fetchState === 'success' ? (
        <span className="hidden text-[11px] text-emerald-500 lg:inline">Fetched origin</span>
      ) : null}

      {pendingDialog ? (
        <GitMutationConfirmDialog
          open={pendingMutation !== null}
          title={pendingDialog.title}
          description={pendingDialog.description}
          warnings={pendingDialog.warnings}
          blockedReasons={pendingDialog.blockedReasons}
          confirmLabel={pendingDialog.confirmLabel}
          isSubmitting={isSubmitting}
          onConfirm={() => void confirmMutation()}
          onCancel={() => setPendingMutation(null)}
        />
      ) : null}
    </>
  )
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values))
}
