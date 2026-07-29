import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SECURE_CONTROL_HEADER,
  applyTerminalCorsHeaders,
  validateSecureBuilderControlCapability,
  validateSecureBuilderControlOrigin,
  validateTerminalHttpOrigin,
  validateTerminalWsOrigin,
} from '../terminal-access-policy.js'

function createRequest(options: {
  origin?: string
  host?: string
  remoteAddress?: string
  encrypted?: boolean
} = {}): IncomingMessage {
  return {
    headers: {
      ...(options.origin ? { origin: options.origin } : {}),
      ...(options.host ? { host: options.host } : {}),
    },
    socket: {
      remoteAddress: options.remoteAddress ?? '127.0.0.1',
      encrypted: options.encrypted ?? false,
    },
  } as unknown as IncomingMessage
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('terminal-access-policy', () => {
  it('requires an exact per-launch capability for secure mutations', () => {
    const token = 'a'.repeat(43)
    const valid = createRequest()
    valid.headers[SECURE_CONTROL_HEADER] = token
    const invalid = createRequest()
    invalid.headers[SECURE_CONTROL_HEADER] = `${token.slice(0, -1)}b`

    expect(validateSecureBuilderControlCapability(valid, token)).toBe(true)
    expect(validateSecureBuilderControlCapability(invalid, token)).toBe(false)
    expect(validateSecureBuilderControlCapability(createRequest(), token)).toBe(false)
    expect(validateSecureBuilderControlCapability(valid, '')).toBe(false)
  })

  it('accepts only exact configured origins for secure builder controls', () => {
    const options = {
      backendHost: '127.0.0.1',
      backendPort: 47287,
      uiPort: 47188,
    }
    expect(validateSecureBuilderControlOrigin(
      createRequest({
        origin: 'http://localhost:47188',
        host: 'attacker.example:47287',
      }),
      options,
    )).toEqual({ ok: true, allowedOrigin: 'http://localhost:47188' })
    expect(validateSecureBuilderControlOrigin(
      createRequest({
        origin: 'http://127.0.0.1:47287',
        host: 'attacker.example:47287',
      }),
      options,
    )).toEqual({ ok: true, allowedOrigin: 'http://127.0.0.1:47287' })
  })

  it('rejects DNS-rebinding Host and Origin pairs for secure builder controls', () => {
    const result = validateSecureBuilderControlOrigin(
      createRequest({
        origin: 'http://attacker.example',
        host: 'attacker.example:47287',
        remoteAddress: '127.0.0.1',
      }),
      {
        backendHost: '127.0.0.1',
        backendPort: 47287,
        uiPort: 47188,
      },
    )

    expect(result).toEqual({
      ok: false,
      allowedOrigin: null,
      errorMessage: 'Origin not allowed',
    })
  })

  it('allows same-origin HTTPS secure control from a remote browser', () => {
    const result = validateSecureBuilderControlOrigin(
      createRequest({
        origin: 'https://forge.example.com',
        host: 'forge.example.com',
        remoteAddress: '192.0.2.20',
        encrypted: true,
      }),
      {
        backendHost: '0.0.0.0',
        backendPort: 47287,
        uiPort: 47188,
      },
    )

    expect(result).toEqual({
      ok: true,
      allowedOrigin: 'https://forge.example.com',
    })
  })

  it('allows the trusted HTTP development UI to reach the same Desktop host on the backend port', () => {
    vi.stubEnv('FORGE_DESKTOP', '1')

    const result = validateSecureBuilderControlOrigin(
      createRequest({
        origin: 'http://10.128.4.7:47188',
        host: '10.128.4.7:47287',
        remoteAddress: '10.128.4.20',
      }),
      {
        backendHost: '0.0.0.0',
        backendPort: 47287,
        uiPort: 47188,
      },
    )

    expect(result).toEqual({
      ok: true,
      allowedOrigin: 'http://10.128.4.7:47188',
    })
  })

  it('rejects trusted HTTP cross-port control outside Desktop mode', () => {
    vi.stubEnv('FORGE_DESKTOP', '0')

    const result = validateSecureBuilderControlOrigin(
      createRequest({
        origin: 'http://10.128.4.7:47188',
        host: '10.128.4.7:47287',
        remoteAddress: '10.128.4.20',
      }),
      {
        backendHost: '0.0.0.0',
        backendPort: 47287,
        uiPort: 47188,
      },
    )

    expect(result).toEqual({
      ok: false,
      allowedOrigin: null,
      errorMessage: 'Origin not allowed',
    })
  })

  it('rejects trusted HTTP control when the UI and backend hostnames differ', () => {
    vi.stubEnv('FORGE_DESKTOP', '1')

    const result = validateSecureBuilderControlOrigin(
      createRequest({
        origin: 'http://attacker.example:47188',
        host: '10.128.4.7:47287',
        remoteAddress: '10.128.4.20',
      }),
      {
        backendHost: '0.0.0.0',
        backendPort: 47287,
        uiPort: 47188,
      },
    )

    expect(result).toEqual({
      ok: false,
      allowedOrigin: null,
      errorMessage: 'Origin not allowed',
    })
  })

  it('rejects trusted HTTP control from unexpected UI or backend ports', () => {
    vi.stubEnv('FORGE_DESKTOP', '1')

    const options = {
      backendHost: '0.0.0.0',
      backendPort: 47287,
      uiPort: 47188,
    }
    expect(validateSecureBuilderControlOrigin(
      createRequest({
        origin: 'http://10.128.4.7:9999',
        host: '10.128.4.7:47287',
        remoteAddress: '10.128.4.20',
      }),
      options,
    )).toEqual({
      ok: false,
      allowedOrigin: null,
      errorMessage: 'Origin not allowed',
    })
    expect(validateSecureBuilderControlOrigin(
      createRequest({
        origin: 'http://10.128.4.7:47188',
        host: '10.128.4.7:9999',
        remoteAddress: '10.128.4.20',
      }),
      options,
    )).toEqual({
      ok: false,
      allowedOrigin: null,
      errorMessage: 'Origin not allowed',
    })
  })

  it('rejects same-origin remote HTTP secure control', () => {
    const result = validateSecureBuilderControlOrigin(
      createRequest({
        origin: 'http://forge.example.com',
        host: 'forge.example.com',
        remoteAddress: '192.0.2.20',
      }),
      {
        backendHost: '0.0.0.0',
        backendPort: 47287,
        uiPort: 47188,
      },
    )

    expect(result).toEqual({
      ok: false,
      allowedOrigin: null,
      errorMessage: 'Origin not allowed',
    })
  })

  it('rejects no-Origin secure control requests from non-loopback clients', () => {
    const result = validateSecureBuilderControlOrigin(
      createRequest({
        host: '192.0.2.10:47287',
        remoteAddress: '192.0.2.20',
      }),
      {
        backendHost: '0.0.0.0',
        backendPort: 47287,
        uiPort: 47188,
      },
    )

    expect(result).toEqual({
      ok: false,
      allowedOrigin: null,
      errorMessage: 'Missing Origin',
    })
  })

  it('allows no-Origin secure control requests only from loopback', () => {
    const result = validateSecureBuilderControlOrigin(
      createRequest({
        host: '127.0.0.1:47287',
        remoteAddress: '::ffff:127.0.0.1',
      }),
      {
        backendHost: '0.0.0.0',
        backendPort: 47287,
        uiPort: 47188,
      },
    )

    expect(result).toEqual({ ok: true, allowedOrigin: null })
  })

  it('allows credentialed browser fetches for validated terminal origins', () => {
    const request = createRequest({ origin: 'http://localhost:47188' })
    const headers = new Map<string, string>()
    const response = {
      setHeader: (name: string, value: string) => headers.set(name.toLowerCase(), value),
    } as unknown as ServerResponse

    applyTerminalCorsHeaders(request, response, 'GET, POST, OPTIONS', 'http://localhost:47188')

    expect(headers.get('access-control-allow-origin')).toBe('http://localhost:47188')
    expect(headers.get('access-control-allow-credentials')).toBe('true')
    expect(headers.get('access-control-allow-methods')).toBe('GET, POST, OPTIONS')
    expect(headers.get('access-control-allow-headers')).toBe('content-type')
  })

  it('allows same-origin HTTP requests', () => {
    const result = validateTerminalHttpOrigin(
      createRequest({ origin: 'http://127.0.0.1:47187' }),
      new URL('http://127.0.0.1:47187/api/terminals'),
    )

    expect(result).toEqual({ ok: true, allowedOrigin: 'http://127.0.0.1:47187' })
  })

  it('rejects cross-origin HTTP requests', () => {
    const result = validateTerminalHttpOrigin(
      createRequest({ origin: 'https://evil.example' }),
      new URL('http://127.0.0.1:47187/api/terminals'),
    )

    expect(result).toEqual({ ok: false, allowedOrigin: null, errorMessage: 'Origin not allowed' })
  })

  it('allows the loopback development UI on a different port', () => {
    const result = validateTerminalHttpOrigin(
      createRequest({ origin: 'http://localhost:47188' }),
      new URL('http://127.0.0.1:47287/api/secure-sessions/manager'),
    )

    expect(result).toEqual({ ok: true, allowedOrigin: 'http://localhost:47188' })
  })

  it('allows HTTP requests with no Origin header', () => {
    const result = validateTerminalHttpOrigin(
      createRequest(),
      new URL('http://127.0.0.1:47187/api/terminals'),
    )

    expect(result).toEqual({ ok: true, allowedOrigin: null })
  })

  it('allows Electron app:// origins only in desktop mode', () => {
    vi.stubEnv('FORGE_DESKTOP', '1')

    const allowed = validateTerminalHttpOrigin(
      createRequest({ origin: 'app://forge' }),
      new URL('http://127.0.0.1:47187/api/terminals'),
    )
    expect(allowed).toEqual({ ok: true, allowedOrigin: 'app://forge' })

    vi.stubEnv('FORGE_DESKTOP', '0')
    const rejected = validateTerminalHttpOrigin(
      createRequest({ origin: 'app://forge' }),
      new URL('http://127.0.0.1:47187/api/terminals'),
    )
    expect(rejected).toEqual({ ok: false, allowedOrigin: null, errorMessage: 'Origin not allowed' })
  })

  it('applies the same allow/reject rules for websocket origins', () => {
    const sameOrigin = validateTerminalWsOrigin(
      createRequest({ origin: 'http://127.0.0.1:47187', host: '127.0.0.1:47187' }),
    )
    expect(sameOrigin).toEqual({ ok: true })

    const crossOrigin = validateTerminalWsOrigin(
      createRequest({ origin: 'https://evil.example', host: '127.0.0.1:47187' }),
    )
    expect(crossOrigin).toEqual({ ok: false, errorMessage: 'Origin not allowed' })
  })

  it('allows Electron websocket origins only in desktop mode', () => {
    vi.stubEnv('FORGE_DESKTOP', '1')
    const allowed = validateTerminalWsOrigin(
      createRequest({ origin: 'app://forge', host: '127.0.0.1:47187' }),
    )
    expect(allowed).toEqual({ ok: true })

    vi.stubEnv('FORGE_DESKTOP', '0')
    const rejected = validateTerminalWsOrigin(
      createRequest({ origin: 'app://forge', host: '127.0.0.1:47187' }),
    )
    expect(rejected).toEqual({ ok: false, errorMessage: 'Origin not allowed' })
  })

  it('allows websocket requests with no Origin when they arrive from loopback', () => {
    const result = validateTerminalWsOrigin(
      createRequest({ host: '127.0.0.1:47187', remoteAddress: '127.0.0.1' }),
    )

    expect(result).toEqual({ ok: true })
  })
})
