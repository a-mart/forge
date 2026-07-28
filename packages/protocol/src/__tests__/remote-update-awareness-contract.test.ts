import { describe, expect, expectTypeOf, it } from 'vitest'

import { REMOTE_UPDATE_AWARENESS_PROJECT_STATES } from '../index.js'
import type {
  ActivateRemoteUpdateAwarenessProjectRequest,
  DismissRemoteUpdateAwarenessProjectUpdateRequest,
  GetRemoteUpdateAwarenessIncomingRequest,
  GetRemoteUpdateAwarenessIncomingResponse,
  RefreshRemoteUpdateAwarenessProjectRequest,
  RemoteUpdateAwarenessIncomingInspection,
  RemoteUpdateAwarenessProjectChangedEvent,
  RemoteUpdateAwarenessProjectClearedEvent,
  RemoteUpdateAwarenessProjectSnapshot,
  RemoteUpdateAwarenessProjectState,
  ServerEvent,
  UpdateRemoteUpdateAwarenessProjectOverrideRequest,
  UpdateRemoteUpdateAwarenessSettingsRequest,
} from '../index.js'

const snapshot = {
  projectId: 'project-1',
  override: 'inherit',
  globalEnabled: false,
  effectiveEnabled: false,
  state: 'unobserved',
  lastObservedAt: null,
  failureCode: null,
  attentionRequired: false,
  dismissalTarget: null,
} satisfies RemoteUpdateAwarenessProjectSnapshot

const fullObservedTipOid = 'a'.repeat(40)

const incoming = {
  projectId: 'project-1',
  remoteDisplayName: 'origin',
  defaultBranchDisplay: 'main',
  observedTipOid: fullObservedTipOid,
  generation: 7,
  observedAt: '2026-07-20T12:00:00.000Z',
  freshnessCheckedAt: '2026-07-20T12:01:00.000Z',
  staleAfter: '2026-07-20T12:06:00.000Z',
  state: 'update_available',
  failureCode: null,
  attentionRequired: true,
  commits: {
    commitCount: 2,
    commitLimit: 20,
    hasMore: false,
    commits: [
      { subject: 'Add safe Incoming inspection', committedAt: '2026-07-20T11:58:00.000Z' },
      { subject: 'Document remote awareness', committedAt: '2026-07-20T11:57:00.000Z' },
    ],
  },
  fileChanges: {
    changedFileCount: 3,
    changedFileCountLimit: 100,
    hasMore: false,
    addedCount: 1,
    modifiedCount: 1,
    deletedCount: 1,
    renamedCount: 0,
  },
} satisfies RemoteUpdateAwarenessIncomingInspection

