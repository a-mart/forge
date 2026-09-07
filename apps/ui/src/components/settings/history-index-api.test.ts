import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchHistoryIndex, setHistoryIndexPaused } from './history-index-api'
vi.mock('@/lib/api-endpoint', () => ({ resolveApiEndpoint: (ws: string, path: string) => `${ws.replace(/^ws/, 'http')}${path}` }))
afterEach(() => vi.unstubAllGlobals())
describe('History settings API', () => {
  it('targets the supplied origin and sends only a boolean update', async () => {
    const fetch = vi.fn(async () => new Response('{"paused":true}', { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const controller = new AbortController()
    expect(await fetchHistoryIndex('wss://builder.example', controller.signal)).toEqual({ paused: true })
    expect(fetch).toHaveBeenLastCalledWith('https://builder.example/api/history/index', expect.objectContaining({ signal: controller.signal, cache: 'no-store' }))
    await setHistoryIndexPaused('ws://127.0.0.1:1234', false)
    expect(fetch).toHaveBeenLastCalledWith('http://127.0.0.1:1234/api/history/index', expect.objectContaining({ method: 'PATCH', body: '{"paused":false}' }))
  })
  it('does not silently accept an unsupported server', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Not found', { status: 404 })))
    await expect(fetchHistoryIndex('ws://localhost')).rejects.toThrow('unavailable')
  })
})
