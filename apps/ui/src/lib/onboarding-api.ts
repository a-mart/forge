import type { OnboardingState, OnboardingTechnicalLevel } from '@forge/protocol'
import { resolveApiEndpoint } from '@/lib/api-endpoint'

export type OnboardingStateSummary = Pick<OnboardingState, 'status' | 'completedAt' | 'skippedAt' | 'preferences'>

export interface SaveOnboardingPreferencesInput {
  preferredName: string
  technicalLevel: OnboardingTechnicalLevel
  additionalPreferences?: string | null
}

interface OnboardingStateResponse {
  state?: OnboardingStateSummary
  error?: string
}

function readApiError(response: Response, fallback: string): Promise<string> {
  return response
    .json()
    .then((payload) => {
      if (payload && typeof payload === 'object' && typeof (payload as { error?: unknown }).error === 'string') {
        return (payload as { error: string }).error
      }
      return fallback
    })
    .catch(() => fallback)
}

export async function fetchOnboardingState(
  wsUrl: string,
  signal?: AbortSignal,
): Promise<OnboardingStateSummary> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/onboarding/state')
  const response = await fetch(endpoint, { signal })
  if (!response.ok) {
    throw new Error(await readApiError(response, 'Failed to load onboarding state.'))
  }

  const payload = (await response.json()) as OnboardingStateResponse
  if (!payload.state) {
    throw new Error('Onboarding state response is missing state data.')
  }

  return payload.state
}

export async function saveOnboardingPreferences(
  wsUrl: string,
  input: SaveOnboardingPreferencesInput,
): Promise<OnboardingStateSummary> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/onboarding/preferences')
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })

  if (!response.ok) {
    throw new Error(await readApiError(response, 'Failed to save onboarding preferences.'))
  }

  const payload = (await response.json()) as OnboardingStateResponse
  if (!payload.state) {
    throw new Error('Onboarding preferences response is missing state data.')
  }

  return payload.state
}

export async function skipOnboarding(
  wsUrl: string,
): Promise<OnboardingStateSummary> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/onboarding/preferences')
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'skipped' }),
  })

  if (!response.ok) {
    throw new Error(await readApiError(response, 'Failed to skip onboarding.'))
  }

  const payload = (await response.json()) as OnboardingStateResponse
  if (!payload.state) {
    throw new Error('Onboarding skip response is missing state data.')
  }

  return payload.state
}
