type SyntheticModifiers = {
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

export type SyntheticTrustedEventSignature =
  | (SyntheticModifiers & {
      kind: 'pointer'
      phase: 'pointermove' | 'pointerdown' | 'pointerup'
      clientX: number
      clientY: number
      button: number
      buttons: number
      pointerType: string
      isPrimary: boolean
    })
  | (SyntheticModifiers & {
      kind: 'key'
      phase: 'keydown' | 'keyup'
      key: string
      code: string
      location: number
      repeat: boolean
    })
  | (SyntheticModifiers & {
      kind: 'wheel'
      phase: 'wheel'
      clientX: number
      clientY: number
      deltaX: number
      deltaY: number
      deltaZ: number
      deltaMode: number
    })
  | (SyntheticModifiers & {
      kind: 'touch'
      phase: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel'
      touches: SyntheticTouchPoint[]
      changedTouches: SyntheticTouchPoint[]
    })

export interface SyntheticTouchPoint {
  identifier: number
  clientX: number
  clientY: number
  radiusX: number
  radiusY: number
  rotationAngle: number
  force: number
}

export interface TrustedEventLike {
  type: string
  isTrusted: boolean
  [key: string]: unknown
}

export type TrustedInputDisposition = 'ignored' | 'synthetic' | 'interrupted'

export const TRUSTED_INPUT_EVENT_NAMES = [
  'pointermove', 'pointerdown', 'pointerup',
  'keydown', 'keyup',
  'wheel',
  'touchstart', 'touchmove', 'touchend', 'touchcancel',
] as const

const HUMAN_INTERRUPTION_START_EVENTS = new Set<string>(['pointerdown', 'keydown', 'wheel', 'touchstart'])

interface TrustedInputEventTarget {
  addEventListener(type: string, listener: (event: Event) => void, options?: AddEventListenerOptions | boolean): void
  removeEventListener(type: string, listener: (event: Event) => void, options?: EventListenerOptions | boolean): void
}

/** Installs the exact listener set used by each singleton content bridge. */
export function installExactTrustedInputListeners(
  target: TrustedInputEventTarget,
  guard: ExactSyntheticInputGuard,
  onInterruption: (event: Event) => void,
): () => void {
  const listener = (event: Event): void => {
    if (guard.observe(event) === 'interrupted') onInterruption(event)
  }
  for (const eventName of TRUSTED_INPUT_EVENT_NAMES) target.addEventListener(eventName, listener, { capture: true, passive: true })
  return () => {
    for (const eventName of TRUSTED_INPUT_EVENT_NAMES) target.removeEventListener(eventName, listener, { capture: true })
  }
}

/**
 * A content-document guard for one exact CDP input sequence. There is no time blanket: each
 * trusted DOM event must equal and consume the next expected signature. A mismatch or interleaved
 * physical event immediately ends suppression and transfers control to the human.
 */
export class ExactSyntheticInputGuard {
  private operationId: string | null = null
  private controlEpoch = 0
  private expected: SyntheticTrustedEventSignature[] = []

  start(operationId: string, controlEpoch: number, expected: SyntheticTrustedEventSignature[]): void {
    this.operationId = operationId
    this.controlEpoch = controlEpoch
    this.expected = expected.map((signature) => structuredClone(signature))
  }

  end(operationId: string, controlEpoch: number): boolean {
    if (this.operationId !== operationId || this.controlEpoch !== controlEpoch) return false
    this.clear()
    return true
  }

  clear(): void {
    this.operationId = null
    this.expected = []
  }

  observe(event: Event | TrustedEventLike): TrustedInputDisposition {
    const observed = event as unknown as TrustedEventLike
    if (observed.isTrusted !== true) return 'ignored'
    if (this.operationId === null) {
      // Observe every phase while synthetic input is active, but preserve the deliberate human
      // gesture sentinels while idle so ordinary pointer movement/key release does not churn epochs.
      return HUMAN_INTERRUPTION_START_EVENTS.has(observed.type) ? 'interrupted' : 'ignored'
    }
    const expected = this.expected[0]
    if (expected !== undefined && syntheticEventMatches(expected, observed)) {
      this.expected.shift()
      return 'synthetic'
    }
    // Physical pointer movement is collaborative presence, not a takeover. It neither consumes
    // nor clears the exact synthetic sequence; the next trusted click/key/wheel/touch phase still
    // has to match exactly or invalidate the operation epoch.
    if (observed.type === 'pointermove') return 'ignored'
    this.clear()
    return 'interrupted'
  }
}

export function parseSyntheticTrustedEventSequence(value: unknown): SyntheticTrustedEventSignature[] | null {
  if (!Array.isArray(value) || value.length > 16) return null
  const parsed: SyntheticTrustedEventSignature[] = []
  for (const candidate of value) {
    if (!validSyntheticSignature(candidate)) return null
    parsed.push(structuredClone(candidate))
  }
  return parsed
}

export function syntheticEventMatches(expected: SyntheticTrustedEventSignature, event: TrustedEventLike): boolean {
  if (event.type !== expected.phase || !matchesModifiers(expected, event)) return false
  if (expected.kind === 'pointer') {
    return finiteEqual(event.clientX, expected.clientX) && finiteEqual(event.clientY, expected.clientY) &&
      event.button === expected.button && event.buttons === expected.buttons && event.pointerType === expected.pointerType &&
      event.isPrimary === expected.isPrimary
  }
  if (expected.kind === 'key') {
    return event.key === expected.key && event.code === expected.code && event.location === expected.location && event.repeat === expected.repeat
  }
  if (expected.kind === 'wheel') {
    return finiteEqual(event.clientX, expected.clientX) && finiteEqual(event.clientY, expected.clientY) &&
      finiteEqual(event.deltaX, expected.deltaX) && finiteEqual(event.deltaY, expected.deltaY) &&
      finiteEqual(event.deltaZ, expected.deltaZ) && event.deltaMode === expected.deltaMode
  }
  return touchListMatches(event.touches, expected.touches) && touchListMatches(event.changedTouches, expected.changedTouches)
}

function validSyntheticSignature(value: unknown): value is SyntheticTrustedEventSignature {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const signature = value as Record<string, unknown>
  const modifiers = ['altKey', 'ctrlKey', 'metaKey', 'shiftKey'].every((key) => typeof signature[key] === 'boolean')
  if (!modifiers) return false
  if (signature.kind === 'pointer') {
    return ['pointermove', 'pointerdown', 'pointerup'].includes(String(signature.phase)) &&
      finite(signature.clientX) && finite(signature.clientY) && Number.isSafeInteger(signature.button) &&
      Number.isSafeInteger(signature.buttons) && typeof signature.pointerType === 'string' && signature.pointerType.length <= 32 &&
      typeof signature.isPrimary === 'boolean' && exactKeys(signature, [
        'kind', 'phase', 'clientX', 'clientY', 'button', 'buttons', 'pointerType', 'isPrimary',
        'altKey', 'ctrlKey', 'metaKey', 'shiftKey',
      ])
  }
  if (signature.kind === 'key') {
    return ['keydown', 'keyup'].includes(String(signature.phase)) && typeof signature.key === 'string' && signature.key.length <= 128 &&
      typeof signature.code === 'string' && signature.code.length <= 128 && Number.isSafeInteger(signature.location) &&
      typeof signature.repeat === 'boolean' && exactKeys(signature, [
        'kind', 'phase', 'key', 'code', 'location', 'repeat', 'altKey', 'ctrlKey', 'metaKey', 'shiftKey',
      ])
  }
  if (signature.kind === 'wheel') {
    return signature.phase === 'wheel' && finite(signature.clientX) && finite(signature.clientY) && finite(signature.deltaX) &&
      finite(signature.deltaY) && finite(signature.deltaZ) && Number.isSafeInteger(signature.deltaMode) && exactKeys(signature, [
        'kind', 'phase', 'clientX', 'clientY', 'deltaX', 'deltaY', 'deltaZ', 'deltaMode',
        'altKey', 'ctrlKey', 'metaKey', 'shiftKey',
      ])
  }
  if (signature.kind === 'touch') {
    return ['touchstart', 'touchmove', 'touchend', 'touchcancel'].includes(String(signature.phase)) &&
      validTouchList(signature.touches) && validTouchList(signature.changedTouches) && exactKeys(signature, [
        'kind', 'phase', 'touches', 'changedTouches', 'altKey', 'ctrlKey', 'metaKey', 'shiftKey',
      ])
  }
  return false
}

function matchesModifiers(expected: SyntheticModifiers, event: TrustedEventLike): boolean {
  return event.altKey === expected.altKey && event.ctrlKey === expected.ctrlKey &&
    event.metaKey === expected.metaKey && event.shiftKey === expected.shiftKey
}

function validTouchList(value: unknown): value is SyntheticTouchPoint[] {
  return Array.isArray(value) && value.length <= 16 && value.every((touch) => {
    if (typeof touch !== 'object' || touch === null || Array.isArray(touch)) return false
    const point = touch as Record<string, unknown>
    return Number.isSafeInteger(point.identifier) && finite(point.clientX) && finite(point.clientY) && finite(point.radiusX) &&
      finite(point.radiusY) && finite(point.rotationAngle) && finite(point.force) && exactKeys(point, [
        'identifier', 'clientX', 'clientY', 'radiusX', 'radiusY', 'rotationAngle', 'force',
      ])
  })
}

function touchListMatches(value: unknown, expected: SyntheticTouchPoint[]): boolean {
  if (typeof value !== 'object' || value === null || !('length' in value) || (value as { length?: unknown }).length !== expected.length) return false
  const list = value as { [index: number]: Record<string, unknown> | undefined; length: number }
  return expected.every((point, index) => {
    const actual = list[index]
    return actual !== undefined && actual.identifier === point.identifier && finiteEqual(actual.clientX, point.clientX) &&
      finiteEqual(actual.clientY, point.clientY) && finiteEqual(actual.radiusX ?? 0, point.radiusX) &&
      finiteEqual(actual.radiusY ?? 0, point.radiusY) && finiteEqual(actual.rotationAngle ?? 0, point.rotationAngle) &&
      finiteEqual(actual.force ?? 0, point.force)
  })
}

function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) }
function finiteEqual(value: unknown, expected: number): boolean { return finite(value) && value === expected }
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',')
}

