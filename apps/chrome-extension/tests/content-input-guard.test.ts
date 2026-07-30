import { describe, expect, it } from 'vitest'
import {
  ExactSyntheticInputGuard,
  installExactTrustedInputListeners,
  type SyntheticTrustedEventSignature,
  type TrustedEventLike,
} from '../src/runtime/human-control.js'

class TrustedEventTargetFixture {
  private readonly listeners = new Map<string, Set<(event: Event) => void>>()

  addEventListener(type: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  dispatch(event: TrustedEventLike): void {
    for (const listener of this.listeners.get(event.type) ?? []) listener(event as unknown as Event)
  }
}

const noModifiers = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }
const pointerSequence: SyntheticTrustedEventSignature[] = [
  {
    kind: 'pointer', phase: 'pointermove', clientX: 20, clientY: 30, button: -1, buttons: 0,
    pointerType: 'mouse', isPrimary: true, ...noModifiers,
  },
  {
    kind: 'pointer', phase: 'pointerdown', clientX: 20, clientY: 30, button: 0, buttons: 1,
    pointerType: 'mouse', isPrimary: true, ...noModifiers,
  },
  {
    kind: 'pointer', phase: 'pointerup', clientX: 20, clientY: 30, button: 0, buttons: 0,
    pointerType: 'mouse', isPrimary: true, ...noModifiers,
  },
]

function event(signature: SyntheticTrustedEventSignature, overrides: Record<string, unknown> = {}): TrustedEventLike {
  return { ...signature, type: signature.phase, isTrusted: true, ...overrides }
}

describe('singleton content-bridge trusted-input listeners', () => {
  it('dispatches an exact trusted pointer phase sequence without suppressing any extra event', () => {
    const target = new TrustedEventTargetFixture()
    const guard = new ExactSyntheticInputGuard()
    const interrupted: string[] = []
    const dispose = installExactTrustedInputListeners(target, guard, (input) => interrupted.push(input.type))
    guard.start('pointer-operation', 1, pointerSequence)

    for (const signature of pointerSequence) target.dispatch(event(signature))
    expect(interrupted).toEqual([])

    target.dispatch(event(pointerSequence[1]!))
    expect(interrupted).toEqual(['pointerdown'])
    dispose()
  })

  it('interrupts immediately on coordinate/button mismatch and trusted interleaving', () => {
    const target = new TrustedEventTargetFixture()
    const guard = new ExactSyntheticInputGuard()
    const interrupted: string[] = []
    installExactTrustedInputListeners(target, guard, (input) => interrupted.push(input.type))

    guard.start('coordinate-mismatch', 2, pointerSequence)
    target.dispatch(event(pointerSequence[0]!, { clientX: 21 }))
    expect(interrupted).toEqual(['pointermove'])

    guard.start('interleaved-key', 3, pointerSequence)
    target.dispatch({
      type: 'keydown', isTrusted: true, key: 'x', code: 'KeyX', location: 0, repeat: false, ...noModifiers,
    })
    expect(interrupted).toEqual(['pointermove', 'keydown'])
  })

  it('matches key modifiers plus wheel and touch fields exactly while ignoring untrusted page events', () => {
    const target = new TrustedEventTargetFixture()
    const guard = new ExactSyntheticInputGuard()
    const interrupted: string[] = []
    installExactTrustedInputListeners(target, guard, (input) => interrupted.push(input.type))
    const touch = {
      identifier: 7, clientX: 5, clientY: 6, radiusX: 1, radiusY: 2, rotationAngle: 0, force: 0.5,
    }
    const sequence: SyntheticTrustedEventSignature[] = [
      {
        kind: 'key', phase: 'keydown', key: 'A', code: 'KeyA', location: 0, repeat: false,
        altKey: false, ctrlKey: true, metaKey: false, shiftKey: true,
      },
      {
        kind: 'wheel', phase: 'wheel', clientX: 9, clientY: 10, deltaX: 1, deltaY: 2, deltaZ: 0,
        deltaMode: 0, ...noModifiers,
      },
      {
        kind: 'touch', phase: 'touchstart', touches: [touch], changedTouches: [touch], ...noModifiers,
      },
    ]
    guard.start('mixed-operation', 4, sequence)

    target.dispatch(event(sequence[0]!, { isTrusted: false, ctrlKey: false }))
    target.dispatch(event(sequence[0]!))
    target.dispatch(event(sequence[1]!))
    target.dispatch(event(sequence[2]!))
    expect(interrupted).toEqual([])

    guard.start('modifier-mismatch', 5, [sequence[0]!])
    target.dispatch(event(sequence[0]!, { shiftKey: false }))
    expect(interrupted).toEqual(['keydown'])
  })
})
