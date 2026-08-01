import { useCallback, useEffect, useRef, useState } from 'react'
import type { GenerationThroughputQuery, GenerationThroughputSnapshot } from '@forge/protocol'
import { fetchGenerationThroughput, refreshGenerationThroughput } from './generation-throughput-api'

export function useGenerationThroughput(wsUrl: string, query: GenerationThroughputQuery) {
  const [snapshot, setSnapshot] = useState<GenerationThroughputSnapshot | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isSwitchingQuery, setIsSwitchingQuery] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const previousQuery = useRef('')
  const snapshotRef = useRef<GenerationThroughputSnapshot | null>(null)
  const customIncomplete = query.rangePreset === 'custom' && (!query.startDate || !query.endDate)

  useEffect(() => {
    if (customIncomplete) {
      setIsLoading(false)
      setIsSwitchingQuery(false)
      return
    }
    let cancelled = false
    const queryKey = JSON.stringify(query)
    const changed = previousQuery.current !== queryKey
    previousQuery.current = queryKey
    if (snapshotRef.current && changed) setIsSwitchingQuery(true)
    else setIsLoading(true)
    setError(null)

    fetchGenerationThroughput(wsUrl, query)
      .then((next) => {
        if (!cancelled) {
          snapshotRef.current = next
          setSnapshot(next)
        }
      })
      .catch((nextError) => {
        if (!cancelled) setError(nextError)
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false)
          setIsSwitchingQuery(false)
        }
      })
    return () => { cancelled = true }
  }, [customIncomplete, query, wsUrl]) // query is intentionally the request identity

  const refresh = useCallback(async () => {
    setIsRefreshing(true)
    try {
      const next = await refreshGenerationThroughput(wsUrl, query)
      snapshotRef.current = next
      setSnapshot(next)
      setError(null)
    } catch (nextError) {
      setError(nextError)
    } finally {
      setIsRefreshing(false)
    }
  }, [query, wsUrl])

  return { snapshot, isLoading, isRefreshing, isSwitchingQuery, error, refresh }
}
