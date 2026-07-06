/**
 * Route-level health poll hook.
 *
 * Periodically pings both the builder and collab backend HTTP endpoints to
 * keep connection-health-store accurate regardless of which surface is
 * currently mounted.  This prevents the ModeSwitch dot from going gray
 * when you switch away from a surface whose backend is still available.
 *
 * Multi-backend: pings **all** configured collab backend URLs and reports
 * aggregate health (any available → connected).
 *
 * Cadence + visibility-pause come from the shared {@link useForegroundPoll}
 * policy (WP-U3) so this poll behaves consistently with the other foreground
 * pollers instead of running a bare `setInterval` that never pauses when the
 * tab is hidden.
 */

import { useCallback, useEffect, useRef } from 'react'
import { resolveApiEndpoint } from '@/lib/api-endpoint'
import {
  reportBuilderPoll,
  reportCollabPoll,
} from '@/lib/connection-health-store'
import { useForegroundPoll } from '@/hooks/use-foreground-poll'

/** Poll interval in milliseconds */
const POLL_INTERVAL_MS = 5_000

/**
 * Ping a backend via GET /api/health.
 *
 * Uses GET (not HEAD) because cross-origin requests require CORS headers
 * on the response — GET is the most reliable method for this.  The health
 * endpoint returns a small JSON body (~100 bytes), so bandwidth is negligible.
 *
 * Returns `true` if the backend responds with any status, `false` on
 * network / CORS / timeout error.
 */
async function pingBackend(wsUrl: string): Promise<boolean> {
  try {
    const httpUrl = resolveApiEndpoint(wsUrl, '/api/health')
    const response = await fetch(httpUrl, {
      method: 'GET',
      mode: 'cors',
      // Abort if the server doesn't respond quickly
      signal: AbortSignal.timeout(3_000),
    })
    // Any HTTP response means the server is up
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
 *
 * `collabWsUrls` accepts one or more collab backend WS URLs.  The
 * aggregate result (any reachable → connected) is reported to the
 * health store, keeping the ModeSwitch collab dot accurate even when
 * multiple collab backends are configured.
 */
export function useBackendHealthPoll(
  builderWsUrl: string,
  collabWsUrls: readonly string[],
): void {
  const builderUrlRef = useRef(builderWsUrl)
  const collabUrlsRef = useRef(collabWsUrls)

  // Keep refs current via effect (refs must not be assigned during render)
  useEffect(() => {
    builderUrlRef.current = builderWsUrl
    collabUrlsRef.current = collabWsUrls
  })

  // Stable poll fn: reads the current URLs off refs so the shared poll policy's
  // effect does not restart on every URL-array identity change.
  const poll = useCallback(async () => {
    const urls = collabUrlsRef.current
    const collabPings = urls.length > 0
      ? urls.map((url) => pingBackend(url))
      : [Promise.resolve(false)]

    const [builderOk, ...collabResults] = await Promise.all([
      pingBackend(builderUrlRef.current),
      ...collabPings,
    ])

    reportBuilderPoll(builderOk)
    // Aggregate: collab is available if ANY backend responds
    reportCollabPoll(collabResults.some(Boolean))
  }, [])

  useForegroundPoll(poll, { intervalMs: POLL_INTERVAL_MS })
}
