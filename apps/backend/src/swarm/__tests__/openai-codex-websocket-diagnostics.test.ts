import { afterEach, describe, expect, it } from 'vitest'
import {
  getOpenAICodexWebSocketConstructorDiagnostics,
  installOpenAICodexWebSocketDiagnostics,
  resetOpenAICodexWebSocketConstructorDiagnosticsForTest,
} from '../runtime-utils.js'

const originalWebSocket = globalThis.WebSocket

afterEach(() => {
  delete process.env.FORGE_CODEX_TRANSPORT_DEBUG
  resetOpenAICodexWebSocketConstructorDiagnosticsForTest()
  globalThis.WebSocket = originalWebSocket
})

describe('OpenAI Codex WebSocket constructor diagnostics', () => {
  it('does not install when debug env is disabled', () => {
    process.env.FORGE_CODEX_TRANSPORT_DEBUG = '0'
    installOpenAICodexWebSocketDiagnostics()
    expect(getOpenAICodexWebSocketConstructorDiagnostics()).toMatchObject({
      enabled: false,
      installed: false,
      constructorCalls: 0,
    })
  })

  it('counts only constructor/send/close metadata for Codex WebSocket URLs and preserves behavior', () => {
    process.env.FORGE_CODEX_TRANSPORT_DEBUG = '1'
    const calls: Array<{ url: string; sends: unknown[]; closes: unknown[][] }> = []
    class FakeWebSocket {
      static CONNECTING = 0
      static OPEN = 1
      static CLOSING = 2
      static CLOSED = 3
      readonly call: { url: string; sends: unknown[]; closes: unknown[][] }
      constructor(url: string | URL, _protocols?: unknown) {
        this.call = { url: String(url), sends: [], closes: [] }
        calls.push(this.call)
      }
      send(data: unknown) {
        this.call.sends.push(data)
      }
      close(...args: unknown[]) {
        this.call.closes.push(args)
      }
    }
    globalThis.WebSocket = FakeWebSocket as unknown as typeof globalThis.WebSocket

    installOpenAICodexWebSocketDiagnostics()
    const codexSocket = new globalThis.WebSocket('wss://chatgpt.com/backend-api/codex/responses', { headers: { authorization: 'redacted' } } as never)
    codexSocket.send('secret-payload')
    codexSocket.close(1000, 'done')
    const otherSocket = new globalThis.WebSocket('wss://example.com/socket')
    otherSocket.send('other-payload')
    otherSocket.close(1001, 'other')

    expect(calls).toEqual([
      { url: 'wss://chatgpt.com/backend-api/codex/responses', sends: ['secret-payload'], closes: [[1000, 'done']] },
      { url: 'wss://example.com/socket', sends: ['other-payload'], closes: [[1001, 'other']] },
    ])
    expect(getOpenAICodexWebSocketConstructorDiagnostics()).toMatchObject({
      enabled: true,
      installed: true,
      constructorCalls: 1,
      constructorErrors: 0,
      sendCalls: 1,
      closeCalls: 1,
      lastUrlHost: 'chatgpt.com',
      lastUrlPath: '/backend-api/codex/responses',
    })
    expect(JSON.stringify(getOpenAICodexWebSocketConstructorDiagnostics())).not.toContain('secret-payload')
    expect(JSON.stringify(getOpenAICodexWebSocketConstructorDiagnostics())).not.toContain('authorization')
  })

  it('does not count other ChatGPT backend-api WebSocket URLs', () => {
    process.env.FORGE_CODEX_TRANSPORT_DEBUG = '1'
    class FakeWebSocket {
      constructor(_url: string | URL, _protocols?: unknown) {}
      send(_data: unknown) {}
      close(_code?: number, _reason?: string) {}
    }
    globalThis.WebSocket = FakeWebSocket as unknown as typeof globalThis.WebSocket

    installOpenAICodexWebSocketDiagnostics()
    new globalThis.WebSocket('wss://chatgpt.com/backend-api/conversation')
    new globalThis.WebSocket('wss://chatgpt.com/backend-api/responses')
    new globalThis.WebSocket('wss://chatgpt.com/backend-api/codex/other')
    new globalThis.WebSocket('wss://chatgpt.com/not-backend-api/codex/responses')

    expect(getOpenAICodexWebSocketConstructorDiagnostics()).toMatchObject({
      constructorCalls: 0,
      sendCalls: 0,
      closeCalls: 0,
    })
  })

  it('is idempotent when installed twice', () => {
    process.env.FORGE_CODEX_TRANSPORT_DEBUG = '1'
    const calls: string[] = []
    class FakeWebSocket {
      constructor(url: string | URL, _protocols?: unknown) {
        calls.push(String(url))
      }
      send(_data: unknown) {}
      close(_code?: number, _reason?: string) {}
    }
    globalThis.WebSocket = FakeWebSocket as unknown as typeof globalThis.WebSocket

    installOpenAICodexWebSocketDiagnostics()
    const wrapped = globalThis.WebSocket
    installOpenAICodexWebSocketDiagnostics()

    expect(globalThis.WebSocket).toBe(wrapped)
    const codexSocket = new globalThis.WebSocket('wss://chatgpt.com/backend-api/codex/responses')
    codexSocket.send('payload')

    expect(calls).toEqual(['wss://chatgpt.com/backend-api/codex/responses'])
    expect(getOpenAICodexWebSocketConstructorDiagnostics()).toMatchObject({
      constructorCalls: 1,
      sendCalls: 1,
    })
  })
})
