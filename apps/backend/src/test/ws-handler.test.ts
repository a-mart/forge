import { describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import type { ServerEvent } from '@forge/protocol'
import type { SidebarPerfRecorder } from '../stats/sidebar-perf-types.js'
import { WsHandler } from '../ws/ws-handler.js'
import { resetWsLogThrottleForTest } from '../ws/ws-log-throttle.js'

function createPerfStub(): SidebarPerfRecorder {
  return {
    recordDuration: vi.fn(),
    increment: vi.fn(),
    readSummary: vi.fn(() => ({ histograms: {}, counters: {} })),
    readRecentSlowEvents: vi.fn(() => []),
  }
}

describe('WsHandler send guards', () => {
  it('rate-limits aggregate conversation paging per websocket', () => {
    const handler = new WsHandler({
      swarmManager: {
        getConfig: () => ({ debug: false, paths: { dataDir: '/tmp' } }),
      } as any,
      mobilePushService: {} as any,
      allowNonManagerSubscriptions: true,
      perf: createPerfStub(),
    })
    const socket = {} as WebSocket

    for (let index = 0; index < 8; index += 1) {
      expect((handler as any).allowConversationPageRequest(socket)).toBe(true)
    }
    expect((handler as any).allowConversationPageRequest(socket)).toBe(false)
  })

  it('throttles repeated websocket backpressure warnings by event type', () => {
    resetWsLogThrottleForTest()
    const handler = new WsHandler({
      swarmManager: {
        getConfig: () => ({
          debug: false,
          paths: { dataDir: '/tmp' },
        }),
      } as any,
      mobilePushService: {} as any,
      playwrightDiscovery: null,
      allowNonManagerSubscriptions: true,
      perf: createPerfStub(),
    })

    const socket = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 2 * 1024 * 1024,
      send: vi.fn(),
      terminate: vi.fn(),
      _socket: {
        write: vi.fn(),
      },
    } as any

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      ;(handler as any).send(socket, {
        type: 'ready',
        serverTime: '2026-03-19T00:00:00.000Z',
        subscribedAgentId: 'cortex',
      } satisfies ServerEvent)
      ;(handler as any).send(socket, {
        type: 'ready',
        serverTime: '2026-03-19T00:00:01.000Z',
        subscribedAgentId: 'cortex',
      } satisfies ServerEvent)
      ;(handler as any).send(socket, {
        type: 'agents_snapshot',
        agents: [],
      } satisfies ServerEvent)
      ;(handler as any).send(socket, {
        type: 'agents_snapshot',
        agents: [],
      } satisfies ServerEvent)

      expect(socket.send).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalledTimes(2)
      expect(warn).toHaveBeenNthCalledWith(
        1,
        '[swarm] ws:drop_event:backpressure',
        expect.objectContaining({
          eventType: 'ready',
          bufferedAmount: 2 * 1024 * 1024,
        }),
      )
      expect(warn).toHaveBeenNthCalledWith(
        2,
        '[swarm] ws:drop_event:backpressure',
        expect.objectContaining({
          eventType: 'agents_snapshot',
          bufferedAmount: 2 * 1024 * 1024,
        }),
      )
    } finally {
      warn.mockRestore()
      resetWsLogThrottleForTest()
    }
  })

  it('drops malformed websocket clients before ws send can recurse into itself', () => {
    const handler = new WsHandler({
      swarmManager: {
        getConfig: () => ({
          debug: false,
          paths: { dataDir: '/tmp' },
        }),
      } as any,
      mobilePushService: {} as any,
      allowNonManagerSubscriptions: true,
      perf: createPerfStub(),
    })

    const terminate = vi.fn()
    const send = vi.fn()
    const socket = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
      send,
      terminate,
      _socket: {
        write: send,
      },
    } as any

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      ;(handler as any).send(socket, {
        type: 'ready',
        serverTime: '2026-03-19T00:00:00.000Z',
        subscribedAgentId: 'cortex',
      } satisfies ServerEvent)

      expect(send).not.toHaveBeenCalled()
      expect(terminate).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalledWith(
        '[swarm] ws:drop_event:invalid_socket',
        expect.objectContaining({
          eventType: 'ready',
          reason: 'socket_write_recurses_into_websocket_send',
        }),
      )
    } finally {
      warn.mockRestore()
    }
  })

  it('catches synchronous websocket send failures instead of crashing the process', () => {
    const handler = new WsHandler({
      swarmManager: {
        getConfig: () => ({
          debug: false,
          paths: { dataDir: '/tmp' },
        }),
      } as any,
      mobilePushService: {} as any,
      allowNonManagerSubscriptions: true,
      perf: createPerfStub(),
    })

    const terminate = vi.fn()
    const socket = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
      send: () => {
        throw new RangeError('Maximum call stack size exceeded')
      },
      terminate,
      _socket: {
        write: vi.fn(),
      },
    } as any

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      expect(() => {
        ;(handler as any).send(socket, {
          type: 'ready',
          serverTime: '2026-03-19T00:00:00.000Z',
          subscribedAgentId: 'cortex',
        } satisfies ServerEvent)
      }).not.toThrow()

      expect(terminate).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalledWith(
        '[swarm] ws:drop_event:send_failed',
        expect.objectContaining({
          eventType: 'ready',
          message: 'Maximum call stack size exceeded',
        }),
      )
    } finally {
      warn.mockRestore()
    }
  })
})

