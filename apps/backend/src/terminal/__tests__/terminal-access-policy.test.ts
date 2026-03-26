import type { IncomingMessage } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
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
