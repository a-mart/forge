import { useState, useEffect, useCallback, useRef } from 'react'
import { fetchTokenAnalytics, refreshTokenAnalytics } from './token-analytics-api'
import type { TokenAnalyticsSnapshot, TokenAnalyticsQuery } from '@forge/protocol'

export function useTokenAnalytics(wsUrl: string, query: TokenAnalyticsQuery) {
  const [snapshot, setSnapshot] = useState<TokenAnalyticsSnapshot | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isSwitchingQuery, setIsSwitchingQuery] = useState(false)
  const prevQueryRef = useRef<string>('')

  // Suppress fetches when custom range is selected but dates are incomplete/invalid
  const isCustomIncomplete =
    query.rangePreset === 'custom' && (!query.startDate || !query.endDate)

  const requestSequence = useRef(0)

  useEffect(() => {
    const sequence = ++requestSequence.current
    setIsRefreshing(false)
    if (isCustomIncomplete) {
      // Don't fetch — keep showing existing snapshot (if any) without error
      setIsLoading(false)
      setIsSwitchingQuery(false)
      return
    }

    let cancelled = false
    const queryKey = JSON.stringify(query)
    const queryChanged = prevQueryRef.current !== queryKey
    prevQueryRef.current = queryKey

    if (snapshot && queryChanged) {
      setIsSwitchingQuery(true)
    } else {
      setIsLoading(true)
    }
    setError(null)

    fetchTokenAnalytics(wsUrl, query)
      .then((data) => {
        if (!cancelled && sequence === requestSequence.current) {
          setSnapshot(data)
          setError(null)
        }
      })
      .catch((err) => {
        if (!cancelled && sequence === requestSequence.current) {
          setError(err instanceof Error ? err.message : 'Failed to fetch token analytics')
        }
      })
      .finally(() => {
        if (!cancelled && sequence === requestSequence.current) {
          setIsLoading(false)
          setIsSwitchingQuery(false)
        }
      })

    return () => {
      cancelled = true
      requestSequence.current += 1
    }
  }, [wsUrl, query, isCustomIncomplete]) // eslint-disable-line react-hooks/exhaustive-deps -- intentionally using snapshot ref

  const refresh = useCallback(async () => {
    const sequence = ++requestSequence.current
    setIsRefreshing(true)
    try {
      const data = await refreshTokenAnalytics(wsUrl, query)
      if (sequence !== requestSequence.current) return
      setSnapshot(data)
      setError(null)
    } catch (err) {
      if (sequence !== requestSequence.current) return
      setError(err instanceof Error ? err.message : 'Refresh failed')
    } finally {
      if (sequence === requestSequence.current) {
        setIsRefreshing(false)
        setIsLoading(false)
        setIsSwitchingQuery(false)
      }
    }
  }, [wsUrl, query])

  return { snapshot, isLoading, error, isRefreshing, isSwitchingQuery, refresh }
}
