import { describe, expect, it } from 'vitest'
import type { RemoteUpdateAwarenessProjectSnapshot } from '@forge/protocol'
import {
  createRemoteUpdateAwarenessMutationTarget,
  remoteUpdateSnapshotMatchesTarget,
} from '@/components/diff-viewer/remote-update-awareness-mutation'
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

  it('requires the current projection to match the initiating project, generation, and version', () => {
    const target = createRemoteUpdateAwarenessMutationTarget(snapshot, 9)
    expect(remoteUpdateSnapshotMatchesTarget(snapshot, target)).toBe(true)
    expect(remoteUpdateSnapshotMatchesTarget({ ...snapshot, projectId: 'project-b' }, target)).toBe(false)
    expect(remoteUpdateSnapshotMatchesTarget({
      ...snapshot,
      dismissalTarget: { generation: 5 },
    }, target)).toBe(false)
  })

  it.each([
    ['state', { state: 'error' as const }],
    ['observation time', { lastObservedAt: '2026-07-21T12:00:00.000Z' }],
    ['attention eligibility', { attentionRequired: false }],
    ['effective enablement', { effectiveEnabled: false }],
  ])('does not treat null generation as a sufficient version when %s changes', (_label, change) => {
    const nullGenerationSnapshot = { ...snapshot, dismissalTarget: null }
    const target = createRemoteUpdateAwarenessMutationTarget(nullGenerationSnapshot, 10)

    expect(remoteUpdateSnapshotMatchesTarget({ ...nullGenerationSnapshot, ...change }, target)).toBe(false)
  })
})
