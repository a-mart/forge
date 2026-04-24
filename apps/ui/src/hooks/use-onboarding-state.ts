import { useCallback, useEffect, useState } from 'react'
import {
  fetchOnboardingState,
  fetchOnboardingStateViaClient,
  type OnboardingStateSummary,
  saveOnboardingPreferences,
  saveOnboardingPreferencesViaClient,
  skipOnboarding,
  skipOnboardingViaClient,
  type SaveOnboardingPreferencesInput,
} from '@/lib/onboarding-api'
import type { SettingsApiClient } from '@/components/settings/settings-api-client'

interface UseOnboardingStateResult {
  onboardingState: OnboardingStateSummary | null
  isLoading: boolean
  hasLoaded: boolean
  isMutating: boolean
  error: string | null
  refresh: () => Promise<OnboardingStateSummary | null>
  savePreferences: (input: SaveOnboardingPreferencesInput) => Promise<OnboardingStateSummary | null>
  skip: () => Promise<OnboardingStateSummary | null>
}

/**
 * Hook for managing onboarding state.
 *
 * Accepts either a SettingsApiClient (target-aware, used from Settings panels)
 * or a raw wsUrl string (legacy, used from non-Settings callers).
 */
export function useOnboardingState(clientOrWsUrl: SettingsApiClient | string): UseOnboardingStateResult {
  const [onboardingState, setOnboardingState] = useState<OnboardingStateSummary | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [hasLoaded, setHasLoaded] = useState(false)
  const [isMutating, setIsMutating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Stable identity key for the dependency — use the apiBaseUrl for clients, raw string for wsUrl
  const depKey = typeof clientOrWsUrl === 'string' ? clientOrWsUrl : clientOrWsUrl.target.apiBaseUrl

  const doFetch = useCallback(async (signal?: AbortSignal): Promise<OnboardingStateSummary> => {
    if (typeof clientOrWsUrl === 'string') {
      return fetchOnboardingState(clientOrWsUrl, signal)
    }
    return fetchOnboardingStateViaClient(clientOrWsUrl, signal)
  }, [clientOrWsUrl, depKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = useCallback(async (): Promise<OnboardingStateSummary | null> => {
    try {
      const nextState = await doFetch()
      setOnboardingState(nextState)
      setError(null)
      return nextState
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load onboarding state.')
      return null
    } finally {
      setHasLoaded(true)
      setIsLoading(false)
    }
  }, [doFetch])

  useEffect(() => {
    const abortController = new AbortController()
    setIsLoading(true)

    void (async () => {
      try {
        const nextState = await doFetch(abortController.signal)
        if (abortController.signal.aborted) {
          return
        }
        setOnboardingState(nextState)
        setError(null)
      } catch (err) {
        if (abortController.signal.aborted) {
          return
        }
        setError(err instanceof Error ? err.message : 'Failed to load onboarding state.')
      } finally {
        if (!abortController.signal.aborted) {
          setHasLoaded(true)
          setIsLoading(false)
        }
      }
    })()

    return () => {
      abortController.abort()
    }
  }, [doFetch])

  const savePreferencesAction = useCallback(async (
    input: SaveOnboardingPreferencesInput,
  ): Promise<OnboardingStateSummary | null> => {
    setIsMutating(true)
    try {
      const nextState = typeof clientOrWsUrl === 'string'
        ? await saveOnboardingPreferences(clientOrWsUrl, input)
        : await saveOnboardingPreferencesViaClient(clientOrWsUrl, input)
      setOnboardingState(nextState)
      setError(null)
      return nextState
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save onboarding preferences.')
      return null
    } finally {
      setIsMutating(false)
    }
  }, [clientOrWsUrl, depKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const skipAction = useCallback(async (): Promise<OnboardingStateSummary | null> => {
    setIsMutating(true)
    try {
      const nextState = typeof clientOrWsUrl === 'string'
        ? await skipOnboarding(clientOrWsUrl)
        : await skipOnboardingViaClient(clientOrWsUrl)
      setOnboardingState(nextState)
      setError(null)
      return nextState
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to skip onboarding.')
      return null
    } finally {
      setIsMutating(false)
    }
  }, [clientOrWsUrl, depKey]) // eslint-disable-line react-hooks/exhaustive-deps

  return {
    onboardingState,
    isLoading,
    hasLoaded,
    isMutating,
    error,
    refresh,
    savePreferences: savePreferencesAction,
    skip: skipAction,
  }
}
