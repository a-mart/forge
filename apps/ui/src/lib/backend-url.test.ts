import { describe, expect, it } from 'vitest'
import { resolveBackendWsUrlFromLocation } from './backend-url'

describe('resolveBackendWsUrlFromLocation', () => {
  it('preserves the dev port mapping from 47188 to 47187', () => {
    expect(
      resolveBackendWsUrlFromLocation(
        { protocol: 'http:', hostname: '127.0.0.1', port: '47188' },
        { webBaseMode: 'auto' },
      ),
    ).toBe('ws://127.0.0.1:47187')
  })

  it('preserves the preview port mapping from 47189 to 47287', () => {
    expect(
      resolveBackendWsUrlFromLocation(
        { protocol: 'http:', hostname: '127.0.0.1', port: '47189' },
        { webBaseMode: 'auto' },
      ),
    ).toBe('ws://127.0.0.1:47287')
  })

  it('falls back to same-origin websocket ports for non-dev web deployments', () => {
    expect(
      resolveBackendWsUrlFromLocation(
        { protocol: 'https:', hostname: 'forge.example.com', port: '8443' },
        { webBaseMode: 'auto' },
      ),
    ).toBe('wss://forge.example.com:8443')
  })

  it('honors the same-origin web-base flag explicitly', () => {
    expect(
      resolveBackendWsUrlFromLocation(
        { protocol: 'http:', hostname: 'localhost', port: '3000' },
        { webBaseMode: 'same-origin' },
      ),
    ).toBe('ws://localhost:3000')
  })
})
