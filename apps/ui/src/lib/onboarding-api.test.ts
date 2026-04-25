/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { SettingsApiClient } from '@/components/settings/settings-api-client'
import type { SettingsBackendTarget } from '@/components/settings/settings-target'

vi.mock('@/lib/api-endpoint', () => ({
  resolveApiEndpoint: (wsUrl: string, path: string) => {
    try {
      const parsed = new URL(wsUrl)
      parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:'
      return new URL(path, parsed.origin).toString()
    } catch {
      return path
    }
  },
}))

const {
  fetchOnboardingStateViaClient,
  saveOnboardingPreferencesViaClient,
  skipOnboardingViaClient,
  fetchOnboardingState,
  saveOnboardingPreferences,
  skipOnboarding,
} = await import('./onboarding-api')

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function makeBuilderTarget(): SettingsBackendTarget {
  return {
    kind: 'builder',
    label: 'Builder',
    description: 'Local builder backend',
    wsUrl: 'ws://127.0.0.1:47187',
    apiBaseUrl: 'http://127.0.0.1:47187/',
    fetchCredentials: 'same-origin',
    requiresAdmin: false,
    availableTabs: ['general'],
  }
}

function makeCollabTarget(): SettingsBackendTarget {
  return {
    kind: 'collab',
    label: 'Collab',
    description: 'Remote collab backend',
    wsUrl: 'wss://collab.example.com',
    apiBaseUrl: 'https://collab.example.com/',
    fetchCredentials: 'include',
    requiresAdmin: true,
    availableTabs: ['general', 'auth'],
  }
}

function makeApiClient(target: SettingsBackendTarget): SettingsApiClient & { fetch: MockInstance } {
  const mockFetch = vi.fn()
  return {
    target,
    endpoint: (path: string) => `${target.apiBaseUrl.replace(/\/$/, '')}${path}`,
    fetch: mockFetch,
    fetchJson: vi.fn(),
    readApiError: vi.fn().mockImplementation(async (response: Response) => {
      try {
        const body = await response.json()
        if (body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string') {
          return (body as { error: string }).error
        }
      } catch { /* empty */ }
      return `Request failed (${response.status})`
    }),
  }
}

const MOCK_STATE = {
  status: 'completed' as const,
  completedAt: '2026-01-01T00:00:00Z',
  skippedAt: null,
  preferences: {
    preferredName: 'Test',
    technicalLevel: 'developer' as const,
  },
}

/* ================================================================== */
/*  Target-aware client functions                                      */
/* ================================================================== */

describe('onboarding-api — client functions', () => {
  describe('fetchOnboardingStateViaClient', () => {
    it('calls client.fetch with /api/onboarding/state', async () => {
      const client = makeApiClient(makeBuilderTarget())
      client.fetch.mockResolvedValue(
        new Response(JSON.stringify({ state: MOCK_STATE }), { status: 200 }),
      )

      const result = await fetchOnboardingStateViaClient(client)

      expect(client.fetch).toHaveBeenCalledWith('/api/onboarding/state', { signal: undefined })
      expect(result).toEqual(MOCK_STATE)
    })

    it('passes abort signal when provided', async () => {
      const client = makeApiClient(makeCollabTarget())
      const controller = new AbortController()
      client.fetch.mockResolvedValue(
        new Response(JSON.stringify({ state: MOCK_STATE }), { status: 200 }),
      )

      await fetchOnboardingStateViaClient(client, controller.signal)

      expect(client.fetch).toHaveBeenCalledWith('/api/onboarding/state', { signal: controller.signal })
    })

    it('throws when response is not ok', async () => {
      const client = makeApiClient(makeCollabTarget())
      client.fetch.mockResolvedValue(
        new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
      )

      await expect(fetchOnboardingStateViaClient(client)).rejects.toThrow()
    })

    it('throws when response state is missing', async () => {
      const client = makeApiClient(makeBuilderTarget())
      client.fetch.mockResolvedValue(
        new Response(JSON.stringify({}), { status: 200 }),
      )

      await expect(fetchOnboardingStateViaClient(client)).rejects.toThrow(
        'Onboarding state response is missing state data.',
      )
    })
  })

  describe('saveOnboardingPreferencesViaClient', () => {
    it('POSTs to /api/onboarding/preferences with JSON body', async () => {
      const client = makeApiClient(makeBuilderTarget())
      client.fetch.mockResolvedValue(
        new Response(JSON.stringify({ state: MOCK_STATE }), { status: 200 }),
      )

      const input = { preferredName: 'Test', technicalLevel: 'developer' as const }
      const result = await saveOnboardingPreferencesViaClient(client, input)

      expect(client.fetch).toHaveBeenCalledWith('/api/onboarding/preferences', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      })
      expect(result).toEqual(MOCK_STATE)
    })

    it('throws when response is not ok', async () => {
      const client = makeApiClient(makeCollabTarget())
      client.fetch.mockResolvedValue(
        new Response(JSON.stringify({ error: 'Validation failed' }), { status: 422 }),
      )

      await expect(
        saveOnboardingPreferencesViaClient(client, {
          preferredName: '',
          technicalLevel: 'developer',
        }),
      ).rejects.toThrow()
    })

    it('throws when response state is missing', async () => {
      const client = makeApiClient(makeBuilderTarget())
      client.fetch.mockResolvedValue(
        new Response(JSON.stringify({}), { status: 200 }),
      )

      await expect(
        saveOnboardingPreferencesViaClient(client, {
          preferredName: 'Test',
          technicalLevel: 'developer',
        }),
      ).rejects.toThrow('Onboarding preferences response is missing state data.')
    })
  })

  describe('skipOnboardingViaClient', () => {
    it('POSTs { status: "skipped" } to /api/onboarding/preferences', async () => {
      const client = makeApiClient(makeCollabTarget())
      client.fetch.mockResolvedValue(
        new Response(JSON.stringify({ state: { ...MOCK_STATE, status: 'skipped', skippedAt: '2026-01-01T00:00:00Z' } }), { status: 200 }),
      )

      const result = await skipOnboardingViaClient(client)

      expect(client.fetch).toHaveBeenCalledWith('/api/onboarding/preferences', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'skipped' }),
      })
      expect(result.status).toBe('skipped')
    })

    it('throws when response is not ok', async () => {
      const client = makeApiClient(makeBuilderTarget())
      client.fetch.mockResolvedValue(
        new Response(JSON.stringify({ error: 'Server error' }), { status: 500 }),
      )

      await expect(skipOnboardingViaClient(client)).rejects.toThrow()
    })
  })
})

