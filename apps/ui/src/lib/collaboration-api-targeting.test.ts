/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fetchMock = vi.fn()

vi.mock('./collaboration-endpoints', () => ({
  resolveCollaborationApiBaseUrl: () => 'https://default.example.com',
}))

const collabApi = await import('./collaboration-api')

describe('collaboration-api target-aware routing', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** Extract the URL from the most recent fetch call. */
  function lastFetchUrl(): string {
    const calls = fetchMock.mock.calls
    expect(calls.length).toBeGreaterThan(0)
    const last = calls[calls.length - 1]!
    return typeof last[0] === 'string' ? last[0] : (last[0] as URL | Request).toString()
  }

  function lastFetchInit(): RequestInit | undefined {
    const calls = fetchMock.mock.calls
    return calls[calls.length - 1]![1] as RequestInit | undefined
  }

  function ok200(body: unknown): Partial<Response> {
    return { ok: true, status: 200, json: async () => body }
  }

  function ok204(): Partial<Response> {
    return { ok: true, status: 204 }
  }

  // ── getChannel ──

  describe('getChannel', () => {
    it('uses default base URL when no apiBaseUrl provided', async () => {
      fetchMock.mockResolvedValueOnce(ok200({ channel: { channelId: 'ch1', name: 'general' } }))
      await collabApi.getChannel('ch1')
      expect(lastFetchUrl()).toBe('https://default.example.com/api/collaboration/channels/ch1')
    })

    it('uses explicit apiBaseUrl when provided', async () => {
      fetchMock.mockResolvedValueOnce(ok200({ channel: { channelId: 'ch1', name: 'general' } }))
      await collabApi.getChannel('ch1', 'https://backend-b.example.com/')
      expect(lastFetchUrl()).toBe('https://backend-b.example.com/api/collaboration/channels/ch1')
    })
  })

  // ── fetchChannelPromptPreview ──

  describe('fetchChannelPromptPreview', () => {
    it('uses default when no apiBaseUrl', async () => {
      fetchMock.mockResolvedValueOnce(ok200({ channelId: 'ch1', sections: [], redacted: false }))
      await collabApi.fetchChannelPromptPreview('ch1')
      expect(lastFetchUrl()).toBe('https://default.example.com/api/collaboration/channels/ch1/prompt-preview')
    })

    it('targets explicit backend', async () => {
      fetchMock.mockResolvedValueOnce(ok200({ channelId: 'ch1', sections: [], redacted: false }))
      await collabApi.fetchChannelPromptPreview('ch1', 'https://remote.example.com/')
      expect(lastFetchUrl()).toBe('https://remote.example.com/api/collaboration/channels/ch1/prompt-preview')
    })
  })

  // ── createChannel ──

  describe('createChannel', () => {
    it('defaults to default base URL', async () => {
      fetchMock.mockResolvedValueOnce(ok200({ ok: true, channel: { channelId: 'ch2', name: 'test' } }))
      await collabApi.createChannel({ name: 'test' })
      expect(lastFetchUrl()).toBe('https://default.example.com/api/collaboration/channels')
    })

    it('targets explicit backend', async () => {
      fetchMock.mockResolvedValueOnce(ok200({ ok: true, channel: { channelId: 'ch2', name: 'test' } }))
      await collabApi.createChannel({ name: 'test' }, 'https://team-b.example.com/')
      expect(lastFetchUrl()).toBe('https://team-b.example.com/api/collaboration/channels')
    })
  })

  // ── updateChannel ──

  describe('updateChannel', () => {
    it('defaults to default base URL', async () => {
      fetchMock.mockResolvedValueOnce(ok200({ ok: true, channel: { channelId: 'ch1', name: 'renamed' } }))
      await collabApi.updateChannel('ch1', { name: 'renamed' })
      expect(lastFetchUrl()).toBe('https://default.example.com/api/collaboration/channels/ch1')
    })

    it('targets explicit backend', async () => {
      fetchMock.mockResolvedValueOnce(ok200({ ok: true, channel: { channelId: 'ch1', name: 'renamed' } }))
      await collabApi.updateChannel('ch1', { name: 'renamed' }, 'https://alpha.example.com/')
      expect(lastFetchUrl()).toBe('https://alpha.example.com/api/collaboration/channels/ch1')
    })
  })

  // ── archiveChannel ──

  describe('archiveChannel', () => {
    it('defaults to default base URL', async () => {
      fetchMock.mockResolvedValueOnce(ok204())
      await collabApi.archiveChannel('ch1')
      expect(lastFetchUrl()).toBe('https://default.example.com/api/collaboration/channels/ch1/archive')
    })

    it('targets explicit backend', async () => {
      fetchMock.mockResolvedValueOnce(ok204())
      await collabApi.archiveChannel('ch1', 'https://backend-x.example.com/')
      expect(lastFetchUrl()).toBe('https://backend-x.example.com/api/collaboration/channels/ch1/archive')
    })
  })

  // ── reorderChannels ──

  describe('reorderChannels', () => {
    it('targets explicit backend', async () => {
      fetchMock.mockResolvedValueOnce(ok204())
      await collabApi.reorderChannels(['a', 'b'], 'https://backend-y.example.com/')
      expect(lastFetchUrl()).toBe('https://backend-y.example.com/api/collaboration/channels/reorder')
    })
  })

  // ── createCategory ──

  describe('createCategory', () => {
    it('targets explicit backend', async () => {
      fetchMock.mockResolvedValueOnce(ok200({ ok: true, category: { categoryId: 'cat1', name: 'Planning' } }))
      await collabApi.createCategory({ name: 'Planning' }, 'https://org-a.example.com/')
      expect(lastFetchUrl()).toBe('https://org-a.example.com/api/collaboration/categories')
    })
  })

  // ── updateCategory ──

  describe('updateCategory', () => {
    it('targets explicit backend', async () => {
      fetchMock.mockResolvedValueOnce(ok200({ ok: true, category: { categoryId: 'cat1', name: 'Dev' } }))
      await collabApi.updateCategory('cat1', { name: 'Dev' }, 'https://org-b.example.com/')
      expect(lastFetchUrl()).toBe('https://org-b.example.com/api/collaboration/categories/cat1')
    })
  })

  // ── deleteCategory ──

  describe('deleteCategory', () => {
    it('targets explicit backend', async () => {
      fetchMock.mockResolvedValueOnce(ok204())
      await collabApi.deleteCategory('cat1', 'https://staging.example.com/')
      expect(lastFetchUrl()).toBe('https://staging.example.com/api/collaboration/categories/cat1')
    })
  })

  // ── reorderCategories ──

  describe('reorderCategories', () => {
    it('targets explicit backend', async () => {
      fetchMock.mockResolvedValueOnce(ok204())
      await collabApi.reorderCategories(['c1', 'c2'], 'https://prod.example.com/')
      expect(lastFetchUrl()).toBe('https://prod.example.com/api/collaboration/categories/reorder')
    })
  })

  // ── Two-connection scenario ──

  describe('two connection routing', () => {
    const BACKEND_A = 'https://collab-a.example.com/'
    const BACKEND_B = 'https://collab-b.example.com/'

    it('routes channel CRUD to the owning backend, not the default', async () => {
      // Create channel on backend A
      fetchMock.mockResolvedValueOnce(ok200({ ok: true, channel: { channelId: 'ch-a', name: 'alpha' } }))
      await collabApi.createChannel({ name: 'alpha' }, BACKEND_A)
      expect(lastFetchUrl()).toContain('collab-a.example.com')
      expect(lastFetchUrl()).not.toContain('default.example.com')

      // Create channel on backend B
      fetchMock.mockResolvedValueOnce(ok200({ ok: true, channel: { channelId: 'ch-b', name: 'beta' } }))
      await collabApi.createChannel({ name: 'beta' }, BACKEND_B)
      expect(lastFetchUrl()).toContain('collab-b.example.com')
      expect(lastFetchUrl()).not.toContain('default.example.com')
    })

    it('all cross-origin requests include credentials: include', async () => {
      fetchMock.mockResolvedValueOnce(ok200({ ok: true, channel: { channelId: 'ch-a', name: 'test' } }))
      await collabApi.createChannel({ name: 'test' }, BACKEND_A)
      expect(lastFetchInit()?.credentials).toBe('include')

      fetchMock.mockResolvedValueOnce(ok204())
      await collabApi.archiveChannel('ch-a', BACKEND_B)
      expect(lastFetchInit()?.credentials).toBe('include')

      fetchMock.mockResolvedValueOnce(ok204())
      await collabApi.deleteCategory('cat-1', BACKEND_A)
      expect(lastFetchInit()?.credentials).toBe('include')
    })
  })
})
