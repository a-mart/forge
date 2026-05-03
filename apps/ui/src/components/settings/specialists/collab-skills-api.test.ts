import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SettingsApiClient } from '../settings-api-client'
import {
  updateChannelSkillSelection,
  updateCategoryDefaultSkillSelection,
  fetchCollabSkillInventory,
} from '../specialists-api'

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function makeClient(fetchFn: SettingsApiClient['fetch']): SettingsApiClient {
  return {
    target: {
      kind: 'collab',
      label: 'Test',
      description: 'Test collab',
      wsUrl: 'ws://test:47187',
      apiBaseUrl: 'http://test:47187',
      fetchCredentials: 'include',
      requiresAdmin: true,
      availableTabs: [],
    },
    endpoint: (path: string) => `http://test:47187${path}`,
    fetch: fetchFn,
    fetchJson: vi.fn(),
    readApiError: async (r: Response) => {
      try {
        const body = (await r.json()) as { error?: string }
        return body.error ?? r.statusText
      } catch {
        return r.statusText
      }
    },
  }
}

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function errorResponse(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

/* ================================================================== */
/*  updateChannelSkillSelection                                        */
/* ================================================================== */

describe('updateChannelSkillSelection', () => {
  it('sends PUT with activeSkillSelection payload and returns updated channel', async () => {
    const mockChannel = { channelId: 'ch-1', activeSkillSelection: { mode: 'custom', savedSelectedSkillHandles: ['brave-search'] } }
    const fetchFn = vi.fn().mockResolvedValue(okResponse({ channel: mockChannel }))
    const client = makeClient(fetchFn)

    const result = await updateChannelSkillSelection(client, 'ch-1', {
      mode: 'custom',
      savedSelectedSkillHandles: ['brave-search'],
    })

    expect(fetchFn).toHaveBeenCalledWith(
      '/api/collaboration/channels/ch-1/skills/selection',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          activeSkillSelection: { mode: 'custom', savedSelectedSkillHandles: ['brave-search'] },
        }),
      }),
    )
    expect(result).toEqual(mockChannel)
  })

  it('sends all mode payload', async () => {
    const mockChannel = { channelId: 'ch-1', activeSkillSelection: { mode: 'all' } }
    const fetchFn = vi.fn().mockResolvedValue(okResponse({ channel: mockChannel }))
    const client = makeClient(fetchFn)

    await updateChannelSkillSelection(client, 'ch-1', { mode: 'all' })

    const callBody = JSON.parse(fetchFn.mock.calls[0][1].body as string) as Record<string, unknown>
    expect(callBody).toEqual({ activeSkillSelection: { mode: 'all' } })
  })

  it('throws on API error', async () => {
    const fetchFn = vi.fn().mockResolvedValue(errorResponse(400, 'Invalid selection'))
    const client = makeClient(fetchFn)

    await expect(
      updateChannelSkillSelection(client, 'ch-1', { mode: 'all' }),
    ).rejects.toThrow('Invalid selection')
  })

  it('throws when response lacks channel', async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResponse({ ok: true }))
    const client = makeClient(fetchFn)

    await expect(
      updateChannelSkillSelection(client, 'ch-1', { mode: 'all' }),
    ).rejects.toThrow('Backend did not return updated channel')
  })
})

/* ================================================================== */
/*  updateCategoryDefaultSkillSelection                                */
/* ================================================================== */

describe('updateCategoryDefaultSkillSelection', () => {
  it('sends PATCH with defaultSkillSelection and returns updated category', async () => {
    const mockCategory = { categoryId: 'cat-1', defaultSkillSelection: { mode: 'all' } }
    const fetchFn = vi.fn().mockResolvedValue(okResponse({ category: mockCategory }))
    const client = makeClient(fetchFn)

    const result = await updateCategoryDefaultSkillSelection(client, 'cat-1', { mode: 'all' })

    expect(fetchFn).toHaveBeenCalledWith(
      '/api/collaboration/categories/cat-1',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ defaultSkillSelection: { mode: 'all' } }),
      }),
    )
    expect(result).toEqual(mockCategory)
  })

  it('throws on API error', async () => {
    const fetchFn = vi.fn().mockResolvedValue(errorResponse(404, 'Category not found'))
    const client = makeClient(fetchFn)

    await expect(
      updateCategoryDefaultSkillSelection(client, 'cat-1', { mode: 'all' }),
    ).rejects.toThrow('Category not found')
  })

  it('throws when response lacks category', async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResponse({ ok: true }))
    const client = makeClient(fetchFn)

    await expect(
      updateCategoryDefaultSkillSelection(client, 'cat-1', { mode: 'all' }),
    ).rejects.toThrow('Backend did not return updated category')
  })
})

/* ================================================================== */
/*  fetchCollabSkillInventory                                          */
/* ================================================================== */

describe('fetchCollabSkillInventory', () => {
  it('fetches and returns skill inventory', async () => {
    const skills = [{ skillId: 'memory', name: 'Memory', directoryName: 'memory' }]
    const fetchFn = vi.fn().mockResolvedValue(okResponse({ skills }))
    const client = makeClient(fetchFn)

    const result = await fetchCollabSkillInventory(client)

    expect(fetchFn).toHaveBeenCalledWith('/api/settings/skills', { cache: 'no-store' })
    expect(result).toEqual(skills)
  })

  it('returns empty array when response has no skills', async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResponse({}))
    const client = makeClient(fetchFn)

    const result = await fetchCollabSkillInventory(client)
    expect(result).toEqual([])
  })

  it('throws on API error', async () => {
    const fetchFn = vi.fn().mockResolvedValue(errorResponse(500, 'Server error'))
    const client = makeClient(fetchFn)

    await expect(fetchCollabSkillInventory(client)).rejects.toThrow('Server error')
  })
})
