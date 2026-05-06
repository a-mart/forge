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

const userContext = {
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'next' }] },
  ],
} as Parameters<typeof streamSimple>[1]

afterEach(() => {
  globalThis.WebSocket = originalWebSocket
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

function closeEvent(code: number, reason = ''): Event {
  const event = new Event('close') as Event & { code: number; reason: string }
  Object.defineProperties(event, {
    code: { value: code },
    reason: { value: reason },
  })
  return event
}

function completedEvent(responseId: string): MessageEvent {
  return new MessageEvent('message', {
    data: JSON.stringify({
      type: 'response.completed',
      response: {
        id: responseId,
        status: 'completed',
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    }),
  })
}

function responseCreatedEvent(responseId: string): MessageEvent {
  return new MessageEvent('message', {
    data: JSON.stringify({ type: 'response.created', response: { id: responseId } }),
  })
}

function textDeltaEvents(text: string): MessageEvent[] {
  return [
    new MessageEvent('message', {
      data: JSON.stringify({
        type: 'response.output_item.added',
        item: { id: 'msg_partial', type: 'message', content: [] },
      }),
    }),
    new MessageEvent('message', {
      data: JSON.stringify({ type: 'response.content_part.added', part: { type: 'output_text', text: '' } }),
    }),
    new MessageEvent('message', {
      data: JSON.stringify({ type: 'response.output_text.delta', delta: text }),
    }),
  ]
}

function functionCallDeltaEvents(delta: string): MessageEvent[] {
  return [
    new MessageEvent('message', {
      data: JSON.stringify({
        type: 'response.output_item.added',
        item: {
          id: 'fc_partial',
          call_id: 'call_partial',
          type: 'function_call',
          name: 'shell',
          arguments: '',
        },
      }),
    }),
    new MessageEvent('message', {
      data: JSON.stringify({ type: 'response.function_call_arguments.delta', delta }),
    }),
  ]
}

function sseResponse(events: unknown[]): Response {
  const body = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
      }
      controller.close()
    },
  })
  return new Response(body, { status: 200 })
}

function completedSseEvent(responseId: string): unknown {
  return {
    type: 'response.completed',
    response: {
      id: responseId,
      status: 'completed',
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    },
  }
}

function installFailingFetch(message: string) {
  const fetchSpy = vi.fn(async () => {
    throw new Error(message)
  })
  globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch
  return fetchSpy
}

