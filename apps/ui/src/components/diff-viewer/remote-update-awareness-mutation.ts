import type { RemoteUpdateAwarenessProjectSnapshot } from '@forge/protocol'

export interface RemoteUpdateAwarenessMutationTarget {
  projectId: string
  generation: number | null
  projectionFingerprint: string
  requestId: number
}

export function remoteUpdateAwarenessProjectionFingerprint(
  snapshot: RemoteUpdateAwarenessProjectSnapshot,
): string {
  return JSON.stringify([
    snapshot.projectId,
    snapshot.dismissalTarget?.generation ?? null,
    snapshot.override,
    snapshot.globalEnabled,
    snapshot.effectiveEnabled,
    snapshot.state,
    snapshot.lastObservedAt ?? null,
    snapshot.failureCode,
    snapshot.attentionRequired,
  ])
}

export function createRemoteUpdateAwarenessMutationTarget(
  snapshot: RemoteUpdateAwarenessProjectSnapshot,
  requestId: number,
): RemoteUpdateAwarenessMutationTarget {
  return {
    projectId: snapshot.projectId,
    generation: snapshot.dismissalTarget?.generation ?? null,
    projectionFingerprint: remoteUpdateAwarenessProjectionFingerprint(snapshot),
    requestId,
  }
}

export type RemoteUpdateAwarenessSnapshotChange = (
  snapshot: RemoteUpdateAwarenessProjectSnapshot,
  expectedTarget?: RemoteUpdateAwarenessMutationTarget,
) => void

export function remoteUpdateSnapshotMatchesTarget(
  snapshot: RemoteUpdateAwarenessProjectSnapshot | null,
  target: RemoteUpdateAwarenessMutationTarget,
): boolean {
  return Boolean(
    snapshot &&
      snapshot.projectId === target.projectId &&
      (snapshot.dismissalTarget?.generation ?? null) === target.generation &&
      remoteUpdateAwarenessProjectionFingerprint(snapshot) === target.projectionFingerprint,
  )
}
