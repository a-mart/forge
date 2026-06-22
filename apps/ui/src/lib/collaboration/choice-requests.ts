import type { ChoiceRequestStatus } from '@forge/protocol'
import type { CollabChoiceRequest } from '../collab-ws-state'

/** Matches subscribe replay limits in collaboration WS bootstrap. */
export const COLLAB_NON_PENDING_CHOICE_CAP = 200

const TERMINAL_STATUSES = new Set<ChoiceRequestStatus>(['answered', 'cancelled', 'expired'])

function isTerminalStatus(status: ChoiceRequestStatus): boolean {
  return TERMINAL_STATUSES.has(status)
}

function parseTimestamp(timestamp: string): number {
  const parsed = new Date(timestamp).getTime()
  return Number.isNaN(parsed) ? 0 : parsed
}

function minTimestamp(a: string, b: string): string {
  return parseTimestamp(a) <= parseTimestamp(b) ? a : b;
}

function pruneNonPendingRows(
  rows: CollabChoiceRequest[],
  maxNonPending: number,
): CollabChoiceRequest[] {
  const pendingRows = rows.filter((row) => row.status === 'pending')
  const nonPendingRows = rows.filter((row) => row.status !== 'pending')

  if (nonPendingRows.length <= maxNonPending) {
    return rows
  }

  // Keep all pending rows plus the newest completed rows; adapter sorting restores chronology.
  const keptNonPending = [...nonPendingRows]
    .sort((a, b) => parseTimestamp(b.timestamp) - parseTimestamp(a.timestamp))
    .slice(0, maxNonPending)

  return [...pendingRows, ...keptNonPending]
}

/**
 * Upserts a collaboration choice lifecycle row by choiceId.
 * Terminal statuses win over pending replays; duplicate pending replays keep
 * the earliest timestamp between the existing and incoming rows.
 */
export function upsertCollabChoiceRequest(
  existing: CollabChoiceRequest[],
  incoming: CollabChoiceRequest,
  options?: { maxNonPending?: number },
): CollabChoiceRequest[] {
  const maxNonPending = options?.maxNonPending ?? COLLAB_NON_PENDING_CHOICE_CAP
  const idx = existing.findIndex((row) => row.choiceId === incoming.choiceId)

  if (idx >= 0) {
    const current = existing[idx]

    if (isTerminalStatus(current.status) && incoming.status === 'pending') {
      return existing
    }

    const nextRow =
      current.status === 'pending' && incoming.status === 'pending'
        ? { ...incoming, timestamp: minTimestamp(current.timestamp, incoming.timestamp) }
        : incoming

    const updated = [...existing]
    updated[idx] = nextRow
    return pruneNonPendingRows(updated, maxNonPending)
  }

  return pruneNonPendingRows([...existing, incoming], maxNonPending)
}
