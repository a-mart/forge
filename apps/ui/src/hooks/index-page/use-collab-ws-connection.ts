/**
 * Collab WS context type, provider, and consumer hook.
 *
 * The multi-backend connection lifecycle is managed by
 * `useCollabConnections()` in `use-collab-connections.ts`.  This module
 * retains the shared context shape that downstream components import.
 */

import {
  createContext,
  useContext,
  type MutableRefObject,
} from 'react'
import type { CollabWsClient } from '@/lib/collaboration/ws-client'
import type { CollabWsState } from '@/lib/collab-ws-state'

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
// NOTE: The legacy `useCollabWsConnection` hook was removed — the multi-backend
// `useCollabConnections()` hook (in use-collab-connections.ts) now manages all
// per-backend WS client lifecycles.  This module retains the shared context
// type/provider/consumer that downstream components still import.
// ---------------------------------------------------------------------------
