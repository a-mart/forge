import { describe, expect, it } from 'vitest'
import { SyntheticInputSequencer, isTrustedHumanInterruption, type SyntheticInputOperation } from '../src/runtime/human-control.js'

describe('trusted human control interruption', () => {
  it('interrupts trusted input outside an active synthetic sequence', () => {
    expect(isTrustedHumanInterruption({ isTrusted: true, observedAt: 101, syntheticUntil: 100 })).toBe(true)
  })

  it('does not let untrusted page events or correlated CDP input interrupt itself', () => {
    expect(isTrustedHumanInterruption({ isTrusted: false, observedAt: 101, syntheticUntil: 0 })).toBe(false)
    expect(isTrustedHumanInterruption({ isTrusted: true, observedAt: 99, syntheticUntil: 100 })).toBe(false)
    expect(isTrustedHumanInterruption({ isTrusted: true, observedAt: 100, syntheticUntil: 100 })).toBe(false)
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
