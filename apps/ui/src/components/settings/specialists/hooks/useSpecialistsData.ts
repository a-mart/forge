import { useCallback, useEffect, useRef, useState } from 'react'
import type { ResolvedSpecialistDefinition } from '@forge/protocol'
import type { SettingsApiClient } from '../../settings-api-client'
import {
  fetchSpecialists,
  fetchSharedSpecialists,
  fetchSpecialistsEnabled,
  setSpecialistsEnabledApi,
} from '../../specialists-api'

/**
 * Manages loading of specialist definitions and the global enabled toggle.
 */
export function useSpecialistsData(
  clientOrWsUrl: SettingsApiClient | string,
  selectedScope: string,
  isGlobal: boolean,
  specialistChangeKey: number,
) {
  const [specialists, setSpecialists] = useState<ResolvedSpecialistDefinition[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const loadRequestIdRef = useRef(0)

  // Global specialists enabled toggle
  const [specialistsEnabled, setSpecialistsEnabled] = useState(true)
  const [enabledLoading, setEnabledLoading] = useState(true)
  const [enabledToggling, setEnabledToggling] = useState(false)

  // Reset specialists on scope change — MUST be declared before the load effect
  // so that React runs it first (effects fire in declaration order), ensuring the
  // request ID is incremented before loadSpecialists captures its own ID.
  useEffect(() => {
    loadRequestIdRef.current += 1
    setSpecialists([])
    setLoading(true)
    setError(null)
  }, [selectedScope])

  const loadSpecialists = useCallback(async (): Promise<ResolvedSpecialistDefinition[]> => {
    const requestId = ++loadRequestIdRef.current
    setLoading(true)
    setError(null)

    try {
      const data = isGlobal
        ? await fetchSharedSpecialists(clientOrWsUrl)
        : await fetchSpecialists(clientOrWsUrl, selectedScope)
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
  }, [clientOrWsUrl, selectedScope, isGlobal])

  useEffect(() => {
    void loadSpecialists()
  }, [loadSpecialists, specialistChangeKey])

  // Load global enabled state
  useEffect(() => {
    let cancelled = false
    setEnabledLoading(true)
    fetchSpecialistsEnabled(clientOrWsUrl)
      .then((enabled) => { if (!cancelled) setSpecialistsEnabled(enabled) })
      .catch(() => { /* default to true on error */ })
      .finally(() => { if (!cancelled) setEnabledLoading(false) })
    return () => { cancelled = true }
  }, [clientOrWsUrl, specialistChangeKey])

  const handleToggleEnabled = useCallback(async () => {
    const next = !specialistsEnabled
    setEnabledToggling(true)
    try {
      await setSpecialistsEnabledApi(clientOrWsUrl, next)
      setSpecialistsEnabled(next)
    } catch {
      // Revert on failure — the WS event will correct if needed
    } finally {
      setEnabledToggling(false)
    }
  }, [clientOrWsUrl, specialistsEnabled])

  return {
    specialists,
    loading,
    error,
    loadSpecialists,
    specialistsEnabled,
    enabledLoading,
    enabledToggling,
    handleToggleEnabled,
  }
}
