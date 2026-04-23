/**
 * React hook + context for the collab WS client lifecycle.
 *
 * Manages connect/disconnect/reconnect and exposes collab state to the
 * component tree. Only active when the collab surface is mounted.
 *
 * Channel selection is driven by the caller via
 * `clientRef.current.setActiveChannel(channelId)`.
 */

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
} from 'react'
import { CollabWsClient } from '@/lib/collaboration/ws-client'
import {
  createInitialCollabWsState,
  type CollabWsState,
} from '@/lib/collab-ws-state'

// ---------------------------------------------------------------------------
// Context shape
// ---------------------------------------------------------------------------

export interface CollabWsConnectionValue {
  /** Ref to the live client instance (stable across renders) */
  clientRef: MutableRefObject<CollabWsClient | null>
  /** Current snapshot of collab state (triggers re-renders) */
  state: CollabWsState
}

const CollabWsContext = createContext<CollabWsConnectionValue | null>(null)

export const CollabWsProvider = CollabWsContext.Provider

// ---------------------------------------------------------------------------
// Consumer hook
// ---------------------------------------------------------------------------

export function useCollabWsContext(): CollabWsConnectionValue {
  const ctx = useContext(CollabWsContext)
  if (!ctx) {
    throw new Error('useCollabWsContext must be used inside a <CollabWsProvider>')
  }
  return ctx
}

// ---------------------------------------------------------------------------
// Connection lifecycle hook
// ---------------------------------------------------------------------------

/**
 * Manages the collab WS client lifecycle for a given backend WS URL.
 *
 * Usage (inside CollabSurface):
 * ```tsx
 * const collab = useCollabWsConnection(wsUrl)
 * return (
 *   <CollabWsProvider value={collab}>
 *     {children}
 *   </CollabWsProvider>
 * )
 * ```
 */
export function useCollabWsConnection(wsUrl: string): CollabWsConnectionValue {
  const clientRef = useRef<CollabWsClient | null>(null)
  const [state, setState] = useState<CollabWsState>(() => createInitialCollabWsState())

  useEffect(() => {
    const client = new CollabWsClient(wsUrl)
    clientRef.current = client
    setState(client.getState())

    const unsubscribe = client.subscribe((nextState) => {
      setState(nextState)
    })

    client.start()

    return () => {
      unsubscribe()
      if (clientRef.current === client) {
        clientRef.current = null
      }
      client.destroy()
    }
  }, [wsUrl])

  return { clientRef, state }
}
