import { useState, useEffect, useCallback, useRef } from 'react'
import { fetchTokenAnalytics, refreshTokenAnalytics } from './token-analytics-api'
import type { TokenAnalyticsSnapshot, TokenAnalyticsQuery } from '@forge/protocol'

export function useTokenAnalytics(wsUrl: string, query: TokenAnalyticsQuery) {
  const [snapshot, setSnapshot] = useState<TokenAnalyticsSnapshot | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const prevQueryRef = useRef<string>('')

  // Suppress fetches when custom range is selected but dates are incomplete/invalid
  const isCustomIncomplete =
    query.rangePreset === 'custom' && (!query.startDate || !query.endDate)

  useEffect(() => {
    if (isCustomIncomplete) {
      // Don't fetch — keep showing existing snapshot (if any) without error
      setIsLoading(false)
      return
    }

    let cancelled = false
    const queryKey = JSON.stringify(query)
    const queryChanged = prevQueryRef.current !== queryKey
    prevQueryRef.current = queryKey

    if (snapshot && queryChanged) {
      // Show loading overlay rather than full skeleton when filters change
      setIsLoading(true)
    } else if (!snapshot) {
      setIsLoading(true)
    }
    setError(null)

    fetchTokenAnalytics(wsUrl, query)
      .then((data) => {
        if (!cancelled) {
          setSnapshot(data)
          setError(null)
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to fetch token analytics')
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [wsUrl, query, isCustomIncomplete]) // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = useCallback(async () => {
    setIsRefreshing(true)
    try {
      const data = await refreshTokenAnalytics(wsUrl, query)
      setSnapshot(data)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Refresh failed')
    } finally {
      setIsRefreshing(false)
    }
  }, [wsUrl, query])

  return { snapshot, isLoading, error, isRefreshing, refresh }
}
