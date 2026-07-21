import { useEffect, useRef, useState } from 'react'
import type { RemoteUpdateAwarenessIncomingInspection, RemoteUpdateAwarenessProjectSnapshot } from '@forge/protocol'
import { AlertCircle, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  dismissRemoteUpdateAwarenessProjectUpdate,
  fetchRemoteUpdateAwarenessIncoming,
  refreshRemoteUpdateAwarenessProject,
} from '@/components/settings/remote-update-awareness-api'
import {
  createRemoteUpdateAwarenessMutationTarget,
  remoteUpdateAwarenessProjectionFingerprint,
  type RemoteUpdateAwarenessMutationTarget,
  type RemoteUpdateAwarenessSnapshotChange,
} from './remote-update-awareness-mutation'

function statusCopy(snapshot: RemoteUpdateAwarenessProjectSnapshot): string | null {
  switch (snapshot.state) {
    case 'update_available': return 'The remote default branch has advanced.'
    case 'stale': return 'Remote status is stale. No update is inferred.'
    case 'error': return snapshot.failureCode === 'auth' ? 'Remote check needs authentication.' : 'Remote check could not complete.'
    case 'unresolved': return 'The remote default branch could not be resolved.'
    case 'unknown': return 'Remote branch relationship is unknown.'
    case 'rewound': return 'The remote default branch was rewound.'
    case 'diverged': return 'Local and remote branch history diverged.'
    case 'missing': return 'The tracked remote branch is unavailable.'
    case 'detached': return 'The selected repository is detached.'
    default: return null
  }
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.trim() ? cause.message : fallback
}

function snapshotTargetKey(snapshot: RemoteUpdateAwarenessProjectSnapshot | null): string {
  return snapshot ? remoteUpdateAwarenessProjectionFingerprint(snapshot) : 'none'
}

export function RemoteUpdateAwarenessBanner({
  wsUrl,
  snapshot,
  onInspect,
  onSnapshotChange,
}: {
  wsUrl: string
  snapshot: RemoteUpdateAwarenessProjectSnapshot | null
  onInspect: () => void
  onSnapshotChange: RemoteUpdateAwarenessSnapshotChange
}) {
  const [activeMutation, setActiveMutation] = useState<{
    kind: 'refresh' | 'dismiss'
    target: RemoteUpdateAwarenessMutationTarget
  } | null>(null)
  const [feedback, setFeedback] = useState<{
    targetKey: string
    message: string
  } | null>(null)
  const mountedRef = useRef(false)
  const requestIdRef = useRef(0)
  const activeRequestRef = useRef<RemoteUpdateAwarenessMutationTarget | null>(null)
  const targetKey = snapshotTargetKey(snapshot)
  const currentTargetKeyRef = useRef(targetKey)
  const targetEpochRef = useRef(0)

  if (currentTargetKeyRef.current !== targetKey) {
    currentTargetKeyRef.current = targetKey
    targetEpochRef.current += 1
    activeRequestRef.current = null
    setActiveMutation(null)
    setFeedback(null)
  }

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      activeRequestRef.current = null
    }
  }, [])

  if (!snapshot || !snapshot.effectiveEnabled) return null
  const copy = statusCopy(snapshot)
  if (!copy || (snapshot.state === 'update_available' && !snapshot.attentionRequired)) return null

  const beginMutation = (kind: 'refresh' | 'dismiss') => {
    if (activeRequestRef.current) return null
    const target = createRemoteUpdateAwarenessMutationTarget(snapshot, requestIdRef.current + 1)
    requestIdRef.current = target.requestId
    activeRequestRef.current = target
    setActiveMutation({ kind, target })
    setFeedback(null)
    return { target, targetEpoch: targetEpochRef.current }
  }

  const isCurrentRequest = (target: RemoteUpdateAwarenessMutationTarget, targetEpoch: number) =>
    mountedRef.current &&
    targetEpochRef.current === targetEpoch &&
    activeRequestRef.current?.requestId === target.requestId &&
    currentTargetKeyRef.current === target.projectionFingerprint

  const finishMutation = (target: RemoteUpdateAwarenessMutationTarget, targetEpoch: number) => {
    if (!isCurrentRequest(target, targetEpoch)) return
    activeRequestRef.current = null
    setActiveMutation((current) => current?.target.requestId === target.requestId ? null : current)
  }

  const refresh = async () => {
    const request = beginMutation('refresh')
    if (!request) return
    const { target, targetEpoch } = request
    try {
      const response = await refreshRemoteUpdateAwarenessProject(wsUrl, target.projectId)
      if (isCurrentRequest(target, targetEpoch)) {
        onSnapshotChange(response.snapshot, target)
      }
    } catch {
      if (isCurrentRequest(target, targetEpoch)) {
        setFeedback({ targetKey, message: 'Could not check remote updates. Retry when ready.' })
      }
    } finally {
      finishMutation(target, targetEpoch)
    }
  }

  const dismiss = async () => {
    if (!snapshot.dismissalTarget) return
    const request = beginMutation('dismiss')
    if (!request) return
    const { target, targetEpoch } = request
    try {
      const response = await dismissRemoteUpdateAwarenessProjectUpdate(
        wsUrl,
        target.projectId,
        target.generation!,
      )
      if (isCurrentRequest(target, targetEpoch)) {
        onSnapshotChange(response.snapshot, target)
      }
    } catch (cause: unknown) {
      if (isCurrentRequest(target, targetEpoch)) {
        const message = errorMessage(cause, '')
        setFeedback({
          targetKey,
          message: /stale|conflict/i.test(message)
            ? 'Incoming changed before dismissal. Check now, then retry.'
            : 'Could not dismiss this notification. Retry when ready.',
        })
      }
    } finally {
      finishMutation(target, targetEpoch)
    }
  }

  const mutationRunning = activeMutation?.target.projectionFingerprint === targetKey
  const refreshing = mutationRunning && activeMutation.kind === 'refresh'
  const visibleFeedback = feedback?.targetKey === targetKey ? feedback.message : null

  const isUpdate = snapshot.state === 'update_available'
  return (
    <div className="mx-3 mt-3 flex flex-wrap items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs" role="status">
      <AlertCircle className="size-3.5 shrink-0 text-amber-600" />
      <span className="min-w-0 flex-1 text-foreground">{copy}</span>
      {isUpdate ? (
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onInspect}>
          Inspect Incoming
        </Button>
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs"
        disabled={mutationRunning}
        onClick={() => void refresh()}
      >
        <RefreshCw className={refreshing ? 'mr-1 size-3 animate-spin' : 'mr-1 size-3'} />Check now
      </Button>
      {isUpdate && snapshot.dismissalTarget ? (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          disabled={mutationRunning}
          onClick={() => void dismiss()}
          title="Hide this notification until the remote default branch advances again."
        >
          Dismiss
        </Button>
      ) : null}
      {visibleFeedback ? (
        <p className="basis-full text-right text-xs text-destructive" role="alert">{visibleFeedback}</p>
      ) : null}
    </div>
  )
}

