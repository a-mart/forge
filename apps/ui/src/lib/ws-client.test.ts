import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ManagerWsClient } from './ws-client'

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

describe('ManagerWsClient', () => {
  const originalWebSocket = globalThis.WebSocket
  const originalWindow = (globalThis as any).window
  const originalDocument = (globalThis as any).document

  beforeEach(() => {
    FakeWebSocket.instances = []
    vi.useFakeTimers()
    ;(globalThis as any).window = {}
    ;(globalThis as any).document = {
      hasFocus: () => false,
    }
    ;(globalThis as any).WebSocket = FakeWebSocket
  })

  afterEach(() => {
    vi.useRealTimers()
    ;(globalThis as any).WebSocket = originalWebSocket
    ;(globalThis as any).window = originalWindow
    ;(globalThis as any).document = originalDocument
  })

  it('subscribes on connect and sends user_message commands to the active agent', () => {
    const client = new ManagerWsClient('ws://127.0.0.1:8787', 'manager')

    const snapshots: ReturnType<typeof client.getState>[] = []
    client.subscribe((state) => {
      snapshots.push(state)
    })

    client.start()
    vi.advanceTimersByTime(60)

    const socket = FakeWebSocket.instances[0]
    expect(socket).toBeDefined()

    socket.emit('open')
    expect(socket.sentPayloads).toHaveLength(1)
    expect(JSON.parse(socket.sentPayloads[0])).toEqual({ type: 'subscribe', agentId: 'manager' })

    emitServerEvent(socket, {
      type: 'ready',
      serverTime: new Date().toISOString(),
      subscribedAgentId: 'manager',
    })

    client.sendUserMessage('hello manager')

    expect(JSON.parse(socket.sentPayloads[1])).toEqual({
      type: 'user_message',
      text: 'hello manager',
      agentId: 'manager',
    })

    emitServerEvent(socket, {
      type: 'conversation_message',
      agentId: 'manager',
      role: 'assistant',
      text: 'hello from manager',
      timestamp: new Date().toISOString(),
      source: 'speak_to_user',
    })

    const latestManagerMessage = snapshots.at(-1)?.messages.at(-1)
    expect(latestManagerMessage?.type === 'conversation_message' ? latestManagerMessage.text : undefined).toBe('hello from manager')

    client.destroy()
  })

  it('sends choice response and cancel commands', () => {
    const client = new ManagerWsClient('ws://127.0.0.1:8787', 'manager')

    client.start()
    vi.advanceTimersByTime(60)

    const socket = FakeWebSocket.instances[0]
    socket.emit('open')

    emitServerEvent(socket, {
      type: 'ready',
      serverTime: new Date().toISOString(),
      subscribedAgentId: 'manager',
    })

    client.sendChoiceResponse('manager', 'choice-1', [
      {
        questionId: 'q1',
        selectedOptionIds: ['option-a'],
        text: 'Because it is safer',
      },
    ])

    expect(JSON.parse(socket.sentPayloads.at(-1) ?? '')).toEqual({
      type: 'choice_response',
      agentId: 'manager',
      choiceId: 'choice-1',
      answers: [
        {
          questionId: 'q1',
          selectedOptionIds: ['option-a'],
          text: 'Because it is safer',
        },
      ],
    })

    client.sendChoiceCancel('manager', 'choice-1')

    expect(JSON.parse(socket.sentPayloads.at(-1) ?? '')).toEqual({
      type: 'choice_cancel',
      agentId: 'manager',
      choiceId: 'choice-1',
    })

    client.destroy()
  })

  it('tracks pending choice ids from live events and bootstrap snapshots', () => {
    const client = new ManagerWsClient('ws://127.0.0.1:8787', 'manager')

    client.start()
    vi.advanceTimersByTime(60)

    const socket = FakeWebSocket.instances[0]
    socket.emit('open')

    emitServerEvent(socket, {
      type: 'ready',
      serverTime: new Date().toISOString(),
      subscribedAgentId: 'manager',
    })

    emitServerEvent(socket, {
      type: 'pending_choices_snapshot',
      agentId: 'manager',
      choiceIds: ['choice-1'],
    })
    expect(client.getState().pendingChoiceIds.has('choice-1')).toBe(true)

    emitServerEvent(socket, {
      type: 'choice_request',
      agentId: 'manager',
      choiceId: 'choice-2',
      questions: [
        {
          id: 'q1',
          question: 'Which path should I take?',
          options: [{ id: 'option-a', label: 'Option A' }],
        },
      ],
      status: 'pending',
      timestamp: new Date().toISOString(),
    })
    expect(client.getState().pendingChoiceIds.has('choice-2')).toBe(true)

    emitServerEvent(socket, {
      type: 'choice_request',
      agentId: 'manager',
      choiceId: 'choice-2',
      questions: [
        {
          id: 'q1',
          question: 'Which path should I take?',
          options: [{ id: 'option-a', label: 'Option A' }],
        },
      ],
      status: 'answered',
      answers: [
        {
          questionId: 'q1',
          selectedOptionIds: ['option-a'],
        },
      ],
      timestamp: new Date().toISOString(),
    })
    expect(client.getState().pendingChoiceIds.has('choice-2')).toBe(false)

    emitServerEvent(socket, {
      type: 'conversation_reset',
      agentId: 'manager',
      timestamp: new Date().toISOString(),
      reason: 'user_new_command',
    })
    expect(client.getState().pendingChoiceIds.size).toBe(0)

    client.destroy()
  })

  it('subscribes without forcing manager id when no initial target is provided', () => {
    const client = new ManagerWsClient('ws://127.0.0.1:8787')

    client.start()
    vi.advanceTimersByTime(60)

    const socket = FakeWebSocket.instances[0]
    expect(socket).toBeDefined()

    socket.emit('open')
    expect(socket.sentPayloads).toHaveLength(1)
    expect(JSON.parse(socket.sentPayloads[0])).toEqual({ type: 'subscribe' })

    emitServerEvent(socket, {
      type: 'ready',
      serverTime: new Date().toISOString(),
      subscribedAgentId: 'release-manager',
    })

    expect(client.getState().targetAgentId).toBe('release-manager')
    expect(client.getState().subscribedAgentId).toBe('release-manager')

    client.destroy()
  })

  it('stores telegram_status events from the backend', () => {
    const client = new ManagerWsClient('ws://127.0.0.1:8787', 'manager')

    client.start()
    vi.advanceTimersByTime(60)

    const socket = FakeWebSocket.instances[0]
    socket.emit('open')

    emitServerEvent(socket, {
      type: 'ready',
      serverTime: new Date().toISOString(),
      subscribedAgentId: 'manager',
    })

    emitServerEvent(socket, {
      type: 'telegram_status',
      state: 'connected',
      enabled: true,
      updatedAt: new Date().toISOString(),
      message: 'Telegram connected',
      botId: '123456789',
      botUsername: 'swarm_bot',
    })

    expect(client.getState().telegramStatus?.state).toBe('connected')
    expect(client.getState().telegramStatus?.enabled).toBe(true)

    client.destroy()
  })

  it('reloads the page only after reconnecting following a disconnect', () => {
    const reload = vi.fn()
    ;(globalThis as any).window = {
      location: {
        reload,
      },
    }

    const client = new ManagerWsClient('ws://127.0.0.1:8787', 'manager')

    client.start()
    vi.advanceTimersByTime(60)

    const socket = FakeWebSocket.instances[0]
    expect(socket).toBeDefined()

    socket.emit('open')
    expect(reload).not.toHaveBeenCalled()

    socket.close()
    vi.advanceTimersByTime(1200)

    const reconnectedSocket = FakeWebSocket.instances[1]
    expect(reconnectedSocket).toBeDefined()

    reconnectedSocket.emit('open')
    expect(reload).toHaveBeenCalledTimes(1)

    client.destroy()
  })

  it('sends attachment-only user messages when images are provided', () => {
    const client = new ManagerWsClient('ws://127.0.0.1:8787', 'manager')

    client.start()
    vi.advanceTimersByTime(60)

    const socket = FakeWebSocket.instances[0]
    socket.emit('open')

    emitServerEvent(socket, {
      type: 'ready',
      serverTime: new Date().toISOString(),
      subscribedAgentId: 'manager',
    })

    client.sendUserMessage('', {
      attachments: [
        {
          mimeType: 'image/png',
          data: 'aGVsbG8=',
          fileName: 'diagram.png',
        },
      ],
    })

    expect(JSON.parse(socket.sentPayloads.at(-1) ?? '')).toEqual({
      type: 'user_message',
      text: '',
      attachments: [
        {
          mimeType: 'image/png',
          data: 'aGVsbG8=',
          fileName: 'diagram.png',
        },
      ],
      agentId: 'manager',
    })

    client.destroy()
  })

  it('sends text and binary attachments in user messages', () => {
    const client = new ManagerWsClient('ws://127.0.0.1:8787', 'manager')

    client.start()
    vi.advanceTimersByTime(60)

    const socket = FakeWebSocket.instances[0]
    socket.emit('open')

    emitServerEvent(socket, {
      type: 'ready',
      serverTime: new Date().toISOString(),
      subscribedAgentId: 'manager',
    })

    client.sendUserMessage('', {
      attachments: [
        {
          type: 'text',
          mimeType: 'text/markdown',
          text: '# Notes',
          fileName: 'notes.md',
        },
        {
          type: 'binary',
          mimeType: 'application/pdf',
          data: 'aGVsbG8=',
          fileName: 'design.pdf',
        },
      ],
    })

    expect(JSON.parse(socket.sentPayloads.at(-1) ?? '')).toEqual({
      type: 'user_message',
      text: '',
      attachments: [
        {
          type: 'text',
          mimeType: 'text/markdown',
          text: '# Notes',
          fileName: 'notes.md',
        },
        {
          type: 'binary',
          mimeType: 'application/pdf',
          data: 'aGVsbG8=',
          fileName: 'design.pdf',
        },
      ],
      agentId: 'manager',
    })

    client.destroy()
  })

  it('can switch subscriptions and route outgoing/incoming messages by selected agent', () => {
    const client = new ManagerWsClient('ws://127.0.0.1:8787', 'manager')
    const snapshots: ReturnType<typeof client.getState>[] = []

    client.subscribe((state) => {
      snapshots.push(state)
    })

    client.start()
    vi.advanceTimersByTime(60)

    const socket = FakeWebSocket.instances[0]
    socket.emit('open')

    emitServerEvent(socket, {
      type: 'ready',
      serverTime: new Date().toISOString(),
      subscribedAgentId: 'manager',
    })

    client.subscribeToAgent('worker-1')

    expect(JSON.parse(socket.sentPayloads.at(-1) ?? '')).toEqual({
      type: 'subscribe',
      agentId: 'worker-1',
    })

    emitServerEvent(socket, {
      type: 'ready',
      serverTime: new Date().toISOString(),
      subscribedAgentId: 'worker-1',
    })

    emitServerEvent(socket, {
      type: 'conversation_history',
      agentId: 'worker-1',
      messages: [],
    })

    client.sendUserMessage('hello worker')

    expect(JSON.parse(socket.sentPayloads.at(-1) ?? '')).toEqual({
      type: 'user_message',
      text: 'hello worker',
      agentId: 'worker-1',
    })

    emitServerEvent(socket, {
      type: 'conversation_message',
      agentId: 'manager',
      role: 'assistant',
      text: 'manager output',
      timestamp: new Date().toISOString(),
      source: 'speak_to_user',
    })

    expect(
      snapshots.at(-1)?.messages.some(
        (message) => message.type === 'conversation_message' && message.text === 'manager output',
      ),
    ).toBe(false)

    emitServerEvent(socket, {
      type: 'conversation_message',
      agentId: 'worker-1',
      role: 'assistant',
      text: 'worker output',
      timestamp: new Date().toISOString(),
      source: 'system',
    })

    const latestWorkerMessage = snapshots.at(-1)?.messages.at(-1)
    expect(latestWorkerMessage?.type === 'conversation_message' ? latestWorkerMessage.text : undefined).toBe('worker output')
    expect(snapshots.at(-1)?.targetAgentId).toBe('worker-1')
    expect(snapshots.at(-1)?.subscribedAgentId).toBe('worker-1')

    client.destroy()
  })

  it('treats unread_notification as sound-only and does not mutate unread counts', () => {
    const client = new ManagerWsClient('ws://127.0.0.1:8787', 'manager')

    client.start()
    vi.advanceTimersByTime(60)

    const socket = FakeWebSocket.instances[0]
    socket.emit('open')

    emitServerEvent(socket, {
      type: 'ready',
      serverTime: new Date().toISOString(),
      subscribedAgentId: 'manager',
    })

    emitServerEvent(socket, {
      type: 'unread_notification',
      agentId: 'worker-1',
    })

    emitServerEvent(socket, {
      type: 'unread_notification',
      agentId: 'worker-1',
    })

    emitServerEvent(socket, {
      type: 'unread_notification',
      agentId: 'manager',
    })

    expect(client.getState().unreadCounts['worker-1']).toBeUndefined()
    expect(client.getState().unreadCounts['manager']).toBeUndefined()

    client.destroy()
  })

  it('replaces unread counts from unread_counts_snapshot events', () => {
    const client = new ManagerWsClient('ws://127.0.0.1:8787', 'manager')

    client.start()
    vi.advanceTimersByTime(60)

    const socket = FakeWebSocket.instances[0]
    socket.emit('open')

    emitServerEvent(socket, {
      type: 'ready',
      serverTime: new Date().toISOString(),
      subscribedAgentId: 'manager',
    })

    emitServerEvent(socket, {
      type: 'unread_counts_snapshot',
      counts: {
        'session-a': 2,
        'session-b': 1,
      },
    })

    expect(client.getState().unreadCounts).toEqual({
      'session-a': 2,
      'session-b': 1,
    })

    emitServerEvent(socket, {
      type: 'unread_counts_snapshot',
      counts: {
        'session-b': 5,
      },
    })

    expect(client.getState().unreadCounts).toEqual({
      'session-b': 5,
    })

    client.destroy()
  })

  it('filters the currently viewed session from unread_counts_snapshot', () => {
    const client = new ManagerWsClient('ws://127.0.0.1:8787', 'manager')

    client.start()
    vi.advanceTimersByTime(60)

    const socket = FakeWebSocket.instances[0]
    socket.emit('open')

    emitServerEvent(socket, {
      type: 'ready',
      serverTime: new Date().toISOString(),
      subscribedAgentId: 'manager',
    })

    emitServerEvent(socket, {
      type: 'unread_counts_snapshot',
      counts: {
        'manager': 4,
        'session-b': 2,
      },
    })

    expect(client.getState().unreadCounts).toEqual({
      'session-b': 2,
    })

    client.destroy()
  })

  it('applies unread_count_update deltas and removes entries at count=0', () => {
    const client = new ManagerWsClient('ws://127.0.0.1:8787', 'manager')

    client.start()
    vi.advanceTimersByTime(60)

    const socket = FakeWebSocket.instances[0]
    socket.emit('open')

    emitServerEvent(socket, {
      type: 'ready',
      serverTime: new Date().toISOString(),
      subscribedAgentId: 'manager',
    })

    emitServerEvent(socket, {
      type: 'unread_count_update',
      agentId: 'session-a',
      count: 3,
    })

    emitServerEvent(socket, {
      type: 'unread_count_update',
      agentId: 'session-b',
      count: 1,
    })

    expect(client.getState().unreadCounts).toEqual({
      'session-a': 3,
      'session-b': 1,
    })

    emitServerEvent(socket, {
      type: 'unread_count_update',
      agentId: 'session-a',
      count: 0,
    })

    expect(client.getState().unreadCounts).toEqual({
      'session-b': 1,
    })

    client.destroy()
  })

  it('ignores unread_count_update for the currently selected target agent', () => {
    const client = new ManagerWsClient('ws://127.0.0.1:8787', 'manager')

    client.start()
    vi.advanceTimersByTime(60)

    const socket = FakeWebSocket.instances[0]
    socket.emit('open')

    emitServerEvent(socket, {
      type: 'ready',
      serverTime: new Date().toISOString(),
      subscribedAgentId: 'manager',
    })

    emitServerEvent(socket, {
      type: 'unread_count_update',
      agentId: 'manager',
      count: 7,
    })

    expect(client.getState().unreadCounts['manager']).toBeUndefined()

    client.destroy()
  })

  it('sends mark_unread commands to the server', () => {
    const client = new ManagerWsClient('ws://127.0.0.1:8787', 'manager')

    client.start()
    vi.advanceTimersByTime(60)

    const socket = FakeWebSocket.instances[0]
    socket.emit('open')

    emitServerEvent(socket, {
      type: 'ready',
      serverTime: new Date().toISOString(),
      subscribedAgentId: 'manager',
    })

    client.markUnread('manager--s2')

    expect(client.getState().unreadCounts['manager--s2']).toBe(1)
    expect(JSON.parse(socket.sentPayloads.at(-1) ?? '')).toEqual({
      type: 'mark_unread',
      agentId: 'manager--s2',
    })

    client.destroy()
  })

  it('preserves conversation messages when history includes many tool-call events', () => {
    const client = new ManagerWsClient('ws://127.0.0.1:8787', 'voice')

    client.start()
    vi.advanceTimersByTime(60)

    const socket = FakeWebSocket.instances[0]
    socket.emit('open')

    emitServerEvent(socket, {
      type: 'ready',
      serverTime: new Date().toISOString(),
      subscribedAgentId: 'voice',
    })

    const baseTime = Date.now()
    const conversationMessages = Array.from({ length: 120 }, (_, index) => ({
      type: 'conversation_message' as const,
      agentId: 'voice',
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      text: `message-${index}`,
      timestamp: new Date(baseTime + index).toISOString(),
      source: index % 2 === 0 ? ('user_input' as const) : ('speak_to_user' as const),
    }))

    const toolMessages = Array.from({ length: 480 }, (_, index) => ({
      type: 'agent_tool_call' as const,
      agentId: 'voice',
      actorAgentId: 'voice-worker',
      timestamp: new Date(baseTime + 120 + index).toISOString(),
      kind: 'tool_execution_update' as const,
      toolName: 'bash',
      toolCallId: `call-${index}`,
      text: '{"ok":true}',
    }))

    emitServerEvent(socket, {
      type: 'conversation_history',
      agentId: 'voice',
      messages: [...conversationMessages, ...toolMessages],
    })

    const state = client.getState()
    expect(state.messages).toHaveLength(120)
    expect(state.activityMessages).toHaveLength(480)
    expect(state.messages.filter((message) => message.type === 'conversation_message')).toHaveLength(120)

    client.destroy()
  })

  it('stores conversation_log events for the selected agent and ignores other threads', () => {
    const client = new ManagerWsClient('ws://127.0.0.1:8787', 'manager')

    client.start()
    vi.advanceTimersByTime(60)

    const socket = FakeWebSocket.instances[0]
    socket.emit('open')

    emitServerEvent(socket, {
      type: 'ready',
      serverTime: new Date().toISOString(),
      subscribedAgentId: 'worker-1',
    })

    emitServerEvent(socket, {
      type: 'conversation_log',
      agentId: 'manager',
      timestamp: new Date().toISOString(),
      source: 'runtime_log',
      kind: 'tool_execution_start',
      toolName: 'read',
      toolCallId: 'call-1',
      text: '{"path":"README.md"}',
    })

    expect(client.getState().messages).toHaveLength(0)
    expect(client.getState().activityMessages).toHaveLength(0)

    emitServerEvent(socket, {
      type: 'conversation_log',
      agentId: 'worker-1',
      timestamp: new Date().toISOString(),
      source: 'runtime_log',
      kind: 'tool_execution_end',
      toolName: 'read',
      toolCallId: 'call-1',
      text: '{"ok":true}',
      isError: false,
    })

    const lastMessage = client.getState().messages.at(-1)
    expect(lastMessage?.type).toBe('conversation_log')
    if (lastMessage?.type === 'conversation_log') {
      expect(lastMessage.kind).toBe('tool_execution_end')
      expect(lastMessage.toolName).toBe('read')
    }

    client.destroy()
  })

  it('stores agent activity events for the selected agent and ignores other threads', () => {
    const client = new ManagerWsClient('ws://127.0.0.1:8787', 'manager')

    client.start()
    vi.advanceTimersByTime(60)

    const socket = FakeWebSocket.instances[0]
    socket.emit('open')

    emitServerEvent(socket, {
      type: 'ready',
      serverTime: new Date().toISOString(),
      subscribedAgentId: 'manager',
    })

    emitServerEvent(socket, {
      type: 'agent_message',
      agentId: 'other-manager',
      timestamp: new Date().toISOString(),
      source: 'agent_to_agent',
      fromAgentId: 'worker-a',
      toAgentId: 'worker-b',
      text: 'ignore me',
      requestedDelivery: 'auto',
      acceptedMode: 'steer',
    })

    expect(client.getState().messages).toHaveLength(0)

    emitServerEvent(socket, {
      type: 'agent_message',
      agentId: 'manager',
      timestamp: new Date().toISOString(),
      source: 'agent_to_agent',
      fromAgentId: 'manager',
      toAgentId: 'worker-1',
      text: 'run this task',
      requestedDelivery: 'auto',
      acceptedMode: 'steer',
    })

    emitServerEvent(socket, {
      type: 'agent_tool_call',
      agentId: 'manager',
      actorAgentId: 'worker-1',
      timestamp: new Date().toISOString(),
      kind: 'tool_execution_start',
      toolName: 'read',
      toolCallId: 'call-2',
      text: '{"path":"README.md"}',
    })

    const activityMessages = client.getState().activityMessages
    expect(activityMessages).toHaveLength(2)
    expect(activityMessages[0]?.type).toBe('agent_message')
    expect(activityMessages[1]?.type).toBe('agent_tool_call')

    client.destroy()
  })

  it('sends explicit followUp delivery when requested', () => {
    const client = new ManagerWsClient('ws://127.0.0.1:8787', 'worker-1')

    client.start()
    vi.advanceTimersByTime(60)

    const socket = FakeWebSocket.instances[0]
    socket.emit('open')

    emitServerEvent(socket, {
      type: 'ready',
      serverTime: new Date().toISOString(),
      subscribedAgentId: 'worker-1',
    })

    client.sendUserMessage('queued update', { agentId: 'worker-1', delivery: 'followUp' })

    expect(JSON.parse(socket.sentPayloads.at(-1) ?? '')).toEqual({
      type: 'user_message',
      text: 'queued update',
      agentId: 'worker-1',
      delivery: 'followUp',
    })

    client.destroy()
  })

  it('sends kill_agent command when deleting a sub-agent', () => {
    const client = new ManagerWsClient('ws://127.0.0.1:8787', 'manager')

    client.start()
    vi.advanceTimersByTime(60)

    const socket = FakeWebSocket.instances[0]
    socket.emit('open')

    emitServerEvent(socket, {
      type: 'ready',
      serverTime: new Date().toISOString(),
      subscribedAgentId: 'manager',
    })

    client.deleteAgent('worker-2')

    expect(JSON.parse(socket.sentPayloads.at(-1) ?? '')).toEqual({
      type: 'kill_agent',
      agentId: 'worker-2',
    })

    client.destroy()
  })

  it('sends stop_all_agents and resolves from stop_all_agents_result event', async () => {
    const client = new ManagerWsClient('ws://127.0.0.1:8787', 'manager')

    client.start()
    vi.advanceTimersByTime(60)

    const socket = FakeWebSocket.instances[0]
    socket.emit('open')

    emitServerEvent(socket, {
      type: 'ready',
      serverTime: new Date().toISOString(),
      subscribedAgentId: 'manager',
    })

    const stopPromise = client.stopAllAgents('manager')
    const stopPayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')

    expect(stopPayload).toMatchObject({
      type: 'stop_all_agents',
      managerId: 'manager',
    })
    expect(typeof stopPayload.requestId).toBe('string')

    emitServerEvent(socket, {
      type: 'stop_all_agents_result',
      requestId: stopPayload.requestId,
      managerId: 'manager',
      stoppedWorkerIds: ['worker-1', 'worker-2'],
      managerStopped: true,
    })

    await expect(stopPromise).resolves.toEqual({
      managerId: 'manager',
      stoppedWorkerIds: ['worker-1', 'worker-2'],
      managerStopped: true,
    })

    client.destroy()
  })

  it('clears only the current thread messages on conversation_reset', () => {
    const client = new ManagerWsClient('ws://127.0.0.1:47187', 'manager')
    const snapshots: ReturnType<typeof client.getState>[] = []

    client.subscribe((state) => {
      snapshots.push(state)
    })

    client.start()
    vi.advanceTimersByTime(60)

    const socket = FakeWebSocket.instances[0]
    socket.emit('open')

    emitServerEvent(socket, {
      type: 'ready',
      serverTime: new Date().toISOString(),
      subscribedAgentId: 'manager',
    })

    emitServerEvent(socket, {
      type: 'agents_snapshot',
      agents: [
        {
          agentId: 'manager',
          managerId: 'manager',
          displayName: 'Manager',
          role: 'manager',
          status: 'idle',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          cwd: '/tmp',
          model: {
            provider: 'openai-codex',
            modelId: 'gpt-5.3-codex',
            thinkingLevel: 'xhigh',
          },
          sessionFile: '/tmp/manager.jsonl',
        },
      ],
    })

    emitServerEvent(socket, {
      type: 'agent_status',
      agentId: 'manager',
      status: 'streaming',
      pendingCount: 2,
    })

    emitServerEvent(socket, {
      type: 'conversation_message',
      agentId: 'manager',
      role: 'assistant',
      text: 'working...',
      timestamp: new Date().toISOString(),
      source: 'speak_to_user',
    })

    emitServerEvent(socket, {
      type: 'agent_tool_call',
      agentId: 'manager',
      actorAgentId: 'manager',
      timestamp: new Date().toISOString(),
      kind: 'tool_execution_update',
      toolName: 'read',
      toolCallId: 'call-3',
      text: '{"ok":true}',
    })

    emitServerEvent(socket, {
      type: 'error',
      code: 'TEST_ERROR',
      message: 'transient error',
    })

    const beforeReset = snapshots.at(-1)
    expect(beforeReset?.messages.length).toBeGreaterThan(0)
    expect(beforeReset?.activityMessages.length).toBeGreaterThan(0)
    expect(beforeReset?.agents.length).toBeGreaterThan(0)
    expect(Object.keys(beforeReset?.statuses ?? {})).toContain('manager')
    expect(beforeReset?.lastError).toBe('transient error')

    emitServerEvent(socket, {
      type: 'conversation_reset',
      agentId: 'manager',
      timestamp: new Date().toISOString(),
      reason: 'user_new_command',
    })

    const afterReset = snapshots.at(-1)
    expect(afterReset?.connected).toBe(true)
    expect(afterReset?.subscribedAgentId).toBe('manager')
    expect(afterReset?.messages).toHaveLength(0)
    expect(afterReset?.activityMessages).toHaveLength(0)
    expect(afterReset?.agents).toHaveLength(1)
    expect(Object.keys(afterReset?.statuses ?? {})).toContain('manager')
    expect(afterReset?.lastError).toBeNull()

    client.destroy()
  })

  it('sends create_manager and resolves with manager_created event', async () => {
    const client = new ManagerWsClient('ws://127.0.0.1:8787', 'manager')

    client.start()
    vi.advanceTimersByTime(60)

    const socket = FakeWebSocket.instances[0]
    socket.emit('open')

    emitServerEvent(socket, {
      type: 'ready',
      serverTime: new Date().toISOString(),
      subscribedAgentId: 'manager',
    })

    const creationPromise = client.createManager({
      name: 'release-manager',
      cwd: '/tmp/release',
      model: 'pi-codex',
    })

    const sentCreatePayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')
    expect(sentCreatePayload.type).toBe('create_manager')
    expect(sentCreatePayload.name).toBe('release-manager')
    expect(sentCreatePayload.cwd).toBe('/tmp/release')
    expect(sentCreatePayload.model).toBe('pi-codex')
    expect(typeof sentCreatePayload.requestId).toBe('string')

    emitServerEvent(socket, {
      type: 'manager_created',
      requestId: sentCreatePayload.requestId,
      manager: {
        agentId: 'release-manager',
        managerId: 'manager',
        displayName: 'Release Manager',
        role: 'manager',
        status: 'idle',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        cwd: '/tmp/release',
        model: {
          provider: 'openai-codex',
          modelId: 'gpt-5.3-codex',
          thinkingLevel: 'high',
        },
        sessionFile: '/tmp/release-manager.jsonl',
      },
    })

    await expect(creationPromise).resolves.toMatchObject({ agentId: 'release-manager' })
    expect(client.getState().agents.some((agent) => agent.agentId === 'release-manager')).toBe(true)

    client.destroy()
  })

  it('sends directory picker commands and resolves response events', async () => {
    const client = new ManagerWsClient('ws://127.0.0.1:8787', 'manager')

    client.start()
    vi.advanceTimersByTime(60)

    const socket = FakeWebSocket.instances[0]
    socket.emit('open')

    emitServerEvent(socket, {
      type: 'ready',
      serverTime: new Date().toISOString(),
      subscribedAgentId: 'manager',
    })

    const listPromise = client.listDirectories('/tmp')
    const listPayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')

    expect(listPayload).toMatchObject({
      type: 'list_directories',
      path: '/tmp',
    })
    expect(typeof listPayload.requestId).toBe('string')

    emitServerEvent(socket, {
      type: 'directories_listed',
      requestId: listPayload.requestId,
      path: '/tmp',
      directories: ['/tmp/a', '/tmp/b'],
    })

    await expect(listPromise).resolves.toEqual({
      path: '/tmp',
      directories: ['/tmp/a', '/tmp/b'],
    })

    const validatePromise = client.validateDirectory('/tmp/a')
    const validatePayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')

    expect(validatePayload).toMatchObject({
      type: 'validate_directory',
      path: '/tmp/a',
    })

    emitServerEvent(socket, {
      type: 'directory_validated',
      requestId: validatePayload.requestId,
      path: '/tmp/a',
      valid: true,
      resolvedPath: '/private/tmp/a',
    })

    await expect(validatePromise).resolves.toEqual({
      path: '/tmp/a',
      valid: true,
      message: null,
      resolvedPath: '/private/tmp/a',
    })

    const pickPromise = client.pickDirectory('/tmp')
    const pickPayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')

    expect(pickPayload).toMatchObject({
      type: 'pick_directory',
      defaultPath: '/tmp',
    })

    emitServerEvent(socket, {
      type: 'directory_picked',
      requestId: pickPayload.requestId,
      path: '/tmp/picked',
    })

    await expect(pickPromise).resolves.toBe('/tmp/picked')

    client.destroy()
  })

  it('rejects delete_manager when backend returns an error', async () => {
    const client = new ManagerWsClient('ws://127.0.0.1:8787', 'manager')

    client.start()
    vi.advanceTimersByTime(60)

    const socket = FakeWebSocket.instances[0]
    socket.emit('open')

    emitServerEvent(socket, {
      type: 'ready',
      serverTime: new Date().toISOString(),
      subscribedAgentId: 'manager',
    })

    const deletePromise = client.deleteManager('manager')
    const deletePayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')

    emitServerEvent(socket, {
      type: 'error',
      code: 'DELETE_MANAGER_FAILED',
      message: 'Delete failed for testing.',
      requestId: deletePayload.requestId,
    })

    await expect(deletePromise).rejects.toThrow('DELETE_MANAGER_FAILED: Delete failed for testing.')
    expect(client.getState().lastError).toBe('Delete failed for testing.')

    client.destroy()
  })

  it('falls back to the most recent session in the same profile when the selected session is deleted', () => {
    const client = new ManagerWsClient('ws://127.0.0.1:8787', 'alpha--s3')

    client.start()
    vi.advanceTimersByTime(60)

    const socket = FakeWebSocket.instances[0]
    socket.emit('open')

    emitServerEvent(socket, {
      type: 'ready',
      serverTime: new Date().toISOString(),
      subscribedAgentId: 'alpha--s3',
    })

    emitServerEvent(socket, {
      type: 'agents_snapshot',
      agents: [
        {
          agentId: 'alpha',
          managerId: 'alpha',
          displayName: 'Alpha Default',
          role: 'manager',
          status: 'idle',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:01:00.000Z',
          cwd: '/tmp/alpha',
          profileId: 'alpha',
          model: {
            provider: 'openai-codex',
            modelId: 'gpt-5.3-codex',
            thinkingLevel: 'medium',
          },
          sessionFile: '/tmp/alpha.jsonl',
        },
        {
          agentId: 'alpha--s2',
          managerId: 'alpha--s2',
          displayName: 'Alpha Session 2',
          role: 'manager',
          status: 'idle',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:03:00.000Z',
          cwd: '/tmp/alpha',
          profileId: 'alpha',
          model: {
            provider: 'openai-codex',
            modelId: 'gpt-5.3-codex',
            thinkingLevel: 'medium',
          },
          sessionFile: '/tmp/alpha--s2.jsonl',
        },
        {
          agentId: 'alpha--s3',
          managerId: 'alpha--s3',
          displayName: 'Alpha Session 3',
          role: 'manager',
          status: 'idle',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:04:00.000Z',
          cwd: '/tmp/alpha',
          profileId: 'alpha',
          model: {
            provider: 'openai-codex',
            modelId: 'gpt-5.3-codex',
            thinkingLevel: 'medium',
          },
          sessionFile: '/tmp/alpha--s3.jsonl',
        },
        {
          agentId: 'beta',
          managerId: 'beta',
          displayName: 'Beta Default',
          role: 'manager',
          status: 'idle',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:05:00.000Z',
          cwd: '/tmp/beta',
          profileId: 'beta',
          model: {
            provider: 'openai-codex',
            modelId: 'gpt-5.3-codex',
            thinkingLevel: 'medium',
          },
          sessionFile: '/tmp/beta.jsonl',
        },
      ],
    })

    emitServerEvent(socket, {
      type: 'session_deleted',
      requestId: 'req-session-delete',
      agentId: 'alpha--s3',
      profileId: 'alpha',
    })

    expect(client.getState().targetAgentId).toBe('alpha--s2')

    const subscribePayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')
    expect(subscribePayload).toMatchObject({
      type: 'subscribe',
      agentId: 'alpha--s2',
    })

    client.destroy()
  })

  it('falls back to the primary manager when selected manager is deleted', () => {
    const client = new ManagerWsClient('ws://127.0.0.1:8787', 'manager')

    client.start()
    vi.advanceTimersByTime(60)

    const socket = FakeWebSocket.instances[0]
    socket.emit('open')

    emitServerEvent(socket, {
      type: 'ready',
      serverTime: new Date().toISOString(),
      subscribedAgentId: 'manager-2',
    })

    emitServerEvent(socket, {
      type: 'agents_snapshot',
      agents: [
        {
          agentId: 'manager',
          managerId: 'manager',
          displayName: 'Primary Manager',
          role: 'manager',
          status: 'idle',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: '/tmp',
          model: {
            provider: 'openai-codex',
            modelId: 'gpt-5.3-codex',
            thinkingLevel: 'medium',
          },
          sessionFile: '/tmp/manager.jsonl',
        },
        {
          agentId: 'manager-2',
          managerId: 'manager',
          displayName: 'Manager 2',
          role: 'manager',
          status: 'idle',
          createdAt: '2026-01-01T00:01:00.000Z',
          updatedAt: '2026-01-01T00:01:00.000Z',
          cwd: '/tmp/secondary',
          model: {
            provider: 'openai-codex',
            modelId: 'gpt-5.3-codex',
            thinkingLevel: 'medium',
          },
          sessionFile: '/tmp/manager-2.jsonl',
        },
      ],
    })

    emitServerEvent(socket, {
      type: 'manager_deleted',
      managerId: 'manager-2',
      terminatedWorkerIds: [],
    })

    expect(client.getState().targetAgentId).toBe('manager')

    const subscribePayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')
    expect(subscribePayload).toMatchObject({
      type: 'subscribe',
      agentId: 'manager',
    })

    client.destroy()
  })

  it('clears selection when the last manager is deleted and blocks sends until a new agent exists', () => {
    const client = new ManagerWsClient('ws://127.0.0.1:8787', 'manager')

    client.start()
    vi.advanceTimersByTime(60)

    const socket = FakeWebSocket.instances[0]
    socket.emit('open')

    emitServerEvent(socket, {
      type: 'ready',
      serverTime: new Date().toISOString(),
      subscribedAgentId: 'manager',
    })

    emitServerEvent(socket, {
      type: 'agents_snapshot',
      agents: [
        {
          agentId: 'manager',
          managerId: 'manager',
          displayName: 'Manager',
          role: 'manager',
          status: 'idle',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: '/tmp',
          model: {
            provider: 'openai-codex',
            modelId: 'gpt-5.3-codex',
            thinkingLevel: 'medium',
          },
          sessionFile: '/tmp/manager.jsonl',
        },
      ],
    })

    emitServerEvent(socket, {
      type: 'manager_deleted',
      managerId: 'manager',
      terminatedWorkerIds: [],
    })

    expect(client.getState().targetAgentId).toBeNull()
    expect(client.getState().subscribedAgentId).toBeNull()

    const sentCountBefore = socket.sentPayloads.length
    client.sendUserMessage('hello?')

    expect(socket.sentPayloads).toHaveLength(sentCountBefore)
    expect(client.getState().lastError).toContain('No active agent selected')

    client.destroy()
  })

  it('invalidates a loaded session when an unknown worker status arrives and refetches on demand', async () => {
    const client = new ManagerWsClient('ws://127.0.0.1:8787', 'manager')

    client.start()
    vi.advanceTimersByTime(60)

    const socket = FakeWebSocket.instances[0]
    socket.emit('open')

    emitServerEvent(socket, {
      type: 'ready',
      serverTime: new Date().toISOString(),
      subscribedAgentId: 'manager',
    })

    emitServerEvent(socket, {
      type: 'agents_snapshot',
      agents: [
        {
          agentId: 'manager',
          managerId: 'manager',
          displayName: 'Manager',
          role: 'manager',
          status: 'idle',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: '/tmp',
          workerCount: 1,
          activeWorkerCount: 0,
          model: {
            provider: 'openai-codex',
            modelId: 'gpt-5.3-codex',
            thinkingLevel: 'medium',
          },
          sessionFile: '/tmp/manager.jsonl',
        },
      ],
    })

    const initialFetch = client.getSessionWorkers('manager')
    const initialFetchPayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')
    expect(initialFetchPayload).toMatchObject({
      type: 'get_session_workers',
      sessionAgentId: 'manager',
    })

    emitServerEvent(socket, {
      type: 'session_workers_snapshot',
      sessionAgentId: 'manager',
      requestId: initialFetchPayload.requestId,
      workers: [
        {
          agentId: 'worker-1',
          managerId: 'manager',
          displayName: 'Worker 1',
          role: 'worker',
          status: 'idle',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: '/tmp',
          model: {
            provider: 'openai-codex',
            modelId: 'gpt-5.3-codex',
            thinkingLevel: 'medium',
          },
          sessionFile: '/tmp/worker-1.jsonl',
        },
      ],
    })

    await expect(initialFetch).resolves.toMatchObject({ sessionAgentId: 'manager' })
    expect(client.getState().loadedSessionIds.has('manager')).toBe(true)

    emitServerEvent(socket, {
      type: 'agent_status',
      agentId: 'worker-2',
      managerId: 'manager',
      status: 'streaming',
      pendingCount: 1,
    })

    expect(client.getState().loadedSessionIds.has('manager')).toBe(false)
    expect(client.getState().agents.some((agent) => agent.agentId === 'worker-2')).toBe(false)
    expect(client.getState().agents.find((agent) => agent.agentId === 'manager')?.activeWorkerCount).toBe(1)

    const refetch = client.getSessionWorkers('manager')
    const refetchPayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')
    expect(refetchPayload).toMatchObject({
      type: 'get_session_workers',
      sessionAgentId: 'manager',
    })
    expect(refetchPayload.requestId).not.toBe(initialFetchPayload.requestId)

    // Simulate the agents_snapshot that the backend emits when a new worker spawns,
    // updating the manager's advertised workerCount to match the actual worker count.
    emitServerEvent(socket, {
      type: 'agents_snapshot',
      agents: [
        {
          agentId: 'manager',
          managerId: 'manager',
          displayName: 'Manager',
          role: 'manager',
          status: 'idle',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: '/tmp',
          workerCount: 2,
          activeWorkerCount: 1,
          model: {
            provider: 'openai-codex',
            modelId: 'gpt-5.3-codex',
            thinkingLevel: 'medium',
          },
          sessionFile: '/tmp/manager.jsonl',
        },
      ],
    })

    emitServerEvent(socket, {
      type: 'session_workers_snapshot',
      sessionAgentId: 'manager',
      requestId: refetchPayload.requestId,
      workers: [
        {
          agentId: 'worker-1',
          managerId: 'manager',
          displayName: 'Worker 1',
          role: 'worker',
          status: 'idle',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: '/tmp',
          model: {
            provider: 'openai-codex',
            modelId: 'gpt-5.3-codex',
            thinkingLevel: 'medium',
          },
          sessionFile: '/tmp/worker-1.jsonl',
        },
        {
          agentId: 'worker-2',
          managerId: 'manager',
          displayName: 'Worker 2',
          role: 'worker',
          status: 'streaming',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: '/tmp',
          model: {
            provider: 'openai-codex',
            modelId: 'gpt-5.3-codex',
            thinkingLevel: 'medium',
          },
          sessionFile: '/tmp/worker-2.jsonl',
        },
      ],
    })

    await expect(refetch).resolves.toMatchObject({ sessionAgentId: 'manager' })
    expect(client.getState().loadedSessionIds.has('manager')).toBe(true)
    expect(client.getState().agents.some((agent) => agent.agentId === 'worker-2')).toBe(true)

    client.destroy()
  })

  it('hydrates streamingStartedAt from snapshots and preserves it across snapshot refreshes', () => {
    const client = new ManagerWsClient('ws://127.0.0.1:8787', 'manager')

    client.start()
    vi.advanceTimersByTime(60)

    const socket = FakeWebSocket.instances[0]
    socket.emit('open')

    emitServerEvent(socket, {
      type: 'ready',
      serverTime: new Date().toISOString(),
      subscribedAgentId: 'manager',
    })

    emitServerEvent(socket, {
      type: 'agents_snapshot',
      agents: [
        {
          agentId: 'manager',
          managerId: 'manager',
          displayName: 'Manager',
          role: 'manager',
          status: 'idle',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: '/tmp',
          workerCount: 1,
          activeWorkerCount: 1,
          model: {
            provider: 'openai-codex',
            modelId: 'gpt-5.3-codex',
            thinkingLevel: 'medium',
          },
          sessionFile: '/tmp/manager.jsonl',
        },
      ],
    })

    const snapshotStartedAt = Date.parse('2026-01-01T00:00:05.000Z')
    vi.setSystemTime(snapshotStartedAt)

    emitServerEvent(socket, {
      type: 'session_workers_snapshot',
      sessionAgentId: 'manager',
      workers: [
        {
          agentId: 'worker-1',
          managerId: 'manager',
          displayName: 'Worker 1',
          role: 'worker',
          status: 'streaming',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:05.000Z',
          cwd: '/tmp',
          model: {
            provider: 'openai-codex',
            modelId: 'gpt-5.3-codex',
            thinkingLevel: 'medium',
          },
          sessionFile: '/tmp/worker-1.jsonl',
        },
      ],
    })

    expect(client.getState().statuses['worker-1']?.streamingStartedAt).toBe(snapshotStartedAt)

    vi.setSystemTime(Date.parse('2026-01-01T00:00:10.000Z'))
    emitServerEvent(socket, {
      type: 'agents_snapshot',
      agents: [
        {
          agentId: 'manager',
          managerId: 'manager',
          displayName: 'Manager',
          role: 'manager',
          status: 'idle',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:10.000Z',
          cwd: '/tmp',
          workerCount: 1,
          activeWorkerCount: 1,
          model: {
            provider: 'openai-codex',
            modelId: 'gpt-5.3-codex',
            thinkingLevel: 'medium',
          },
          sessionFile: '/tmp/manager.jsonl',
        },
      ],
    })

    expect(client.getState().statuses['worker-1']?.streamingStartedAt).toBe(snapshotStartedAt)

    vi.setSystemTime(Date.parse('2026-01-01T00:00:15.000Z'))
    emitServerEvent(socket, {
      type: 'session_workers_snapshot',
      sessionAgentId: 'manager',
      workers: [
        {
          agentId: 'worker-1',
          managerId: 'manager',
          displayName: 'Worker 1',
          role: 'worker',
          status: 'streaming',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:15.000Z',
          cwd: '/tmp',
          model: {
            provider: 'openai-codex',
            modelId: 'gpt-5.3-codex',
            thinkingLevel: 'medium',
          },
          sessionFile: '/tmp/worker-1.jsonl',
        },
      ],
    })

    expect(client.getState().statuses['worker-1']?.streamingStartedAt).toBe(snapshotStartedAt)

    client.destroy()
  })

  it('resets streamingStartedAt when a snapshot shows a new streaming run after idle', () => {
    const client = new ManagerWsClient('ws://127.0.0.1:8787', 'manager')

    client.start()
    vi.advanceTimersByTime(60)

    const socket = FakeWebSocket.instances[0]
    socket.emit('open')

    emitServerEvent(socket, {
      type: 'ready',
      serverTime: new Date().toISOString(),
      subscribedAgentId: 'manager',
    })

    emitServerEvent(socket, {
      type: 'agents_snapshot',
      agents: [
        {
          agentId: 'manager',
          managerId: 'manager',
          displayName: 'Manager',
          role: 'manager',
          status: 'idle',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: '/tmp',
          workerCount: 1,
          activeWorkerCount: 0,
          model: {
            provider: 'openai-codex',
            modelId: 'gpt-5.3-codex',
            thinkingLevel: 'medium',
          },
          sessionFile: '/tmp/manager.jsonl',
        },
      ],
    })

    const firstRunStartedAt = Date.parse('2026-01-01T00:00:05.000Z')
    vi.setSystemTime(firstRunStartedAt)
    emitServerEvent(socket, {
      type: 'session_workers_snapshot',
      sessionAgentId: 'manager',
      workers: [
        {
          agentId: 'worker-1',
          managerId: 'manager',
          displayName: 'Worker 1',
          role: 'worker',
          status: 'streaming',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:05.000Z',
          cwd: '/tmp',
          model: {
            provider: 'openai-codex',
            modelId: 'gpt-5.3-codex',
            thinkingLevel: 'medium',
          },
          sessionFile: '/tmp/worker-1.jsonl',
        },
      ],
    })

    expect(client.getState().statuses['worker-1']?.streamingStartedAt).toBe(firstRunStartedAt)

    emitServerEvent(socket, {
      type: 'agent_status',
      agentId: 'worker-1',
      managerId: 'manager',
      status: 'idle',
      pendingCount: 0,
    })
    expect(client.getState().statuses['worker-1']?.status).toBe('idle')

    const secondRunStartedAt = Date.parse('2026-01-01T00:00:20.000Z')
    vi.setSystemTime(secondRunStartedAt)
    emitServerEvent(socket, {
      type: 'session_workers_snapshot',
      sessionAgentId: 'manager',
      workers: [
        {
          agentId: 'worker-1',
          managerId: 'manager',
          displayName: 'Worker 1',
          role: 'worker',
          status: 'streaming',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:20.000Z',
          cwd: '/tmp',
          model: {
            provider: 'openai-codex',
            modelId: 'gpt-5.3-codex',
            thinkingLevel: 'medium',
          },
          sessionFile: '/tmp/worker-1.jsonl',
        },
      ],
    })

    expect(client.getState().statuses['worker-1']).toMatchObject({
      status: 'streaming',
      streamingStartedAt: secondRunStartedAt,
    })

    client.destroy()
  })

  it('preserves unloaded worker statuses across agents snapshots for stable active-worker deltas', () => {
    const client = new ManagerWsClient('ws://127.0.0.1:8787', 'manager')

    client.start()
    vi.advanceTimersByTime(60)

    const socket = FakeWebSocket.instances[0]
    socket.emit('open')

    emitServerEvent(socket, {
      type: 'ready',
      serverTime: new Date().toISOString(),
      subscribedAgentId: 'manager',
    })

    emitServerEvent(socket, {
      type: 'agents_snapshot',
      agents: [
        {
          agentId: 'manager',
          managerId: 'manager',
          displayName: 'Manager',
          role: 'manager',
          status: 'idle',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: '/tmp',
          workerCount: 1,
          activeWorkerCount: 0,
          model: {
            provider: 'openai-codex',
            modelId: 'gpt-5.3-codex',
            thinkingLevel: 'medium',
          },
          sessionFile: '/tmp/manager.jsonl',
        },
      ],
    })

    emitServerEvent(socket, {
      type: 'agent_status',
      agentId: 'worker-ghost',
      managerId: 'manager',
      status: 'streaming',
      pendingCount: 1,
    })

    expect(client.getState().agents.find((agent) => agent.agentId === 'manager')?.activeWorkerCount).toBe(1)
    expect(client.getState().statuses['worker-ghost']?.status).toBe('streaming')

    emitServerEvent(socket, {
      type: 'agents_snapshot',
      agents: [
        {
          agentId: 'manager',
          managerId: 'manager',
          displayName: 'Manager',
          role: 'manager',
          status: 'idle',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: '/tmp',
          workerCount: 1,
          activeWorkerCount: 1,
          model: {
            provider: 'openai-codex',
            modelId: 'gpt-5.3-codex',
            thinkingLevel: 'medium',
          },
          sessionFile: '/tmp/manager.jsonl',
        },
      ],
    })

    expect(client.getState().statuses['worker-ghost']?.status).toBe('streaming')

    emitServerEvent(socket, {
      type: 'agent_status',
      agentId: 'worker-ghost',
      managerId: 'manager',
      status: 'streaming',
      pendingCount: 2,
    })

    expect(client.getState().agents.find((agent) => agent.agentId === 'manager')?.activeWorkerCount).toBe(1)

    client.destroy()
  })

  describe('bootstrap batching', () => {
    /**
     * Helper: create a client with a completed initial bootstrap.
     * The initial connect does NOT use subscribeToAgent, so no bootstrap buffer.
     */
    function setupConnectedClient(initialAgentId = 'session-a') {
      const client = new ManagerWsClient('ws://127.0.0.1:8787', initialAgentId)
      client.start()
      vi.advanceTimersByTime(60)
      const socket = FakeWebSocket.instances.at(-1)!
      socket.emit('open')

      // Complete initial bootstrap (no subscribeToAgent ⇒ no bootstrap buffer)
      emitServerEvent(socket, { type: 'ready', serverTime: new Date().toISOString(), subscribedAgentId: initialAgentId })
      emitServerEvent(socket, { type: 'conversation_history', agentId: initialAgentId, messages: [] })
      emitServerEvent(socket, { type: 'pending_choices_snapshot', agentId: initialAgentId, choiceIds: [] })
      emitServerEvent(socket, { type: 'unread_counts_snapshot', counts: {} })

      return { client, socket }
    }

    it('coalesces bootstrap events into a single state update on session switch', () => {
      const { client, socket } = setupConnectedClient()

      // Switch to session-b — starts bootstrap buffer
      client.subscribeToAgent('session-b')

      let notificationCount = 0
      const unsub = client.subscribe(() => { notificationCount++ })
      notificationCount = 0 // reset after initial subscribe callback

      // Emit all 4 coalescible bootstrap events
      emitServerEvent(socket, { type: 'ready', serverTime: new Date().toISOString(), subscribedAgentId: 'session-b' })
      emitServerEvent(socket, {
        type: 'conversation_history',
        agentId: 'session-b',
        messages: [
          { type: 'conversation_message', agentId: 'session-b', role: 'user', text: 'hello', timestamp: new Date().toISOString(), source: 'user_input' },
        ],
      })
      emitServerEvent(socket, { type: 'pending_choices_snapshot', agentId: 'session-b', choiceIds: ['choice-1'] })
      emitServerEvent(socket, { type: 'unread_counts_snapshot', counts: { 'session-c': 3 } })

      // All 4 events coalesced into exactly 1 state update
      expect(notificationCount).toBe(1)

      // All bootstrap data present in final state
      const state = client.getState()
      expect(state.subscribedAgentId).toBe('session-b')
      expect(state.targetAgentId).toBe('session-b')
      expect(state.connected).toBe(true)
      expect(state.messages).toHaveLength(1)
      expect(state.pendingChoiceIds.has('choice-1')).toBe(true)
      expect(state.unreadCounts).toEqual({ 'session-c': 3 })

      unsub()
      client.destroy()
    })

    it('includes unread badge state in the single hydrated bootstrap commit', () => {
      const { client, socket } = setupConnectedClient()

      client.subscribeToAgent('session-b')

      const snapshots: ReturnType<typeof client.getState>[] = []
      const unsub = client.subscribe((state) => { snapshots.push(state) })
      snapshots.length = 0

      emitServerEvent(socket, { type: 'ready', serverTime: new Date().toISOString(), subscribedAgentId: 'session-b' })
      emitServerEvent(socket, { type: 'conversation_history', agentId: 'session-b', messages: [] })
      emitServerEvent(socket, { type: 'pending_choices_snapshot', agentId: 'session-b', choiceIds: [] })
      emitServerEvent(socket, {
        type: 'unread_counts_snapshot',
        counts: { 'session-b': 1, 'session-c': 5, 'session-d': 2 },
      })

      // Exactly one snapshot from bootstrap flush
      expect(snapshots).toHaveLength(1)

      // Unread counts present, with target session-b filtered out
      expect(snapshots[0].unreadCounts).toEqual({ 'session-c': 5, 'session-d': 2 })

      unsub()
      client.destroy()
    })

    it('force-flushes bootstrap buffer when a live conversation event arrives', () => {
      const { client, socket } = setupConnectedClient()

      client.subscribeToAgent('session-b')

      const snapshots: ReturnType<typeof client.getState>[] = []
      const unsub = client.subscribe((state) => { snapshots.push(state) })
      snapshots.length = 0

      // Emit first 2 of 4 bootstrap events
      emitServerEvent(socket, { type: 'ready', serverTime: new Date().toISOString(), subscribedAgentId: 'session-b' })
      emitServerEvent(socket, {
        type: 'conversation_history',
        agentId: 'session-b',
        messages: [
          { type: 'conversation_message', agentId: 'session-b', role: 'user', text: 'hello', timestamp: new Date().toISOString(), source: 'user_input' },
        ],
      })

      // No notifications yet — events are buffered
      expect(snapshots).toHaveLength(0)

      // Live event arrives before bootstrap completes → force-flush
      emitServerEvent(socket, {
        type: 'conversation_message',
        agentId: 'session-b',
        role: 'assistant',
        text: 'live response',
        timestamp: new Date().toISOString(),
        source: 'speak_to_user',
      })

      // 2 notifications: force-flush + live event
      expect(snapshots).toHaveLength(2)

      // First: flushed bootstrap state (history message)
      expect(snapshots[0].subscribedAgentId).toBe('session-b')
      expect(snapshots[0].messages).toHaveLength(1)

      // Second: live event appended on top
      expect(snapshots[1].messages).toHaveLength(2)
      const lastMsg = snapshots[1].messages.at(-1)
      expect(lastMsg?.type === 'conversation_message' ? lastMsg.text : undefined).toBe('live response')

      unsub()
      client.destroy()
    })

    it('force-flushes on agent_status for a worker of the bootstrap target', () => {
      const { client, socket } = setupConnectedClient()

      client.subscribeToAgent('session-b')

      let notificationCount = 0
      const unsub = client.subscribe(() => { notificationCount++ })
      notificationCount = 0

      // Partial bootstrap — only ready so far
      emitServerEvent(socket, { type: 'ready', serverTime: new Date().toISOString(), subscribedAgentId: 'session-b' })
      expect(notificationCount).toBe(0)

      // agent_status for a worker of the bootstrap target → force-flush
      emitServerEvent(socket, {
        type: 'agent_status',
        agentId: 'worker-1',
        managerId: 'session-b',
        status: 'streaming',
        pendingCount: 1,
      })

      // Force-flush produced a notification, and the agent_status was processed
      expect(notificationCount).toBeGreaterThanOrEqual(1)
      expect(client.getState().subscribedAgentId).toBe('session-b')
      expect(client.getState().statuses['worker-1']?.status).toBe('streaming')

      unsub()
      client.destroy()
    })

    it('handles bootstrap for empty sessions with no history or choices', () => {
      const { client, socket } = setupConnectedClient()

      client.subscribeToAgent('session-b')

      let notificationCount = 0
      const unsub = client.subscribe(() => { notificationCount++ })
      notificationCount = 0

      emitServerEvent(socket, { type: 'ready', serverTime: new Date().toISOString(), subscribedAgentId: 'session-b' })
      emitServerEvent(socket, { type: 'conversation_history', agentId: 'session-b', messages: [] })
      emitServerEvent(socket, { type: 'pending_choices_snapshot', agentId: 'session-b', choiceIds: [] })
      emitServerEvent(socket, { type: 'unread_counts_snapshot', counts: {} })

      expect(notificationCount).toBe(1)
      expect(client.getState().messages).toHaveLength(0)
      expect(client.getState().pendingChoiceIds.size).toBe(0)
      expect(client.getState().subscribedAgentId).toBe('session-b')

      unsub()
      client.destroy()
    })

    it('flushes bootstrap buffer via timeout when terminal signal is missing', () => {
      const { client, socket } = setupConnectedClient()

      client.subscribeToAgent('session-b')

      let notificationCount = 0
      const unsub = client.subscribe(() => { notificationCount++ })
      notificationCount = 0

      // Emit only 3 of 4 expected events (missing unread_counts_snapshot)
      emitServerEvent(socket, { type: 'ready', serverTime: new Date().toISOString(), subscribedAgentId: 'session-b' })
      emitServerEvent(socket, { type: 'conversation_history', agentId: 'session-b', messages: [] })
      emitServerEvent(socket, { type: 'pending_choices_snapshot', agentId: 'session-b', choiceIds: [] })

      // No flush yet — waiting for terminal signal
      expect(notificationCount).toBe(0)

      // Advance past the safety timeout (100ms)
      vi.advanceTimersByTime(200)

      // Buffer flushed via timeout
      expect(notificationCount).toBe(1)
      expect(client.getState().subscribedAgentId).toBe('session-b')

      unsub()
      client.destroy()
    })

    it('does not buffer events during initial connect (only during subscribeToAgent)', () => {
      const client = new ManagerWsClient('ws://127.0.0.1:8787', 'session-a')

      let notificationCount = 0
      client.subscribe(() => { notificationCount++ })
      notificationCount = 0

      client.start()
      vi.advanceTimersByTime(60)

      const socket = FakeWebSocket.instances[0]
      socket.emit('open')
      notificationCount = 0 // reset after connect state update

      // Each event produces its own state update (no batching)
      emitServerEvent(socket, { type: 'ready', serverTime: new Date().toISOString(), subscribedAgentId: 'session-a' })
      expect(notificationCount).toBe(1)

      emitServerEvent(socket, { type: 'conversation_history', agentId: 'session-a', messages: [] })
      expect(notificationCount).toBe(2)

      client.destroy()
    })

    it('passes non-coalescible events through normally during bootstrap', () => {
      const { client, socket } = setupConnectedClient()

      client.subscribeToAgent('session-b')

      const snapshots: ReturnType<typeof client.getState>[] = []
      const unsub = client.subscribe((state) => { snapshots.push(state) })
      snapshots.length = 0

      // First bootstrap event (buffered)
      emitServerEvent(socket, { type: 'ready', serverTime: new Date().toISOString(), subscribedAgentId: 'session-b' })
      expect(snapshots).toHaveLength(0)

      // Non-coalescible event should pass through immediately
      emitServerEvent(socket, {
        type: 'agents_snapshot',
        agents: [{
          agentId: 'session-b',
          managerId: 'session-b',
          displayName: 'Session B',
          role: 'manager',
          status: 'idle',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          cwd: '/tmp',
          model: { provider: 'openai-codex', modelId: 'gpt-5.3-codex', thinkingLevel: 'medium' },
          sessionFile: '/tmp/session-b.jsonl',
        }],
      })

      // agents_snapshot triggered an immediate state update even during bootstrap
      expect(snapshots.length).toBeGreaterThanOrEqual(1)
      expect(client.getState().agents.some((a) => a.agentId === 'session-b')).toBe(true)

      // Complete bootstrap
      emitServerEvent(socket, { type: 'conversation_history', agentId: 'session-b', messages: [] })
      emitServerEvent(socket, { type: 'pending_choices_snapshot', agentId: 'session-b', choiceIds: [] })
      emitServerEvent(socket, { type: 'unread_counts_snapshot', counts: {} })

      // Bootstrap data flushed
      expect(client.getState().subscribedAgentId).toBe('session-b')

      unsub()
      client.destroy()
    })
  })
})
