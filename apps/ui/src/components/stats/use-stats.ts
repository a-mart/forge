import { useState, useEffect, useCallback } from 'react'
import { fetchStats, refreshStats } from './stats-api'
import type { StatsSnapshot, StatsRange } from '@forge/protocol'

export function useStats(wsUrl: string, range: StatsRange = '7d') {
  const [stats, setStats] = useState<StatsSnapshot | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isRefreshing, setIsRefreshing] = useState(false)

  useEffect(() => {
    let cancelled = false
    setIsLoading(true)
    setError(null)

    fetchStats(wsUrl, range)
      .then((data) => {
        if (!cancelled) {
          setStats(data)
          setError(null)
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to fetch stats')
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
  }, [wsUrl, range])

  const refresh = useCallback(async () => {
    setIsRefreshing(true)
    try {
      const data = await refreshStats(wsUrl, range)
      setStats(data)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Refresh failed')
    } finally {
      setIsRefreshing(false)
    }
  }, [wsUrl, range])

  return { stats, isLoading, error, isRefreshing, refresh }
}
