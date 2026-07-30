import { describe, expect, it } from 'vitest'
import {
  ExactSyntheticInputGuard,
  SyntheticInputSequencer,
  parseSyntheticTrustedEventSequence,
  type SyntheticInputOperation,
  type SyntheticTrustedEventSignature,
} from '../src/runtime/human-control.js'

const pointerDown: SyntheticTrustedEventSignature = {
  kind: 'pointer', phase: 'pointerdown', clientX: 12, clientY: 34, button: 0, buttons: 1,
  pointerType: 'mouse', isPrimary: true, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false,
}
const pointerMove: SyntheticTrustedEventSignature = {
  ...pointerDown, phase: 'pointermove', button: -1, buttons: 0,
}

describe('trusted human control interruption', () => {
  it('interrupts trusted gesture starts while idle without treating ordinary movement as a new gesture', () => {
    const guard = new ExactSyntheticInputGuard()
    expect(guard.observe({ ...pointerDown, type: pointerDown.phase, isTrusted: true })).toBe('interrupted')
    expect(guard.observe({ ...pointerDown, type: 'pointermove', isTrusted: true })).toBe('ignored')
    expect(guard.observe({ ...pointerDown, type: pointerDown.phase, isTrusted: false })).toBe('ignored')
  })

  it('consumes only a validated exact ordered synthetic signature and interrupts mismatches or interleaving', () => {
    expect(parseSyntheticTrustedEventSequence([pointerDown])).toEqual([pointerDown])
    expect(parseSyntheticTrustedEventSequence([{ ...pointerDown, extra: true }])).toBeNull()
    const guard = new ExactSyntheticInputGuard()
    guard.start('operation-1', 4, [pointerDown])
    expect(guard.observe({ ...pointerDown, type: pointerDown.phase, isTrusted: false })).toBe('ignored')
    expect(guard.observe({ ...pointerMove, clientX: 99, type: pointerMove.phase, isTrusted: true })).toBe('interrupted')

    guard.start('exact-pointer-move', 5, [pointerMove, pointerDown])
    expect(guard.observe({ ...pointerMove, type: pointerMove.phase, isTrusted: true })).toBe('synthetic')
    expect(guard.observe({ ...pointerDown, type: pointerDown.phase, isTrusted: true })).toBe('synthetic')
    expect(guard.observe({ ...pointerDown, type: pointerDown.phase, isTrusted: true })).toBe('interrupted')

    guard.start('operation-2', 6, [pointerDown])
    expect(guard.observe({ ...pointerDown, clientX: 13, type: pointerDown.phase, isTrusted: true })).toBe('interrupted')

    guard.start('operation-3', 7, [pointerDown])
    expect(guard.observe({
      type: 'keydown', isTrusted: true, key: 'x', code: 'KeyX', location: 0, repeat: false,
      altKey: false, ctrlKey: false, metaKey: false, shiftKey: false,
    })).toBe('interrupted')
  })

  it('requires a matching acknowledgement/epoch around the CDP input seam', async () => {
    const events: string[] = []
    let current = true
    const operation: SyntheticInputOperation = {
      leaseId: 'lease', leaseEpoch: 1, tabId: 3, method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: 1, y: 2 },
    }
    const sequencer = new SyntheticInputSequencer({
      beginAgentControl: async () => { events.push('begin'); return 4 },
      signalStart: async (_operation, operationId, controlEpoch) => { events.push(`start:${operationId}:${controlEpoch}`); return { operationId, controlEpoch } },
      isCurrent: () => current,
      sendCdpInput: async () => { events.push('cdp'); return { accepted: true } },
      signalEnd: (_operation, operationId, controlEpoch) => { events.push(`end:${operationId}:${controlEpoch}`) },
      randomId: () => 'operation-1',
    })
    await expect(sequencer.run(operation)).resolves.toEqual({ accepted: true })
    expect(events).toEqual(['begin', 'start:operation-1:4', 'cdp', 'end:operation-1:4'])

    const stale = new SyntheticInputSequencer({
      beginAgentControl: async () => 5,
      signalStart: async () => ({ operationId: 'other-operation', controlEpoch: 5 }),
      isCurrent: () => true,
      sendCdpInput: async () => { throw new Error('must not send') },
      signalEnd: () => { events.push('stale-end') },
      randomId: () => 'operation-2',
    })
    await expect(stale.run(operation)).rejects.toThrow('acknowledgement is stale')
    expect(events).toContain('stale-end')

    const interrupted = new SyntheticInputSequencer({
      beginAgentControl: async () => 6,
      signalStart: async (_operation, operationId, controlEpoch) => ({ operationId, controlEpoch }),
      isCurrent: () => current,
      sendCdpInput: async () => { current = false },
      signalEnd: () => undefined,
      randomId: () => 'operation-3',
    })
    current = true
    await expect(interrupted.run(operation)).rejects.toThrow('interrupted by trusted human control')
  })
})
