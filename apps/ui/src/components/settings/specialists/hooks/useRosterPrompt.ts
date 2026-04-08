import { useCallback, useRef, useState } from 'react'
import { fetchRosterPrompt } from '../../specialists-api'

/**
 * Manages the roster prompt dialog state and fetching.
 */
export function useRosterPrompt(wsUrl: string, selectedScope: string, isGlobal: boolean) {
  const rosterRequestIdRef = useRef(0)
  const [rosterOpen, setRosterOpen] = useState(false)
  const [rosterMarkdown, setRosterMarkdown] = useState('')
  const [rosterLoading, setRosterLoading] = useState(false)
  const [rosterError, setRosterError] = useState<string | null>(null)

  const handleViewRoster = useCallback(async () => {
    if (isGlobal) return

    const requestId = ++rosterRequestIdRef.current
    setRosterOpen(true)
    setRosterLoading(true)
    setRosterError(null)

    try {
      const markdown = await fetchRosterPrompt(wsUrl, selectedScope)
      if (requestId === rosterRequestIdRef.current) {
        setRosterMarkdown(markdown)
      }
    } catch (err) {
      if (requestId === rosterRequestIdRef.current) {
        setRosterMarkdown('')
        setRosterError(err instanceof Error ? err.message : 'Failed to load roster prompt')
      }
    } finally {
      if (requestId === rosterRequestIdRef.current) {
        setRosterLoading(false)
      }
    }
  }, [wsUrl, selectedScope, isGlobal])

  /** Reset roster state (used on scope change). */
  const resetRoster = useCallback(() => {
    rosterRequestIdRef.current += 1
    setRosterLoading(false)
    setRosterMarkdown('')
    setRosterError(null)
  }, [])

  return {
    rosterOpen,
    setRosterOpen,
    rosterMarkdown,
    rosterLoading,
    rosterError,
    handleViewRoster,
    resetRoster,
  }
}
