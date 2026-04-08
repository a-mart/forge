import { useEffect, useState } from 'react'
import { resolveApiEndpoint } from '@/lib/api-endpoint'
import type { CortexScanBadgeResponse } from '../types'

interface UseCortexReviewBadgeOptions {
  connected: boolean
  hasCortexProfile: boolean
  wsUrl?: string
}

export function useCortexReviewBadge({
  connected,
  hasCortexProfile,
  wsUrl,
}: UseCortexReviewBadgeOptions): number | null {
  const [outstandingReviewCount, setOutstandingReviewCount] = useState<number | null>(null)

  useEffect(() => {
    if (!connected || !hasCortexProfile) {
      setOutstandingReviewCount(null)
      return
    }

    const controller = new AbortController()
    const endpoint = resolveApiEndpoint(wsUrl, '/api/cortex/scan')

    void fetch(endpoint, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Cortex scan failed (${response.status})`)
        }
        return response.json() as Promise<CortexScanBadgeResponse>
      })
      .then((payload) => {
        if (controller.signal.aborted) return
        setOutstandingReviewCount(
          typeof payload.scan?.summary?.needsReview === 'number' ? payload.scan.summary.needsReview : 0,
        )
      })
      .catch(() => {
        if (controller.signal.aborted) return
        setOutstandingReviewCount(null)
      })

    return () => controller.abort()
  }, [connected, hasCortexProfile, wsUrl])

  return outstandingReviewCount
}
