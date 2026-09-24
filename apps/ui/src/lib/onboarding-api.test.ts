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

/* ================================================================== */
/*  Target-aware client functions                                      */
/* ================================================================== */

describe('onboarding-api — client functions', () => {
  describe('fetchOnboardingStateViaClient', () => {
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
    it('throws on error response', async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ error: 'Not found' }), { status: 404 }),
      )

      await expect(fetchOnboardingState('ws://127.0.0.1:47187')).rejects.toThrow('Not found')
    })
  })

  describe('saveOnboardingPreferences', () => {
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
    it('throws on error response', async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ error: 'Server error' }), { status: 500 }),
      )

      await expect(skipOnboarding('ws://127.0.0.1:47187')).rejects.toThrow('Server error')
    })
  })
})