describe('WsHandler session attention dismissal', () => {
  function createOpenSocket() {
    return {
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
      send: vi.fn(),
      terminate: vi.fn(),
      _socket: { write: vi.fn() },
    } as any
  }

  it('accepts an exact dismissal before room subscription and correlates the result', async () => {
    const dismissSessionAttention = vi.fn(async () => ({
      revision: 8,
      changes: [{ sessionAgentId: 'manager-1', attention: null }],
    }))
    const handler = new WsHandler({
      swarmManager: {
        getConfig: () => ({ runtimeTarget: 'builder', debug: false, paths: { dataDir: '/tmp' } }),
        dismissSessionAttention,
      } as any,
      mobilePushService: {} as any,
      allowNonManagerSubscriptions: true,
      perf: createPerfStub(),
    })
    const socket = createOpenSocket()

    await (handler as any).handleSocketMessage(socket, Buffer.from(JSON.stringify({
      type: 'dismiss_session_attention',
      attentionIds: ['attention-1'],
      requestId: 'dismiss-1',
    })))

    expect(dismissSessionAttention).toHaveBeenCalledWith(['attention-1'])
    expect(JSON.parse(socket.send.mock.calls[0]![0])).toEqual({
      type: 'session_attention_update',
      revision: 8,
      changes: [{ sessionAgentId: 'manager-1', attention: null }],
      requestId: 'dismiss-1',
    })
  })

  it('correlates validation errors for an oversized dismissal', async () => {
    const dismissSessionAttention = vi.fn()
    const handler = new WsHandler({
      swarmManager: {
        getConfig: () => ({ runtimeTarget: 'builder', debug: false, paths: { dataDir: '/tmp' } }),
        dismissSessionAttention,
      } as any,
      mobilePushService: {} as any,
      allowNonManagerSubscriptions: true,
      perf: createPerfStub(),
    })
    const socket = createOpenSocket()

    await (handler as any).handleSocketMessage(socket, Buffer.from(JSON.stringify({
      type: 'dismiss_session_attention',
      attentionIds: Array.from({ length: 101 }, (_, index) => `attention-${index}`),
      requestId: 'dismiss-too-many',
    })))

    expect(dismissSessionAttention).not.toHaveBeenCalled()
    expect(JSON.parse(socket.send.mock.calls[0]![0])).toEqual({
      type: 'error',
      code: 'INVALID_COMMAND',
      message: 'dismiss_session_attention.attentionIds must contain at most 100 entries',
      requestId: 'dismiss-too-many',
    })
  })

  it('returns a correlated error when durable dismissal fails', async () => {
    const handler = new WsHandler({
      swarmManager: {
        getConfig: () => ({ runtimeTarget: 'builder', debug: false, paths: { dataDir: '/tmp' } }),
        dismissSessionAttention: vi.fn(async () => { throw new Error('disk unavailable') }),
      } as any,
      mobilePushService: {} as any,
      allowNonManagerSubscriptions: true,
      perf: createPerfStub(),
    })
    const socket = createOpenSocket()

    await (handler as any).handleSocketMessage(socket, Buffer.from(JSON.stringify({
      type: 'dismiss_session_attention',
      attentionIds: ['attention-1'],
      requestId: 'dismiss-2',
    })))

    expect(JSON.parse(socket.send.mock.calls[0]![0])).toEqual({
      type: 'error',
      code: 'SESSION_ATTENTION_DISMISS_FAILED',
      message: 'disk unavailable',
      requestId: 'dismiss-2',
    })
  })
})
