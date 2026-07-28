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

  it('envUrl takes priority over port heuristic (electron dev browser access)', () => {
    // When VITE_FORGE_WS_URL is set (e.g. during dev:electron), the env var
    // should override the port-based heuristic so browser access at 47188
    // connects to the Electron backend on 47287.
    expect(
      resolveBackendWsUrlFromLocation(
        { protocol: 'http:', hostname: '127.0.0.1', port: '47188' },
        { envUrl: 'ws://127.0.0.1:47287', webBaseMode: 'auto' },
      ),
    ).toBe('ws://127.0.0.1:47287')
  })

  it('combines an explicit backend port with the browser hostname for remote Electron development', () => {
    expect(
      resolveBackendWsUrlFromLocation(
        { protocol: 'http:', hostname: '10.128.4.7', port: '47188' },
        { envPort: '47287', webBaseMode: 'auto' },
      ),
    ).toBe('ws://10.128.4.7:47287')
  })

  it('uses secure websockets with the explicit backend port on HTTPS pages', () => {
    expect(
      resolveBackendWsUrlFromLocation(
        { protocol: 'https:', hostname: 'forge.example.test', port: '47188' },
        { envPort: '47287', webBaseMode: 'auto' },
      ),
    ).toBe('wss://forge.example.test:47287')
  })

  it('ignores an invalid explicit backend port', () => {
    expect(
      resolveBackendWsUrlFromLocation(
        { protocol: 'http:', hostname: '10.128.4.7', port: '47188' },
        { envPort: 'not-a-port', webBaseMode: 'auto' },
      ),
    ).toBe('ws://10.128.4.7:47187')
  })

  it('electronWsUrl takes priority over envUrl', () => {
    expect(
      resolveBackendWsUrlFromLocation(
        { protocol: 'http:', hostname: '127.0.0.1', port: '47188' },
        {
          electronWsUrl: 'ws://127.0.0.1:47287',
          envUrl: 'ws://127.0.0.1:9999',
          envPort: '9998',
        },
      ),
    ).toBe('ws://127.0.0.1:47287')
  })
})
