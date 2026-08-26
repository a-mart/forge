import { describe, expect, it, vi } from 'vitest'
import type { RemoteUpdateAwarenessProjectSnapshot } from '@forge/protocol'
import {
  dismissVisibleRemoteUpdateBanner,
  isVisibleDismissibleRemoteUpdateBanner,
} from './remote-update-awareness-dismiss'
import { createRemoteUpdateAwarenessMutationTarget } from './remote-update-awareness-mutation'

const api = vi.hoisted(() => ({
  dismissRemoteUpdateAwarenessProjectUpdate: vi.fn(),
}))

vi.mock('@/components/settings/remote-update-awareness-api', () => api)

const snapshot: RemoteUpdateAwarenessProjectSnapshot = {
  projectId: 'project-1',
  override: 'inherit',
  globalEnabled: true,
  effectiveEnabled: true,
  state: 'update_available',
  lastObservedAt: null,
  failureCode: null,
  attentionRequired: true,
  dismissalTarget: { generation: 7 },
}

describe('dismissVisibleRemoteUpdateBanner', () => {
  it('reuses exact-generation dismissal only for the visible advanced-branch banner', async () => {
    const dismissedSnapshot = { ...snapshot, attentionRequired: false }
    api.dismissRemoteUpdateAwarenessProjectUpdate.mockResolvedValue({ snapshot: dismissedSnapshot })

    expect(isVisibleDismissibleRemoteUpdateBanner(snapshot)).toBe(true)
    await expect(dismissVisibleRemoteUpdateBanner('ws://localhost:47188', snapshot, 4)).resolves.toEqual({
      snapshot: dismissedSnapshot,
      expectedTarget: createRemoteUpdateAwarenessMutationTarget(snapshot, 4),
    })
    expect(api.dismissRemoteUpdateAwarenessProjectUpdate).toHaveBeenCalledWith(
      'ws://localhost:47188',
      'project-1',
      7,
    )
  })

  it.each([
    ['already dismissed', { attentionRequired: false }],
    ['disabled', { effectiveEnabled: false }],
    ['stale', { state: 'stale' as const }],
    ['missing generation', { dismissalTarget: null }],
  ])('does not dismiss when the banner is not visible (%s)', async (_label, change) => {
    api.dismissRemoteUpdateAwarenessProjectUpdate.mockReset()
    const hidden = { ...snapshot, ...change }

    expect(isVisibleDismissibleRemoteUpdateBanner(hidden)).toBe(false)
    await expect(dismissVisibleRemoteUpdateBanner('ws://localhost:47188', hidden)).resolves.toBeNull()
    expect(api.dismissRemoteUpdateAwarenessProjectUpdate).not.toHaveBeenCalled()
  })
})
