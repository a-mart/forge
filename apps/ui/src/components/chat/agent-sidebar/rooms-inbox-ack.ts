import { useCallback, useEffect, useMemo, useState } from 'react'
import { PREFERENCE_CHANGE_EVENT } from '@/lib/sidebar-prefs'

export const ROOMS_INBOX_ACK_STORAGE_KEY = 'forge-sidebar-inbox-ack'
const ROOMS_INBOX_ACK_VERSION = 1
const MAX_ACK_ENTRIES = 200
const ACKED_ENTRY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

export type RoomsInboxAttentionReason = 'awaiting_choice' | 'error' | 'unread_result'

export interface RoomsInboxAcknowledgement {
  reason: RoomsInboxAttentionReason
  signature: string
  raisedAt: number
  ackedAt?: number
  /** The acknowledged signal was authoritatively observed as resolved. */
  clearedAt?: number
}

export interface RoomsInboxAttentionSignal {
  key: string
  reason: RoomsInboxAttentionReason
  signature: string
}

interface StoredAcknowledgements {
  version: number
  entries: Record<string, RoomsInboxAcknowledgement>
}

export function getRoomsInboxAcknowledgementKey(originId: string, sessionAgentId: string): string {
  return `${originId}::${sessionAgentId}`
}

function isAttentionReason(value: unknown): value is RoomsInboxAttentionReason {
  return value === 'awaiting_choice' || value === 'error' || value === 'unread_result'
}

function isAcknowledgement(value: unknown): value is RoomsInboxAcknowledgement {
  if (!value || typeof value !== 'object') return false
  const entry = value as Partial<RoomsInboxAcknowledgement>
  return isAttentionReason(entry.reason)
    && typeof entry.signature === 'string'
    && typeof entry.raisedAt === 'number'
    && Number.isFinite(entry.raisedAt)
    && (entry.ackedAt === undefined || (typeof entry.ackedAt === 'number' && Number.isFinite(entry.ackedAt)))
    && (entry.clearedAt === undefined || (typeof entry.clearedAt === 'number' && Number.isFinite(entry.clearedAt)))
}

function entriesEqual(
  left: Readonly<Record<string, RoomsInboxAcknowledgement>>,
  right: Readonly<Record<string, RoomsInboxAcknowledgement>>,
): boolean {
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every((key) => {
    const a = left[key]
    const b = right[key]
    return Boolean(b)
      && a.reason === b.reason
      && a.signature === b.signature
      && a.raisedAt === b.raisedAt
      && a.ackedAt === b.ackedAt
      && a.clearedAt === b.clearedAt
  })
}

export function readRoomsInboxAcknowledgements(): Record<string, RoomsInboxAcknowledgement> {
  try {
    const raw = localStorage.getItem(ROOMS_INBOX_ACK_STORAGE_KEY)
    if (!raw) return {}
    const stored = JSON.parse(raw) as Partial<StoredAcknowledgements>
    if (stored.version !== ROOMS_INBOX_ACK_VERSION || !stored.entries || typeof stored.entries !== 'object') return {}
    return Object.fromEntries(
      Object.entries(stored.entries).filter(([, entry]) => isAcknowledgement(entry)),
    )
  } catch {
    return {}
  }
}

export function storeRoomsInboxAcknowledgements(entries: Readonly<Record<string, RoomsInboxAcknowledgement>>): void {
  try {
    const stored: StoredAcknowledgements = {
      version: ROOMS_INBOX_ACK_VERSION,
      entries: { ...entries },
    }
    localStorage.setItem(ROOMS_INBOX_ACK_STORAGE_KEY, JSON.stringify(stored))
  } catch {
    // Keep the current tab responsive when persistence is unavailable.
  }

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(PREFERENCE_CHANGE_EVENT, {
      detail: { key: ROOMS_INBOX_ACK_STORAGE_KEY },
    }))
  }
}

