import { describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import type { ServerEvent } from '@forge/protocol'
import {
  BOOTSTRAP_CRITICAL_EVENT_TYPES,
  MAX_WS_BUFFERED_AMOUNT_BYTES,
  MAX_WS_CATALOG_SNAPSHOT_BYTES,
  MAX_WS_EVENT_BYTES,
  sendWsEvent,
  sendWsEventWithBackpressure,
  waitForSocketDrain,
} from '../ws/ws-send.js'
import { resetWsLogThrottleForTest } from '../ws/ws-log-throttle.js'

/**
 * Minimal fake matching the send-path validation in ws-send.ts: it needs a distinct `_socket` object
 * exposing a `write` function (that is not the socket's own `send`), an OPEN readyState, a mutable
 * `bufferedAmount`, and `send`/`terminate` spies.
 */
function createFakeSocket(options: { bufferedAmount?: number } = {}): {
  socket: WebSocket
  sendMock: ReturnType<typeof vi.fn>
  setBufferedAmount: (value: number) => void
  setReadyState: (value: number) => void
} {
  let bufferedAmount = options.bufferedAmount ?? 0
  let readyState: number = WebSocket.OPEN
  const sendMock = vi.fn((_data: string, cb?: (error?: Error) => void) => {
    cb?.(undefined)
  })

  const socket = {
    _socket: { write: () => true },
    get readyState() {
      return readyState
    },
    get bufferedAmount() {
      return bufferedAmount
    },
    send: sendMock,
    terminate: vi.fn(),
  } as unknown as WebSocket

  return {
    socket,
    sendMock,
    setBufferedAmount: (value: number) => {
      bufferedAmount = value
    },
    setReadyState: (value: number) => {
      readyState = value
    },
  }
}

function readyEvent(): ServerEvent {
  return { type: 'ready', serverTime: '2026-01-01T00:00:00.000Z', subscribedAgentId: 'manager-1' }
}

function liveEvent(): ServerEvent {
  return {
    type: 'agent_message',
    agentId: 'manager-1',
    text: 'streaming chunk',
    timestamp: '2026-01-01T00:00:00.000Z',
  } as ServerEvent
}

describe('sendWsEventWithBackpressure', () => {
  it('exposes ready and conversation_history as bootstrap-critical', () => {
    expect(BOOTSTRAP_CRITICAL_EVENT_TYPES.has('ready')).toBe(true)
    expect(BOOTSTRAP_CRITICAL_EVENT_TYPES.has('conversation_history')).toBe(true)
    expect(BOOTSTRAP_CRITICAL_EVENT_TYPES.has('bootstrap_failed')).toBe(true)
    expect(BOOTSTRAP_CRITICAL_EVENT_TYPES.has('agents_snapshot')).toBe(true)
    // Sole carrier of sticky Needs You state at bootstrap and in live fanout.
    expect(BOOTSTRAP_CRITICAL_EVENT_TYPES.has('session_attention_snapshot')).toBe(true)
    expect(BOOTSTRAP_CRITICAL_EVENT_TYPES.has('agent_message')).toBe(false)
  })

  it('awaits drain and then sends a bootstrap-critical event instead of dropping it', async () => {
    resetWsLogThrottleForTest()
    const fake = createFakeSocket({ bufferedAmount: MAX_WS_BUFFERED_AMOUNT_BYTES + 500_000 })
    const onDropSocket = vi.fn()

    const pending = sendWsEventWithBackpressure({
      socket: fake.socket,
      event: readyEvent(),
      onDropSocket,
    })

    // Buffer is still over cap: nothing sent yet, socket not dropped/terminated.
    await Promise.resolve()
    expect(fake.sendMock).not.toHaveBeenCalled()

    // Simulate the OS draining the socket buffer below the cap.
    fake.setBufferedAmount(0)

    const bytes = await pending
    expect(fake.sendMock).toHaveBeenCalledTimes(1)
    expect(typeof bytes).toBe('number')
    expect(onDropSocket).not.toHaveBeenCalled()
    expect((fake.socket.terminate as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })

  it('does not terminate the socket for transient backpressure while awaiting drain', async () => {
    resetWsLogThrottleForTest()
    const fake = createFakeSocket({ bufferedAmount: MAX_WS_BUFFERED_AMOUNT_BYTES + 200_000 })
    const onDropSocket = vi.fn()

    const pending = sendWsEventWithBackpressure({
      socket: fake.socket,
      event: readyEvent(),
      onDropSocket,
      timeoutMs: 50,
    })

    fake.setBufferedAmount(10)
    await pending

    expect(onDropSocket).not.toHaveBeenCalled()
    expect(fake.socket.terminate).not.toHaveBeenCalled()
    expect(fake.sendMock).toHaveBeenCalledTimes(1)
  })

  it('awaits drain and sends a requestId-carrying response instead of dropping it', async () => {
    // Regression: a session_workers_snapshot response dropped while a large
    // session bootstrap saturated the socket left the client hanging on its
    // pending get_session_workers promise (deduping every retry) and the
    // sidebar/pill worker lists permanently empty.
    resetWsLogThrottleForTest()
    const fake = createFakeSocket({ bufferedAmount: MAX_WS_BUFFERED_AMOUNT_BYTES + 500_000 })
    const onDropSocket = vi.fn()

    const pending = sendWsEventWithBackpressure({
      socket: fake.socket,
      event: {
        type: 'session_workers_snapshot',
        sessionAgentId: 'manager-1',
        workers: [],
        requestId: 'get_session_workers-1',
      } as unknown as ServerEvent,
      onDropSocket,
    })

    await Promise.resolve()
    expect(fake.sendMock).not.toHaveBeenCalled()

    fake.setBufferedAmount(0)

    const bytes = await pending
    expect(fake.sendMock).toHaveBeenCalledTimes(1)
    expect(typeof bytes).toBe('number')
    expect(onDropSocket).not.toHaveBeenCalled()
  })

  it('classifies a nested browser automation requestId as critical and waits for drain', async () => {
    resetWsLogThrottleForTest()
    const fake = createFakeSocket({ bufferedAmount: MAX_WS_BUFFERED_AMOUNT_BYTES + 100 })
    const pending = sendWsEventWithBackpressure({
      socket: fake.socket,
      event: {
        type: 'browser_automation_request',
        request: { requestId: 'broker-1' },
      } as unknown as ServerEvent,
      onDropSocket: vi.fn(),
    })
    await Promise.resolve()
    expect(fake.sendMock).not.toHaveBeenCalled()
    fake.setBufferedAmount(0)
    await expect(pending).resolves.toEqual(expect.any(Number))
    expect(fake.sendMock).toHaveBeenCalledOnce()
  })

  it('still drops a requestId-less broadcast of the same event type when over the cap', async () => {
    resetWsLogThrottleForTest()
    const fake = createFakeSocket({ bufferedAmount: MAX_WS_BUFFERED_AMOUNT_BYTES + 1 })
    const onDropSocket = vi.fn()

    const result = await sendWsEventWithBackpressure({
      socket: fake.socket,
      event: {
        type: 'session_workers_snapshot',
        sessionAgentId: 'manager-1',
        workers: [],
      } as unknown as ServerEvent,
      onDropSocket,
    })

    expect(result).toBeNull()
    expect(fake.sendMock).not.toHaveBeenCalled()
    expect(onDropSocket).not.toHaveBeenCalled()
  })

  it('drops (does not send) a non-bootstrap event when over the buffer cap', async () => {
    resetWsLogThrottleForTest()
    const fake = createFakeSocket({ bufferedAmount: MAX_WS_BUFFERED_AMOUNT_BYTES + 1 })
    const onDropSocket = vi.fn()

    const result = await sendWsEventWithBackpressure({
      socket: fake.socket,
      event: liveEvent(),
      onDropSocket,
    })

    expect(result).toBeNull()
    expect(fake.sendMock).not.toHaveBeenCalled()
    // Backpressure-drop of a live event must not terminate the socket.
    expect(onDropSocket).not.toHaveBeenCalled()
    expect(fake.socket.terminate).not.toHaveBeenCalled()
  })

  it('falls back to the drop path when the drain wait times out on a stuck socket', async () => {
    resetWsLogThrottleForTest()
    const fake = createFakeSocket({ bufferedAmount: MAX_WS_BUFFERED_AMOUNT_BYTES + 1 })
    const onDropSocket = vi.fn()

    // Buffer never drains; a short timeout forces the fallback to sendWsEvent (which drops over cap).
    const result = await sendWsEventWithBackpressure({
      socket: fake.socket,
      event: readyEvent(),
      onDropSocket,
      timeoutMs: 40,
    })

    expect(result).toBeNull()
    expect(fake.sendMock).not.toHaveBeenCalled()
    // Transient backpressure (buffer full, no send error) must never terminate the socket.
    expect(onDropSocket).not.toHaveBeenCalled()
    expect(fake.socket.terminate).not.toHaveBeenCalled()
  })

  it('sends immediately when the buffer is already under the cap', async () => {
    resetWsLogThrottleForTest()
    const fake = createFakeSocket({ bufferedAmount: 0 })
    const onDropSocket = vi.fn()

    const bytes = await sendWsEventWithBackpressure({
      socket: fake.socket,
      event: readyEvent(),
      onDropSocket,
    })

    expect(typeof bytes).toBe('number')
    expect(fake.sendMock).toHaveBeenCalledTimes(1)
  })
})

describe('waitForSocketDrain', () => {
  it('resolves false immediately when the socket is not OPEN', async () => {
    const fake = createFakeSocket({ bufferedAmount: MAX_WS_BUFFERED_AMOUNT_BYTES + 1 })
    fake.setReadyState(WebSocket.CLOSED)
    await expect(waitForSocketDrain(fake.socket, 1000)).resolves.toBe(false)
  })

  it('resolves true immediately when already under the cap', async () => {
    const fake = createFakeSocket({ bufferedAmount: 0 })
    await expect(waitForSocketDrain(fake.socket, 1000)).resolves.toBe(true)
  })

  it('resolves false when the socket closes mid-wait (no busy loop, no throw)', async () => {
    const fake = createFakeSocket({ bufferedAmount: MAX_WS_BUFFERED_AMOUNT_BYTES + 1 })
    const pending = waitForSocketDrain(fake.socket, 1000)
    fake.setReadyState(WebSocket.CLOSING)
    await expect(pending).resolves.toBe(false)
  })

  it('resolves true once the buffer drains below the cap', async () => {
    const fake = createFakeSocket({ bufferedAmount: MAX_WS_BUFFERED_AMOUNT_BYTES + 100 })
    const pending = waitForSocketDrain(fake.socket, 1000)
    fake.setBufferedAmount(0)
    await expect(pending).resolves.toBe(true)
  })
})

describe('sendWsEvent (live-path drop behavior is unchanged)', () => {
  it('allows catalog snapshots beyond the general event cap', () => {
    resetWsLogThrottleForTest()
    const fake = createFakeSocket({ bufferedAmount: 0 })
    const onDropSocket = vi.fn()
    const event = {
      type: 'agents_snapshot',
      agents: [],
      testPadding: 'x'.repeat(MAX_WS_EVENT_BYTES),
    } as unknown as ServerEvent

    const eventBytes = Buffer.byteLength(JSON.stringify(event), 'utf8')
    expect(eventBytes).toBeGreaterThan(MAX_WS_EVENT_BYTES)
    expect(eventBytes).toBeLessThan(MAX_WS_CATALOG_SNAPSHOT_BYTES)

    expect(sendWsEvent({ socket: fake.socket, event, onDropSocket })).toBe(eventBytes)
    expect(fake.sendMock).toHaveBeenCalledTimes(1)
    expect(onDropSocket).not.toHaveBeenCalled()
  })

  it('keeps the general event cap for non-catalog events', () => {
    resetWsLogThrottleForTest()
    const fake = createFakeSocket({ bufferedAmount: 0 })
    const onDropSocket = vi.fn()
    const event = {
      ...liveEvent(),
      text: 'x'.repeat(MAX_WS_EVENT_BYTES),
    } as ServerEvent

    expect(sendWsEvent({ socket: fake.socket, event, onDropSocket })).toBeNull()
    expect(fake.sendMock).not.toHaveBeenCalled()
    expect(onDropSocket).not.toHaveBeenCalled()
  })

  it('drops over-cap events without terminating', () => {
    resetWsLogThrottleForTest()
    const fake = createFakeSocket({ bufferedAmount: MAX_WS_BUFFERED_AMOUNT_BYTES + 1 })
    const onDropSocket = vi.fn()

    const result = sendWsEvent({ socket: fake.socket, event: liveEvent(), onDropSocket })

    expect(result).toBeNull()
    expect(fake.sendMock).not.toHaveBeenCalled()
    expect(onDropSocket).not.toHaveBeenCalled()
    expect(fake.socket.terminate).not.toHaveBeenCalled()
  })

  it('terminates via onDropSocket on a genuine synchronous send error', () => {
    resetWsLogThrottleForTest()
    const fake = createFakeSocket({ bufferedAmount: 0 })
    fake.sendMock.mockImplementationOnce(() => {
      throw new Error('broken socket')
    })
    const onDropSocket = vi.fn()

    const result = sendWsEvent({ socket: fake.socket, event: readyEvent(), onDropSocket })

    expect(result).toBeNull()
    expect(onDropSocket).toHaveBeenCalledTimes(1)
  })
})
