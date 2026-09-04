import { describe, expect, it } from 'vitest'
import {
  resolveSecureOutputQuarantineUi,
  secureOutputQuarantineConfigFields,
  secureOutputQuarantineEventKey,
  visibleSecureOutputState,
} from './output-quarantine'
import type { SecureSessionSnapshotView } from './types'

function snapshot(
  overrides: Partial<SecureSessionSnapshotView> = {},
): SecureSessionSnapshotView {
  return {
    sessionAgentId: 'manager-1',
    principalKind: 'manager',
    revision: 6,
    executionMode: 'secure',
    environmentStatus: 'ready',
    outputState: 'quarantined',
    leases: [],
    pendingRequests: [],
    updatedAt: '2026-07-23T12:00:00.000Z',
    ...overrides,
  }
}

describe('secureOutputQuarantineEventKey', () => {
  it('is empty unless output is currently quarantined', () => {
    expect(secureOutputQuarantineEventKey(null)).toBeNull()
    expect(secureOutputQuarantineEventKey(snapshot({ outputState: 'clear' }))).toBeNull()
    expect(secureOutputQuarantineEventKey(snapshot())).toBe(
      ['', 'manager-1', '6', '2026-07-23T12:00:00.000Z'].join('\u0000'),
    )
  })

  it('changes when the session, revision, updatedAt, or origin changes', () => {
    const originA = secureOutputQuarantineEventKey(snapshot(), 'origin-a')
    expect(originA).not.toBe(secureOutputQuarantineEventKey(snapshot(), 'origin-b'))
    expect(originA).not.toBe(secureOutputQuarantineEventKey(snapshot({
      sessionAgentId: 'manager-2',
    }), 'origin-a'))
    expect(originA).not.toBe(secureOutputQuarantineEventKey(snapshot({
      revision: 7,
    }), 'origin-a'))
    expect(originA).not.toBe(secureOutputQuarantineEventKey(snapshot({
      updatedAt: '2026-07-23T12:01:00.000Z',
    }), 'origin-a'))
  })
})

describe('visibleSecureOutputState', () => {
  it('hides an acknowledged quarantine until a new event key arrives', () => {
    const key = secureOutputQuarantineEventKey(snapshot(), 'origin-a')
    expect(visibleSecureOutputState('quarantined', key, key)).toBe('clear')
    expect(visibleSecureOutputState(
      'quarantined',
      secureOutputQuarantineEventKey(snapshot({ revision: 7 }), 'origin-a'),
      key,
    )).toBe('quarantined')
  })

  it('re-shows after output clears and then quarantines again', () => {
    const first = snapshot({
      revision: 6,
      updatedAt: '2026-07-23T12:00:00.000Z',
    })
    const acknowledged = secureOutputQuarantineEventKey(first, 'origin-a')
    expect(visibleSecureOutputState(
      'clear',
      secureOutputQuarantineEventKey(snapshot({
        ...first,
        outputState: 'clear',
      }), 'origin-a'),
      acknowledged,
    )).toBe('clear')

    const next = snapshot({
      revision: 7,
      updatedAt: '2026-07-23T12:05:00.000Z',
    })
    expect(visibleSecureOutputState(
      'quarantined',
      secureOutputQuarantineEventKey(next, 'origin-a'),
      acknowledged,
    )).toBe('quarantined')
  })

  it('re-shows after a clear snapshot drops the acknowledged key', () => {
    const current = snapshot()
    const acknowledged = secureOutputQuarantineEventKey(current, 'origin-a')
    expect(visibleSecureOutputState('quarantined', acknowledged, acknowledged)).toBe('clear')
    expect(visibleSecureOutputState('quarantined', acknowledged, null)).toBe('quarantined')
  })
})

describe('resolveSecureOutputQuarantineUi', () => {
  it('masks a dismissed quarantine for both picker and request configs', () => {
    const current = snapshot()
    const acknowledged = secureOutputQuarantineEventKey(current, 'origin-a')
    expect(secureOutputQuarantineConfigFields(resolveSecureOutputQuarantineUi({
      snapshot: current,
      originId: 'origin-a',
      acknowledgedKey: acknowledged,
    }))).toEqual({ outputState: 'clear' })
  })

  it('re-shows a later quarantine on the same session', () => {
    const acknowledged = secureOutputQuarantineEventKey(snapshot(), 'origin-a')
    const ui = resolveSecureOutputQuarantineUi({
      snapshot: snapshot({
        revision: 8,
        updatedAt: '2026-07-23T12:10:00.000Z',
      }),
      originId: 'origin-a',
      acknowledgedKey: acknowledged,
    })
    expect(ui.outputState).toBe('quarantined')
    expect(ui.outputStateReason).toContain('Forge removed protected material')
    expect(secureOutputQuarantineConfigFields(ui).outputState).toBe('quarantined')
  })
})