/** Drops vanished sessions, old acknowledgements, and entries beyond the bounded local cache. */
function isAuthoritativeInventoryEntry(
  key: string,
  authoritativeOriginIds: ReadonlySet<string> | undefined,
  inventoryOriginIds?: ReadonlySet<string>,
): boolean {
  // Direct reconciliation callers without origin bootstrap state retain the
  // original fully-authoritative behavior. Live callers provide every known
  // origin so a delimiter-bearing origin ID cannot be mistaken for its prefix.
  if (!authoritativeOriginIds) return true
  const matchingOriginId = [...(inventoryOriginIds ?? authoritativeOriginIds)]
    .filter((originId) => key.startsWith(`${originId}::`))
    .sort((left, right) => right.length - left.length)[0]
  return matchingOriginId ? authoritativeOriginIds.has(matchingOriginId) : false
}

export function garbageCollectRoomsInboxAcknowledgements(
  entries: Readonly<Record<string, RoomsInboxAcknowledgement>>,
  existingSessionKeys: ReadonlySet<string>,
  now = Date.now(),
  authoritativeOriginIds?: ReadonlySet<string>,
  inventoryOriginIds?: ReadonlySet<string>,
): Record<string, RoomsInboxAcknowledgement> {
  const kept = Object.entries(entries)
    // A missing session is only meaningful after that origin has supplied both
    // authoritative inventories. Age and size bounds still apply before then.
    .filter(([key, entry]) => (existingSessionKeys.has(key)
        || !isAuthoritativeInventoryEntry(key, authoritativeOriginIds, inventoryOriginIds))
      && (entry.ackedAt === undefined || now - entry.ackedAt <= ACKED_ENTRY_MAX_AGE_MS))
    .sort(([, left], [, right]) => right.raisedAt - left.raisedAt)
    .slice(0, MAX_ACK_ENTRIES)
  return Object.fromEntries(kept)
}

/**
 * Signals whose live presence this page session has actually observed. A cold
 * load starts empty, so an acknowledged entry cannot be marked cleared purely
 * because bootstrap has not delivered its unread counts yet. Module-scoped
 * because it is per page session, never persisted, and must not resurrect.
 */
const observedLiveSignalKeys = new Set<string>()

/** Test seam: reset the per-page-session observation set. */
export function resetObservedRoomsInboxSignals(): void {
  observedLiveSignalKeys.clear()
}

/**
 * Reconciles eager attention signals. Acknowledged entries are tombstones:
 * authoritative signal absence marks an instance cleared but never deletes it.
 */
export function reconcileRoomsInboxAcknowledgements(
  entries: Readonly<Record<string, RoomsInboxAcknowledgement>>,
  signals: readonly RoomsInboxAttentionSignal[],
  existingSessionKeys: ReadonlySet<string>,
  now = Date.now(),
  authoritativeOriginIds?: ReadonlySet<string>,
  inventoryOriginIds?: ReadonlySet<string>,
): Record<string, RoomsInboxAcknowledgement> {
  const next = garbageCollectRoomsInboxAcknowledgements(
    entries,
    existingSessionKeys,
    now,
    authoritativeOriginIds,
    inventoryOriginIds,
  )
  const liveSignalKeys = new Set(signals.map((signal) => signal.key))
  for (const key of liveSignalKeys) observedLiveSignalKeys.add(key)

  // An acknowledged entry remains a tombstone after its signal clears. Only an
  // authoritative, unfiltered session inventory can establish that absence as
  // a real resolution; display filters must never mark it cleared.
  for (const [key, entry] of Object.entries(next)) {
    if (
      entry.ackedAt !== undefined
      && entry.clearedAt === undefined
      && !liveSignalKeys.has(key)
      && existingSessionKeys.has(key)
      && isAuthoritativeInventoryEntry(key, authoritativeOriginIds, inventoryOriginIds)
      // Agents/profiles readiness does NOT imply the unread snapshot has landed.
      // On a cold load the session can be present and its origin authoritative
      // while unread counts are still empty, which makes an unresolved item look
      // resolved and silently re-raises it after reload. Only treat absence as
      // resolution for a signal this page session actually observed live.
      && observedLiveSignalKeys.has(key)
    ) {
      next[key] = { ...entry, clearedAt: now }
    }
  }

  for (const signal of signals) {
    const previous = next[signal.key]
    if (!previous) {
      next[signal.key] = {
        reason: signal.reason,
        signature: signal.signature,
        raisedAt: now,
      }
      continue
    }
    if (
      previous.ackedAt !== undefined
      && (previous.clearedAt !== undefined || previous.signature !== signal.signature)
    ) {
      next[signal.key] = {
        reason: signal.reason,
        signature: signal.signature,
        raisedAt: now,
      }
      continue
    }
    if (previous.ackedAt === undefined) {
      next[signal.key] = {
        ...previous,
        reason: signal.reason,
        signature: signal.signature,
      }
    }
  }
  return garbageCollectRoomsInboxAcknowledgements(
    next,
    existingSessionKeys,
    now,
    authoritativeOriginIds,
    inventoryOriginIds,
  )
}

