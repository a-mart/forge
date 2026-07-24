import { describe, expect, it } from 'vitest'
import { createInitialManagerWsState } from '@/lib/ws-state'
import { handleConfigEvent } from './config-event-handlers'

describe('remote update awareness WS state', () => {
  const snapshot = {
    projectId: 'project-1', override: 'inherit' as const, globalEnabled: true, effectiveEnabled: true,
    state: 'update_available' as const, lastObservedAt: null, failureCode: null, attentionRequired: true,
    dismissalTarget: { generation: 3 },
  }

  it('applies the active project projection and clears only its matching project', () => {
    let state = createInitialManagerWsState('agent-1')
    const updateState = (patch: Partial<typeof state>) => { state = { ...state, ...patch } }
    expect(handleConfigEvent({ type: 'remote_update_awareness_project_changed', snapshot }, { state, updateState, requestTracker: {} as never })).toBe(true)
    expect(state.remoteUpdateAwarenessSnapshot).toEqual(snapshot)

    handleConfigEvent({ type: 'remote_update_awareness_project_cleared', projectId: 'other-project' }, { state, updateState, requestTracker: {} as never })
    expect(state.remoteUpdateAwarenessSnapshot).toEqual(snapshot)

    handleConfigEvent({ type: 'remote_update_awareness_project_cleared', projectId: 'project-1' }, { state, updateState, requestTracker: {} as never })
    expect(state.remoteUpdateAwarenessSnapshot).toBeNull()
  })
})

describe('secure secret catalog invalidation', () => {
  it('keeps the newest catalog revision', () => {
    let state = createInitialManagerWsState('agent-1')
    const updateState = (patch: Partial<typeof state>) => { state = { ...state, ...patch } }
    const context = { state, updateState, requestTracker: {} as never }

    handleConfigEvent(
      { type: 'secure_secret_catalog_changed', revision: 4 },
      context,
    )
    expect(state.secureSecretCatalogRevision).toBe(4)

    handleConfigEvent(
      { type: 'secure_secret_catalog_changed', revision: 3 },
      { ...context, state },
    )
    expect(state.secureSecretCatalogRevision).toBe(4)
  })
})