export function RemoteUpdateAwarenessIncoming({
  wsUrl,
  projectId,
  generation,
}: {
  wsUrl: string
  projectId: string
  generation: number | null
}) {
  const [incoming, setIncoming] = useState<RemoteUpdateAwarenessIncomingInspection | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadRequest, setLoadRequest] = useState(0)

  useEffect(() => {
    let cancelled = false
    setIncoming(null)
    setError(null)
    void fetchRemoteUpdateAwarenessIncoming(wsUrl, projectId).then(
      (response) => {
        if (!cancelled) setIncoming(response.incoming)
      },
      (cause: unknown) => {
        if (!cancelled) setError(errorMessage(cause, 'Incoming details are unavailable.'))
      },
    )
    return () => {
      cancelled = true
    }
  }, [generation, loadRequest, projectId, wsUrl])

  if (error) {
    return (
      <div className="flex items-center gap-3 p-4 text-sm text-destructive" role="alert">
        <span>{error}</span>
        <Button variant="outline" size="sm" onClick={() => setLoadRequest((current) => current + 1)}>
          Retry
        </Button>
      </div>
    )
  }
  if (!incoming) return <div className="p-4 text-sm text-muted-foreground">Loading incoming changes…</div>

  const branch = incoming.defaultBranchDisplay ?? 'the remote default branch'
  return (
    <div className="space-y-4 overflow-auto p-4" aria-label="Incoming remote changes">
      <div><h2 className="text-sm font-semibold">Incoming</h2><p className="mt-1 text-xs text-muted-foreground">Inspection only for {branch}; no changes are applied.</p></div>
      {incoming.state !== 'update_available' ? <p className="rounded-md border border-border/60 bg-muted/30 p-3 text-sm text-muted-foreground">Remote state: {incoming.state.replaceAll('_', ' ')}.</p> : null}
      <section className="rounded-md border border-border/60"><div className="border-b border-border/60 px-3 py-2 text-xs font-medium">Commits represented ({incoming.commits.commitCount}{incoming.commits.hasMore ? '+' : ''})</div>
        {incoming.commits.commits.length ? incoming.commits.commits.map((commit, index) => <div key={`${commit.subject}-${index}`} className="border-b border-border/40 px-3 py-2 last:border-0"><p className="text-sm">{commit.subject}</p>{commit.committedAt ? <p className="mt-0.5 text-xs text-muted-foreground">{new Date(commit.committedAt).toLocaleString()}</p> : null}</div>) : <p className="px-3 py-3 text-sm text-muted-foreground">No bounded commit details are available.</p>}
      </section>
      {incoming.fileChanges ? <p className="text-xs text-muted-foreground">{incoming.fileChanges.changedFileCount === null ? 'File-change summary is unavailable.' : `${incoming.fileChanges.changedFileCount}${incoming.fileChanges.hasMore ? '+' : ''} changed files in this inspection.`}</p> : null}
    </div>
  )
}
