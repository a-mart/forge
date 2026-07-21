import { describe, expect, it } from 'vitest'
import type { RemoteUpdateAwarenessProjectSnapshot } from '@forge/protocol'
import { getActiveLocalRemoteUpdateSnapshot } from './remote-update-awareness'

const snapshot: RemoteUpdateAwarenessProjectSnapshot = {
  projectId: 'project-a',
  override: 'inherit',
  globalEnabled: true,
  effectiveEnabled: true,
  state: 'update_available',
  lastObservedAt: null,
  failureCode: null,
  attentionRequired: true,
  dismissalTarget: { generation: 4 },
}

describe('getActiveLocalRemoteUpdateSnapshot', () => {
  it('keeps only the matching active local project projection', () => {
    expect(getActiveLocalRemoteUpdateSnapshot(snapshot, 'project-a', false, false)).toBe(snapshot)
    expect(getActiveLocalRemoteUpdateSnapshot(snapshot, 'project-b', false, false)).toBeNull()
    expect(getActiveLocalRemoteUpdateSnapshot(snapshot, null, false, false)).toBeNull()
  })

  it('never exposes remote-origin or Cortex-session attention in chat', () => {
    expect(getActiveLocalRemoteUpdateSnapshot(snapshot, 'project-a', true, false)).toBeNull()
    expect(getActiveLocalRemoteUpdateSnapshot(snapshot, 'project-a', false, true)).toBeNull()
  })
})