describe('remote update awareness protocol contract', () => {
  it('models the local global master and local per-project overrides', () => {
    const global: UpdateRemoteUpdateAwarenessSettingsRequest = { globalEnabled: true }
    const inherit: UpdateRemoteUpdateAwarenessProjectOverrideRequest = {
      projectId: 'project-1',
      override: 'inherit',
    }
    const on: UpdateRemoteUpdateAwarenessProjectOverrideRequest = {
      projectId: 'project-1',
      override: 'on',
    }
    const off: UpdateRemoteUpdateAwarenessProjectOverrideRequest = {
      projectId: 'project-1',
      override: 'off',
    }
    const wire = JSON.parse(JSON.stringify({ global, inherit, on, off })) as {
      global: UpdateRemoteUpdateAwarenessSettingsRequest
      inherit: UpdateRemoteUpdateAwarenessProjectOverrideRequest
      on: UpdateRemoteUpdateAwarenessProjectOverrideRequest
      off: UpdateRemoteUpdateAwarenessProjectOverrideRequest
    }

    expect(wire.global.globalEnabled).toBe(true)
    expect([wire.inherit.override, wire.on.override, wire.off.override]).toEqual(['inherit', 'on', 'off'])
    expect(snapshot.globalEnabled).toBe(false)
    expect(snapshot.effectiveEnabled).toBe(false)
  })

  it('keeps observation truth and its exact dismissal target after dismissal', () => {
    const observed = {
      ...snapshot,
      globalEnabled: true,
      effectiveEnabled: true,
      state: 'update_available',
      lastObservedAt: '2026-07-20T12:00:00.000Z',
      attentionRequired: true,
      dismissalTarget: { generation: 7 },
    } satisfies RemoteUpdateAwarenessProjectSnapshot
    const dismiss = {
      projectId: observed.projectId,
      dismissalTarget: observed.dismissalTarget,
    } satisfies DismissRemoteUpdateAwarenessProjectUpdateRequest
    const dismissed = {
      ...observed,
      attentionRequired: false,
    } satisfies RemoteUpdateAwarenessProjectSnapshot

    expect(dismiss.dismissalTarget.generation).toBe(7)
    expect(dismissed.state).toBe('update_available')
    expect(dismissed.attentionRequired).toBe(false)
    expect(dismissed.dismissalTarget).toEqual({ generation: 7 })
  })

  it('carries exact, bounded Incoming evidence without server-local or sensitive fields', () => {
    const request = { projectId: incoming.projectId } satisfies GetRemoteUpdateAwarenessIncomingRequest
    const response = { incoming } satisfies GetRemoteUpdateAwarenessIncomingResponse

    expect(request.projectId).toBe('project-1')
    expect(response.incoming.observedTipOid).toBe(fullObservedTipOid)
    expect(response.incoming.observedTipOid).toHaveLength(40)
    expect(response.incoming.generation).toBe(7)
    expect(response.incoming.commits.commitCount).toBeLessThanOrEqual(response.incoming.commits.commitLimit)
    expect(response.incoming.commits.commits).toHaveLength(response.incoming.commits.commitCount)
    expect(response.incoming.fileChanges?.changedFileCount).toBeLessThanOrEqual(
      response.incoming.fileChanges?.changedFileCountLimit ?? 0,
    )
    expect(Object.keys(response.incoming)).not.toEqual(expect.arrayContaining([
      'repositoryPath',
      'path',
      'remoteUrl',
      'credentials',
      'commandOutput',
      'monitorKey',
      'viewerId',
    ]))
    expect(Object.keys(response.incoming.commits.commits[0] ?? {})).not.toEqual(expect.arrayContaining([
      'author',
      'body',
      'path',
      'commandOutput',
    ]))
  })

  it('defines local activation and manual refresh requests by project identity only', () => {
    const activate = { projectId: 'project-1' } satisfies ActivateRemoteUpdateAwarenessProjectRequest
    const refresh = { projectId: 'project-1' } satisfies RefreshRemoteUpdateAwarenessProjectRequest

    expect(activate).toEqual(refresh)
  })

  it('exports changed and cleared projections through ServerEvent', () => {
    const changed = {
      type: 'remote_update_awareness_project_changed',
      snapshot,
    } satisfies RemoteUpdateAwarenessProjectChangedEvent
    const cleared = {
      type: 'remote_update_awareness_project_cleared',
      projectId: snapshot.projectId,
    } satisfies RemoteUpdateAwarenessProjectClearedEvent

    const events = [changed, cleared] satisfies readonly ServerEvent[]
    expect(events.map((event) => event.type)).toEqual([
      'remote_update_awareness_project_changed',
      'remote_update_awareness_project_cleared',
    ])
  })

  it('pins the exhaustive sanitized state vocabulary', () => {
    const states: readonly RemoteUpdateAwarenessProjectState[] = REMOTE_UPDATE_AWARENESS_PROJECT_STATES

    expectTypeOf<Exclude<RemoteUpdateAwarenessProjectState, (typeof states)[number]>>().toEqualTypeOf<never>()
    expectTypeOf<Exclude<(typeof states)[number], RemoteUpdateAwarenessProjectState>>().toEqualTypeOf<never>()
    expect(states).toHaveLength(15)
    expect(states).toEqual(expect.arrayContaining(['update_available', 'rewound', 'missing', 'detached', 'stale']))
    expect(JSON.parse(JSON.stringify(REMOTE_UPDATE_AWARENESS_PROJECT_STATES))).toEqual(states)
  })
})
