import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CollabWsClient } from './ws-client'

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
    this.emit('close')
  }

  emit(type: string, event?: any): void {
    const handlers = this.listeners[type] ?? []
    for (const handler of handlers) {
      handler(event)
    }
  }
}

function emitServerEvent(socket: FakeWebSocket, event: unknown): void {
  socket.emit('message', {
    data: JSON.stringify(event),
  })
}

describe('CollabWsClient (transport-backed)', () => {
  const originalWebSocket = globalThis.WebSocket
  const originalWindow = (globalThis as any).window

  beforeEach(() => {
    FakeWebSocket.instances = []
    vi.useFakeTimers()
    ;(globalThis as any).window = {}
    ;(globalThis as any).WebSocket = FakeWebSocket
  })

  afterEach(() => {
    vi.useRealTimers()
    ;(globalThis as any).WebSocket = originalWebSocket
    ;(globalThis as any).window = originalWindow
  })

  it('stores COLLAB_* server errors instead of dropping them', () => {
    const client = new CollabWsClient('ws://127.0.0.1:8787/collab')

    client.start()
    vi.advanceTimersByTime(60)

    const socket = FakeWebSocket.instances[0]
    expect(socket).toBeDefined()

    socket.emit('open')
    emitServerEvent(socket, {
      type: 'error',
      code: 'COLLAB_USER_MESSAGE_FAILED',
      message: 'Message dispatch failed.',
    })

    expect(client.getState().lastError).toBe('Message dispatch failed.')
    expect(client.getState().lastErrorCode).toBe('COLLAB_USER_MESSAGE_FAILED')

    client.destroy()
  })

  it('tracks collab worker snapshots, activity, and streaming timestamps for the active channel', () => {
    const client = new CollabWsClient('ws://127.0.0.1:8787/collab')

    client.start()
    vi.advanceTimersByTime(60)

    const socket = FakeWebSocket.instances[0]
    socket.emit('open')
    client.setActiveChannel('channel-1')

    emitServerEvent(socket, {
      type: 'collab_channel_status',
      channelId: 'channel-1',
      status: 'responding',
      agentStatus: 'streaming',
      streamingStartedAt: 1234,
    })
    emitServerEvent(socket, {
      type: 'collab_session_workers_snapshot',
      channelId: 'channel-1',
      sessionAgentId: 'session-1',
      workers: [
        {
          agentId: 'worker-1',
          managerId: 'session-1',
          displayName: 'Backend Specialist',
          role: 'worker',
          status: 'streaming',
          createdAt: '2026-04-14T12:00:00.000Z',
          updatedAt: '2026-04-14T12:00:00.000Z',
          cwd: '/tmp',
          model: { provider: 'openai-codex', modelId: 'gpt-5.3-codex', thinkingLevel: 'medium' },
          sessionFile: '/tmp/worker-1.jsonl',
          streamingStartedAt: 1235,
        },
      ],
    })
    emitServerEvent(socket, {
      type: 'collab_session_activity_snapshot',
      channelId: 'channel-1',
      sessionAgentId: 'session-1',
      activity: [
        {
          type: 'agent_tool_call',
          agentId: 'session-1',
          actorAgentId: 'worker-1',
          timestamp: '2026-04-14T12:01:00.000Z',
          kind: 'tool_execution_start',
          toolName: 'bash',
          toolCallId: 'tool-1',
          text: '{"command":"pnpm test"}',
        },
      ],
    })
    emitServerEvent(socket, {
      type: 'collab_session_agent_status',
      channelId: 'channel-1',
      sessionAgentId: 'session-1',
      agentId: 'worker-1',
      managerId: 'session-1',
      status: 'streaming',
      pendingCount: 1,
      streamingStartedAt: 1235,
    })

    expect(client.getState()).toMatchObject({
      activeChannelId: 'channel-1',
      channelStatus: 'responding',
      channelStreamingStartedAt: 1234,
      sessionWorkers: [
        expect.objectContaining({ agentId: 'worker-1', managerId: 'session-1' }),
      ],
      sessionActivity: [
        expect.objectContaining({ type: 'agent_tool_call', actorAgentId: 'worker-1' }),
      ],
      sessionAgentStatuses: {
        'worker-1': {
          status: 'streaming',
          pendingCount: 1,
          streamingStartedAt: 1235,
        },
      },
    })

    client.destroy()
  })

  it('clears old worker state when switching channels and loads the new channel snapshots only', () => {
    const client = new CollabWsClient('ws://127.0.0.1:8787/collab')

    client.start()
    vi.advanceTimersByTime(60)

    const socket = FakeWebSocket.instances[0]
    socket.emit('open')

    client.setActiveChannel('channel-1')
    emitServerEvent(socket, {
      type: 'collab_session_workers_snapshot',
      channelId: 'channel-1',
      sessionAgentId: 'session-1',
      workers: [
        {
          agentId: 'worker-1',
          managerId: 'session-1',
          displayName: 'Worker One',
          role: 'worker',
          status: 'streaming',
          createdAt: '2026-04-14T12:00:00.000Z',
          updatedAt: '2026-04-14T12:00:00.000Z',
          cwd: '/tmp',
          model: { provider: 'openai-codex', modelId: 'gpt-5.3-codex', thinkingLevel: 'medium' },
          sessionFile: '/tmp/worker-1.jsonl',
        },
      ],
    })
    emitServerEvent(socket, {
      type: 'collab_session_activity_snapshot',
      channelId: 'channel-1',
      sessionAgentId: 'session-1',
      activity: [
        {
          type: 'agent_message',
          agentId: 'session-1',
          timestamp: '2026-04-14T12:01:00.000Z',
          source: 'user_to_agent',
          toAgentId: 'worker-1',
          text: 'Investigate',
        },
      ],
    })
    emitServerEvent(socket, {
      type: 'collab_session_agent_status',
      channelId: 'channel-1',
      sessionAgentId: 'session-1',
      agentId: 'worker-1',
      managerId: 'session-1',
      status: 'streaming',
      pendingCount: 1,
    })

    expect(client.getState().sessionWorkers).toHaveLength(1)
    expect(client.getState().sessionActivity).toHaveLength(1)
    expect(client.getState().sessionAgentStatuses['worker-1']?.status).toBe('streaming')

    // Switch to a different channel
    client.setActiveChannel('channel-2')

    expect(client.getState()).toMatchObject({
      activeChannelId: 'channel-2',
      sessionWorkers: [],
      sessionActivity: [],
      sessionAgentStatuses: {},
    })

    // Stale event for old channel should be ignored
    emitServerEvent(socket, {
      type: 'collab_session_workers_snapshot',
      channelId: 'channel-1',
      sessionAgentId: 'session-1',
      workers: [
        {
          agentId: 'worker-old',
          managerId: 'session-1',
          displayName: 'Old Worker',
          role: 'worker',
          status: 'streaming',
          createdAt: '2026-04-14T12:00:00.000Z',
          updatedAt: '2026-04-14T12:00:00.000Z',
          cwd: '/tmp',
          model: { provider: 'openai-codex', modelId: 'gpt-5.3-codex', thinkingLevel: 'medium' },
          sessionFile: '/tmp/worker-old.jsonl',
        },
      ],
    })
    expect(client.getState().sessionWorkers).toEqual([])

    // Event for new channel should be applied
    emitServerEvent(socket, {
      type: 'collab_session_workers_snapshot',
      channelId: 'channel-2',
      sessionAgentId: 'session-2',
      workers: [
        {
          agentId: 'worker-2',
          managerId: 'session-2',
          displayName: 'Worker Two',
          role: 'worker',
          status: 'idle',
          createdAt: '2026-04-14T12:02:00.000Z',
          updatedAt: '2026-04-14T12:02:00.000Z',
          cwd: '/tmp',
          model: { provider: 'openai-codex', modelId: 'gpt-5.3-codex', thinkingLevel: 'medium' },
          sessionFile: '/tmp/worker-2.jsonl',
        },
      ],
    })

    expect(client.getState().sessionWorkers).toEqual([
      expect.objectContaining({ agentId: 'worker-2', managerId: 'session-2' }),
    ])

    client.destroy()
  })

  it('applies collab_message_pinned updates to the active channel history', () => {
    const client = new CollabWsClient('ws://127.0.0.1:8787/collab')

    client.start()
    vi.advanceTimersByTime(60)

    const socket = FakeWebSocket.instances[0]
    socket.emit('open')
    client.setActiveChannel('channel-1')

    emitServerEvent(socket, {
      type: 'collab_channel_history',
      channelId: 'channel-1',
      messages: [
        {
          channelId: 'channel-1',
          id: 'msg-1',
          role: 'assistant',
          text: 'Hello',
          timestamp: '2026-04-14T12:00:00.000Z',
          source: 'speak_to_user',
          pinned: false,
        },
      ],
    })
    emitServerEvent(socket, {
      type: 'collab_message_pinned',
      channelId: 'channel-1',
      messageId: 'msg-1',
      pinned: true,
    })

    expect(client.getState().channelHistory).toEqual([
      expect.objectContaining({ id: 'msg-1', pinned: true }),
    ])

    emitServerEvent(socket, {
      type: 'collab_message_pinned',
      channelId: 'channel-2',
      messageId: 'msg-1',
      pinned: false,
    })

    expect(client.getState().channelHistory).toEqual([
      expect.objectContaining({ id: 'msg-1', pinned: true }),
    ])

    client.destroy()
  })

  it('sends collab pin commands when pinMessage is called', () => {
    const client = new CollabWsClient('ws://127.0.0.1:8787/collab')

    client.start()
    vi.advanceTimersByTime(60)

    const socket = FakeWebSocket.instances[0]
    socket.emit('open')

    socket.sentPayloads.length = 0
    client.pinMessage('channel-1', 'msg-1', true)

    expect(socket.sentPayloads).toEqual([
      JSON.stringify({ type: 'collab_pin_message', channelId: 'channel-1', messageId: 'msg-1', pinned: true }),
    ])

    client.destroy()
  })

  it('sends unsubscribe then subscribe when switching channels via setActiveChannel', () => {
    const client = new CollabWsClient('ws://127.0.0.1:8787/collab')

    client.start()
    vi.advanceTimersByTime(60)

    const socket = FakeWebSocket.instances[0]
    socket.emit('open')

    // Clear the bootstrap command sent on open
    socket.sentPayloads.length = 0

    client.setActiveChannel('channel-1')
    expect(socket.sentPayloads).toEqual([
      JSON.stringify({ type: 'collab_subscribe_channel', channelId: 'channel-1' }),
    ])

    socket.sentPayloads.length = 0

    client.setActiveChannel('channel-2')
    expect(socket.sentPayloads).toEqual([
      JSON.stringify({ type: 'collab_unsubscribe_channel', channelId: 'channel-1' }),
      JSON.stringify({ type: 'collab_subscribe_channel', channelId: 'channel-2' }),
    ])

    socket.sentPayloads.length = 0

    client.setActiveChannel(null)
    expect(socket.sentPayloads).toEqual([
      JSON.stringify({ type: 'collab_unsubscribe_channel', channelId: 'channel-2' }),
    ])

    client.destroy()
  })

  it('sends bootstrap command on open and re-subscribes the active channel after reconnect', () => {
    const client = new CollabWsClient('ws://127.0.0.1:8787/collab')

    client.start()
    vi.advanceTimersByTime(60)

    const socket = FakeWebSocket.instances[0]
    socket.emit('open')

    // Should have sent bootstrap
    expect(socket.sentPayloads).toContainEqual(
      JSON.stringify({ type: 'collab_bootstrap' }),
    )

    // Set a channel
    client.setActiveChannel('channel-1')

    // Simulate bootstrap response
    emitServerEvent(socket, {
      type: 'collab_bootstrap',
      workspace: { workspaceId: 'ws-1', displayName: 'Test', memberCount: 3 },
      categories: [],
      channels: [],
      currentUser: { userId: 'user-1', username: 'test', role: 'admin' },
    })

    expect(client.getState().hasBootstrapped).toBe(true)

    // Simulate disconnect/reconnect
    socket.readyState = FakeWebSocket.CLOSED
    socket.emit('close', new Event('close'))

    expect(client.getState().connected).toBe(false)
    expect(client.getState().hasBootstrapped).toBe(false)

    // Advance past reconnect delay
    vi.advanceTimersByTime(1300)

    const socket2 = FakeWebSocket.instances[1]
    expect(socket2).toBeDefined()
    socket2.emit('open')

    // Should have sent bootstrap on the new socket
    expect(socket2.sentPayloads).toContainEqual(
      JSON.stringify({ type: 'collab_bootstrap' }),
    )

    // Simulate the bootstrap response — should re-subscribe to channel-1
    emitServerEvent(socket2, {
      type: 'collab_bootstrap',
      workspace: { workspaceId: 'ws-1', displayName: 'Test', memberCount: 3 },
      categories: [],
      channels: [],
      currentUser: { userId: 'user-1', username: 'test', role: 'admin' },
    })

    expect(socket2.sentPayloads).toContainEqual(
      JSON.stringify({ type: 'collab_subscribe_channel', channelId: 'channel-1' }),
    )

    client.destroy()
  })

  describe('sendMessage', () => {
    it('accepts text-only sends', () => {
      const client = new CollabWsClient('ws://127.0.0.1:8787/collab')

      client.start()
      vi.advanceTimersByTime(60)

      const socket = FakeWebSocket.instances[0]
      socket.emit('open')

      const result = client.sendMessage('channel-1', 'Hello world')
      expect(result).toBe(true)

      expect(socket.sentPayloads).toContainEqual(
        JSON.stringify({
          type: 'collab_user_message',
          channelId: 'channel-1',
          content: 'Hello world',
        }),
      )

      client.destroy()
    })

    it('accepts text + attachments sends', () => {
      const client = new CollabWsClient('ws://127.0.0.1:8787/collab')

      client.start()
      vi.advanceTimersByTime(60)

      const socket = FakeWebSocket.instances[0]
      socket.emit('open')

      const attachments = [{ mimeType: 'image/png', data: 'base64data', fileName: 'img.png' }]
      const result = client.sendMessage('channel-1', 'See this', attachments)
      expect(result).toBe(true)

      expect(socket.sentPayloads).toContainEqual(
        JSON.stringify({
          type: 'collab_user_message',
          channelId: 'channel-1',
          content: 'See this',
          attachments,
        }),
      )

      client.destroy()
    })

    it('accepts attachment-only sends (no text)', () => {
      const client = new CollabWsClient('ws://127.0.0.1:8787/collab')

      client.start()
      vi.advanceTimersByTime(60)

      const socket = FakeWebSocket.instances[0]
      socket.emit('open')

      const attachments = [{ mimeType: 'image/png', data: 'base64data', fileName: 'img.png' }]
      const result = client.sendMessage('channel-1', '', attachments)
      expect(result).toBe(true)

      expect(socket.sentPayloads).toContainEqual(
        JSON.stringify({
          type: 'collab_user_message',
          channelId: 'channel-1',
          content: '',
          attachments,
        }),
      )

      client.destroy()
    })

    it('rejects empty text + no attachments', () => {
      const client = new CollabWsClient('ws://127.0.0.1:8787/collab')

      client.start()
      vi.advanceTimersByTime(60)

      const socket = FakeWebSocket.instances[0]
      socket.emit('open')

      // Clear bootstrap payload
      socket.sentPayloads.length = 0

      expect(client.sendMessage('channel-1', '')).toBe(false)
      expect(client.sendMessage('channel-1', '   ')).toBe(false)
      expect(client.sendMessage('channel-1', '', [])).toBe(false)
      expect(client.sendMessage('channel-1', '  ', undefined)).toBe(false)

      // No user_message commands should have been sent
      const userMessages = socket.sentPayloads.filter((p) => p.includes('collab_user_message'))
      expect(userMessages).toHaveLength(0)

      client.destroy()
    })
  })

  it('clears worker state on disconnect and repopulates after reconnect bootstrap', () => {
    const client = new CollabWsClient('ws://127.0.0.1:8787/collab')

    client.start()
    vi.advanceTimersByTime(60)

    const socket = FakeWebSocket.instances[0]
    socket.emit('open')

    client.setActiveChannel('channel-1')

    // Populate worker state
    emitServerEvent(socket, {
      type: 'collab_session_workers_snapshot',
      channelId: 'channel-1',
      sessionAgentId: 'session-1',
      workers: [
        {
          agentId: 'worker-1',
          managerId: 'session-1',
          displayName: 'Worker One',
          role: 'worker',
          status: 'streaming',
          createdAt: '2026-04-14T12:00:00.000Z',
          updatedAt: '2026-04-14T12:00:00.000Z',
          cwd: '/tmp',
          model: { provider: 'openai-codex', modelId: 'gpt-5.3-codex', thinkingLevel: 'medium' },
          sessionFile: '/tmp/worker-1.jsonl',
        },
      ],
    })
    emitServerEvent(socket, {
      type: 'collab_session_activity_snapshot',
      channelId: 'channel-1',
      sessionAgentId: 'session-1',
      activity: [
        {
          type: 'agent_tool_call',
          agentId: 'session-1',
          actorAgentId: 'worker-1',
          timestamp: '2026-04-14T12:01:00.000Z',
          kind: 'tool_execution_start',
          toolName: 'bash',
          toolCallId: 'tool-1',
          text: '{"command":"pnpm test"}',
        },
      ],
    })
    emitServerEvent(socket, {
      type: 'collab_session_agent_status',
      channelId: 'channel-1',
      sessionAgentId: 'session-1',
      agentId: 'worker-1',
      managerId: 'session-1',
      status: 'streaming',
      pendingCount: 1,
    })

    // Verify worker state is populated
    expect(client.getState().sessionWorkers).toHaveLength(1)
    expect(client.getState().sessionActivity).toHaveLength(1)
    expect(client.getState().sessionAgentStatuses['worker-1']).toBeDefined()

    // Disconnect — worker state must be cleared
    socket.readyState = FakeWebSocket.CLOSED
    socket.emit('close', new Event('close'))

    expect(client.getState().sessionWorkers).toEqual([])
    expect(client.getState().sessionActivity).toEqual([])
    expect(client.getState().sessionAgentStatuses).toEqual({})

    // Reconnect
    vi.advanceTimersByTime(1300)
    const socket2 = FakeWebSocket.instances[1]
    socket2.emit('open')

    // Bootstrap + re-subscribe
    emitServerEvent(socket2, {
      type: 'collab_bootstrap',
      workspace: { workspaceId: 'ws-1', displayName: 'Test', memberCount: 3 },
      categories: [],
      channels: [],
      currentUser: { userId: 'user-1', username: 'test', role: 'admin' },
    })

    // New worker snapshot arrives for re-subscribed channel
    emitServerEvent(socket2, {
      type: 'collab_session_workers_snapshot',
      channelId: 'channel-1',
      sessionAgentId: 'session-1',
      workers: [
        {
          agentId: 'worker-2',
          managerId: 'session-1',
          displayName: 'Worker Two',
          role: 'worker',
          status: 'idle',
          createdAt: '2026-04-14T12:05:00.000Z',
          updatedAt: '2026-04-14T12:05:00.000Z',
          cwd: '/tmp',
          model: { provider: 'openai-codex', modelId: 'gpt-5.3-codex', thinkingLevel: 'medium' },
          sessionFile: '/tmp/worker-2.jsonl',
        },
      ],
    })

    // State should now reflect the new worker, not the old one
    expect(client.getState().sessionWorkers).toHaveLength(1)
    expect(client.getState().sessionWorkers[0].agentId).toBe('worker-2')

    client.destroy()
  })
})
