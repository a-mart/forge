import type { OnboardingState, OnboardingStatus } from '@forge/protocol'
import { resolveApiEndpoint } from '@/lib/api-endpoint'

export type OnboardingStateSummary = Pick<
  OnboardingState,
  | 'status'
  | 'cycleId'
  | 'revision'
  | 'firstPromptSentAt'
  | 'startedAt'
  | 'completedAt'
  | 'deferredAt'
  | 'migratedAt'
  | 'lastUpdatedAt'
  | 'captured'
>

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

export async function updateOnboardingStatus(
  wsUrl: string,
  input: { status: Extract<OnboardingStatus, 'active' | 'deferred'>; reason?: string | null },
): Promise<OnboardingStateSummary> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/onboarding/state')
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })

  if (!response.ok) {
    throw new Error(await readApiError(response, 'Failed to update onboarding state.'))
  }

  const payload = (await response.json()) as OnboardingStateResponse
  if (!payload.state) {
    throw new Error('Onboarding state update response is missing state data.')
  }

  return payload.state
}
