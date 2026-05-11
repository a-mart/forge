import { describe, expect, it } from 'vitest'

import { ForgeClient, normalizeBaseUrl } from './forge-client.js'

describe('ForgeClient', () => {
  it('normalizes WebSocket URLs to HTTP URLs for CLI HTTP reads', () => {
    expect(normalizeBaseUrl('ws://127.0.0.1:47287').toString()).toBe('http://127.0.0.1:47287/')
    expect(normalizeBaseUrl('wss://forge.example').toString()).toBe('https://forge.example/')
  })

  it('always sends bearer auth and never retries unauthenticated', async () => {
    const calls: Array<{ url: string; auth: string | null }> = []
    const client = new ForgeClient({
      url: 'http://127.0.0.1:47287',
      apiKey: 'secret',
      fetchImpl: async (url, init) => {
        const headers = new Headers(init?.headers)
        calls.push({ url: String(url), auth: headers.get('authorization') })
        return Response.json({
          serverTime: 'now',
          serverVersion: '0.9.0',
          capabilities: { protocolVersion: 1, minCliVersion: '0.9.0', available: true, features: {} },
        })
      },
    })

    await client.getCapabilities()
    expect(calls).toEqual([{ url: 'http://127.0.0.1:47287/api/cli/capabilities', auth: 'Bearer secret' }])
  })
})