export function acknowledgeRoomsInboxEntries(
  entries: Readonly<Record<string, RoomsInboxAcknowledgement>>,
  keys: readonly string[],
  now = Date.now(),
): Record<string, RoomsInboxAcknowledgement> {
  const next = { ...entries }
  for (const key of keys) {
    const entry = next[key]
    if (entry && entry.ackedAt === undefined) next[key] = { ...entry, ackedAt: now }
  }
  return next
}

/**
 * Storage seam for Rooms Inbox dismissals. UI code only deals in composite keys
 * and can later swap this hook for a server-backed acknowledgement source.
 */
export function useRoomsInboxAcknowledgements({
  existingSessionKeys,
  authoritativeOriginIds,
  inventoryOriginIds,
  signals,
}: {
  existingSessionKeys: ReadonlySet<string>
  /** Origins whose agent and profile inventories are authoritative this epoch. */
  authoritativeOriginIds: ReadonlySet<string>
  /** Every origin represented in this reconciliation pass. */
  inventoryOriginIds: ReadonlySet<string>
  signals: readonly RoomsInboxAttentionSignal[]
}): {
  entries: Record<string, RoomsInboxAcknowledgement>
  acknowledge: (keys: readonly string[]) => void
} {
  const [storedEntries, setStoredEntries] = useState(readRoomsInboxAcknowledgements)
  const existingKeysSignature = [...existingSessionKeys].sort().join('\u0000')
  const authoritativeOriginsSignature = [...authoritativeOriginIds].sort().join('\u0000')
  const inventoryOriginsSignature = [...inventoryOriginIds].sort().join('\u0000')
  const signalsSignature = signals
    .map((signal) => `${signal.key}\u0000${signal.reason}\u0000${signal.signature}`)
    .sort()
    .join('\u0000')
  const reconciledEntries = useMemo(() => reconcileRoomsInboxAcknowledgements(
    storedEntries,
    signals,
    existingSessionKeys,
    Date.now(),
    authoritativeOriginIds,
    inventoryOriginIds,
  ), [authoritativeOriginsSignature, existingKeysSignature, inventoryOriginsSignature, signalsSignature, storedEntries])

  useEffect(() => {
    if (entriesEqual(storedEntries, reconciledEntries)) return
    storeRoomsInboxAcknowledgements(reconciledEntries)
    setStoredEntries(reconciledEntries)
  }, [reconciledEntries, storedEntries])

  useEffect(() => {
    const refresh = (event: Event) => {
      const key = event.type === 'storage'
        ? (event as StorageEvent).key
        : (event as CustomEvent<{ key?: string }>).detail?.key
      if (key && key !== ROOMS_INBOX_ACK_STORAGE_KEY) return
      setStoredEntries(readRoomsInboxAcknowledgements())
    }
    window.addEventListener(PREFERENCE_CHANGE_EVENT, refresh)
    window.addEventListener('storage', refresh)
    return () => {
      window.removeEventListener(PREFERENCE_CHANGE_EVENT, refresh)
      window.removeEventListener('storage', refresh)
    }
  }, [])

  const acknowledge = useCallback((keys: readonly string[]) => {
    const next = acknowledgeRoomsInboxEntries(reconciledEntries, keys)
    if (entriesEqual(reconciledEntries, next)) return
    storeRoomsInboxAcknowledgements(next)
    setStoredEntries(next)
  }, [reconciledEntries])

  return { entries: reconciledEntries, acknowledge }
}