export interface SyntheticInputOperation {
  leaseId: string
  leaseEpoch: number
  tabId: number
  method: 'Input.dispatchMouseEvent' | 'Input.dispatchKeyEvent' | 'Input.insertText' | 'Input.dispatchTouchEvent'
  params: Record<string, unknown>
}

export interface SyntheticInputHooks {
  beginAgentControl(operation: SyntheticInputOperation): Promise<number>
  signalStart(operation: SyntheticInputOperation, operationId: string, controlEpoch: number): Promise<{ operationId: string; controlEpoch: number }>
  isCurrent(operation: SyntheticInputOperation, controlEpoch: number): boolean
  sendCdpInput(operation: SyntheticInputOperation): Promise<unknown>
  signalEnd(operation: SyntheticInputOperation, operationId: string, controlEpoch: number): Promise<void> | void
  randomId(): string
}

/**
 * The input primitive does not claim a protocol operation implementation. It brackets the existing
 * CDP Input seam with content-script acknowledgement and lease/control-epoch checks so stale or
 * unmatched trusted input cannot be mistaken for the agent's own sequence.
 */
export class SyntheticInputSequencer {
  constructor(private readonly hooks: SyntheticInputHooks) {}

  async run(operation: SyntheticInputOperation): Promise<unknown> {
    const controlEpoch = await this.hooks.beginAgentControl(operation)
    const operationId = this.hooks.randomId()
    try {
      const acknowledgement = await this.hooks.signalStart(operation, operationId, controlEpoch)
      if (acknowledgement.operationId !== operationId || acknowledgement.controlEpoch !== controlEpoch ||
          !this.hooks.isCurrent(operation, controlEpoch)) {
        throw new Error('synthetic input acknowledgement is stale')
      }
      const result = await this.hooks.sendCdpInput(operation)
      if (!this.hooks.isCurrent(operation, controlEpoch)) throw new Error('synthetic input was interrupted by trusted human control')
      return result
    } finally {
      await this.hooks.signalEnd(operation, operationId, controlEpoch)
    }
  }
}
