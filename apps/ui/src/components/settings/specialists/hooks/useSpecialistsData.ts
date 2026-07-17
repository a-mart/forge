import { useCallback, useEffect, useRef, useState } from 'react'
import type { ResolvedSpecialistDefinition } from '@forge/protocol'
import type { SettingsSessionContext } from '../../session-context'
import type { SettingsApiClient } from '../../settings-api-client'
import {
  fetchSpecialists,
  fetchSharedSpecialists,
  fetchChannelSpecialists,
} from '../../specialists-api'

/**
 * Manages loading of specialist definitions for the selected scope.
 *
 * When `channelId` is provided, specialists are loaded from the channel
 * specialist endpoint rather than the global or profile endpoints.
 */
export function useSpecialistsData(
  clientOrWsUrl: SettingsApiClient | string,
  selectedScope: string,
  isGlobal: boolean,
  specialistChangeKey: number,
  channelId?: string,
  previewSession?: SettingsSessionContext | null,
) {
  const [specialists, setSpecialists] = useState<ResolvedSpecialistDefinition[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const loadRequestIdRef = useRef(0)

  // Channel selection metadata (only populated for channel scope)
  const [selectedGlobalHandles, setSelectedGlobalHandles] = useState<string[]>([])
  const [missingSelectedHandles, setMissingSelectedHandles] = useState<string[]>([])

  // Reset specialists on scope change — MUST be declared before the load effect
  // so that React runs it first (effects fire in declaration order), ensuring the
  // request ID is incremented before loadSpecialists captures its own ID.
  useEffect(() => {
    loadRequestIdRef.current += 1
    setSpecialists([])
    setLoading(true)
    setError(null)
    setSelectedGlobalHandles([])
    setMissingSelectedHandles([])
  }, [selectedScope])

  const loadSpecialists = useCallback(async (): Promise<ResolvedSpecialistDefinition[]> => {
    const requestId = ++loadRequestIdRef.current
    setLoading(true)
    setError(null)

    try {
      let data: ResolvedSpecialistDefinition[]

      if (channelId) {
        // Channel scope — load from channel specialist endpoint
        const channelResponse = await fetchChannelSpecialists(clientOrWsUrl, channelId)
        data = channelResponse.specialists
        if (requestId === loadRequestIdRef.current) {
          setSelectedGlobalHandles(channelResponse.selectedGlobalSpecialistHandles)
          setMissingSelectedHandles(channelResponse.missingSelectedSpecialistHandles)
        }
      } else if (isGlobal) {
        data = await fetchSharedSpecialists(clientOrWsUrl)
      } else {
        const sessionAgentId = previewSession?.profileId === selectedScope ? previewSession.agentId : undefined
        data = await fetchSpecialists(clientOrWsUrl, selectedScope, sessionAgentId)
      }

      if (requestId === loadRequestIdRef.current) {
        setSpecialists(data)
      }
      return data
    } catch (err) {
      if (requestId === loadRequestIdRef.current) {
        setSpecialists([])
        setError(err instanceof Error ? err.message : 'Failed to load specialists')
      }
      return []
    } finally {
      if (requestId === loadRequestIdRef.current) {
        setLoading(false)
      }
    }
  }, [clientOrWsUrl, selectedScope, isGlobal, channelId, previewSession])

  useEffect(() => {
    void loadSpecialists()
  }, [loadSpecialists, specialistChangeKey])

  return {
    specialists,
    loading,
    error,
    loadSpecialists,
    selectedGlobalHandles,
    missingSelectedHandles,
  }
}
