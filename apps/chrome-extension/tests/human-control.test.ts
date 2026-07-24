import { describe, expect, it } from 'vitest'
import { isTrustedHumanInterruption } from '../src/runtime/human-control.js'

describe('trusted human control interruption', () => {
  it('interrupts trusted input outside an active synthetic sequence', () => {
    expect(isTrustedHumanInterruption({ isTrusted: true, observedAt: 101, syntheticUntil: 100 })).toBe(true)
  })

  it('does not let untrusted page events or correlated CDP input interrupt itself', () => {
    expect(isTrustedHumanInterruption({ isTrusted: false, observedAt: 101, syntheticUntil: 0 })).toBe(false)
    expect(isTrustedHumanInterruption({ isTrusted: true, observedAt: 99, syntheticUntil: 100 })).toBe(false)
    expect(isTrustedHumanInterruption({ isTrusted: true, observedAt: 100, syntheticUntil: 100 })).toBe(false)
  })
})
