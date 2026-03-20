import { useCallback, useEffect, useState } from 'react'
import {
  fetchOnboardingState,
  type OnboardingStateSummary,
  saveOnboardingPreferences,
  skipOnboarding,
  type SaveOnboardingPreferencesInput,
} from '@/lib/onboarding-api'

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

export function useOnboardingState(wsUrl: string): UseOnboardingStateResult {
  const [onboardingState, setOnboardingState] = useState<OnboardingStateSummary | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [hasLoaded, setHasLoaded] = useState(false)
  const [isMutating, setIsMutating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<OnboardingStateSummary | null> => {
    try {
      const nextState = await fetchOnboardingState(wsUrl)
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
  }, [wsUrl])

  useEffect(() => {
    const abortController = new AbortController()
    setIsLoading(true)

    void (async () => {
      try {
        const nextState = await fetchOnboardingState(wsUrl, abortController.signal)
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
  }, [wsUrl])

  const savePreferencesAction = useCallback(async (
    input: SaveOnboardingPreferencesInput,
  ): Promise<OnboardingStateSummary | null> => {
    setIsMutating(true)
    try {
      const nextState = await saveOnboardingPreferences(wsUrl, input)
      setOnboardingState(nextState)
      setError(null)
      return nextState
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save onboarding preferences.')
      return null
    } finally {
      setIsMutating(false)
    }
  }, [wsUrl])

  const skipAction = useCallback(async (): Promise<OnboardingStateSummary | null> => {
    setIsMutating(true)
    try {
      const nextState = await skipOnboarding(wsUrl)
      setOnboardingState(nextState)
      setError(null)
      return nextState
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to skip onboarding.')
      return null
    } finally {
      setIsMutating(false)
    }
  }, [wsUrl])

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
