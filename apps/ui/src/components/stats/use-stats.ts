import { useState, useEffect, useCallback, useRef } from 'react'
import { fetchStats, refreshStats } from './stats-api'
import type { StatsSnapshot, StatsRange } from '@forge/protocol'

export function useStats(wsUrl: string, range: StatsRange = '7d') {
  const [stats, setStats] = useState<StatsSnapshot | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isSwitchingRange, setIsSwitchingRange] = useState(false)
  const prevRangeRef = useRef(range)

  const requestSequence = useRef(0)

  useEffect(() => {
    const sequence = ++requestSequence.current
    setIsRefreshing(false)
    let cancelled = false
    const rangeChanged = prevRangeRef.current !== range
    prevRangeRef.current = range

    // If we already have stats and the range changed, show switching indicator
    // instead of full loading skeleton
    if (stats && rangeChanged) {
      setIsSwitchingRange(true)
    } else {
      setIsLoading(true)
    }
    setError(null)

    fetchStats(wsUrl, range)
      .then((data) => {
        if (!cancelled && sequence === requestSequence.current) {
          setStats(data)
          setError(null)
        }
      })
      .catch((err) => {
        if (!cancelled && sequence === requestSequence.current) {
          setError(err instanceof Error ? err.message : 'Failed to fetch stats')
        }
      })
      .finally(() => {
        if (!cancelled && sequence === requestSequence.current) {
          setIsLoading(false)
          setIsSwitchingRange(false)
        }
      })

    return () => {
      cancelled = true
      requestSequence.current += 1
    }
  }, [wsUrl, range]) // eslint-disable-line react-hooks/exhaustive-deps -- intentionally using stats ref

  const refresh = useCallback(async () => {
    const sequence = ++requestSequence.current
    setIsRefreshing(true)
    try {
      const data = await refreshStats(wsUrl, range)
      if (sequence !== requestSequence.current) return
      setStats(data)
      setError(null)
    } catch (err) {
      if (sequence !== requestSequence.current) return
      setError(err instanceof Error ? err.message : 'Refresh failed')
    } finally {
      if (sequence === requestSequence.current) {
        setIsRefreshing(false)
        setIsLoading(false)
        setIsSwitchingRange(false)
      }
    }
  }, [wsUrl, range])

  return { stats, isLoading, error, isRefreshing, isSwitchingRange, refresh }
}
