import { afterEach, describe, expect, it, vi } from 'vitest'
import { streamSimple } from '@mariozechner/pi-ai'
import type { Model } from '@mariozechner/pi-ai'

const originalWebSocket = globalThis.WebSocket
const originalFetch = globalThis.fetch

const fakeCodexToken = `e30.${Buffer.from(JSON.stringify({
  'https://api.openai.com/auth': { chatgpt_account_id: 'acct_test' },
})).toString('base64url')}.sig`

const codexModel: Model<'openai-codex-responses'> = {
  id: 'gpt-5.1-codex',
  name: 'GPT-5.1 Codex',
  api: 'openai-codex-responses',
  provider: 'openai-codex',
  baseUrl: 'https://chatgpt.com/backend-api',
  reasoning: true,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 32_000,
}

afterEach(() => {
  globalThis.WebSocket = originalWebSocket
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('OpenAI Codex transport forwarding', () => {
  it('forwards transport through streamSimple so websocket-cached creates a WebSocket instead of falling back to SSE', async () => {
    const constructedUrls: string[] = []
    const sentPayloads: string[] = []

    class FakeWebSocket extends EventTarget {
      static CONNECTING = 0
      static OPEN = 1
      static CLOSING = 2
      static CLOSED = 3
      readyState = FakeWebSocket.OPEN

      constructor(url: string | URL, _protocols?: unknown) {
        super()
        constructedUrls.push(String(url))
        queueMicrotask(() => this.dispatchEvent(new Event('open')))
      }

      send(payload: string) {
        sentPayloads.push(payload)
        queueMicrotask(() => {
          this.dispatchEvent(new MessageEvent('message', {
            data: JSON.stringify({
              type: 'response.completed',
              response: {
                id: 'resp_test',
                status: 'completed',
                usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
              },
            }),
          }))
        })
      }

      close(_code?: number, _reason?: string) {
        this.readyState = FakeWebSocket.CLOSED
      }
    }

    globalThis.WebSocket = FakeWebSocket as unknown as typeof globalThis.WebSocket
    const fetchSpy = vi.fn(async () => {
      throw new Error('SSE fetch should not be used when transport is websocket-cached')
    })
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch

    const result = await streamSimple(codexModel, { messages: [] }, {
      apiKey: fakeCodexToken,
      transport: 'websocket-cached',
      sessionId: 'test-session-id',
      reasoning: 'low',
    }).result()

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(constructedUrls).toEqual(['wss://chatgpt.com/backend-api/codex/responses'])
    expect(sentPayloads).toHaveLength(1)
    expect(JSON.parse(sentPayloads[0])).toMatchObject({ type: 'response.create', model: 'gpt-5.1-codex' })
    expect(result.stopReason).toBe('stop')
    expect(result.responseId).toBe('resp_test')
  })
})
