import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearCodexCatalogCache,
  ensureCodexCatalogWarm,
  fetchCodexCatalogWithCache,
  getCachedCodexCatalog,
  isCodexCatalogCacheFresh,
} from './codex-catalog-cache'
import { fetchCodexCatalog } from './codex-catalog-api'

vi.mock('./codex-catalog-api', () => ({
  fetchCodexCatalog: vi.fn(),
}))

const fetchCodexCatalogMock = vi.mocked(fetchCodexCatalog)

const snapshot = {
  apps: [],
  plugins: [{ selector: 'fireflies', displayName: 'Fireflies' }],
  tools: [],
  fetchedAt: '2026-01-01T00:00:00.000Z',
}

describe('codex-catalog-cache', () => {
  beforeEach(() => {
    clearCodexCatalogCache()
    fetchCodexCatalogMock.mockReset()
  })

  afterEach(() => {
    clearCodexCatalogCache()
  })

  it('preloads and serves cached catalog without refetching while fresh', async () => {
    fetchCodexCatalogMock.mockResolvedValue({ status: 'ok', snapshot })

    ensureCodexCatalogWarm(undefined, 'manager-1')
    await vi.waitFor(() => {
      expect(fetchCodexCatalogMock).toHaveBeenCalledTimes(1)
    })

    const cached = await fetchCodexCatalogWithCache(undefined, 'manager-1')
    expect(cached.status).toBe('ok')
    if (cached.status === 'ok') {
      expect(cached.snapshot.plugins[0]?.selector).toBe('fireflies')
    }
    expect(fetchCodexCatalogMock).toHaveBeenCalledTimes(1)
    expect(getCachedCodexCatalog('manager-1')?.plugins[0]?.selector).toBe('fireflies')
    expect(isCodexCatalogCacheFresh('manager-1')).toBe(true)
  })

  it('returns stale cache when refresh fails', async () => {
    fetchCodexCatalogMock.mockResolvedValueOnce({ status: 'ok', snapshot })
    await fetchCodexCatalogWithCache(undefined, 'manager-1')

    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-02T00:00:00.000Z'))
    fetchCodexCatalogMock.mockResolvedValueOnce({ status: 'error' })

    const result = await fetchCodexCatalogWithCache(undefined, 'manager-1')
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.snapshot.plugins[0]?.selector).toBe('fireflies')
    }

    vi.useRealTimers()
  })
})
