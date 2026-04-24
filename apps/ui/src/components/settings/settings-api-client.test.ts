/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

vi.mock('@/lib/collaboration-endpoints', () => ({
  resolveCollaborationApiBaseUrl: () => 'https://collab.example.com/',
}))

const { createSettingsApiClient, createBuilderSettingsApiClient } = await import('./settings-api-client')
const { createBuilderSettingsTarget, createCollabSettingsTarget } = await import('./settings-target')

describe('SettingsApiClient', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn<typeof globalThis, 'fetch'>>

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }),
    )
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  describe('endpoint', () => {
    it('resolves paths against the builder target base URL', () => {
      const client = createSettingsApiClient(createBuilderSettingsTarget('ws://127.0.0.1:47187'))

      expect(client.endpoint('/api/settings/auth')).toBe('http://127.0.0.1:47187/api/settings/auth')
    })

    it('resolves paths against the collab target base URL', () => {
      const client = createSettingsApiClient(createCollabSettingsTarget('wss://collab.example.com'))

      expect(client.endpoint('/api/settings/auth')).toBe('https://collab.example.com/api/settings/auth')
    })

    it('handles query parameters in paths', () => {
      const client = createSettingsApiClient(createBuilderSettingsTarget('ws://127.0.0.1:47187'))

      expect(client.endpoint('/api/stats?range=7d')).toBe('http://127.0.0.1:47187/api/stats?range=7d')
    })
  })

  describe('fetch', () => {
    it('uses same-origin credentials for builder target', async () => {
      const client = createSettingsApiClient(createBuilderSettingsTarget('ws://127.0.0.1:47187'))

      await client.fetch('/api/settings/auth')

      expect(fetchSpy).toHaveBeenCalledWith(
        'http://127.0.0.1:47187/api/settings/auth',
        expect.objectContaining({ credentials: 'same-origin' }),
      )
    })

    it('uses include credentials for collab target', async () => {
      const client = createSettingsApiClient(createCollabSettingsTarget('wss://collab.example.com'))

      await client.fetch('/api/settings/auth')

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://collab.example.com/api/settings/auth',
        expect.objectContaining({ credentials: 'include' }),
      )
    })

    it('allows explicit credentials override', async () => {
      const client = createSettingsApiClient(createBuilderSettingsTarget('ws://127.0.0.1:47187'))

      await client.fetch('/api/settings/auth', { credentials: 'omit' })

      expect(fetchSpy).toHaveBeenCalledWith(
        'http://127.0.0.1:47187/api/settings/auth',
        expect.objectContaining({ credentials: 'omit' }),
      )
    })

    it('preserves AbortSignal', async () => {
      const controller = new AbortController()
      const client = createSettingsApiClient(createBuilderSettingsTarget('ws://127.0.0.1:47187'))

      await client.fetch('/api/settings/auth', { signal: controller.signal })

      expect(fetchSpy).toHaveBeenCalledWith(
        'http://127.0.0.1:47187/api/settings/auth',
        expect.objectContaining({ signal: controller.signal }),
      )
    })

    it('preserves request method and headers', async () => {
      const client = createSettingsApiClient(createCollabSettingsTarget('wss://collab.example.com'))

      await client.fetch('/api/settings/auth', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: '{"key":"value"}',
      })

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://collab.example.com/api/settings/auth',
        expect.objectContaining({
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: '{"key":"value"}',
          credentials: 'include',
        }),
      )
    })

    it('preserves cache option', async () => {
      const client = createSettingsApiClient(createBuilderSettingsTarget('ws://127.0.0.1:47187'))

      await client.fetch('/api/settings/auth', { cache: 'no-store' })

      expect(fetchSpy).toHaveBeenCalledWith(
        'http://127.0.0.1:47187/api/settings/auth',
        expect.objectContaining({ cache: 'no-store' }),
      )
    })
  })

  describe('fetchJson', () => {
    it('parses JSON response', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ providers: ['anthropic'] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )

      const client = createSettingsApiClient(createBuilderSettingsTarget('ws://127.0.0.1:47187'))
      const result = await client.fetchJson<{ providers: string[] }>('/api/settings/auth')

      expect(result).toEqual({ providers: ['anthropic'] })
    })

    it('throws on error response with error message from body', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
      )

      const client = createSettingsApiClient(createCollabSettingsTarget('wss://collab.example.com'))

      await expect(client.fetchJson('/api/settings/auth')).rejects.toThrow('Unauthorized')
    })
  })

  describe('readApiError', () => {
    it('extracts error field from JSON response', async () => {
      const response = new Response(JSON.stringify({ error: 'Bad request' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })

      const client = createSettingsApiClient(createBuilderSettingsTarget('ws://127.0.0.1:47187'))
      const message = await client.readApiError(response)

      expect(message).toBe('Bad request')
    })

    it('falls back to status code', async () => {
      const response = new Response('', { status: 500 })

      const client = createSettingsApiClient(createBuilderSettingsTarget('ws://127.0.0.1:47187'))
      const message = await client.readApiError(response)

      expect(message).toBe('Request failed (500)')
    })
  })

  describe('createBuilderSettingsApiClient', () => {
    it('creates a builder client from a raw wsUrl', async () => {
      const client = createBuilderSettingsApiClient('ws://127.0.0.1:47187')

      expect(client.target.kind).toBe('builder')
      expect(client.endpoint('/api/settings/auth')).toBe('http://127.0.0.1:47187/api/settings/auth')

      await client.fetch('/api/settings/auth')

      expect(fetchSpy).toHaveBeenCalledWith(
        'http://127.0.0.1:47187/api/settings/auth',
        expect.objectContaining({ credentials: 'same-origin' }),
      )
    })
  })
})
