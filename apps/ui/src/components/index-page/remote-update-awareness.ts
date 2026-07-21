import type { RemoteUpdateAwarenessProjectSnapshot } from '@forge/protocol'

/**
 * The local Builder only retains an awareness projection for its active local
 * project. Do not let a previous project or a remote-origin projection leak
 * into the current workspace.
 */
export function getActiveLocalRemoteUpdateSnapshot(
  snapshot: RemoteUpdateAwarenessProjectSnapshot | null,
  activeProjectId: string | null,
  isRemoteOriginActive: boolean,
  isCortexSession: boolean,
): RemoteUpdateAwarenessProjectSnapshot | null {
  if (
    isRemoteOriginActive ||
    isCortexSession ||
    !activeProjectId ||
    snapshot?.projectId !== activeProjectId
  ) {
    return null
  }

  return snapshot
}
