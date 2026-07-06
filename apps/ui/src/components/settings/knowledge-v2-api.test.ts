import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchKnowledgeV2Settings, updateKnowledgeV2Settings } from './knowledge-v2-api'

const WS_URL = 'ws://127.0.0.1:8787'

function settingsBody(enabled: boolean) {
  return {
    settings: {
      enabled,
      legacyCleanupConfirmed: false,
      indexCaps: { global: 200, profile: 100 },
      updatedAt: null,
    },
    defaults: {
      enabled: false,
      legacyCleanupConfirmed: false,
      indexCaps: { global: 200, profile: 100 },
      updatedAt: null,
    },
    constraints: { indexCaps: { min: 0, max: 1000, defaults: { global: 200, profile: 100 } } },
  }
}

describe('knowledge-v2-api', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads the current enabled state from GET', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(settingsBody(true)), { status: 200 }))

    const result = await fetchKnowledgeV2Settings(WS_URL)
    expect(result.available).toBe(true)
    if (result.available) {
      expect(result.response.settings.enabled).toBe(true)
    }
  })

  it('reports unavailable (not an error) when the endpoint returns 404', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: 'Builder only' }), { status: 404 }),
    )

    const result = await fetchKnowledgeV2Settings(WS_URL)
    expect(result.available).toBe(false)
  })

  it('throws on non-404 error responses', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: 'boom' }), { status: 500 }),
    )

    await expect(fetchKnowledgeV2Settings(WS_URL)).rejects.toThrow('boom')
  })

  it('writes the enabled flag via PUT and returns the updated settings', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ ok: true, ...settingsBody(true) }), { status: 200 }),
    )

    const response = await updateKnowledgeV2Settings(WS_URL, { enabled: true })
    expect(response.settings.enabled).toBe(true)

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/settings/knowledge-v2'),
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ enabled: true }),
      }),
    )
  })
})
