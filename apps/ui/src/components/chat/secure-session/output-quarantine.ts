import type { SecureSessionSnapshotView } from './types'

export type SecureOutputState = 'clear' | 'quarantined'

const QUARANTINED_OUTPUT_REASON =
  'Forge removed protected material before it reached the agent. The Secure Session remains active.'

type SecureOutputQuarantineSnapshot = Pick<
  SecureSessionSnapshotView,
  'sessionAgentId' | 'revision' | 'updatedAt' | 'outputState'
>

export interface SecureOutputQuarantineUi {
  eventKey: string | null
  outputState: SecureOutputState
  outputStateReason?: string
}

/**
 * One UI-visible quarantine event. Dismissing acknowledges this key only;
 * a later clear→quarantined transition or a new revision/updatedAt re-shows.
 */
export function secureOutputQuarantineEventKey(
  snapshot: SecureOutputQuarantineSnapshot | null | undefined,
  originId?: string,
): string | null {
  if (!snapshot || snapshot.outputState !== 'quarantined') return null
  return [
    originId ?? '',
    snapshot.sessionAgentId,
    String(snapshot.revision),
    snapshot.updatedAt,
  ].join('\u0000')
}

export function visibleSecureOutputState(
  outputState: SecureOutputState | undefined,
  eventKey: string | null,
  acknowledgedKey: string | null,
): SecureOutputState {
  if (outputState !== 'quarantined') return 'clear'
  if (eventKey !== null && eventKey === acknowledgedKey) return 'clear'
  return 'quarantined'
}

export function resolveSecureOutputQuarantineUi(options: {
  snapshot?: SecureSessionSnapshotView | null
  originId?: string
  acknowledgedKey: string | null
}): SecureOutputQuarantineUi {
  const eventKey = secureOutputQuarantineEventKey(options.snapshot, options.originId)
  const outputState = visibleSecureOutputState(
    options.snapshot?.outputState,
    eventKey,
    options.acknowledgedKey,
  )
  return {
    eventKey,
    outputState,
    ...(outputState === 'quarantined'
      ? { outputStateReason: QUARANTINED_OUTPUT_REASON }
      : {}),
  }
}

export function secureOutputQuarantineConfigFields(
  ui: SecureOutputQuarantineUi,
): {
  outputState: SecureOutputState
  outputStateReason?: string
} {
  return {
    outputState: ui.outputState,
    ...(ui.outputStateReason ? { outputStateReason: ui.outputStateReason } : {}),
  }
}
