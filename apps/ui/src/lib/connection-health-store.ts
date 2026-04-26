/**
 * Module-level external store tracking both WebSocket backends' connection
 * health.  Each surface (Builder / Collab) reports its raw WS connected
 * state; this store derives the user-visible health and retains
 * `wasEverConnected` across reconnect cycles (the WS clients clear their
 * own bootstrap flags on disconnect, so we track it here instead).
 *
 * When a surface unmounts it calls `mark*Inactive()` — the store honestly
 * shows 'disconnected' rather than retaining a stale green.
 */

import { useSyncExternalStore } from 'react'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Connection health for a backend WebSocket:
 * - `'connected'`    — WS is open  (green dot)
 * - `'reconnecting'` — WS dropped after a prior successful connection  (amber dot)
 * - `'disconnected'` — WS never connected, surface unmounted, or feature unconfigured  (gray dot)
 */
export type ConnectionHealth = 'connected' | 'reconnecting' | 'disconnected'

// ---------------------------------------------------------------------------
// Internal per-surface tracker
// ---------------------------------------------------------------------------

interface SurfaceTracker {
  /** Latest reported WS connected flag */
  reported: boolean
  /** Whether this surface has ever been connected (survives reconnect cycles while active) */
  wasEverConnected: boolean
  /** Whether the monitoring surface component is currently mounted */
  active: boolean
}

const INITIAL_TRACKER: SurfaceTracker = {
  reported: false,
  wasEverConnected: false,
  active: false,
}

function deriveFromTracker(t: SurfaceTracker): ConnectionHealth {
  if (!t.active) return 'disconnected'
  if (t.reported) return 'connected'
  if (t.wasEverConnected) return 'reconnecting'
  return 'disconnected'
}

// ---------------------------------------------------------------------------
// Store state
// ---------------------------------------------------------------------------

interface HealthSnapshot {
  builder: ConnectionHealth
  collab: ConnectionHealth
}

let builderTracker: SurfaceTracker = { ...INITIAL_TRACKER }
let collabTracker: SurfaceTracker = { ...INITIAL_TRACKER }
let snapshot: HealthSnapshot = { builder: 'disconnected', collab: 'disconnected' }
const listeners = new Set<() => void>()

function recalc(): void {
  const next: HealthSnapshot = {
    builder: deriveFromTracker(builderTracker),
    collab: deriveFromTracker(collabTracker),
  }
  if (next.builder === snapshot.builder && next.collab === snapshot.collab) return
  snapshot = next
  for (const fn of listeners) fn()
}

// ---------------------------------------------------------------------------
// Writers — called from surface components
// ---------------------------------------------------------------------------

/**
 * Report the builder WS connected state.  Call from a `useEffect` keyed on
 * `state.connected`.  The store internally tracks whether this surface has
 * ever been connected so it can distinguish 'reconnecting' from 'disconnected'.
 */
export function reportBuilderConnected(connected: boolean): void {
  builderTracker = {
    reported: connected,
    wasEverConnected: connected || builderTracker.wasEverConnected,
    active: true,
  }
  recalc()
}

/**
 * Mark the builder surface as inactive (unmounted).  Call from a cleanup-only
 * `useEffect(() => () => markBuilderInactive(), [])`.
 */
export function markBuilderInactive(): void {
  builderTracker = { ...INITIAL_TRACKER }
  recalc()
}

/**
 * Report the collab WS connected state.  Mirror of `reportBuilderConnected`.
 */
export function reportCollabConnected(connected: boolean): void {
  collabTracker = {
    reported: connected,
    wasEverConnected: connected || collabTracker.wasEverConnected,
    active: true,
  }
  recalc()
}

/**
 * Mark the collab surface as inactive (unmounted).  Mirror of `markBuilderInactive`.
 */
export function markCollabInactive(): void {
  collabTracker = { ...INITIAL_TRACKER }
  recalc()
}

// ---------------------------------------------------------------------------
// React hook (useSyncExternalStore for tear-free reads)
// ---------------------------------------------------------------------------

function getSnapshot(): HealthSnapshot {
  return snapshot
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/**
 * Read both backends' connection health from any component in the tree.
 */
export function useConnectionHealth(): HealthSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

// ---------------------------------------------------------------------------
// Test-only helpers
// ---------------------------------------------------------------------------

/** @internal */
export function _resetForTesting(): void {
  builderTracker = { ...INITIAL_TRACKER }
  collabTracker = { ...INITIAL_TRACKER }
  snapshot = { builder: 'disconnected', collab: 'disconnected' }
  listeners.clear()
}

/** @internal — Expose tracker for white-box assertions */
export function _getTrackers(): { builder: SurfaceTracker; collab: SurfaceTracker } {
  return { builder: { ...builderTracker }, collab: { ...collabTracker } }
}
