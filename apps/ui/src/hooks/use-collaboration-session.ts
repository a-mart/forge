import { useCallback, useEffect, useRef, useState } from 'react'
import type { CollaborationSessionInfo, CollaborationStatus } from '@forge/protocol'
import { resolveCollaborationApiBaseUrl } from '@/lib/collaboration-endpoints'

export interface CollaborationSession {
  isCollabEnabled: boolean
  isAdmin: boolean
  isMember: boolean
  isLoading: boolean
  hasLoaded: boolean
  /** Re-fetch collaboration status and session after a login attempt. */
  refresh: () => void
}

interface UseCollaborationSessionOptions {
  enabled?: boolean
}

async function fetchJson<T>(baseUrl: string, path: string, signal: AbortSignal): Promise<T> {
  const endpoint = new URL(path, baseUrl).toString()
  const response = await fetch(endpoint, {
    credentials: 'include',
    signal,
  })

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`)
  }

  return (await response.json()) as T
}

export function useCollaborationSession(
  options: UseCollaborationSessionOptions = {},
): CollaborationSession {
  const isTestMode = import.meta.env.MODE === 'test'
  const enabled = options.enabled ?? true
  const [isCollabEnabled, setIsCollabEnabled] = useState(false)
  const [role, setRole] = useState<'admin' | 'member' | null>(null)
  const [isLoading, setIsLoading] = useState(enabled && !isTestMode)
  const [hasLoaded, setHasLoaded] = useState(isTestMode)
  const [refreshCounter, setRefreshCounter] = useState(0)
  const controllerRef = useRef<AbortController | null>(null)

  const load = useCallback(async (signal: AbortSignal) => {
    setIsLoading(true)
    const baseUrl = resolveCollaborationApiBaseUrl()

    try {
      const status = await fetchJson<CollaborationStatus>(baseUrl, '/api/collaboration/status', signal)
      if (signal.aborted) return

      const enabled = status.enabled === true
      setIsCollabEnabled(enabled)

      if (!enabled) {
        setRole(null)
        return
      }

      const session = await fetchJson<CollaborationSessionInfo>(baseUrl, '/api/collaboration/me', signal)
      if (signal.aborted) return

      const nextRole = session.authenticated ? session.user?.role ?? null : null
      setRole(nextRole)
    } catch {
      if (signal.aborted) return
      setIsCollabEnabled(false)
      setRole(null)
    } finally {
      if (!signal.aborted) {
        setIsLoading(false)
        setHasLoaded(true)
      }
    }
  }, [])

  const refresh = useCallback(() => {
    setRefreshCounter((c) => c + 1)
  }, [])

  useEffect(() => {
    if (isTestMode) {
      return
    }

    if (!enabled) {
      setIsLoading(false)
      return
    }

    // Abort any in-flight request from a previous render / refresh
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    void load(controller.signal)
    return () => controller.abort()
  }, [enabled, isTestMode, load, refreshCounter])

  useEffect(() => {
    if (isTestMode || !enabled) {
      return
    }

    const handleServerUrlChange = () => {
      refresh()
    }

    window.addEventListener('forge-collab-server-url-change', handleServerUrlChange)
    window.addEventListener('storage', handleServerUrlChange)
    return () => {
      window.removeEventListener('forge-collab-server-url-change', handleServerUrlChange)
      window.removeEventListener('storage', handleServerUrlChange)
    }
  }, [enabled, isTestMode, refresh])

  return {
    isCollabEnabled,
    isAdmin: role === 'admin',
    isMember: role === 'member',
    isLoading,
    hasLoaded,
    refresh,
  }
}