describe('OpenAI Codex transport forwarding and websocket recovery', () => {
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
        queueMicrotask(() => this.dispatchEvent(completedEvent('resp_test')))
      }

      close(_code?: number, _reason?: string) {
        this.readyState = FakeWebSocket.CLOSED
      }
    }

    globalThis.WebSocket = FakeWebSocket as unknown as typeof globalThis.WebSocket
    const fetchSpy = installFailingFetch('SSE fetch should not be used when transport is websocket-cached')

    const result = await streamSimple(codexModel, { messages: [] }, {
      apiKey: fakeCodexToken,
      transport: 'websocket-cached',
      sessionId: 'test-session-forwarding',
      reasoning: 'low',
    }).result()

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(constructedUrls).toEqual(['wss://chatgpt.com/backend-api/codex/responses'])
    expect(sentPayloads).toHaveLength(1)
    expect(JSON.parse(sentPayloads[0])).toMatchObject({ type: 'response.create', model: 'gpt-5.1-codex' })
    expect(result.stopReason).toBe('stop')
    expect(result.responseId).toBe('resp_test')
  })

  it('retries strict websocket once on a 1006 close after send but before output starts', async () => {
    const sockets: EventTarget[] = []
    const sentPayloads: string[] = []

    class FakeWebSocket extends EventTarget {
      static CONNECTING = 0
      static OPEN = 1
      static CLOSING = 2
      static CLOSED = 3
      readyState = FakeWebSocket.OPEN

      constructor(_url: string | URL, _protocols?: unknown) {
        super()
        sockets.push(this)
        queueMicrotask(() => this.dispatchEvent(new Event('open')))
      }

      send(payload: string) {
        sentPayloads.push(payload)
        if (sockets.length === 1) {
          queueMicrotask(() => this.dispatchEvent(closeEvent(1006)))
          return
        }
        queueMicrotask(() => this.dispatchEvent(completedEvent('resp_retry_success')))
      }

      close(_code?: number, _reason?: string) {
        this.readyState = FakeWebSocket.CLOSED
      }
    }

    globalThis.WebSocket = FakeWebSocket as unknown as typeof globalThis.WebSocket
    const fetchSpy = installFailingFetch('SSE fetch should not be used for strict websocket retry')

    const result = await streamSimple(codexModel, { messages: [] }, {
      apiKey: fakeCodexToken,
      transport: 'websocket',
      sessionId: 'test-session-strict-retry',
      reasoning: 'low',
    }).result()

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(sockets).toHaveLength(2)
    expect(sentPayloads).toHaveLength(2)
    expect(result.stopReason).toBe('stop')
    expect(result.responseId).toBe('resp_retry_success')
    expect(result.content).toEqual([])
  })

  it('does not retry or fall back after partial websocket output has started', async () => {
    const sockets: EventTarget[] = []

    class FakeWebSocket extends EventTarget {
      static CONNECTING = 0
      static OPEN = 1
      static CLOSING = 2
      static CLOSED = 3
      readyState = FakeWebSocket.OPEN

      constructor(_url: string | URL, _protocols?: unknown) {
        super()
        sockets.push(this)
        queueMicrotask(() => this.dispatchEvent(new Event('open')))
      }

      send(_payload: string) {
        queueMicrotask(() => {
          for (const event of textDeltaEvents('partial')) this.dispatchEvent(event)
          this.dispatchEvent(closeEvent(1006))
        })
      }

      close(_code?: number, _reason?: string) {
        this.readyState = FakeWebSocket.CLOSED
      }
    }

    globalThis.WebSocket = FakeWebSocket as unknown as typeof globalThis.WebSocket
    const fetchSpy = installFailingFetch('SSE fetch should not be used after partial websocket output')

    const result = await streamSimple(codexModel, { messages: [] }, {
      apiKey: fakeCodexToken,
      transport: 'websocket-cached',
      sessionId: 'test-session-partial',
      reasoning: 'low',
    }).result()

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(sockets).toHaveLength(1)
    expect(result.stopReason).toBe('error')
    expect(result.errorMessage).toContain('WebSocket closed 1006')
    expect(result.errorMessage).toContain('phase: response.output_text.delta')
    expect(result.content).toEqual([{ type: 'text', text: 'partial' }])
  })

  it('resets a stale response.created id before replaying a pre-output websocket close', async () => {
    const sentPayloads: string[] = []

    class FakeWebSocket extends EventTarget {
      static CONNECTING = 0
      static OPEN = 1
      static CLOSING = 2
      static CLOSED = 3
      readyState = FakeWebSocket.OPEN
      attempt: number

      constructor(_url: string | URL, _protocols?: unknown) {
        super()
        this.attempt = sentPayloads.length
        queueMicrotask(() => this.dispatchEvent(new Event('open')))
      }

      send(payload: string) {
        sentPayloads.push(payload)
        if (sentPayloads.length === 1) {
          queueMicrotask(() => {
            this.dispatchEvent(responseCreatedEvent('resp_stale'))
            this.dispatchEvent(closeEvent(1006))
          })
          return
        }
        queueMicrotask(() => this.dispatchEvent(completedEvent('resp_fresh')))
      }

      close(_code?: number, _reason?: string) {
        this.readyState = FakeWebSocket.CLOSED
      }
    }

    globalThis.WebSocket = FakeWebSocket as unknown as typeof globalThis.WebSocket
    installFailingFetch('SSE fetch should not be used for strict websocket retry')

    const result = await streamSimple(codexModel, { messages: [] }, {
      apiKey: fakeCodexToken,
      transport: 'websocket',
      sessionId: 'test-session-created-reset',
      reasoning: 'low',
    }).result()

    expect(sentPayloads).toHaveLength(2)
    expect(result.stopReason).toBe('stop')
    expect(result.responseId).toBe('resp_fresh')
    expect(result.responseId).not.toBe('resp_stale')
  })

  it('drops a reused cached stale socket and retries websocket-cached with full body and no previous_response_id', async () => {
    const sentPayloads: unknown[] = []
    const sockets: FakeWebSocket[] = []

    class FakeWebSocket extends EventTarget {
      static CONNECTING = 0
      static OPEN = 1
      static CLOSING = 2
      static CLOSED = 3
      readyState = FakeWebSocket.OPEN

      constructor(_url: string | URL, _protocols?: unknown) {
        super()
        sockets.push(this)
        queueMicrotask(() => this.dispatchEvent(new Event('open')))
      }

      send(payload: string) {
        const parsed = JSON.parse(payload) as Record<string, unknown>
        sentPayloads.push(parsed)
        if (sentPayloads.length === 1) {
          queueMicrotask(() => this.dispatchEvent(completedEvent('resp_cached_seed')))
          return
        }
        if (sentPayloads.length === 2) {
          queueMicrotask(() => this.dispatchEvent(closeEvent(1006)))
          return
        }
        queueMicrotask(() => this.dispatchEvent(completedEvent('resp_after_stale_retry')))
      }

      close(_code?: number, _reason?: string) {
        this.readyState = FakeWebSocket.CLOSED
      }
    }

    globalThis.WebSocket = FakeWebSocket as unknown as typeof globalThis.WebSocket
    const fetchSpy = installFailingFetch('SSE fetch should not be used when websocket-cached retry succeeds')

    await streamSimple(codexModel, { messages: [] }, {
      apiKey: fakeCodexToken,
      transport: 'websocket-cached',
      sessionId: 'test-session-stale-cache',
      reasoning: 'low',
    }).result()
    const result = await streamSimple(codexModel, userContext, {
      apiKey: fakeCodexToken,
      transport: 'websocket-cached',
      sessionId: 'test-session-stale-cache',
      reasoning: 'low',
    }).result()

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(sockets).toHaveLength(2)
    expect(sentPayloads).toHaveLength(3)
    expect(sentPayloads[1]).toMatchObject({ previous_response_id: 'resp_cached_seed' })
    expect(sentPayloads[2]).not.toHaveProperty('previous_response_id')
    expect((sentPayloads[2] as { input?: unknown[] }).input?.length).toBeGreaterThan(0)
    expect(result.responseId).toBe('resp_after_stale_retry')
  })

  it('preserves healthy websocket-cached continuation with previous_response_id and delta input', async () => {
    const sentPayloads: unknown[] = []
    const sockets: EventTarget[] = []

    class FakeWebSocket extends EventTarget {
      static CONNECTING = 0
      static OPEN = 1
      static CLOSING = 2
      static CLOSED = 3
      readyState = FakeWebSocket.OPEN

      constructor(_url: string | URL, _protocols?: unknown) {
        super()
        sockets.push(this)
        queueMicrotask(() => this.dispatchEvent(new Event('open')))
      }

      send(payload: string) {
        const parsed = JSON.parse(payload) as Record<string, unknown>
        sentPayloads.push(parsed)
        queueMicrotask(() => this.dispatchEvent(completedEvent(`resp_healthy_${sentPayloads.length}`)))
      }

      close(_code?: number, _reason?: string) {
        this.readyState = FakeWebSocket.CLOSED
      }
    }

    globalThis.WebSocket = FakeWebSocket as unknown as typeof globalThis.WebSocket
    const fetchSpy = installFailingFetch('SSE fetch should not be used for healthy cached continuation')

    await streamSimple(codexModel, { messages: [] }, {
      apiKey: fakeCodexToken,
      transport: 'websocket-cached',
      sessionId: 'test-session-healthy-cache',
      reasoning: 'low',
    }).result()
    const result = await streamSimple(codexModel, userContext, {
      apiKey: fakeCodexToken,
      transport: 'websocket-cached',
      sessionId: 'test-session-healthy-cache',
      reasoning: 'low',
    }).result()

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(sockets).toHaveLength(1)
    expect(sentPayloads).toHaveLength(2)
    expect(sentPayloads[1]).toMatchObject({ previous_response_id: 'resp_healthy_1' })
    expect((sentPayloads[1] as { input?: unknown[] }).input?.length).toBeGreaterThan(0)
    expect(result.responseId).toBe('resp_healthy_2')
  })

  it('falls back to SSE for auto transport after a replay-safe websocket failure', async () => {
    const sockets: EventTarget[] = []

    class FakeWebSocket extends EventTarget {
      static CONNECTING = 0
      static OPEN = 1
      static CLOSING = 2
      static CLOSED = 3
      readyState = FakeWebSocket.OPEN

      constructor(_url: string | URL, _protocols?: unknown) {
        super()
        sockets.push(this)
        queueMicrotask(() => this.dispatchEvent(new Event('open')))
      }

      send(_payload: string) {
        queueMicrotask(() => this.dispatchEvent(closeEvent(1006)))
      }

      close(_code?: number, _reason?: string) {
        this.readyState = FakeWebSocket.CLOSED
      }
    }

    globalThis.WebSocket = FakeWebSocket as unknown as typeof globalThis.WebSocket
    const fetchSpy = vi.fn(async () => sseResponse([completedSseEvent('resp_sse_fallback')]))
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch

    const result = await streamSimple(codexModel, { messages: [] }, {
      apiKey: fakeCodexToken,
      transport: 'auto',
      sessionId: 'test-session-auto-fallback',
      reasoning: 'low',
    }).result()

    expect(sockets).toHaveLength(1)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(result.stopReason).toBe('stop')
    expect(result.responseId).toBe('resp_sse_fallback')
  })

  it('does not retry or fall back after partial websocket-cached function-call output has started', async () => {
    const sockets: EventTarget[] = []

    class FakeWebSocket extends EventTarget {
      static CONNECTING = 0
      static OPEN = 1
      static CLOSING = 2
      static CLOSED = 3
      readyState = FakeWebSocket.OPEN

      constructor(_url: string | URL, _protocols?: unknown) {
        super()
        sockets.push(this)
        queueMicrotask(() => this.dispatchEvent(new Event('open')))
      }

      send(_payload: string) {
        queueMicrotask(() => {
          for (const event of functionCallDeltaEvents('{"cmd":"ls"}')) this.dispatchEvent(event)
          this.dispatchEvent(closeEvent(1006))
        })
      }

      close(_code?: number, _reason?: string) {
        this.readyState = FakeWebSocket.CLOSED
      }
    }

    globalThis.WebSocket = FakeWebSocket as unknown as typeof globalThis.WebSocket
    const fetchSpy = installFailingFetch('SSE fetch should not be used after partial function-call output')

    const result = await streamSimple(codexModel, { messages: [] }, {
      apiKey: fakeCodexToken,
      transport: 'websocket-cached',
      sessionId: 'test-session-partial-tool',
      reasoning: 'low',
    }).result()

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(sockets).toHaveLength(1)
    expect(result.stopReason).toBe('error')
    expect(result.errorMessage).toContain('WebSocket closed 1006')
    expect(result.errorMessage).toContain('phase: response.function_call_arguments.delta')
    expect(result.content).toEqual([{ type: 'toolCall', id: 'call_partial|fc_partial', name: 'shell', arguments: { cmd: 'ls' } }])
  })

  it('does not fall back to SSE for auto transport after partial output has started', async () => {
    const sockets: EventTarget[] = []

    class FakeWebSocket extends EventTarget {
      static CONNECTING = 0
      static OPEN = 1
      static CLOSING = 2
      static CLOSED = 3
      readyState = FakeWebSocket.OPEN

      constructor(_url: string | URL, _protocols?: unknown) {
        super()
        sockets.push(this)
        queueMicrotask(() => this.dispatchEvent(new Event('open')))
      }

      send(_payload: string) {
        queueMicrotask(() => {
          for (const event of textDeltaEvents('auto partial')) this.dispatchEvent(event)
          this.dispatchEvent(closeEvent(1006))
        })
      }

      close(_code?: number, _reason?: string) {
        this.readyState = FakeWebSocket.CLOSED
      }
    }

    globalThis.WebSocket = FakeWebSocket as unknown as typeof globalThis.WebSocket
    const fetchSpy = installFailingFetch('SSE fetch should not be used after partial auto output')

    const result = await streamSimple(codexModel, { messages: [] }, {
      apiKey: fakeCodexToken,
      transport: 'auto',
      sessionId: 'test-session-auto-partial',
      reasoning: 'low',
    }).result()

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(sockets).toHaveLength(1)
    expect(result.stopReason).toBe('error')
    expect(result.errorMessage).toContain('WebSocket closed 1006')
    expect(result.content).toEqual([{ type: 'text', text: 'auto partial' }])
  })

  it('does not retry or fall back when the request is aborted', async () => {
    const sockets: EventTarget[] = []
    const abortController = new AbortController()

    class FakeWebSocket extends EventTarget {
      static CONNECTING = 0
      static OPEN = 1
      static CLOSING = 2
      static CLOSED = 3
      readyState = FakeWebSocket.OPEN

      constructor(_url: string | URL, _protocols?: unknown) {
        super()
        sockets.push(this)
        queueMicrotask(() => this.dispatchEvent(new Event('open')))
      }

      send(_payload: string) {
        queueMicrotask(() => abortController.abort())
      }

      close(_code?: number, _reason?: string) {
        this.readyState = FakeWebSocket.CLOSED
      }
    }

    globalThis.WebSocket = FakeWebSocket as unknown as typeof globalThis.WebSocket
    const fetchSpy = installFailingFetch('SSE fetch should not be used after abort')

    const result = await streamSimple(codexModel, { messages: [] }, {
      apiKey: fakeCodexToken,
      transport: 'websocket-cached',
      sessionId: 'test-session-abort',
      reasoning: 'low',
      signal: abortController.signal,
    }).result()

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(sockets).toHaveLength(1)
    expect(result.stopReason).toBe('aborted')
    expect(result.errorMessage).toBe('Request was aborted')
  })
})
