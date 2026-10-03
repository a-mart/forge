import { describe, expect, it } from 'vitest'
import {
  ExactSyntheticInputGuard,
  parseSyntheticTrustedEventSequence,
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
})
