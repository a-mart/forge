import { useEffect, useMemo, useState } from 'react'
import type { ProviderUsageStats } from '@forge/protocol'
import { resolveApiEndpoint } from '@/lib/api-endpoint'
import { resolveBackendWsUrl } from '@/lib/backend-url'

const PROVIDER_USAGE_POLL_MS = 180_000

export function useProviderUsage(enabled: boolean): ProviderUsageStats | null {
  const [providers, setProviders] = useState<ProviderUsageStats | null>(null)
  const wsUrl = useMemo(() => resolveBackendWsUrl(), [])

  useEffect(() => {
    if (!enabled) {
      setProviders(null)
      return
    }

    let cancelled = false
    let pollTimer: ReturnType<typeof setTimeout> | null = null
    let controller: AbortController | null = null

    const clearPollTimer = () => {
      if (pollTimer) {
        clearTimeout(pollTimer)
        pollTimer = null
      }
    }

    const fetchProviderUsage = async () => {
      controller?.abort()
      controller = new AbortController()

      try {
        const endpoint = resolveApiEndpoint(wsUrl, '/api/provider-usage')
        const response = await fetch(endpoint, { signal: controller.signal })
        if (!response.ok) {
          throw new Error(`Failed to fetch provider usage: ${response.status}`)
        }

        const data = (await response.json()) as ProviderUsageStats
        if (!cancelled) {
          setProviders(data)
        }
      } catch (error) {
        if ((error instanceof DOMException && error.name === 'AbortError') || cancelled) {
          return
        }
      }
    }

    const scheduleNextPoll = () => {
      clearPollTimer()
      if (cancelled || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) {
        return
      }

      pollTimer = setTimeout(() => {
        void run()
      }, PROVIDER_USAGE_POLL_MS)
    }

    const run = async () => {
      await fetchProviderUsage()
      scheduleNextPoll()
    }

    const handleVisibilityChange = () => {
      if (typeof document === 'undefined') {
        return
      }

      if (document.visibilityState === 'hidden') {
        clearPollTimer()
        controller?.abort()
        controller = null
        return
      }

      void run()
    }

    void run()

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange)
    }

    return () => {
      cancelled = true
      clearPollTimer()
      controller?.abort()
      controller = null
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange)
      }
    }
  }, [enabled, wsUrl])

  return providers
}
