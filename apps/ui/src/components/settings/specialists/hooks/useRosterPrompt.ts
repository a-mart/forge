import { useCallback, useRef, useState } from 'react'
import type { SettingsApiClient } from '../../settings-api-client'
import { fetchRosterPrompt, fetchChannelRosterPrompt } from '../../specialists-api'

/**
 * Manages the roster prompt dialog state and fetching.
 *
 * When `channelId` is provided, the channel-specific roster prompt endpoint
 * is used instead of the profile roster prompt.
 */
export function useRosterPrompt(
  clientOrWsUrl: SettingsApiClient | string,
  selectedScope: string,
  isGlobal: boolean,
  channelId?: string,
) {
  const rosterRequestIdRef = useRef(0)
  const [rosterOpen, setRosterOpen] = useState(false)
  const [rosterMarkdown, setRosterMarkdown] = useState('')
  const [rosterLoading, setRosterLoading] = useState(false)
  const [rosterError, setRosterError] = useState<string | null>(null)

  const handleViewRoster = useCallback(async () => {
    if (isGlobal && !channelId) return

    const requestId = ++rosterRequestIdRef.current
    setRosterOpen(true)
    setRosterLoading(true)
    setRosterError(null)

    try {
      const markdown = channelId
        ? await fetchChannelRosterPrompt(clientOrWsUrl, channelId)
        : await fetchRosterPrompt(clientOrWsUrl, selectedScope)
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
  }, [clientOrWsUrl, selectedScope, isGlobal, channelId])

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
