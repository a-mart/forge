/**
 * Module-level external store tracking both WebSocket backends' connection
 * health.  Each surface (Builder / Collab) reports its raw WS connected
 * state; this store derives the user-visible health and retains
 * `wasEverConnected` across reconnect cycles (the WS clients clear their
 * own bootstrap flags on disconnect, so we track it here instead).
 *
 * Health dots reflect **backend availability**, not whether the surface
 * component is currently mounted.  A route-level health poll keeps the
 * inactive surface's dot accurate so switching away from a surface does
 * not immediately turn its dot gray.
 */

import { useSyncExternalStore } from 'react'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Connection health for a backend WebSocket:
 * - `'connected'`    — backend is reachable  (green dot)
 * - `'reconnecting'` — backend was reachable before but is currently down  (amber dot)
 * - `'disconnected'` — backend has never been reachable, or feature unconfigured  (gray dot)
 */
export type ConnectionHealth = 'connected' | 'reconnecting' | 'disconnected'

// ---------------------------------------------------------------------------
// Internal per-surface tracker
// ---------------------------------------------------------------------------

interface SurfaceTracker {
  /** Latest reported WS connected flag (real-time, from active surface) */
  wsConnected: boolean
  /** Latest health-poll result (periodic, from route-level poll) */
  pollAvailable: boolean
  /** Whether this backend has ever been reachable (survives reconnect cycles) */
  wasEverConnected: boolean
}

const INITIAL_TRACKER: SurfaceTracker = {
  wsConnected: false,
  pollAvailable: false,
  wasEverConnected: false,
}

function deriveFromTracker(t: SurfaceTracker): ConnectionHealth {
  if (t.wsConnected || t.pollAvailable) return 'connected'
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
// Writers — surface WS reports (from mounted surface components)
// ---------------------------------------------------------------------------

/**
 * Report the builder WS connected state.  Call from a `useEffect` keyed on
 * `state.connected`.  The store internally tracks whether this surface has
 * ever been connected so it can distinguish 'reconnecting' from 'disconnected'.
 */
export function reportBuilderConnected(connected: boolean): void {
  builderTracker = {
    ...builderTracker,
    wsConnected: connected,
    wasEverConnected: connected || builderTracker.wasEverConnected,
  }
  recalc()
}

/**
 * Report the collab WS connected state.  Mirror of `reportBuilderConnected`.
 */
export function reportCollabConnected(connected: boolean): void {
  collabTracker = {
    ...collabTracker,
    wsConnected: connected,
    wasEverConnected: connected || collabTracker.wasEverConnected,
  }
  recalc()
}

// ---------------------------------------------------------------------------
// Writers — route-level health poll (always running, regardless of surface)
// ---------------------------------------------------------------------------

/**
 * Report builder backend availability from the route-level health poll.
 */
export function reportBuilderPoll(available: boolean): void {
  builderTracker = {
    ...builderTracker,
    pollAvailable: available,
    wasEverConnected: available || builderTracker.wasEverConnected,
  }
  recalc()
}

/**
 * Report collab backend availability from the route-level health poll.
 */
export function reportCollabPoll(available: boolean): void {
  collabTracker = {
    ...collabTracker,
    pollAvailable: available,
    wasEverConnected: available || collabTracker.wasEverConnected,
  }
  recalc()
}

// ---------------------------------------------------------------------------
// Deprecated — kept as no-ops for backward compatibility
// ---------------------------------------------------------------------------

/** @deprecated No longer needed — health poll tracks availability */
export function markBuilderInactive(): void {
  // Clear WS signal only; poll keeps availability accurate
  builderTracker = { ...builderTracker, wsConnected: false }
  recalc()
}

/** @deprecated No longer needed — health poll tracks availability */
export function markCollabInactive(): void {
  // Clear WS signal only; poll keeps availability accurate
  collabTracker = { ...collabTracker, wsConnected: false }
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
