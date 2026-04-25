/**
 * Target-scoped backend state provider for the Settings shell.
 *
 * Builder target reuses the existing BuilderSurface WebSocket state
 * (managers, profiles, telegram status, change keys) passed via props.
 *
 * Collab target opens a secondary Builder-protocol WebSocket only when
 * the current collab user is an admin and the Settings view is active.
 * Members and unauthenticated users are blocked — no WebSocket is created,
 * no panels are mounted.
 */

import { useEffect, useRef, useState } from 'react'
import { ManagerWsClient } from '@/lib/ws-client'
import type { ManagerWsState } from '@/lib/ws-state'
import type { SettingsBackendTarget } from './settings-target'

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface SettingsBackendState {
  /** Whether this state source is ready (WS bootstrapped for collab, always true for builder). */
  ready: boolean
  /** Non-null when the user cannot access settings (collab member/unauthenticated). */
  blockedReason: 'admin_required' | 'auth_required' | null
  /** Remote WS state — only populated for collab admin. null for builder (passed via props). */
  wsState: ManagerWsState | null
}

interface UseSettingsBackendStateOptions {
  target: SettingsBackendTarget
  /** Whether the settings view is active. Only creates WS when true. */
  enabled: boolean
  /** Is the current user an admin on the collab backend? (Collab target only) */
  isAdmin: boolean
  /** Is the current user a member (non-admin) on the collab backend? (Collab target only) */
  isMember: boolean
  /** Has the collab session finished loading? (Collab target only) */
  hasLoaded: boolean
}

/* ------------------------------------------------------------------ */
/*  Hook                                                               */
/* ------------------------------------------------------------------ */

export function useSettingsBackendState({
  target,
  enabled,
  isAdmin,
  isMember,
  hasLoaded,
}: UseSettingsBackendStateOptions): SettingsBackendState {
  const [wsState, setWsState] = useState<ManagerWsState | null>(null)
  const clientRef = useRef<ManagerWsClient | null>(null)

  // Collab target: determine blocked reason
  const blockedReason: 'admin_required' | 'auth_required' | null =
    target.kind === 'collab' && hasLoaded && !isAdmin
      ? isMember
        ? 'admin_required'
        : 'auth_required'
      : null

  const shouldConnect = enabled && target.kind === 'collab' && isAdmin && !blockedReason

  // Manage the secondary Builder-protocol WebSocket for collab admin settings.
  // For builder target, shouldConnect is always false so the effect is a no-op.
  useEffect(() => {
    if (!shouldConnect) {
      setWsState(null)
      return
    }

    const client = new ManagerWsClient(target.wsUrl)
    clientRef.current = client
    setWsState(client.getState())

    const unsubscribe = client.subscribe((nextState) => {
      setWsState(nextState)
    })

    client.start()

    return () => {
      unsubscribe()
      if (clientRef.current === client) {
        clientRef.current = null
      }
      client.destroy()
      setWsState(null)
    }
  }, [shouldConnect, target.wsUrl])

  // Builder target: no secondary WS, state from BuilderSurface props
  if (target.kind === 'builder') {
    return {
      ready: true,
      blockedReason: null,
      wsState: null,
    }
  }

  return {
    ready: shouldConnect ? (wsState?.hasReceivedAgentsSnapshot ?? false) : !blockedReason,
    blockedReason,
    wsState: shouldConnect ? wsState : null,
  }
}
