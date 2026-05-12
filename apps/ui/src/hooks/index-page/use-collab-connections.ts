/**
 * React hook + context for the multi-connection collab manager.
 *
 * Wraps {@link CollabConnectionManager} in React lifecycle, providing:
 * - A central state map of all connections (metadata-only for inactive ones)
 * - Exactly one active detail subscription at a time
 * - Backward-compatible active-connection state for existing consumers
 * - Registry-reactive: listens for connection add/remove/edit events
 *
 * Usage:
 * ```tsx
 * const connections = useCollabConnections(targets)
 * return (
 *   <CollabConnectionsProvider value={connections}>
 *     {children}
 *   </CollabConnectionsProvider>
 * )
 * ```
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from 'react'
import {
  CollabConnectionManager,
} from '@/lib/collaboration/connection-manager'
import type { CollabWsState } from '@/lib/collab-ws-state'
import type { CollabWsClient } from '@/lib/collaboration/ws-client'
import type { CollaborationEndpointTarget } from '@/lib/collaboration-connections'

// ---------------------------------------------------------------------------
// Context shape
// ---------------------------------------------------------------------------

export interface CollabConnectionsValue {
  /** All connection states keyed by connectionId */
  connectionStates: Record<string, CollabWsState>

  /** Ordered connection IDs (insertion order from registry) */
  connectionIds: string[]

  /** Connection targets for label/metadata access */
  targets: readonly CollaborationEndpointTarget[]

  /** Currently active connectionId (detail subscription owner) */
  activeConnectionId: string | null

  /** Currently active channelId */
  activeChannelId: string | null

  /**
   * Switch active channel, possibly across connections.
   * Clears old detail subscription before establishing new one.
   */
  setActiveChannel: (connectionId: string | null, channelId: string | null) => void

  /** Get client for a specific connection (for imperative operations) */
  getClient: (connectionId: string) => CollabWsClient | null

  /** Manager ref for advanced imperative access */
  managerRef: MutableRefObject<CollabConnectionManager | null>
}

const CollabConnectionsContext = createContext<CollabConnectionsValue | null>(null)

export const CollabConnectionsProvider = CollabConnectionsContext.Provider

// ---------------------------------------------------------------------------
// Consumer hook
// ---------------------------------------------------------------------------

export function useCollabConnectionsContext(): CollabConnectionsValue {
  const ctx = useContext(CollabConnectionsContext)
  if (!ctx) {
    throw new Error(
      'useCollabConnectionsContext must be used inside a <CollabConnectionsProvider>',
    )
  }
  return ctx
}

// ---------------------------------------------------------------------------
// Lifecycle hook
// ---------------------------------------------------------------------------

/**
 * Manages the multi-connection collab manager lifecycle.
 *
 * Creates one {@link CollabWsClient} per target for metadata-only
 * subscriptions.  The active detail subscription is controlled via
 * `setActiveChannel(connectionId, channelId)`.
 *
 * Reacts to target list changes by syncing the manager (adding new
 * connections, removing stale ones, recreating on URL change).
 */
export function useCollabConnections(
  targets: readonly CollaborationEndpointTarget[],
): CollabConnectionsValue {
  const managerRef = useRef<CollabConnectionManager | null>(null)
  const [, forceRender] = useState(0)

  // Lazily create manager (stable across renders).
  // Accessing the ref during render is intentional here — it's the
  // React-recommended lazy-init pattern (check-then-set on first render).
  /* eslint-disable react-hooks/refs */
  if (!managerRef.current) {
    managerRef.current = new CollabConnectionManager()
  }

  const manager = managerRef.current
  /* eslint-enable react-hooks/refs */

  // Subscribe to manager state changes → trigger re-renders.
  // IMPORTANT: This effect must run BEFORE syncConnections so that the
  // listener is registered when syncConnections calls notify().  Otherwise
  // the initial sync notification is lost and consumers see stale empty
  // state until the first async client event (WebSocket connect/bootstrap).
  useEffect(() => {
    return manager.subscribe(() => {
      forceRender((c) => c + 1)
    })
  }, [manager])

  // Sync connections when targets change
  useEffect(() => {
    manager.syncConnections(targets)
  }, [manager, targets])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      managerRef.current?.destroy()
      managerRef.current = null
    }
  }, [])

  // Stable callback for setting active channel
  const setActiveChannel = useCallback(
    (connectionId: string | null, channelId: string | null) => {
      manager.setActiveChannel(connectionId, channelId)
    },
    [manager],
  )

  // Stable callback for getting a client
  const getClient = useCallback(
    (connectionId: string) => manager.getClient(connectionId),
    [manager],
  )

  // Snapshot values from manager (re-read on each render triggered by forceRender).
  // These reads are intentional during render — the manager ref is used as a stable
  // external store that we re-snapshot on each render cycle.
  /* eslint-disable react-hooks/refs */
  const connectionStates = manager.getAllStates()
  const connectionIds = manager.getConnectionIds()
  const activeConnectionId = manager.activeConnectionId
  const activeChannelId = manager.activeChannelId
  /* eslint-enable react-hooks/refs */

  // Memoize return value to prevent unnecessary re-renders in consumers.
  // The `renderCount` dep (from forceRender) ensures this updates when manager
  // notifies, but identity stays stable when values haven't changed.
  //
  // The snapshot values and managerRef are intentional render-time reads from
  // a ref-backed external store — disable react-hooks/refs for this block.
  /* eslint-disable react-hooks/refs */
  return useMemo<CollabConnectionsValue>(
    () => ({
      connectionStates,
      connectionIds,
      targets,
      activeConnectionId,
      activeChannelId,
      setActiveChannel,
      getClient,
      managerRef,
    }),
    [connectionStates, connectionIds, targets, activeConnectionId, activeChannelId, setActiveChannel, getClient],
  )
  /* eslint-enable react-hooks/refs */
}
