import { useEffect, useRef, useState } from 'react'
import type { HistoryIndexStatus } from '@forge/protocol'
import { fetchHistoryIndex, setHistoryIndexPaused } from './history-index-api'

/** Mounted per backend origin by SettingsHistory. No polling while hidden. */
export function useHistoryIndex(wsUrl: string) {
  const [status, setStatus] = useState<HistoryIndexStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [updating, setUpdating] = useState(false)
  const alive = useRef(false)
  const busy = useRef(false)
  const sequence = useRef(0)
  const request = useRef<AbortController | null>(null)
  const refreshRef = useRef<() => void>(() => {})

  useEffect(() => {
    alive.current = true
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    async function load() {
      if (!alive.current || busy.current) return
      const id = ++sequence.current
      request.current?.abort()
      const controller = new AbortController()
      request.current = controller
      try {
        const next = await fetchHistoryIndex(wsUrl, controller.signal)
        if (!cancelled && id === sequence.current) { setStatus(next); setError(null) }
      } catch (cause) {
        if (!cancelled && id === sequence.current && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Unable to refresh history status.')
      }
    }
    async function poll() {
      if (!document.hidden) await load()
      if (!cancelled) timer = setTimeout(poll, 5000)
    }
    refreshRef.current = () => { void load() }
    void poll()
    return () => { cancelled = true; alive.current = false; request.current?.abort(); clearTimeout(timer) }
  }, [wsUrl])

  async function togglePaused() {
    if (!status || busy.current) return
    busy.current = true
    setUpdating(true)
    const id = ++sequence.current
    request.current?.abort()
    try {
      const next = await setHistoryIndexPaused(wsUrl, !status.paused)
      if (alive.current && id === sequence.current) { setStatus(next); setError(null) }
    } catch (cause) {
      if (alive.current && id === sequence.current) setError(cause instanceof Error ? cause.message : 'Unable to save indexing preference.')
    } finally {
      busy.current = false
      if (alive.current) setUpdating(false)
    }
  }

  return { status, error, updating, refresh: () => refreshRef.current(), togglePaused }
}
