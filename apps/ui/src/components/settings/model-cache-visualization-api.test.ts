import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fetchModelCacheVisualizationEnabled,
  setModelCacheVisualizationEnabledApi,
} from './model-cache-visualization-api'

describe('model-cache-visualization-api', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('defaults to disabled when enabled is missing from GET payload', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    )

    await expect(fetchModelCacheVisualizationEnabled('ws://127.0.0.1:8787')).resolves.toBe(false)
  })

  it('reads and writes the enabled flag', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ enabled: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))

    await expect(fetchModelCacheVisualizationEnabled('ws://127.0.0.1:8787')).resolves.toBe(true)
    await expect(setModelCacheVisualizationEnabledApi('ws://127.0.0.1:8787', false)).resolves.toBeUndefined()

    expect(fetch).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('/api/settings/model-cache-visualization/enabled'),
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ enabled: false }),
      }),
    )
  })
})
