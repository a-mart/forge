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

  const requestSequence = useRef(0)

  useEffect(() => {
    const sequence = ++requestSequence.current
    setIsRefreshing(false)
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
        if (!cancelled && sequence === requestSequence.current) {
          snapshotRef.current = next
          setSnapshot(next)
        }
      })
      .catch((nextError) => {
        if (!cancelled && sequence === requestSequence.current) setError(nextError)
      })
      .finally(() => {
        if (!cancelled && sequence === requestSequence.current) {
          setIsLoading(false)
          setIsSwitchingQuery(false)
        }
      })
    return () => { cancelled = true; requestSequence.current += 1 }
  }, [customIncomplete, query, wsUrl]) // query is intentionally the request identity

  const refresh = useCallback(async () => {
    const sequence = ++requestSequence.current
    setIsRefreshing(true)
    try {
      const next = await refreshGenerationThroughput(wsUrl, query)
      if (sequence !== requestSequence.current) return
      snapshotRef.current = next
      setSnapshot(next)
      setError(null)
    } catch (nextError) {
      if (sequence !== requestSequence.current) return
      setError(nextError)
    } finally {
      if (sequence === requestSequence.current) {
        setIsRefreshing(false)
        setIsLoading(false)
        setIsSwitchingQuery(false)
      }
    }
  }, [query, wsUrl])

  return { snapshot, isLoading, isRefreshing, isSwitchingQuery, error, refresh }
}