/* ================================================================== */
/*  Legacy raw-wsUrl functions                                         */
/* ================================================================== */

describe('onboarding-api — legacy wsUrl functions', () => {
  let fetchSpy: MockInstance

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  describe('fetchOnboardingState', () => {
    it('fetches from Builder endpoint with same-origin credentials by default', async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ state: MOCK_STATE }), { status: 200 }),
      )

      const result = await fetchOnboardingState('ws://127.0.0.1:47187')

      expect(fetchSpy).toHaveBeenCalledWith(
        'http://127.0.0.1:47187/api/onboarding/state',
        expect.objectContaining({ signal: undefined }),
      )
      expect(result).toEqual(MOCK_STATE)
    })

    it('passes abort signal', async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ state: MOCK_STATE }), { status: 200 }),
      )
      const controller = new AbortController()

      await fetchOnboardingState('ws://127.0.0.1:47187', controller.signal)

      expect(fetchSpy).toHaveBeenCalledWith(
        'http://127.0.0.1:47187/api/onboarding/state',
        expect.objectContaining({ signal: controller.signal }),
      )
    })

    it('throws on error response', async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ error: 'Not found' }), { status: 404 }),
      )

      await expect(fetchOnboardingState('ws://127.0.0.1:47187')).rejects.toThrow('Not found')
    })
  })

  describe('saveOnboardingPreferences', () => {
    it('POSTs preferences to the Builder endpoint', async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ state: MOCK_STATE }), { status: 200 }),
      )

      const input = { preferredName: 'Test', technicalLevel: 'developer' as const }
      await saveOnboardingPreferences('ws://127.0.0.1:47187', input)

      expect(fetchSpy).toHaveBeenCalledWith(
        'http://127.0.0.1:47187/api/onboarding/preferences',
        expect.objectContaining({
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        }),
      )
    })

    it('throws on error response', async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ error: 'Validation failed' }), { status: 422 }),
      )

      await expect(
        saveOnboardingPreferences('ws://127.0.0.1:47187', {
          preferredName: '',
          technicalLevel: 'developer',
        }),
      ).rejects.toThrow('Validation failed')
    })
  })

  describe('skipOnboarding', () => {
    it('POSTs skip request to the Builder endpoint', async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ state: { ...MOCK_STATE, status: 'skipped' } }), { status: 200 }),
      )

      await skipOnboarding('ws://127.0.0.1:47187')

      expect(fetchSpy).toHaveBeenCalledWith(
        'http://127.0.0.1:47187/api/onboarding/preferences',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ status: 'skipped' }),
        }),
      )
    })

    it('throws on error response', async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ error: 'Server error' }), { status: 500 }),
      )

      await expect(skipOnboarding('ws://127.0.0.1:47187')).rejects.toThrow('Server error')
    })
  })
})
