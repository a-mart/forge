import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SettingsApiClient } from '@/components/settings/settings-api-client'
import {
  FUTURE_MODEL,
  FUTURE_WORK_MODE,
  makeManagerSelectionCatalog,
} from './manager-selection-catalog.fixture'
import {
  MANAGER_SELECTION_CATALOG_PATH,
  ManagerSelectionCatalogRequestError,
  fetchManagerSelectionCatalog,
} from './manager-selection-catalog-api'
import { LEGACY_MANAGER_SELECTION_CATALOG_REVISION } from './manager-selection-catalog-legacy'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function makeClient(fetchImpl: SettingsApiClient['fetch']): SettingsApiClient {
  return {
    target: { kind: 'builder' } as SettingsApiClient['target'],
    endpoint: (path) => path,
    fetch: fetchImpl,
    fetchJson: vi.fn(),
    readApiError: vi.fn(async (response) => `Request failed (${response.status})`),
  }
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('fetchManagerSelectionCatalog', () => {
  it('returns one validated server snapshot without adding bundled models', async () => {
    const snapshot = makeManagerSelectionCatalog({
      models: [FUTURE_MODEL],
      workModes: [...makeManagerSelectionCatalog().workModes, FUTURE_WORK_MODE],
      defaults: {
        createManagerModel: {
          provider: FUTURE_MODEL.provider,
          modelId: FUTURE_MODEL.modelId,
          reasoningId: FUTURE_MODEL.defaultReasoningId,
        },
        workModeId: FUTURE_WORK_MODE.id,
      },
    })
    const fetch = vi.fn(async () => jsonResponse(snapshot))

    const result = await fetchManagerSelectionCatalog(makeClient(fetch))

    expect(result).toEqual(snapshot)
    expect(result.models).toHaveLength(1)
    expect(result.models[0]).toMatchObject({ provider: 'future-labs', modelId: 'oracle-9' })
    expect(fetch).toHaveBeenCalledWith(
      MANAGER_SELECTION_CATALOG_PATH,
      { cache: 'no-store' },
    )
  })

  it('uses the isolated legacy reconstruction only for a definitive unsupported route', async () => {
    const fetch = vi.fn<SettingsApiClient['fetch']>()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(jsonResponse({
        version: 1,
        overrides: {},
        providerAvailability: {
          'openai-codex': true,
          anthropic: true,
          xai: true,
        },
      }))

    const result = await fetchManagerSelectionCatalog(makeClient(fetch))

    expect(result.revision).toBe(LEGACY_MANAGER_SELECTION_CATALOG_REVISION)
    expect(fetch).toHaveBeenNthCalledWith(2, '/api/settings/model-overrides', { cache: 'no-store' })
  })

  it.each([401, 403, 500, 503])('does not activate legacy fallback for HTTP %s', async (status) => {
    const fetch = vi.fn(async () => new Response(null, { status }))

    await expect(fetchManagerSelectionCatalog(makeClient(fetch))).rejects.toMatchObject({
      name: ManagerSelectionCatalogRequestError.name,
      status,
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('does not activate legacy fallback for transient or malformed responses', async () => {
    const networkFetch = vi.fn<SettingsApiClient['fetch']>().mockRejectedValue(new Error('offline'))
    await expect(fetchManagerSelectionCatalog(makeClient(networkFetch))).rejects.toThrow('offline')
    expect(networkFetch).toHaveBeenCalledTimes(1)

    const malformedFetch = vi.fn(async () => jsonResponse({
      ...makeManagerSelectionCatalog(),
      version: 99,
    }))
    await expect(fetchManagerSelectionCatalog(makeClient(malformedFetch)))
      .rejects.toThrow('Unsupported manager selection catalog version')
    expect(malformedFetch).toHaveBeenCalledTimes(1)
  })
})
