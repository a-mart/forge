/**
 * Route-level health poll hook.
 *
 * Periodically pings both the builder and collab backend HTTP endpoints to
 * keep connection-health-store accurate regardless of which surface is
 * currently mounted.  This prevents the ModeSwitch dot from going gray
 * when you switch away from a surface whose backend is still available.
 */

import { useEffect, useRef } from 'react'
import { resolveApiEndpoint } from '@/lib/api-endpoint'
import {
  reportBuilderPoll,
  reportCollabPoll,
} from '@/lib/connection-health-store'

/** Poll interval in milliseconds */
const POLL_INTERVAL_MS = 5_000

/**
 * Ping a backend by attempting a lightweight HEAD request to its root.
 * Returns `true` if the backend responds (any status), `false` on network error.
 */
async function pingBackend(wsUrl: string): Promise<boolean> {
  try {
    const httpUrl = resolveApiEndpoint(wsUrl, '/api/health')
    const response = await fetch(httpUrl, {
      method: 'HEAD',
      // Abort if the server doesn't respond quickly
      signal: AbortSignal.timeout(3_000),
    })
    // Any HTTP response (even 404) means the server is up
    return response.ok || response.status > 0
  } catch {
    return false
  }
}

/**
 * Start route-level health polling for both backends.
 *
 * Call once at the top-level page component (IndexPage) so it runs
 * regardless of which surface is currently rendered.
 */
export function useBackendHealthPoll(
  builderWsUrl: string,
  collabWsUrl: string,
): void {
  const builderUrlRef = useRef(builderWsUrl)
  const collabUrlRef = useRef(collabWsUrl)

  // Keep refs current via effect (refs must not be assigned during render)
  useEffect(() => {
    builderUrlRef.current = builderWsUrl
    collabUrlRef.current = collabWsUrl
  })

  useEffect(() => {
    let cancelled = false

    async function poll() {
      if (cancelled) return

      const [builderOk, collabOk] = await Promise.all([
        pingBackend(builderUrlRef.current),
        pingBackend(collabUrlRef.current),
      ])

      if (!cancelled) {
        reportBuilderPoll(builderOk)
        reportCollabPoll(collabOk)
      }
    }

    // Initial poll immediately
    void poll()

    const intervalId = setInterval(() => {
      void poll()
    }, POLL_INTERVAL_MS)

    return () => {
      cancelled = true
      clearInterval(intervalId)
    }
  }, [])
}
