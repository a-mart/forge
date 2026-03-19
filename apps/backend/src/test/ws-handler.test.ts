import { describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import type { ServerEvent } from '@forge/protocol'
import { WsHandler } from '../ws/ws-handler.js'

describe('WsHandler send guards', () => {
  it('drops malformed websocket clients before ws send can recurse into itself', () => {
    const handler = new WsHandler({
      swarmManager: {
        getConfig: () => ({
          debug: false,
          paths: { dataDir: '/tmp' },
        }),
      } as any,
      integrationRegistry: null,
      mobilePushService: {} as any,
      playwrightDiscovery: null,
      allowNonManagerSubscriptions: true,
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
      integrationRegistry: null,
      mobilePushService: {} as any,
      playwrightDiscovery: null,
      allowNonManagerSubscriptions: true,
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
