import type { RemoteUpdateAwarenessProjectSnapshot } from '@forge/protocol'
import { dismissRemoteUpdateAwarenessProjectUpdate } from '@/components/settings/remote-update-awareness-api'
import {
  createRemoteUpdateAwarenessMutationTarget,
  type RemoteUpdateAwarenessMutationTarget,
} from './remote-update-awareness-mutation'

/**
 * True when Source Control is showing the dismissible
 * "The remote default branch has advanced." banner.
 */
export function isVisibleDismissibleRemoteUpdateBanner(
  snapshot: RemoteUpdateAwarenessProjectSnapshot | null | undefined,
): snapshot is RemoteUpdateAwarenessProjectSnapshot & {
  attentionRequired: true
  dismissalTarget: { generation: number }
} {
  return Boolean(
    snapshot?.effectiveEnabled &&
      snapshot.state === 'update_available' &&
      snapshot.attentionRequired &&
      snapshot.dismissalTarget,
  )
}

export async function dismissVisibleRemoteUpdateBanner(
  wsUrl: string,
  snapshot: RemoteUpdateAwarenessProjectSnapshot | null | undefined,
  requestId = 0,
): Promise<{
  snapshot: RemoteUpdateAwarenessProjectSnapshot
  expectedTarget: RemoteUpdateAwarenessMutationTarget
} | null> {
  if (!isVisibleDismissibleRemoteUpdateBanner(snapshot)) {
    return null
  }

  const expectedTarget = createRemoteUpdateAwarenessMutationTarget(snapshot, requestId)
  if (expectedTarget.generation == null) {
    return null
  }

  const response = await dismissRemoteUpdateAwarenessProjectUpdate(
    wsUrl,
    expectedTarget.projectId,
    expectedTarget.generation,
  )
  return { snapshot: response.snapshot, expectedTarget }
}
