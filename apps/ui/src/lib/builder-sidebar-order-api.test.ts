import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSettingsApiClient } from '@/components/settings/settings-api-client'
import {
  createBuilderSettingsTarget,
  createCollabSettingsTarget,
} from '@/components/settings/settings-target'
import {
  BuilderSidebarOrderApiConflictError,
  BuilderSidebarOrderApiUnavailableError,
  createBuilderSidebarOrderApi,
  createLocalBuilderSidebarOrderApi,
} from './builder-sidebar-order-api'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('builder sidebar order API targeting', () => {
  it('always targets the explicitly supplied local Builder backend', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      version: 1,
      revision: 0,
      order: [],
      updatedAt: null,
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    globalThis.fetch = fetchMock as typeof fetch
    const localClient = createSettingsApiClient(
      createBuilderSettingsTarget('ws://127.0.0.1:47187/ws'),
    )
    const api = createBuilderSidebarOrderApi(localClient)

    await api.get()
    await api.put({ baseRevision: 0, order: [] })

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:47187/api/settings/builder-sidebar-order',
      expect.objectContaining({ cache: 'no-store', credentials: 'same-origin' }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:47187/api/settings/builder-sidebar-order',
      expect.objectContaining({ method: 'PUT', credentials: 'same-origin' }),
    )
  })

  it('rejects a remote collaboration target before any request can be sent', () => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as typeof fetch
    const remoteClient = createSettingsApiClient(createCollabSettingsTarget(
      'wss://remote.example/ws',
      'https://remote.example/',
    ))

    expect(() => createBuilderSidebarOrderApi(remoteClient)).toThrow(/local Builder target/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('constructs directly from the local WS URL regardless of an active remote URL', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      version: 1,
      revision: 0,
      order: [],
      updatedAt: null,
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    globalThis.fetch = fetchMock as typeof fetch

    const activeRemoteWsUrl = 'wss://remote.example/ws'
    const api = createLocalBuilderSidebarOrderApi('ws://127.0.0.1:47187/ws')
    expect(activeRemoteWsUrl).not.toContain('127.0.0.1')
    await api.get()

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:47187/api/settings/builder-sidebar-order',
      expect.any(Object),
    )
  })

  it('surfaces validated conflict authority for store-level replay', async () => {
    const current = {
      version: 1,
      revision: 2,
      order: [{ originId: 'local', profileId: 'alpha' }],
      updatedAt: '2026-07-09T12:00:00.000Z',
    }
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'conflict', current }), {
      status: 409,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch
    const api = createBuilderSidebarOrderApi(createSettingsApiClient(
      createBuilderSettingsTarget('ws://localhost:47187/ws'),
    ))

    const error = await api.put({ baseRevision: 1, order: [] }).catch((value: unknown) => value)
    expect(error).toBeInstanceOf(BuilderSidebarOrderApiConflictError)
    expect((error as BuilderSidebarOrderApiConflictError).current).toEqual(current)
  })

  it('rejects malformed 409 authority instead of projecting it as rollback state', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      error: 'conflict',
      current: {
        version: 1,
        revision: 2,
        order: [
          { originId: 'local', profileId: 'duplicate' },
          { originId: 'local', profileId: 'duplicate' },
        ],
        updatedAt: '2026-07-09T12:00:00.000Z',
      },
    }), {
      status: 409,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch
    const api = createLocalBuilderSidebarOrderApi('ws://localhost:47187/ws')

    await expect(api.put({ baseRevision: 1, order: [] })).rejects.toThrow(/response is invalid/)
  })

  it('feature-detects an older backend without enabling DnD writes', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'Not Found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch
    const api = createLocalBuilderSidebarOrderApi('ws://localhost:47187/ws')

    await expect(api.get()).rejects.toBeInstanceOf(BuilderSidebarOrderApiUnavailableError)
  })
})
