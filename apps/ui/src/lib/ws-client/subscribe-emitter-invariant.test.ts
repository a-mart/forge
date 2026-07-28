import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ManagerWsClient } from '../ws-client'

class BehavioralFakeSocket {
  static readonly OPEN = 1
  static readonly CLOSED = 3
  static instances: BehavioralFakeSocket[] = []
  readonly sent: string[] = []
  readonly listeners: Record<string, Array<(event?: unknown) => void>> = {}
  readyState = BehavioralFakeSocket.OPEN

  constructor(_url: string) { BehavioralFakeSocket.instances.push(this) }
  addEventListener(type: string, listener: (event?: unknown) => void) {
    ;(this.listeners[type] ??= []).push(listener)
  }
  send(payload: string) { this.sent.push(payload) }
  close() { this.readyState = BehavioralFakeSocket.CLOSED; this.emit('close') }
  emit(type: string, event?: unknown) { for (const listener of this.listeners[type] ?? []) listener(event) }
}

describe('conversation subscription emitter invariant', () => {
  const originalWebSocket = globalThis.WebSocket
  const originalWindow = (globalThis as { window?: unknown }).window
  beforeEach(() => {
    BehavioralFakeSocket.instances = []
    vi.useFakeTimers()
    ;(globalThis as { window: unknown }).window = {}
    ;(globalThis as { WebSocket: unknown }).WebSocket = BehavioralFakeSocket
  })
  afterEach(() => {
    vi.useRealTimers()
    ;(globalThis as { WebSocket: unknown }).WebSocket = originalWebSocket
    ;(globalThis as { window?: unknown }).window = originalWindow
  })

  it('emits one correlated subscribe command after installing pending bootstrap state', () => {
    const client = new ManagerWsClient('ws://127.0.0.1:47187', 'session-a')
    client.start()
    vi.advanceTimersByTime(60)
    const socket = BehavioralFakeSocket.instances[0]!
    socket.emit('open')

    client.subscribeToAgent('session-b')
    const commands = socket.sent.map((payload) => JSON.parse(payload) as Record<string, unknown>)
    const subscribes = commands.filter((command) => command.type === 'subscribe')
    expect(subscribes).toHaveLength(2)
    const latest = subscribes.at(-1)!
    expect(latest.agentId).toBe('session-b')
    expect(typeof latest.subscriptionId).toBe('string')
    expect(client.getState().conversationBootstrap).toMatchObject({
      phase: 'pending', agentId: 'session-b', subscriptionId: latest.subscriptionId,
    })

    socket.emit('message', { data: JSON.stringify({
      type: 'conversation_history', agentId: 'session-b', messages: [],
      subscriptionId: latest.subscriptionId, servedConversationView: 'web',
    }) })
    expect(client.getState().conversationBootstrap).toMatchObject({ phase: 'ready', protocolMode: 'correlated' })

    // The same active subscription must continue through live ingestion after replay/bootstrap.
    socket.emit('message', { data: JSON.stringify({
      type: 'conversation_message', agentId: 'session-b', id: 'live-1', role: 'assistant',
      text: 'live append', timestamp: new Date().toISOString(), source: 'speak_to_user',
      subscriptionId: latest.subscriptionId,
    }) })
    expect(client.getState().messages.some((message) => message.type === 'conversation_message' && message.text === 'live append')).toBe(true)
    client.destroy()
  })
})
