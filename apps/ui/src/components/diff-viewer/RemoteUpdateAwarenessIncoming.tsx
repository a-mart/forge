import { useEffect, useState } from 'react'
import type { RemoteUpdateAwarenessIncomingInspection, RemoteUpdateAwarenessProjectSnapshot } from '@forge/protocol'
import { AlertCircle, RefreshCw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  dismissRemoteUpdateAwarenessProjectUpdate,
  fetchRemoteUpdateAwarenessIncoming,
  refreshRemoteUpdateAwarenessProject,
} from '@/components/settings/remote-update-awareness-api'

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

export function RemoteUpdateAwarenessBanner({
  wsUrl,
  snapshot,
  onInspect,
  onSnapshotChange,
}: {
  wsUrl: string
  snapshot: RemoteUpdateAwarenessProjectSnapshot | null
  onInspect: () => void
  onSnapshotChange: (snapshot: RemoteUpdateAwarenessProjectSnapshot) => void
}) {
  const [refreshing, setRefreshing] = useState(false)
  if (!snapshot || !snapshot.effectiveEnabled) return null
  const copy = statusCopy(snapshot)
  if (!copy || (snapshot.state === 'update_available' && !snapshot.attentionRequired)) return null
  const refresh = async () => {
    setRefreshing(true)
    try { onSnapshotChange((await refreshRemoteUpdateAwarenessProject(wsUrl, snapshot.projectId)).snapshot) } finally { setRefreshing(false) }
  }
  const dismiss = async () => {
    if (!snapshot.dismissalTarget) return
    onSnapshotChange((await dismissRemoteUpdateAwarenessProjectUpdate(wsUrl, snapshot.projectId, snapshot.dismissalTarget.generation)).snapshot)
  }
  const isUpdate = snapshot.state === 'update_available'
  return (
    <div className="mx-3 mt-3 flex flex-wrap items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs" role="status">
      <AlertCircle className="size-3.5 shrink-0 text-amber-600" />
      <span className="min-w-0 flex-1 text-foreground">{copy}</span>
      {isUpdate ? <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onInspect}>Inspect Incoming</Button> : null}
      <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" disabled={refreshing} onClick={() => void refresh()}>
        <RefreshCw className={refreshing ? 'mr-1 size-3 animate-spin' : 'mr-1 size-3'} />Check now
      </Button>
      {isUpdate && snapshot.dismissalTarget ? <Button variant="ghost" size="icon" className="size-6" onClick={() => void dismiss()} aria-label="Dismiss this exact remote tip"><X className="size-3.5" /></Button> : null}
    </div>
  )
}

export function RemoteUpdateAwarenessIncoming({ wsUrl, projectId }: { wsUrl: string; projectId: string }) {
  const [incoming, setIncoming] = useState<RemoteUpdateAwarenessIncomingInspection | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    void fetchRemoteUpdateAwarenessIncoming(wsUrl, projectId).then(
      (response) => { if (!cancelled) setIncoming(response.incoming) },
      (cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : 'Incoming details are unavailable.') },
    )
    return () => { cancelled = true }
  }, [projectId, wsUrl])
  if (error) return <div className="p-4 text-sm text-destructive">{error}</div>
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
