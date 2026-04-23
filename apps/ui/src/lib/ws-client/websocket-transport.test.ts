import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocketTransport } from './websocket-transport'

// ---------------------------------------------------------------------------
// Fake WebSocket — mirrors the pattern from ws-client.test.ts
// ---------------------------------------------------------------------------

type ListenerMap = Record<string, Array<(event?: any) => void>>

class FakeWebSocket {
  static readonly OPEN = 1
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readonly sentPayloads: string[] = []
  readonly listeners: ListenerMap = {}

  readyState = FakeWebSocket.OPEN

  constructor(_url: string) {
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, listener: (event?: any) => void): void {
    this.listeners[type] ??= []
    this.listeners[type].push(listener)
  }

  send(payload: string): void {
    this.sentPayloads.push(payload)
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED
    this.emit('close', new Event('close'))
  }

  emit(type: string, event?: any): void {
    const handlers = this.listeners[type] ?? []
    for (const handler of handlers) {
      handler(event)
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WebSocketTransport', () => {
  const originalWebSocket = globalThis.WebSocket

  beforeEach(() => {
    FakeWebSocket.instances = []
    vi.useFakeTimers()
    ;(globalThis as any).WebSocket = FakeWebSocket
  })

  afterEach(() => {
    vi.useRealTimers()
    ;(globalThis as any).WebSocket = originalWebSocket
  })

  it('connects and fires onOpen callback', () => {
    const onOpen = vi.fn()
    const transport = new WebSocketTransport({
      url: 'ws://localhost:8787',
      onOpen,
    })

    transport.connect()
    vi.advanceTimersByTime(0)

    const socket = FakeWebSocket.instances[0]
    expect(socket).toBeDefined()

    socket.emit('open')
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(transport.isConnected()).toBe(true)

    transport.disconnect()
  })

  it('fires onClose callback on socket close', () => {
    const onClose = vi.fn()
    const transport = new WebSocketTransport({
      url: 'ws://localhost:8787',
      onClose,
    })

    transport.connect()
    vi.advanceTimersByTime(0)

    const socket = FakeWebSocket.instances[0]
    socket.emit('open')

    socket.close()
    expect(onClose).toHaveBeenCalledTimes(1)

    transport.disconnect()
  })

  it('fires onError callback on socket error', () => {
    const onError = vi.fn()
    const transport = new WebSocketTransport({
      url: 'ws://localhost:8787',
      onError,
    })

    transport.connect()
    vi.advanceTimersByTime(0)

    const socket = FakeWebSocket.instances[0]
    const errorEvent = new Event('error')
    socket.emit('error', errorEvent)
    expect(onError).toHaveBeenCalledWith(errorEvent)

    transport.disconnect()
  })

  it('parses JSON messages and fires onMessage with parsed data', () => {
    const onMessage = vi.fn()
    const transport = new WebSocketTransport({
      url: 'ws://localhost:8787',
      onMessage,
    })

    transport.connect()
    vi.advanceTimersByTime(0)

    const socket = FakeWebSocket.instances[0]
    socket.emit('open')

    const payload = { type: 'test_event', value: 42 }
    socket.emit('message', { data: JSON.stringify(payload) })

    expect(onMessage).toHaveBeenCalledWith(payload)

    transport.disconnect()
  })

  it('silently ignores non-JSON messages', () => {
    const onMessage = vi.fn()
    const transport = new WebSocketTransport({
      url: 'ws://localhost:8787',
      onMessage,
    })

    transport.connect()
    vi.advanceTimersByTime(0)

    const socket = FakeWebSocket.instances[0]
    socket.emit('open')
    socket.emit('message', { data: 'not-json{{{' })

    expect(onMessage).not.toHaveBeenCalled()

    transport.disconnect()
  })

  it('reconnects after close with configured delay', () => {
    const transport = new WebSocketTransport({
      url: 'ws://localhost:8787',
      reconnectDelayMs: 2000,
    })

    transport.connect()
    vi.advanceTimersByTime(0)

    const socket1 = FakeWebSocket.instances[0]
    socket1.emit('open')
    socket1.close()

    // Before delay — no new socket
    expect(FakeWebSocket.instances).toHaveLength(1)

    // After delay — reconnected
    vi.advanceTimersByTime(2000)
    expect(FakeWebSocket.instances).toHaveLength(2)

    const socket2 = FakeWebSocket.instances[1]
    socket2.emit('open')
    expect(transport.isConnected()).toBe(true)

    transport.disconnect()
  })

  it('does not reconnect after disconnect()', () => {
    const transport = new WebSocketTransport({
      url: 'ws://localhost:8787',
      reconnectDelayMs: 500,
    })

    transport.connect()
    vi.advanceTimersByTime(0)

    const socket = FakeWebSocket.instances[0]
    socket.emit('open')

    transport.disconnect()

    // Even after the reconnect delay, no new socket should be created
    vi.advanceTimersByTime(5000)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('send() returns false when disconnected', () => {
    const transport = new WebSocketTransport({
      url: 'ws://localhost:8787',
    })

    // Not connected yet
    expect(transport.send({ type: 'test' })).toBe(false)

    transport.connect()
    vi.advanceTimersByTime(0)

    const socket = FakeWebSocket.instances[0]
    socket.emit('open')

    // Connected — should succeed
    expect(transport.send({ type: 'hello' })).toBe(true)
    expect(JSON.parse(socket.sentPayloads[0])).toEqual({ type: 'hello' })

    // Disconnect, then try again
    transport.disconnect()
    expect(transport.send({ type: 'goodbye' })).toBe(false)
  })

  it('send() JSON-serializes data', () => {
    const transport = new WebSocketTransport({
      url: 'ws://localhost:8787',
    })

    transport.connect()
    vi.advanceTimersByTime(0)

    const socket = FakeWebSocket.instances[0]
    socket.emit('open')

    transport.send({ type: 'subscribe', agentId: 'mgr-1' })

    expect(socket.sentPayloads).toHaveLength(1)
    expect(JSON.parse(socket.sentPayloads[0])).toEqual({
      type: 'subscribe',
      agentId: 'mgr-1',
    })

    transport.disconnect()
  })

  it('sends heartbeat pings at the configured interval', () => {
    const transport = new WebSocketTransport({
      url: 'ws://localhost:8787',
      heartbeatIntervalMs: 5000,
    })

    transport.connect()
    vi.advanceTimersByTime(0)

    const socket = FakeWebSocket.instances[0]
    socket.emit('open')

    // No ping yet
    expect(socket.sentPayloads).toHaveLength(0)

    // Advance past one interval
    vi.advanceTimersByTime(5000)
    expect(socket.sentPayloads).toHaveLength(1)
    expect(JSON.parse(socket.sentPayloads[0])).toEqual({ type: 'ping' })

    // Another interval
    vi.advanceTimersByTime(5000)
    expect(socket.sentPayloads).toHaveLength(2)

    transport.disconnect()
  })

  it('stops heartbeat on close and restarts on reconnect', () => {
    const transport = new WebSocketTransport({
      url: 'ws://localhost:8787',
      heartbeatIntervalMs: 3000,
      reconnectDelayMs: 1000,
    })

    transport.connect()
    vi.advanceTimersByTime(0)

    const socket1 = FakeWebSocket.instances[0]
    socket1.emit('open')

    // One heartbeat
    vi.advanceTimersByTime(3000)
    expect(socket1.sentPayloads).toHaveLength(1)

    // Close — heartbeat should stop
    socket1.close()
    vi.advanceTimersByTime(3000)
    // No additional pings after close
    expect(socket1.sentPayloads).toHaveLength(1)

    // Reconnect
    vi.advanceTimersByTime(1000)
    const socket2 = FakeWebSocket.instances[1]
    socket2.emit('open')

    // Heartbeat resumes on new socket
    vi.advanceTimersByTime(3000)
    expect(socket2.sentPayloads).toHaveLength(1)
    expect(JSON.parse(socket2.sentPayloads[0])).toEqual({ type: 'ping' })

    transport.disconnect()
  })

  it('connect() with initial delay schedules connection after that delay', () => {
    const onOpen = vi.fn()
    const transport = new WebSocketTransport({
      url: 'ws://localhost:8787',
      onOpen,
    })

    transport.connect(100)

    // Before delay
    vi.advanceTimersByTime(50)
    expect(FakeWebSocket.instances).toHaveLength(0)

    // After delay
    vi.advanceTimersByTime(50)
    expect(FakeWebSocket.instances).toHaveLength(1)

    FakeWebSocket.instances[0].emit('open')
    expect(onOpen).toHaveBeenCalledTimes(1)

    transport.disconnect()
  })

  it('subsequent connect() calls are no-ops', () => {
    const transport = new WebSocketTransport({
      url: 'ws://localhost:8787',
    })

    transport.connect()
    transport.connect() // should be ignored
    transport.connect()

    vi.advanceTimersByTime(0)
    expect(FakeWebSocket.instances).toHaveLength(1)

    transport.disconnect()
  })

  it('isConnected() returns false before connect and after disconnect', () => {
    const transport = new WebSocketTransport({
      url: 'ws://localhost:8787',
    })

    expect(transport.isConnected()).toBe(false)

    transport.connect()
    vi.advanceTimersByTime(0)
    FakeWebSocket.instances[0].emit('open')
    expect(transport.isConnected()).toBe(true)

    transport.disconnect()
    expect(transport.isConnected()).toBe(false)
  })
})
