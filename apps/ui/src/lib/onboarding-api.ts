import type { OnboardingState, OnboardingTechnicalLevel } from '@forge/protocol'
import { resolveApiEndpoint } from '@/lib/api-endpoint'
import type { SettingsApiClient } from '@/components/settings/settings-api-client'

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

function readApiErrorFallback(response: Response, fallback: string): Promise<string> {
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

/* ------------------------------------------------------------------ */
/*  Target-aware functions (for Settings paths via SettingsApiClient) */
/* ------------------------------------------------------------------ */

export async function fetchOnboardingStateViaClient(
  client: SettingsApiClient,
  signal?: AbortSignal,
): Promise<OnboardingStateSummary> {
  const response = await client.fetch('/api/onboarding/state', { signal })
  if (!response.ok) {
    throw new Error(await client.readApiError(response))
  }

  const payload = (await response.json()) as OnboardingStateResponse
  if (!payload.state) {
    throw new Error('Onboarding state response is missing state data.')
  }

  return payload.state
}

export async function saveOnboardingPreferencesViaClient(
  client: SettingsApiClient,
  input: SaveOnboardingPreferencesInput,
): Promise<OnboardingStateSummary> {
  const response = await client.fetch('/api/onboarding/preferences', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })

  if (!response.ok) {
    throw new Error(await client.readApiError(response))
  }

  const payload = (await response.json()) as OnboardingStateResponse
  if (!payload.state) {
    throw new Error('Onboarding preferences response is missing state data.')
  }

  return payload.state
}

export async function skipOnboardingViaClient(
  client: SettingsApiClient,
): Promise<OnboardingStateSummary> {
  const response = await client.fetch('/api/onboarding/preferences', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'skipped' }),
  })

  if (!response.ok) {
    throw new Error(await client.readApiError(response))
  }

  const payload = (await response.json()) as OnboardingStateResponse
  if (!payload.state) {
    throw new Error('Onboarding skip response is missing state data.')
  }

  return payload.state
}

/* ------------------------------------------------------------------ */
/*  Legacy raw-wsUrl functions (for non-Settings callers)             */
/* ------------------------------------------------------------------ */

export async function fetchOnboardingState(
  wsUrl: string,
  signal?: AbortSignal,
): Promise<OnboardingStateSummary> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/onboarding/state')
  const response = await fetch(endpoint, { signal })
  if (!response.ok) {
    throw new Error(await readApiErrorFallback(response, 'Failed to load onboarding state.'))
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
    throw new Error(await readApiErrorFallback(response, 'Failed to save onboarding preferences.'))
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
    throw new Error(await readApiErrorFallback(response, 'Failed to skip onboarding.'))
  }

  const payload = (await response.json()) as OnboardingStateResponse
  if (!payload.state) {
    throw new Error('Onboarding skip response is missing state data.')
  }

  return payload.state
}
