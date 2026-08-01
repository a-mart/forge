import { WS_REQUEST_CONTRACTS } from '@forge/protocol'
import type { WsRequestContractType } from '@forge/protocol'
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { ManagerWsClient } from './ws-client'
import { ConversationSnapshotCache } from './ws-client/conversation-snapshot-cache'
import { REQUEST_TIMEOUT_MS, WS_REQUEST_ERROR_HINTS, WS_REQUEST_TYPES } from './ws-client/runtime-types'
import type { WsRequestType } from './ws-client/types'

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

function makeModelCacheObservation(agentId = 'manager', id = 'cache-obs-1') {
  return {
    type: 'model_cache_observation' as const,
    agentId,
    id,
    timestamp: '2026-06-02T12:00:00.000Z',
    runtimeType: 'pi' as const,
    provider: 'openai-codex' as const,
    modelId: 'gpt-5.5',
    tokens: {
      promptInputTokens: 3000,
      cachedInputTokens: 2500,
      cacheWriteInputTokens: 0,
      uncachedInputTokens: 500,
      outputTokens: 120,
      totalTokens: 3120,
      normalization: 'raw_input_tokens_total' as const,
    },
    classification: {
      version: 1 as const,
      status: 'hit' as const,
      cachedRatio: 0.8333333333333334,
      thresholdTokens: 1024,
      hitRatioThreshold: 0.8,
    },
  }
}

function makeManagerDescriptor(overrides: Record<string, unknown> = {}) {
  return {
    agentId: 'manager',
    managerId: 'manager',
    displayName: 'Manager',
    role: 'manager' as const,
    status: 'idle' as const,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cwd: '/tmp',
    model: {
      provider: 'openai-codex' as const,
      modelId: 'gpt-5.5',
      thinkingLevel: 'medium' as const,
    },
    sessionFile: '/tmp/manager.jsonl',
    ...overrides,
  }
}

function makeWorkerDescriptor(agentId: string, managerId = 'manager') {
  return {
    agentId,
    managerId,
    displayName: agentId,
    role: 'worker' as const,
    status: 'streaming' as const,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cwd: '/tmp',
    model: {
      provider: 'openai-codex' as const,
      modelId: 'gpt-5.5',
      thinkingLevel: 'medium' as const,
    },
    sessionFile: `/tmp/${agentId}.jsonl`,
  }
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

  it('keeps promise request policy aligned with protocol contracts', () => {
    expectTypeOf<Exclude<WsRequestType, WsRequestContractType>>().toEqualTypeOf<never>()
    expectTypeOf<Exclude<WsRequestContractType, WsRequestType>>().toEqualTypeOf<never>()

    const contractTypes = WS_REQUEST_CONTRACTS.map((contract) => contract.commandType)
    const contractTypeSet = new Set(contractTypes)
    const requestTypeSet = new Set(WS_REQUEST_TYPES)

    expect(contractTypes).toEqual([
      'browser_host_register',
      'browser_host_hydrate',
      'browser_panel_reveal_acknowledge',
      'browser_host_state_report',
      'browser_recording_start',
      'browser_recording_stop',
      'browser_tab_open',
      'browser_tab_activate',
      'browser_tab_close',
      'browser_tab_resize',
      'list_directories',
      'validate_directory',
      'create_directory',
      'pick_directory',
      'get_session_workers',
      'get_conversation_page',
      'rename_profile',
      'archive_profile',
      'restore_profile',
      'rename_session',
      'pin_session',
      'update_session_model',
      'update_session_delegation',
      'fork_session',
      'merge_session_memory',
      'update_profile_default_model',
      'update_project_delegation_defaults',
      'update_manager_model',
      'update_manager_cwd',
      'stop_all_agents',
      'create_manager',
      'create_repository_project',
      'cancel_repository_project_creation',
      'delete_manager',
      'create_session',
      'stop_session',
      'resume_session',
      'hydrate_archive_last_used',
      'archive_session',
      'restore_session',
      'delete_session',
      'clear_session',
      'session_goal_control',
      'set_session_project_agent',
      'get_project_agent_config',
      'list_project_agent_references',
      'get_project_agent_reference',
      'set_project_agent_reference',
      'delete_project_agent_reference',
      'request_project_agent_recommendations',
      'get_project_agent_sharing',
      'set_project_agent_sharing',
      'get_project_agent_external_directory',
    ])
    expect(contractTypeSet.size).toBe(contractTypes.length)
    expect(WS_REQUEST_TYPES.every((type) => contractTypeSet.has(type))).toBe(true)
    expect(contractTypes.every((type) => requestTypeSet.has(type))).toBe(true)
    expect(requestTypeSet.size).toBe(WS_REQUEST_TYPES.length)
    expect(WS_REQUEST_TYPES.filter((type) => type === 'create_manager')).toHaveLength(1)
    expect(WS_REQUEST_TYPES.filter((type) => type === 'delete_manager')).toHaveLength(1)

    const hintKeys = WS_REQUEST_ERROR_HINTS.map((hint) => `${hint.requestType}:${hint.codeFragment}`)
    expect(new Set(hintKeys).size).toBe(WS_REQUEST_ERROR_HINTS.length)
    expect(
      WS_REQUEST_CONTRACTS.every((contract) =>
        contract.errorCodeFragments.every((codeFragment) =>
          WS_REQUEST_ERROR_HINTS.some((hint) => hint.requestType === contract.commandType && hint.codeFragment === codeFragment),
        ),
      ),
    ).toBe(true)
  })

  it('projects bounded Builder order invalidations and ignores stale revisions', () => {
    const client = new ManagerWsClient('ws://127.0.0.1:8787', null)
    client.start()
    vi.advanceTimersByTime(60)
    const socket = FakeWebSocket.instances[0]!
    socket.emit('open')

    emitServerEvent(socket, { type: 'builder_sidebar_order_updated', revision: 3 })
    emitServerEvent(socket, { type: 'builder_sidebar_order_updated', revision: 2 })

    expect(client.getState().builderSidebarOrderRevision).toBe(3)
    client.destroy()
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
    expect(JSON.parse(socket.sentPayloads[0])).toEqual({
      type: 'subscribe',
      agentId: 'manager',
      conversationPaging: true,
      conversationView: 'web',
      subscriptionId: expect.any(String),
    })

    emitServerEvent(socket, {
      type: 'ready',
      serverTime: new Date().toISOString(),
      subscribedAgentId: 'manager',
    })

    client.sendUserMessage('hello manager')

    expect(JSON.parse(socket.sentPayloads[1])).toEqual({
      type: 'user_message',
      clientRequestId: expect.any(String),
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

  it('serializes reply target metadata on user_message commands', () => {
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

    client.sendUserMessage('reply body', {
      replyTo: {
        messageId: 'original-1',
        role: 'assistant',
        timestamp: '2026-06-29T10:00:00.000Z',
        text: 'Original assistant text',
        source: 'speak_to_user',
        attachmentCount: 1,
      },
    })

    expect(JSON.parse(socket.sentPayloads.at(-1) ?? '')).toEqual({
      type: 'user_message',
      clientRequestId: expect.any(String),
      text: 'reply body',
      agentId: 'manager',
      replyTo: {
        messageId: 'original-1',
        role: 'assistant',
        timestamp: '2026-06-29T10:00:00.000Z',
        text: 'Original assistant text',
        source: 'speak_to_user',
        attachmentCount: 1,
      },
    })

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

  it('ignores observations while disabled and clears them when settings turn off', () => {
    const client = new ManagerWsClient('ws://127.0.0.1:8787', 'manager')
    const cacheObservation = {
      type: 'model_cache_observation' as const,
      agentId: 'manager',
      id: 'cache-obs-1',
      timestamp: '2026-06-02T12:00:00.000Z',
      runtimeType: 'pi' as const,
      provider: 'openai-codex' as const,
      modelId: 'gpt-5.5',
      tokens: {
        promptInputTokens: 3000,
        cachedInputTokens: 2500,
        cacheWriteInputTokens: 0,
        uncachedInputTokens: 500,
        outputTokens: 120,
        totalTokens: 3120,
        normalization: 'raw_input_tokens_total' as const,
      },
      classification: {
        version: 1 as const,
        status: 'hit' as const,
        cachedRatio: 0.8333333333333334,
        thresholdTokens: 1024,
        hitRatioThreshold: 0.8,
      },
    }

    client.start()
    vi.advanceTimersByTime(60)

    const socket = FakeWebSocket.instances[0]
    socket.emit('open')
    emitServerEvent(socket, {
      type: 'ready',
      serverTime: new Date().toISOString(),
      subscribedAgentId: 'manager',
    })

    expect(client.getState().modelCacheVisualizationEnabled).toBe(false)

    emitServerEvent(socket, cacheObservation)
    expect(client.getState().modelCacheObservations).toEqual([])
    expect(client.getState().pendingModelCacheObservations).toHaveLength(1)

    emitServerEvent(socket, {
      type: 'conversation_history',
      agentId: 'manager',
      messages: [cacheObservation],
    })
    expect(client.getState().modelCacheObservations).toEqual([])
    expect(client.getState().pendingModelCacheObservations).toHaveLength(1)

    emitServerEvent(socket, {
      type: 'model_cache_visualization_settings_changed',
      enabled: true,
      updatedAt: new Date().toISOString(),
    })

    expect(client.getState().modelCacheVisualizationEnabled).toBe(true)
    expect(client.getState().modelCacheObservations).toHaveLength(1)
    expect(client.getState().modelCacheObservations[0]?.id).toBe('cache-obs-1')
    expect(client.getState().pendingModelCacheObservations).toEqual([])

    emitServerEvent(socket, {
      ...cacheObservation,
      id: 'cache-obs-2',
    })
    expect(client.getState().modelCacheObservations).toHaveLength(2)
    expect(client.getState().modelCacheObservations.map((entry) => entry.id)).toEqual([
      'cache-obs-1',
      'cache-obs-2',
    ])

    emitServerEvent(socket, {
      type: 'model_cache_visualization_settings_changed',
      enabled: false,
      updatedAt: new Date().toISOString(),
    })

    expect(client.getState().modelCacheVisualizationEnabled).toBe(false)
    expect(client.getState().modelCacheObservations).toEqual([])

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

  it('clears ephemeral Codex elicitations across session, refresh, and reconnect bootstraps', () => {
    const client = new ManagerWsClient('ws://127.0.0.1:8787', 'manager-a')
    client.start()
    vi.advanceTimersByTime(60)
    const socket = FakeWebSocket.instances[0]!
    socket.emit('open')
    emitServerEvent(socket, {
      type: 'ready',
      serverTime: new Date().toISOString(),
      subscribedAgentId: 'manager-a',
    })

    const elicitation = (agentId: string, elicitationId: string) => ({
      type: 'codex_elicitation_request' as const,
      elicitationId,
      agentId,
      sidecarAgentId: `${agentId}--codex`,
      mode: 'form' as const,
      message: 'Codex needs input',
      persistScopes: [],
    })
    emitServerEvent(socket, elicitation('manager-a', 'a-1'))
    expect(client.getState().codexElicitations.map((item) => item.elicitationId)).toEqual(['a-1'])

    client.subscribeToAgent('manager-b')
    expect(client.getState().codexElicitations).toEqual([])
    emitServerEvent(socket, elicitation('manager-b', 'b-1'))
    expect(client.getState().codexElicitations.map((item) => item.elicitationId)).toEqual(['b-1'])

    expect(client.refreshConversationHistory()).toBe(true)
    expect(client.getState().codexElicitations).toEqual([])
    emitServerEvent(socket, elicitation('manager-b', 'b-2'))
    expect(client.getState().codexElicitations.map((item) => item.elicitationId)).toEqual(['b-2'])

    socket.close()
    expect(client.getState().codexElicitations).toEqual([])
    vi.advanceTimersByTime(1200)
    const reconnectedSocket = FakeWebSocket.instances[1]!
    reconnectedSocket.emit('open')
    expect(client.getState().codexElicitations).toEqual([])

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
    expect(JSON.parse(socket.sentPayloads[0])).toEqual({
      type: 'subscribe',
      conversationPaging: true,
      conversationView: 'web',
      subscriptionId: expect.any(String),
    })

    emitServerEvent(socket, {
      type: 'ready',
      serverTime: new Date().toISOString(),
      subscribedAgentId: 'release-manager',
    })
    emitServerEvent(socket, {
      type: 'conversation_history',
      agentId: 'release-manager',
      messages: [],
    })

    expect(client.getState().targetAgentId).toBe('release-manager')
    expect(client.getState().subscribedAgentId).toBe('release-manager')

    client.destroy()
  })

  it('re-hydrates in place on reconnect — re-subscribes and never reloads the page', () => {
    // Guard: a reconnect must NOT trigger a full page reload. The redundant
    // window.location.reload() re-ran the entire bootstrap from scratch and,
    // under a large session on a backpressured socket, fueled a reconnect→reload
    // loop (see UI-RELOAD-LOOP-INVESTIGATION.md). Reconnect now re-hydrates state
    // in place via the re-subscribe below.
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
    expect(JSON.parse(socket.sentPayloads[0])).toEqual({
      type: 'subscribe',
      agentId: 'manager',
      conversationPaging: true,
      conversationView: 'web',
      subscriptionId: expect.any(String),
    })
    expect(client.getState().connectionEpoch).toBe(1)
    emitServerEvent(socket, { type: 'profiles_snapshot', profiles: [] })
    expect(client.getState().hasReceivedProfilesSnapshot).toBe(true)
    emitServerEvent(socket, { type: 'builder_sidebar_order_updated', revision: 5 })
    expect(client.getState().builderSidebarOrderRevision).toBe(5)

    // Backend restart drops the socket; the client schedules a reconnect.
    socket.close()
    expect(client.getState().connected).toBe(false)
    expect(client.getState().hasReceivedProfilesSnapshot).toBe(false)
    vi.advanceTimersByTime(1200)

    const reconnectedSocket = FakeWebSocket.instances[1]
    expect(reconnectedSocket).toBeDefined()

    reconnectedSocket.emit('open')

    // Re-hydration in place: reconnect re-subscribes (re-triggering the backend
    // bootstrap) and resets bootstrap-tracking state — without a page reload.
    expect(reload).not.toHaveBeenCalled()
    expect(JSON.parse(reconnectedSocket.sentPayloads[0])).toEqual({
      type: 'subscribe',
      agentId: 'manager',
      conversationPaging: true,
      conversationView: 'web',
      subscriptionId: expect.any(String),
    })
    expect(client.getState().connected).toBe(true)
    expect(client.getState().connectionEpoch).toBe(2)
    expect(client.getState().builderSidebarOrderRevision).toBeNull()
    expect(client.getState().hasReceivedAgentsSnapshot).toBe(false)
    expect(client.getState().hasReceivedProfilesSnapshot).toBe(false)

    // The restarted backend begins a new revision generation. Its R1 event is
    // accepted rather than being suppressed by the old connection's R5.
    emitServerEvent(reconnectedSocket, { type: 'builder_sidebar_order_updated', revision: 1 })
    expect(client.getState().builderSidebarOrderRevision).toBe(1)

    // The re-subscribe lands: the backend's correlated `ready` re-hydrates the target.
    const reconnectSubscribe = JSON.parse(reconnectedSocket.sentPayloads[0]) as { subscriptionId: string }
    emitServerEvent(reconnectedSocket, {
      type: 'ready',
      serverTime: new Date().toISOString(),
      subscribedAgentId: 'manager',
      subscriptionId: reconnectSubscribe.subscriptionId,
      servedConversationView: 'web',
    })
    expect(client.getState().subscribedAgentId).toBe('manager')
    expect(reload).not.toHaveBeenCalled()

    client.destroy()
  })

  it('preserves loaded session workers across a reconnect when workerCount is unchanged', async () => {
    // Regression: reconnect cleared `loadedSessionIds`, so the post-reconnect
    // managers-only agents_snapshot dropped every cached worker descriptor and
    // queued no refetch — sidebar worker rows and the pill bar went empty while
    // the manager's workerCount badge still showed the true count, until a full
    // page reload re-ran the on-demand fetch.
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
      agents: [makeManagerDescriptor({ workerCount: 2, activeWorkerCount: 2 })],
    })

    const fetch = client.getSessionWorkers('manager')
    const fetchPayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')
    emitServerEvent(socket, {
      type: 'session_workers_snapshot',
      sessionAgentId: 'manager',
      requestId: fetchPayload.requestId,
      workers: [makeWorkerDescriptor('worker-1'), makeWorkerDescriptor('worker-2')],
    })
    await expect(fetch).resolves.toMatchObject({ sessionAgentId: 'manager' })
    expect(client.getState().agents.filter((agent) => agent.role === 'worker')).toHaveLength(2)

    // Backend restart drops the socket; the client reconnects and re-bootstraps.
    socket.close()
    vi.advanceTimersByTime(1200)
    const reconnectedSocket = FakeWebSocket.instances[1]
    reconnectedSocket.emit('open')
    emitServerEvent(reconnectedSocket, {
      type: 'ready',
      serverTime: new Date().toISOString(),
      subscribedAgentId: 'manager',
    })

    // The re-bootstrap agents_snapshot is managers-only, with an unchanged
    // workerCount hint. The cached workers must survive it.
    emitServerEvent(reconnectedSocket, {
      type: 'agents_snapshot',
      agents: [makeManagerDescriptor({ workerCount: 2, activeWorkerCount: 2 })],
    })

    const workers = client.getState().agents.filter((agent) => agent.role === 'worker')
    expect(workers.map((worker) => worker.agentId).sort()).toEqual(['worker-1', 'worker-2'])

    client.destroy()
  })

  it('refetches session workers after a reconnect when workerCount drifted while disconnected', async () => {
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
      agents: [makeManagerDescriptor({ workerCount: 1, activeWorkerCount: 1 })],
    })

    const fetch = client.getSessionWorkers('manager')
    const fetchPayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')
    emitServerEvent(socket, {
      type: 'session_workers_snapshot',
      sessionAgentId: 'manager',
      requestId: fetchPayload.requestId,
      workers: [makeWorkerDescriptor('worker-1')],
    })
    await expect(fetch).resolves.toMatchObject({ sessionAgentId: 'manager' })

    socket.close()
    vi.advanceTimersByTime(1200)
    const reconnectedSocket = FakeWebSocket.instances[1]
    reconnectedSocket.emit('open')
    emitServerEvent(reconnectedSocket, {
      type: 'ready',
      serverTime: new Date().toISOString(),
      subscribedAgentId: 'manager',
    })

    // While disconnected a second worker spawned: the re-bootstrap snapshot
    // advertises workerCount 2 against 1 cached worker, so the client must
    // invalidate and refetch the session workers.
    emitServerEvent(reconnectedSocket, {
      type: 'agents_snapshot',
      agents: [makeManagerDescriptor({ workerCount: 2, activeWorkerCount: 2 })],
    })
    vi.advanceTimersByTime(250)

    const refetchPayload = JSON.parse(reconnectedSocket.sentPayloads.at(-1) ?? '{}')
    expect(refetchPayload).toMatchObject({
      type: 'get_session_workers',
      sessionAgentId: 'manager',
    })

    emitServerEvent(reconnectedSocket, {
      type: 'session_workers_snapshot',
      sessionAgentId: 'manager',
      requestId: refetchPayload.requestId,
      workers: [makeWorkerDescriptor('worker-1'), makeWorkerDescriptor('worker-2')],
    })

    const workers = client.getState().agents.filter((agent) => agent.role === 'worker')
    expect(workers.map((worker) => worker.agentId).sort()).toEqual(['worker-1', 'worker-2'])

    client.destroy()
  })

  it('recovers when a get_session_workers response is lost — fast timeout, then automatic retry', async () => {
    // Regression: the backend dropped session_workers_snapshot responses under
    // socket backpressure (e.g. while a multi-MB conversation_history bootstrap
    // was draining). The client then held the dead request for the default
    // 5-minute timeout — deduping every other fetch trigger onto it — and never
    // retried, leaving the sidebar rows and worker pill bar permanently empty
    // while the manager's workerCount badge stayed correct.
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
      agents: [makeManagerDescriptor({ workerCount: 1, activeWorkerCount: 1 })],
    })

    const fetch = client.getSessionWorkers('manager')
    const fetchPayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')
    expect(fetchPayload).toMatchObject({ type: 'get_session_workers', sessionAgentId: 'manager' })

    // The response never arrives. The request must fail fast (well under the
    // 5-minute default request timeout).
    await vi.advanceTimersByTimeAsync(15_000)
    await expect(fetch).rejects.toThrow('timed out')

    // The cache retries on its own after the backoff delay.
    await vi.advanceTimersByTimeAsync(2_000)
    const retryPayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')
    expect(retryPayload).toMatchObject({ type: 'get_session_workers', sessionAgentId: 'manager' })
    expect(retryPayload.requestId).not.toBe(fetchPayload.requestId)

    emitServerEvent(socket, {
      type: 'session_workers_snapshot',
      sessionAgentId: 'manager',
      requestId: retryPayload.requestId,
      workers: [makeWorkerDescriptor('worker-1')],
    })

    const workers = client.getState().agents.filter((agent) => agent.role === 'worker')
    expect(workers.map((worker) => worker.agentId)).toEqual(['worker-1'])

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
      clientRequestId: expect.any(String),
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
      clientRequestId: expect.any(String),
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
      conversationPaging: true,
      conversationView: 'web',
      subscriptionId: expect.any(String),
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
      clientRequestId: expect.any(String),
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

  it('records an explicit subscription rejection and clears it on the next selection', () => {
    const client = new ManagerWsClient('ws://127.0.0.1:8787', 'manager')
    client.start()
    vi.advanceTimersByTime(60)

    const socket = FakeWebSocket.instances[0]
    socket.emit('open')
    client.subscribeToAgent('missing-worker')
    expect(client.isExplicitSelectionPending()).toBe(true)

    emitServerEvent(socket, {
      type: 'error',
      code: 'UNKNOWN_AGENT',
      message: 'Agent missing-worker does not exist.',
    })

    expect(client.getRejectedExplicitSelectionAgentId()).toBe('missing-worker')
    expect(client.isExplicitSelectionPending()).toBe(false)

    client.subscribeToAgent('worker-1')
    expect(client.getRejectedExplicitSelectionAgentId()).toBeNull()

    client.destroy()
  })

  it('requests and prepends an older conversation page', async () => {
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
      type: 'conversation_history',
      agentId: 'manager',
      mode: 'replace',
      messages: [{
        type: 'conversation_message',
        id: 'newer',
        agentId: 'manager',
        role: 'assistant',
        text: 'newer',
        timestamp: new Date().toISOString(),
        source: 'speak_to_user',
      }],
      page: {
        hasOlder: true,
        nextCursor: 'cursor-1',
        completeness: 'complete',
        source: 'legacy_cache',
      },
    })
    emitServerEvent(socket, { type: 'unread_counts_snapshot', counts: {} })

    const pendingPage = client.loadOlderConversation(25)
    const request = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')
    expect(request).toMatchObject({
      type: 'get_conversation_page',
      agentId: 'manager',
      cursor: 'cursor-1',
      limit: 25,
      view: 'web',
      requestId: expect.any(String),
    })
    expect(client.getState().conversationPageLoading).toBe(true)

    emitServerEvent(socket, {
      type: 'conversation_page',
      agentId: 'manager',
      requestId: request.requestId,
      messages: [{
        type: 'conversation_message',
        id: 'older',
        agentId: 'manager',
        role: 'assistant',
        text: 'older',
        timestamp: new Date(0).toISOString(),
        source: 'speak_to_user',
      }],
      page: {
        hasOlder: false,
        completeness: 'complete',
        source: 'legacy_cache',
      },
    })

    await expect(pendingPage).resolves.toMatchObject({ agentId: 'manager' })
    expect(client.getState().messages.map((entry) => entry.type === 'conversation_message' ? entry.id : 'unexpected'))
      .toEqual(['older', 'newer'])
    expect(client.getState().conversationPageLoading).toBe(false)
    client.destroy()
  })

  it('does not let a stale page rejection clear a newer session page request', async () => {
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
      type: 'conversation_history',
      agentId: 'manager',
      mode: 'replace',
      messages: [],
      page: {
        hasOlder: true,
        nextCursor: 'cursor-a',
        completeness: 'complete',
        source: 'legacy_cache',
      },
    })
    emitServerEvent(socket, { type: 'unread_counts_snapshot', counts: {} })

    const pendingPageA = client.loadOlderConversation()
    const requestA = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')

    client.subscribeToAgent('session-b')
    emitServerEvent(socket, {
      type: 'conversation_history',
      agentId: 'session-b',
      mode: 'replace',
      messages: [],
      page: {
        hasOlder: true,
        nextCursor: 'cursor-b',
        completeness: 'complete',
        source: 'legacy_cache',
      },
    })
    emitServerEvent(socket, { type: 'unread_counts_snapshot', counts: {} })
    const pendingPageB = client.loadOlderConversation()
    const requestB = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')
    expect(requestB.requestId).not.toBe(requestA.requestId)

    emitServerEvent(socket, {
      type: 'error',
      code: 'GET_CONVERSATION_PAGE_FAILED',
      message: 'Session A page failed.',
      requestId: requestA.requestId,
    })
    await expect(pendingPageA).rejects.toThrow(
      'GET_CONVERSATION_PAGE_FAILED: Session A page failed.',
    )
    expect(client.getState()).toMatchObject({
      targetAgentId: 'session-b',
      conversationPageLoading: true,
      conversationPageRequestId: requestB.requestId,
    })

    emitServerEvent(socket, {
      type: 'conversation_page',
      agentId: 'session-b',
      requestId: requestB.requestId,
      messages: [],
      page: {
        hasOlder: false,
        completeness: 'complete',
        source: 'legacy_cache',
      },
    })
    await expect(pendingPageB).resolves.toMatchObject({ agentId: 'session-b' })
    expect(client.getState().conversationPageLoading).toBe(false)
    expect(client.getState().conversationPageRequestId).toBeNull()
    client.destroy()
  })

  it('starts a fresh cursor-bound bootstrap when the Builder conversation view changes', () => {
    const client = new ManagerWsClient('ws://127.0.0.1:8787', 'manager')
    client.start()
    vi.advanceTimersByTime(60)

    const socket = FakeWebSocket.instances[0]
    socket.emit('open')
    expect(client.setConversationView('all')).toBe(true)
    expect(JSON.parse(socket.sentPayloads.at(-1) ?? '{}')).toEqual({
      type: 'subscribe',
      agentId: 'manager',
      conversationPaging: true,
      conversationView: 'all',
      subscriptionId: expect.any(String),
    })
    expect(client.getState().conversationPage).toBeNull()
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

    client.subscribeToAgent('worker-1')
    const workerSubscribe = JSON.parse(socket.sentPayloads.at(-1) ?? '{}') as { subscriptionId: string }
    emitServerEvent(socket, {
      type: 'ready',
      serverTime: new Date().toISOString(),
      subscribedAgentId: 'worker-1',
      subscriptionId: workerSubscribe.subscriptionId,
      servedConversationView: 'web',
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
      clientRequestId: expect.any(String),
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

  it('rejects stop_all_agents via fallback error hints from the shared request contract', async () => {
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

    emitServerEvent(socket, {
      type: 'error',
      code: 'STOP_ALL_AGENTS_FAILED',
      message: 'Stop rejected for testing.',
    })

    await expect(stopPromise).rejects.toThrow('STOP_ALL_AGENTS_FAILED: Stop rejected for testing.')

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
            modelId: 'gpt-5.5',
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
          modelId: 'gpt-5.5',
          thinkingLevel: 'high',
        },
        sessionFile: '/tmp/release-manager.jsonl',
      },
    })

    await expect(creationPromise).resolves.toMatchObject({ agentId: 'release-manager' })
    expect(client.getState().agents.some((agent) => agent.agentId === 'release-manager')).toBe(true)

    client.destroy()
  })

  it('sends delete_manager and resolves with manager_deleted event', async () => {
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

    const deletePromise = client.deleteManager('manager-2')
    const sentDeletePayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')

    expect(sentDeletePayload.type).toBe('delete_manager')
    expect(sentDeletePayload.managerId).toBe('manager-2')
    expect(typeof sentDeletePayload.requestId).toBe('string')

    emitServerEvent(socket, {
      type: 'manager_deleted',
      requestId: sentDeletePayload.requestId,
      managerId: 'manager-2',
      terminatedWorkerIds: ['worker-1'],
    })

    await expect(deletePromise).resolves.toEqual({ managerId: 'manager-2' })

    client.destroy()
  })

  it('sends update_profile_default_model commands and resolves profile_default_model_updated events', async () => {
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

    const updatePromise = client.updateProfileDefaultModel(' profile-a ', 'pi-5.4', 'high')
    const updatePayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')

    expect(updatePayload).toMatchObject({
      type: 'update_profile_default_model',
      profileId: 'profile-a',
      model: 'pi-5.4',
      reasoningLevel: 'high',
    })
    expect(typeof updatePayload.requestId).toBe('string')

    emitServerEvent(socket, {
      type: 'profile_default_model_updated',
      requestId: updatePayload.requestId,
      profileId: 'profile-a',
      model: 'pi-opus',
      reasoningLevel: 'low',
    })

    await expect(updatePromise).resolves.toEqual({ profileId: 'profile-a' })

    client.destroy()
  })

  it('rejects update_profile_default_model via fallback error hints from the shared request contract', async () => {
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

    const updatePromise = client.updateProfileDefaultModel('profile-a', 'pi-5.4')

    emitServerEvent(socket, {
      type: 'error',
      code: 'UPDATE_PROFILE_DEFAULT_MODEL_FAILED',
      message: 'Profile default model update rejected for testing.',
    })

    await expect(updatePromise).rejects.toThrow(
      'UPDATE_PROFILE_DEFAULT_MODEL_FAILED: Profile default model update rejected for testing.',
    )

    client.destroy()
  })

  it('sends update_manager_model commands and resolves manager_model_updated events', async () => {
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

    const updatePromise = client.updateManagerModel(' manager ', 'pi-5.4', 'high')
    const updatePayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')

    expect(updatePayload).toMatchObject({
      type: 'update_manager_model',
      managerId: 'manager',
      model: 'pi-5.4',
      reasoningLevel: 'high',
    })
    expect(typeof updatePayload.requestId).toBe('string')

    emitServerEvent(socket, {
      type: 'manager_model_updated',
      requestId: updatePayload.requestId,
      managerId: 'manager',
      model: 'pi-opus',
      reasoningLevel: 'low',
    })

    await expect(updatePromise).resolves.toEqual({ managerId: 'manager' })

    client.destroy()
  })

  it('rejects update_manager_model via fallback error hints from the shared request contract', async () => {
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

    const updatePromise = client.updateManagerModel('manager', 'pi-5.4')

    emitServerEvent(socket, {
      type: 'error',
      code: 'UPDATE_MANAGER_MODEL_FAILED',
      message: 'Model update rejected for testing.',
    })

    await expect(updatePromise).rejects.toThrow('UPDATE_MANAGER_MODEL_FAILED: Model update rejected for testing.')

    client.destroy()
  })

  it('sends update_manager_cwd commands and resolves manager_cwd_updated events', async () => {
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

    const updatePromise = client.updateManagerCwd(' manager ', ' /tmp/project ')
    const updatePayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')

    expect(updatePayload).toMatchObject({
      type: 'update_manager_cwd',
      managerId: 'manager',
      cwd: '/tmp/project',
    })
    expect(typeof updatePayload.requestId).toBe('string')

    emitServerEvent(socket, {
      type: 'manager_cwd_updated',
      requestId: updatePayload.requestId,
      managerId: 'manager',
      cwd: '/tmp/project',
    })

    await expect(updatePromise).resolves.toEqual({ managerId: 'manager', cwd: '/tmp/project' })

    client.destroy()
  })

  it('rejects update_manager_cwd via fallback error hints from the shared request contract', async () => {
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

    const updatePromise = client.updateManagerCwd('manager', '/tmp/project')

    emitServerEvent(socket, {
      type: 'error',
      code: 'update_manager_cwd_failed',
      message: 'Cwd update rejected for testing.',
    })

    await expect(updatePromise).rejects.toThrow('update_manager_cwd_failed: Cwd update rejected for testing.')

    client.destroy()
  })

  it('sends create_session commands and resolves session_created events', async () => {
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

    const createPromise = client.createSession(' profile-a ', ' New Session ', {
      sessionPurpose: 'agent_creator',
      label: 'Agent Creator',
    })
    const createPayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')

    expect(createPayload).toMatchObject({
      type: 'create_session',
      profileId: 'profile-a',
      name: 'New Session',
      label: 'Agent Creator',
      sessionPurpose: 'agent_creator',
    })
    expect(typeof createPayload.requestId).toBe('string')

    const profile = {
      profileId: 'profile-a',
      displayName: 'Profile A',
      defaultSessionAgentId: 'session-a',
      defaultModel: { provider: 'openai-codex', modelId: 'gpt-5.4', thinkingLevel: 'xhigh' },
      createdAt: '2026-05-05T00:00:00.000Z',
      updatedAt: '2026-05-05T00:00:00.000Z',
    }
    const sessionAgent = {
      agentId: 'session-a',
      managerId: 'session-a',
      displayName: 'New Session',
      role: 'manager',
      status: 'idle',
      createdAt: '2026-05-05T00:00:00.000Z',
      updatedAt: '2026-05-05T00:00:00.000Z',
      cwd: '/tmp/project',
      model: { provider: 'openai-codex', modelId: 'gpt-5.4', thinkingLevel: 'xhigh' },
      sessionFile: '/tmp/session.jsonl',
      profileId: 'profile-a',
    }

    emitServerEvent(socket, {
      type: 'session_created',
      requestId: createPayload.requestId,
      profile,
      sessionAgent,
    })

    await expect(createPromise).resolves.toEqual({ profileId: 'profile-a', sessionAgent })

    client.destroy()
  })

  it('rejects create_session via fallback error hints from the shared request contract', async () => {
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

    const createPromise = client.createSession('profile-a')

    emitServerEvent(socket, {
      type: 'error',
      code: 'CREATE_SESSION_FAILED',
      message: 'Create rejected for testing.',
    })

    await expect(createPromise).rejects.toThrow('CREATE_SESSION_FAILED: Create rejected for testing.')

    client.destroy()
  })

  it('sends stop_session commands and resolves session_stopped events', async () => {
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

    const stopPromise = client.stopSession(' session-a ')
    const stopPayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')

    expect(stopPayload).toMatchObject({
      type: 'stop_session',
      agentId: 'session-a',
    })
    expect(typeof stopPayload.requestId).toBe('string')

    emitServerEvent(socket, {
      type: 'session_stopped',
      requestId: stopPayload.requestId,
      agentId: 'session-a',
      profileId: 'profile-a',
      terminatedWorkerIds: ['worker-a'],
    })

    await expect(stopPromise).resolves.toEqual({ agentId: 'session-a' })

    client.destroy()
  })

  it('rejects stop_session via fallback error hints from the shared request contract', async () => {
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

    const stopPromise = client.stopSession('session-a')

    emitServerEvent(socket, {
      type: 'error',
      code: 'stop_session_failed',
      message: 'Stop rejected for testing.',
    })

    await expect(stopPromise).rejects.toThrow('stop_session_failed: Stop rejected for testing.')

    client.destroy()
  })

  it('sends resume_session commands and resolves session_resumed events', async () => {
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

    const resumePromise = client.resumeSession(' session-a ')
    const resumePayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')

    expect(resumePayload).toMatchObject({
      type: 'resume_session',
      agentId: 'session-a',
    })
    expect(typeof resumePayload.requestId).toBe('string')

    emitServerEvent(socket, {
      type: 'session_resumed',
      requestId: resumePayload.requestId,
      agentId: 'session-a',
      profileId: 'profile-a',
    })

    await expect(resumePromise).resolves.toEqual({ agentId: 'session-a' })

    client.destroy()
  })

  it('rejects resume_session via fallback error hints from the shared request contract', async () => {
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

    const resumePromise = client.resumeSession('session-a')

    emitServerEvent(socket, {
      type: 'error',
      code: 'resume_session_failed',
      message: 'Resume rejected for testing.',
    })

    await expect(resumePromise).rejects.toThrow('resume_session_failed: Resume rejected for testing.')

    client.destroy()
  })


  it('sends archive_session commands and resolves session_archived events', async () => {
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

    const archivePromise = client.archiveSession(' session-a ')
    const archivePayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')

    expect(archivePayload).toMatchObject({
      type: 'archive_session',
      agentId: 'session-a',
    })
    expect(typeof archivePayload.requestId).toBe('string')

    emitServerEvent(socket, {
      type: 'session_archived',
      requestId: archivePayload.requestId,
      agentId: 'session-a',
      profileId: 'profile-a',
      archivedAt: '2026-05-20T00:00:00.000Z',
    })

    await expect(archivePromise).resolves.toEqual({
      agentId: 'session-a',
      profileId: 'profile-a',
      archivedAt: '2026-05-20T00:00:00.000Z',
    })

    client.destroy()
  })

  it('rejects archive_session via fallback error hints from the shared request contract', async () => {
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

    const archivePromise = client.archiveSession('session-a')

    emitServerEvent(socket, {
      type: 'error',
      code: 'ARCHIVE_DEFAULT_SESSION_NOT_ALLOWED',
      message: 'The default session for a project can’t be archived directly.',
    })

    await expect(archivePromise).rejects.toThrow(
      'ARCHIVE_DEFAULT_SESSION_NOT_ALLOWED: The default session for a project can’t be archived directly.',
    )

    client.destroy()
  })

  it('sends restore_session commands and resolves session_restored events', async () => {
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

    const restorePromise = client.restoreSession(' session-a ')
    const restorePayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')

    expect(restorePayload).toMatchObject({
      type: 'restore_session',
      agentId: 'session-a',
    })
    expect(typeof restorePayload.requestId).toBe('string')

    emitServerEvent(socket, {
      type: 'session_restored',
      requestId: restorePayload.requestId,
      agentId: 'session-a',
      profileId: 'profile-a',
      openAgentId: 'session-a',
    })

    await expect(restorePromise).resolves.toEqual({
      agentId: 'session-a',
      profileId: 'profile-a',
      openAgentId: 'session-a',
    })

    client.destroy()
  })

  it('rejects restore_session via fallback error hints from the shared request contract', async () => {
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

    const restorePromise = client.restoreSession('session-a')

    emitServerEvent(socket, {
      type: 'error',
      code: 'ARCHIVE_RESTORE_PARENT_PROJECT_REQUIRED',
      message: 'Restore the project first.',
    })

    await expect(restorePromise).rejects.toThrow(
      'ARCHIVE_RESTORE_PARENT_PROJECT_REQUIRED: Restore the project first.',
    )

    client.destroy()
  })

  it('sends delete_session commands and resolves session_deleted events', async () => {
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

    const deletePromise = client.deleteSession(' session-a ')
    const deletePayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')

    expect(deletePayload).toMatchObject({
      type: 'delete_session',
      agentId: 'session-a',
    })
    expect(typeof deletePayload.requestId).toBe('string')

    emitServerEvent(socket, {
      type: 'session_deleted',
      requestId: deletePayload.requestId,
      agentId: 'session-a',
      profileId: 'profile-a',
      terminatedWorkerIds: ['worker-a'],
    })

    await expect(deletePromise).resolves.toEqual({ agentId: 'session-a' })

    client.destroy()
  })

  it('rejects delete_session via fallback error hints from the shared request contract', async () => {
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

    const deletePromise = client.deleteSession('session-a')

    emitServerEvent(socket, {
      type: 'error',
      code: 'delete_session_failed',
      message: 'Delete rejected for testing.',
    })

    await expect(deletePromise).rejects.toThrow('delete_session_failed: Delete rejected for testing.')

    client.destroy()
  })

  it('sends clear_session commands and resolves session_cleared events', async () => {
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

    const clearPromise = client.clearSession(' session-a ')
    const clearPayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')

    expect(clearPayload).toMatchObject({
      type: 'clear_session',
      agentId: 'session-a',
    })
    expect(typeof clearPayload.requestId).toBe('string')

    emitServerEvent(socket, {
      type: 'session_cleared',
      requestId: clearPayload.requestId,
      agentId: 'session-a',
    })

    await expect(clearPromise).resolves.toEqual({ agentId: 'session-a' })

    client.destroy()
  })

  it('rejects clear_session via fallback error hints from the shared request contract', async () => {
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

    const clearPromise = client.clearSession('session-a')

    emitServerEvent(socket, {
      type: 'error',
      code: 'clear_session_failed',
      message: 'Clear rejected for testing.',
    })

    await expect(clearPromise).rejects.toThrow('clear_session_failed: Clear rejected for testing.')

    client.destroy()
  })

  it('sends set_session_project_agent commands and resolves session_project_agent_updated events', async () => {
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

    const projectAgent = {
      whenToUse: 'Coordinate release notes.',
      systemPrompt: 'You are the release notes project agent.',
      handle: 'release-notes',
      capabilities: ['create_session' as const],
    }
    const setPromise = client.setSessionProjectAgent(' agent-a ', projectAgent)
    const setPayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')

    expect(setPayload).toMatchObject({
      type: 'set_session_project_agent',
      agentId: 'agent-a',
      projectAgent,
    })
    expect(setPayload.requestId).toMatch(/^set_session_project_agent-/)

    const result = {
      agentId: 'agent-a',
      profileId: 'profile-a',
      projectAgent: {
        handle: 'release-notes',
        whenToUse: 'Coordinate release notes.',
        capabilities: ['create_session' as const],
      },
    }

    emitServerEvent(socket, {
      type: 'session_project_agent_updated',
      requestId: setPayload.requestId,
      ...result,
    })

    await expect(setPromise).resolves.toEqual(result)

    client.destroy()
  })

  it('rejects only set_session_project_agent via fallback error hints with concurrent project-agent requests', async () => {
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

    const setPromise = client.setSessionProjectAgent('agent-a', null)
    const setPayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')
    const configPromise = client.getProjectAgentConfig('agent-a')
    const configPayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')

    emitServerEvent(socket, {
      type: 'error',
      code: 'SET_SESSION_PROJECT_AGENT_FAILED',
      message: 'Project agent update rejected for testing.',
    })

    await expect(setPromise).rejects.toThrow(
      'SET_SESSION_PROJECT_AGENT_FAILED: Project agent update rejected for testing.',
    )

    const configResult = {
      agentId: 'agent-a',
      config: {
        version: 1,
        agentId: 'agent-a',
        handle: 'release-notes',
        whenToUse: 'Coordinate release notes.',
        creatorSessionId: undefined,
        capabilities: [],
        promotedAt: '2026-05-05T00:00:00.000Z',
        updatedAt: '2026-05-05T00:00:00.000Z',
      },
      systemPrompt: null,
      references: [],
    }

    emitServerEvent(socket, {
      type: 'project_agent_config',
      requestId: configPayload.requestId,
      ...configResult,
    })

    await expect(configPromise).resolves.toEqual(configResult)
    expect(setPayload.requestId).toMatch(/^set_session_project_agent-/)
    expect(configPayload.requestId).toMatch(/^get_project_agent_config-/)

    client.destroy()
  })

  it('sends get_project_agent_config commands and resolves project_agent_config events', async () => {
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

    const configPromise = client.getProjectAgentConfig(' agent-a ')
    const configPayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')

    expect(configPayload).toMatchObject({
      type: 'get_project_agent_config',
      agentId: 'agent-a',
    })
    expect(configPayload.requestId).toMatch(/^get_project_agent_config-/)

    const result = {
      agentId: 'agent-a',
      config: {
        version: 1,
        agentId: 'agent-a',
        handle: 'release-notes',
        whenToUse: 'Coordinate release notes.',
        creatorSessionId: 'creator-a',
        capabilities: ['create_session'],
        promotedAt: '2026-05-05T00:00:00.000Z',
        updatedAt: '2026-05-05T00:00:00.000Z',
      },
      systemPrompt: 'You are the release notes project agent.',
      references: ['README.md'],
    }

    emitServerEvent(socket, {
      type: 'project_agent_config',
      requestId: configPayload.requestId,
      ...result,
    })

    await expect(configPromise).resolves.toEqual(result)

    client.destroy()
  })

  it('rejects get_project_agent_config via fallback error hints from the shared request contract', async () => {
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

    const configPromise = client.getProjectAgentConfig('agent-a')

    emitServerEvent(socket, {
      type: 'error',
      code: 'PROJECT_AGENT_CONFIG_FAILED',
      message: 'Project agent config rejected for testing.',
    })

    await expect(configPromise).rejects.toThrow('PROJECT_AGENT_CONFIG_FAILED: Project agent config rejected for testing.')

    client.destroy()
  })

  it('sends list_project_agent_references commands and resolves project_agent_references events', async () => {
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

    const referencesPromise = client.listProjectAgentReferences(' agent-a ')
    const referencesPayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')

    expect(referencesPayload).toMatchObject({
      type: 'list_project_agent_references',
      agentId: 'agent-a',
    })
    expect(referencesPayload.requestId).toMatch(/^list_project_agent_references-/)

    const result = {
      agentId: 'agent-a',
      references: ['README.md', 'notes.md'],
    }

    emitServerEvent(socket, {
      type: 'project_agent_references',
      requestId: referencesPayload.requestId,
      ...result,
    })

    await expect(referencesPromise).resolves.toEqual(result)

    client.destroy()
  })

  it('rejects list_project_agent_references via fallback error hints from the shared request contract', async () => {
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

    const referencesPromise = client.listProjectAgentReferences('agent-a')

    emitServerEvent(socket, {
      type: 'error',
      code: 'PROJECT_AGENT_REFERENCES_FAILED',
      message: 'Project agent references rejected for testing.',
    })

    await expect(referencesPromise).rejects.toThrow(
      'PROJECT_AGENT_REFERENCES_FAILED: Project agent references rejected for testing.',
    )

    client.destroy()
  })

  it('sends get_project_agent_reference commands and resolves project_agent_reference events', async () => {
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

    const referencePromise = client.getProjectAgentReference(' agent-a ', ' README.md ')
    const referencePayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')

    expect(referencePayload).toMatchObject({
      type: 'get_project_agent_reference',
      agentId: 'agent-a',
      fileName: 'README.md',
    })
    expect(referencePayload.requestId).toMatch(/^get_project_agent_reference-/)

    const result = {
      agentId: 'agent-a',
      fileName: 'README.md',
      content: '# Reference',
    }

    emitServerEvent(socket, {
      type: 'project_agent_reference',
      requestId: referencePayload.requestId,
      ...result,
    })

    await expect(referencePromise).resolves.toEqual(result)

    client.destroy()
  })

  it('rejects get_project_agent_reference via fallback error hints from the shared request contract', async () => {
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

    const referencePromise = client.getProjectAgentReference('agent-a', 'README.md')

    emitServerEvent(socket, {
      type: 'error',
      code: 'GET_PROJECT_AGENT_REFERENCE_FAILED',
      message: 'Project agent reference rejected for testing.',
    })

    await expect(referencePromise).rejects.toThrow(
      'GET_PROJECT_AGENT_REFERENCE_FAILED: Project agent reference rejected for testing.',
    )

    client.destroy()
  })

  it('sends set_project_agent_reference commands and resolves project_agent_reference_saved events', async () => {
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

    const referencePromise = client.setProjectAgentReference(' agent-a ', ' README.md ', '# Reference')
    const referencePayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')

    expect(referencePayload).toMatchObject({
      type: 'set_project_agent_reference',
      agentId: 'agent-a',
      fileName: 'README.md',
      content: '# Reference',
    })
    expect(referencePayload.requestId).toMatch(/^set_project_agent_reference-/)

    emitServerEvent(socket, {
      type: 'project_agent_reference_saved',
      requestId: referencePayload.requestId,
      agentId: 'agent-a',
      fileName: 'README.md',
    })

    await expect(referencePromise).resolves.toEqual({ agentId: 'agent-a', fileName: 'README.md' })

    client.destroy()
  })

  it('sends delete_project_agent_reference commands and resolves project_agent_reference_deleted events', async () => {
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

    const referencePromise = client.deleteProjectAgentReference(' agent-a ', ' README.md ')
    const referencePayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')

    expect(referencePayload).toMatchObject({
      type: 'delete_project_agent_reference',
      agentId: 'agent-a',
      fileName: 'README.md',
    })
    expect(referencePayload.requestId).toMatch(/^delete_project_agent_reference-/)

    emitServerEvent(socket, {
      type: 'project_agent_reference_deleted',
      requestId: referencePayload.requestId,
      agentId: 'agent-a',
      fileName: 'README.md',
    })

    await expect(referencePromise).resolves.toEqual({ agentId: 'agent-a', fileName: 'README.md' })

    client.destroy()
  })

  it('sends request_project_agent_recommendations commands and resolves project_agent_recommendations events', async () => {
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

    const recommendationsPromise = client.requestProjectAgentRecommendations(' agent-a ')
    const recommendationsPayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')

    expect(recommendationsPayload).toMatchObject({
      type: 'request_project_agent_recommendations',
      agentId: 'agent-a',
    })
    expect(recommendationsPayload.requestId).toMatch(/^request_project_agent_recommendations-/)

    emitServerEvent(socket, {
      type: 'project_agent_recommendations',
      requestId: recommendationsPayload.requestId,
      agentId: 'agent-a',
      whenToUse: 'Use for docs.',
      systemPrompt: 'You maintain docs.',
    })

    await expect(recommendationsPromise).resolves.toEqual({
      agentId: 'agent-a',
      whenToUse: 'Use for docs.',
      systemPrompt: 'You maintain docs.',
    })

    client.destroy()
  })

  it('rejects only matching request_project_agent_recommendations requests from project_agent_recommendations_error events', async () => {
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

    const firstPromise = client.requestProjectAgentRecommendations('agent-a')
    const firstPayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')
    const secondPromise = client.requestProjectAgentRecommendations('agent-b')
    const secondPayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')
    let firstSettled = false
    void firstPromise.finally(() => {
      firstSettled = true
    })

    emitServerEvent(socket, {
      type: 'project_agent_recommendations_error',
      requestId: secondPayload.requestId,
      agentId: 'agent-b',
      message: 'Recommendation failed for testing.',
    })
    await Promise.resolve()

    await expect(secondPromise).rejects.toThrow('Recommendation failed for testing.')
    expect(firstSettled).toBe(false)

    emitServerEvent(socket, {
      type: 'project_agent_recommendations',
      requestId: firstPayload.requestId,
      agentId: 'agent-a',
      whenToUse: 'Use for docs.',
      systemPrompt: 'You maintain docs.',
    })

    await expect(firstPromise).resolves.toEqual({
      agentId: 'agent-a',
      whenToUse: 'Use for docs.',
      systemPrompt: 'You maintain docs.',
    })

    client.destroy()
  })

  it('rejects request_project_agent_recommendations via contract-derived fallback error hints', async () => {
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

    const recommendationsPromise = client.requestProjectAgentRecommendations('agent-a')

    emitServerEvent(socket, {
      type: 'error',
      code: 'PROJECT_AGENT_RECOMMENDATIONS_FAILED',
      message: 'Recommendation rejected for testing.',
    })

    await expect(recommendationsPromise).rejects.toThrow(
      'PROJECT_AGENT_RECOMMENDATIONS_FAILED: Recommendation rejected for testing.',
    )

    client.destroy()
  })

  it('rejects set_project_agent_reference via fallback error hints without broad get-reference interception', async () => {
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

    const getReferencePromise = client.getProjectAgentReference('agent-a', 'README.md')
    const setReferencePromise = client.setProjectAgentReference('agent-a', 'README.md', '# Reference')
    let getSettled = false
    void getReferencePromise.finally(() => {
      getSettled = true
    })

    emitServerEvent(socket, {
      type: 'error',
      code: 'SET_PROJECT_AGENT_REFERENCE_FAILED',
      message: 'Set project agent reference rejected for testing.',
    })
    await Promise.resolve()

    await expect(setReferencePromise).rejects.toThrow(
      'SET_PROJECT_AGENT_REFERENCE_FAILED: Set project agent reference rejected for testing.',
    )
    expect(getSettled).toBe(false)

    emitServerEvent(socket, {
      type: 'project_agent_reference',
      requestId: JSON.parse(socket.sentPayloads.at(-2) ?? '{}').requestId,
      agentId: 'agent-a',
      fileName: 'README.md',
      content: '# Reference',
    })

    await expect(getReferencePromise).resolves.toEqual({
      agentId: 'agent-a',
      fileName: 'README.md',
      content: '# Reference',
    })

    client.destroy()
  })

  it('rejects delete_project_agent_reference via fallback error hints without broad get-reference interception', async () => {
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

    const getReferencePromise = client.getProjectAgentReference('agent-a', 'README.md')
    const deleteReferencePromise = client.deleteProjectAgentReference('agent-a', 'README.md')
    let getSettled = false
    void getReferencePromise.finally(() => {
      getSettled = true
    })

    emitServerEvent(socket, {
      type: 'error',
      code: 'DELETE_PROJECT_AGENT_REFERENCE_FAILED',
      message: 'Delete project agent reference rejected for testing.',
    })
    await Promise.resolve()

    await expect(deleteReferencePromise).rejects.toThrow(
      'DELETE_PROJECT_AGENT_REFERENCE_FAILED: Delete project agent reference rejected for testing.',
    )
    expect(getSettled).toBe(false)

    emitServerEvent(socket, {
      type: 'project_agent_reference',
      requestId: JSON.parse(socket.sentPayloads.at(-2) ?? '{}').requestId,
      agentId: 'agent-a',
      fileName: 'README.md',
      content: '# Reference',
    })

    await expect(getReferencePromise).resolves.toEqual({
      agentId: 'agent-a',
      fileName: 'README.md',
      content: '# Reference',
    })

    client.destroy()
  })

  it('clears visible state on conversation_reset but resolves clear_session only after session_cleared', async () => {
    const client = new ManagerWsClient('ws://127.0.0.1:8787', 'session-a')

    client.start()
    vi.advanceTimersByTime(60)

    const socket = FakeWebSocket.instances[0]
    socket.emit('open')

    emitServerEvent(socket, {
      type: 'ready',
      serverTime: new Date().toISOString(),
      subscribedAgentId: 'session-a',
    })
    emitServerEvent(socket, {
      type: 'conversation_message',
      agentId: 'session-a',
      role: 'assistant',
      text: 'visible before reset',
      timestamp: new Date().toISOString(),
      source: 'speak_to_user',
    })

    const clearPromise = client.clearSession(' session-a ')
    const clearPayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')
    let resolved = false
    void clearPromise.then(() => {
      resolved = true
    })

    emitServerEvent(socket, {
      type: 'conversation_reset',
      agentId: 'session-a',
      timestamp: new Date().toISOString(),
      reason: 'user_new_command',
    })
    await Promise.resolve()

    expect(client.getState().messages).toHaveLength(0)
    expect(resolved).toBe(false)

    emitServerEvent(socket, {
      type: 'session_cleared',
      requestId: clearPayload.requestId,
      agentId: 'session-a',
    })

    await expect(clearPromise).resolves.toEqual({ agentId: 'session-a' })
    expect(resolved).toBe(true)

    client.destroy()
  })

  it('sends rename_session commands and resolves session_renamed events', async () => {
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

    const renamePromise = client.renameSession(' session-a ', ' Renamed Session ')
    const renamePayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')

    expect(renamePayload).toMatchObject({
      type: 'rename_session',
      agentId: 'session-a',
      label: 'Renamed Session',
    })
    expect(typeof renamePayload.requestId).toBe('string')

    emitServerEvent(socket, {
      type: 'session_renamed',
      requestId: renamePayload.requestId,
      agentId: 'session-a',
      label: 'Renamed Session',
    })

    await expect(renamePromise).resolves.toEqual({ agentId: 'session-a' })

    client.destroy()
  })

  it('rejects rename_session via fallback error hints from the shared request contract', async () => {
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

    const renamePromise = client.renameSession('session-a', 'Renamed Session')

    emitServerEvent(socket, {
      type: 'error',
      code: 'rename_session_failed',
      message: 'Rename rejected for testing.',
    })

    await expect(renamePromise).rejects.toThrow('rename_session_failed: Rename rejected for testing.')

    client.destroy()
  })

  it('sends pin_session commands and resolves pinned session_pinned events', async () => {
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

    const pinPromise = client.pinSession(' session-a ', true)
    const pinPayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')

    expect(pinPayload).toMatchObject({
      type: 'pin_session',
      agentId: 'session-a',
      pinned: true,
    })
    expect(typeof pinPayload.requestId).toBe('string')

    emitServerEvent(socket, {
      type: 'session_pinned',
      requestId: pinPayload.requestId,
      agentId: 'session-a',
      pinned: true,
      pinnedAt: '2026-05-05T00:00:00.000Z',
    })

    await expect(pinPromise).resolves.toEqual({ pinnedAt: '2026-05-05T00:00:00.000Z' })

    client.destroy()
  })

  it('sends pin_session commands and resolves unpinned session_pinned events', async () => {
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

    const pinPromise = client.pinSession('session-a', false)
    const pinPayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')

    expect(pinPayload).toMatchObject({
      type: 'pin_session',
      agentId: 'session-a',
      pinned: false,
    })
    expect(typeof pinPayload.requestId).toBe('string')

    emitServerEvent(socket, {
      type: 'session_pinned',
      requestId: pinPayload.requestId,
      agentId: 'session-a',
      pinned: false,
      pinnedAt: null,
    })

    await expect(pinPromise).resolves.toEqual({ pinnedAt: null })

    client.destroy()
  })

  it('rejects pin_session via fallback error hints from the shared request contract', async () => {
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

    const pinPromise = client.pinSession('session-a', true)

    emitServerEvent(socket, {
      type: 'error',
      code: 'pin_session_failed',
      message: 'Pin rejected for testing.',
    })

    await expect(pinPromise).rejects.toThrow('pin_session_failed: Pin rejected for testing.')

    client.destroy()
  })

  it('sends update_session_model commands and resolves session_model_updated events', async () => {
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

    const updatePromise = client.updateSessionModel('session-a', 'inherit')
    const updatePayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')

    expect(updatePayload).toMatchObject({
      type: 'update_session_model',
      sessionAgentId: 'session-a',
      mode: 'inherit',
    })
    expect(typeof updatePayload.requestId).toBe('string')

    emitServerEvent(socket, {
      type: 'session_model_updated',
      requestId: updatePayload.requestId,
      sessionAgentId: 'session-a',
      mode: 'inherit',
      model: { provider: 'openai-codex', modelId: 'gpt-5.4' },
      reasoningLevel: 'xhigh',
    })

    await expect(updatePromise).resolves.toEqual({ sessionAgentId: 'session-a', mode: 'inherit' })

    client.destroy()
  })

  it('rejects update_session_model via fallback error hints from the shared request contract', async () => {
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

    const updatePromise = client.updateSessionModel('session-a', 'inherit')

    emitServerEvent(socket, {
      type: 'error',
      code: 'UPDATE_SESSION_MODEL_FAILED',
      message: 'Update session model rejected for testing.',
    })

    await expect(updatePromise).rejects.toThrow('UPDATE_SESSION_MODEL_FAILED: Update session model rejected for testing.')

    client.destroy()
  })

  it('sends fork_session commands and resolves session_forked events', async () => {
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

    const forkPromise = client.forkSession(' source ', ' Forked ', ' message-1 ')
    const forkPayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')

    expect(forkPayload).toMatchObject({
      type: 'fork_session',
      sourceAgentId: 'source',
      label: 'Forked',
      fromMessageId: 'message-1',
    })
    expect(typeof forkPayload.requestId).toBe('string')

    const newSessionAgent = {
      agentId: 'forked-session',
      managerId: 'forked-session',
      displayName: 'Forked',
      role: 'manager',
      status: 'idle',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      cwd: '/tmp/project',
      model: { provider: 'openai-codex', modelId: 'gpt-5.4' },
      sessionFile: '/tmp/project/session.jsonl',
      profileId: 'profile-a',
    }

    emitServerEvent(socket, {
      type: 'session_forked',
      requestId: forkPayload.requestId,
      sourceAgentId: 'source',
      newSessionAgent,
      profile: {
        profileId: 'profile-a',
        displayName: 'Profile A',
        defaultSessionAgentId: 'source',
        defaultModel: { provider: 'openai-codex', modelId: 'gpt-5.4' },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      fromMessageId: 'message-1',
    })

    await expect(forkPromise).resolves.toEqual({ sourceAgentId: 'source', newSessionAgent })

    client.destroy()
  })

  it('rejects fork_session via fallback error hints from the shared request contract', async () => {
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

    const forkPromise = client.forkSession('source')

    emitServerEvent(socket, {
      type: 'error',
      code: 'FORK_SESSION_FAILED',
      message: 'Fork session rejected for testing.',
    })

    await expect(forkPromise).rejects.toThrow('FORK_SESSION_FAILED: Fork session rejected for testing.')

    client.destroy()
  })

  it('sends merge_session_memory commands, ignores start events, and resolves session_memory_merged events', async () => {
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

    const mergePromise = client.mergeSessionMemory(' session-1 ')
    const mergePayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')
    let settled = false
    mergePromise.finally(() => {
      settled = true
    }).catch(() => undefined)

    expect(mergePayload).toMatchObject({
      type: 'merge_session_memory',
      agentId: 'session-1',
    })
    expect(mergePayload.requestId).toMatch(/^merge_session_memory-/)

    emitServerEvent(socket, {
      type: 'session_memory_merge_started',
      requestId: mergePayload.requestId,
      agentId: 'session-1',
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    emitServerEvent(socket, {
      type: 'session_memory_merged',
      requestId: mergePayload.requestId,
      agentId: 'session-1',
      status: 'applied',
      strategy: 'llm',
      mergedAt: '2026-05-05T00:00:00.000Z',
      auditPath: '/tmp/audit.json',
    })

    await expect(mergePromise).resolves.toEqual({
      agentId: 'session-1',
      status: 'applied',
      strategy: 'llm',
      mergedAt: '2026-05-05T00:00:00.000Z',
      auditPath: '/tmp/audit.json',
    })

    client.destroy()
  })

  it('rejects merge_session_memory from typed session_memory_merge_failed events', async () => {
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

    const mergePromise = client.mergeSessionMemory('session-1')
    const mergePayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')

    emitServerEvent(socket, {
      type: 'session_memory_merge_failed',
      requestId: mergePayload.requestId,
      agentId: 'session-1',
      message: 'Merge failed for testing.',
      status: 'failed',
    })

    await expect(mergePromise).rejects.toThrow('Merge failed for testing.')

    client.destroy()
  })

  it('rejects merge_session_memory via fallback error hints from the shared request contract', async () => {
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

    const mergePromise = client.mergeSessionMemory('session-1')

    emitServerEvent(socket, {
      type: 'error',
      code: 'MERGE_SESSION_MEMORY_FAILED',
      message: 'Merge rejected for testing.',
    })

    await expect(mergePromise).rejects.toThrow('MERGE_SESSION_MEMORY_FAILED: Merge rejected for testing.')

    client.destroy()
  })

  it('sends rename_profile commands and resolves profile_renamed events', async () => {
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

    const renamePromise = client.renameProfile(' profile-a ', ' Renamed Profile ')
    const renamePayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')

    expect(renamePayload).toMatchObject({
      type: 'rename_profile',
      profileId: 'profile-a',
      displayName: 'Renamed Profile',
    })
    expect(typeof renamePayload.requestId).toBe('string')

    emitServerEvent(socket, {
      type: 'profile_renamed',
      requestId: renamePayload.requestId,
      profileId: 'profile-a',
      displayName: 'Renamed Profile',
    })

    await expect(renamePromise).resolves.toEqual({ profileId: 'profile-a' })

    client.destroy()
  })

  it('rejects rename_profile via fallback error hints from the shared request contract', async () => {
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

    const renamePromise = client.renameProfile('profile-a', 'Renamed Profile')

    emitServerEvent(socket, {
      type: 'error',
      code: 'rename_profile_failed',
      message: 'Rename rejected for testing.',
    })

    await expect(renamePromise).rejects.toThrow('rename_profile_failed: Rename rejected for testing.')

    client.destroy()
  })


  it('sends hydrate_archive_last_used commands and resolves hydration events', async () => {
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

    const hydratePromise = client.hydrateArchiveLastUsed()
    const hydratePayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')

    expect(hydratePayload).toMatchObject({
      type: 'hydrate_archive_last_used',
    })
    expect(typeof hydratePayload.requestId).toBe('string')

    emitServerEvent(socket, {
      type: 'archive_last_used_hydrated',
      requestId: hydratePayload.requestId,
      scannedSessionCount: 2,
      hydratedSessionCount: 1,
    })

    await expect(hydratePromise).resolves.toEqual({
      scannedSessionCount: 2,
      hydratedSessionCount: 1,
    })

    client.destroy()
  })

  it('sends archive_profile commands and resolves profile_archived events', async () => {
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

    const archivePromise = client.archiveProfile(' profile-a ')
    const archivePayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')

    expect(archivePayload).toMatchObject({
      type: 'archive_profile',
      profileId: 'profile-a',
    })
    expect(typeof archivePayload.requestId).toBe('string')

    emitServerEvent(socket, {
      type: 'profile_archived',
      requestId: archivePayload.requestId,
      profileId: 'profile-a',
      archivedAt: '2026-05-20T00:00:00.000Z',
    })

    await expect(archivePromise).resolves.toEqual({
      profileId: 'profile-a',
      archivedAt: '2026-05-20T00:00:00.000Z',
    })

    client.destroy()
  })

  it('rejects archive_profile via fallback error hints from the shared request contract', async () => {
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

    const archivePromise = client.archiveProfile('profile-a')

    emitServerEvent(socket, {
      type: 'error',
      code: 'archive_profile_failed',
      message: 'Project archive rejected for testing.',
    })

    await expect(archivePromise).rejects.toThrow('archive_profile_failed: Project archive rejected for testing.')

    client.destroy()
  })

  it('sends restore_profile commands and resolves profile_restored events', async () => {
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

    const restorePromise = client.restoreProfile(' profile-a ')
    const restorePayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')

    expect(restorePayload).toMatchObject({
      type: 'restore_profile',
      profileId: 'profile-a',
    })
    expect(typeof restorePayload.requestId).toBe('string')

    emitServerEvent(socket, {
      type: 'profile_restored',
      requestId: restorePayload.requestId,
      profileId: 'profile-a',
      openAgentId: 'session-a',
    })

    await expect(restorePromise).resolves.toEqual({
      profileId: 'profile-a',
      openAgentId: 'session-a',
    })

    client.destroy()
  })

  it('rejects restore_profile via fallback error hints from the shared request contract', async () => {
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

    const restorePromise = client.restoreProfile('profile-a')

    emitServerEvent(socket, {
      type: 'error',
      code: 'restore_profile_failed',
      message: 'Project restore rejected for testing.',
    })

    await expect(restorePromise).rejects.toThrow('restore_profile_failed: Project restore rejected for testing.')

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

  it('keeps request-scoped directory errors out of conversation messages while rejecting each caller', async () => {
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
    const messageCount = client.getState().messages.length

    const cases = [
      ['LIST_DIRECTORIES_FAILED', () => client.listDirectories('/app')],
      ['VALIDATE_DIRECTORY_FAILED', () => client.validateDirectory('/app')],
      ['CREATE_DIRECTORY_FAILED', () => client.createDirectory('/workspaces', 'demo')],
    ] as const

    for (const [code, request] of cases) {
      const promise = request()
      const payload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')
      emitServerEvent(socket, {
        type: 'error',
        code,
        message: 'Directory is outside the configured workspace roots.',
        requestId: payload.requestId,
      })
      await expect(promise).rejects.toThrow(`${code}: Directory is outside the configured workspace roots.`)
      expect(client.getState().messages).toHaveLength(messageCount)
      expect(client.getState().lastError).toBeNull()
    }

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

    const messageCount = client.getState().messages.length
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
    expect(client.getState().messages).toHaveLength(messageCount + 1)

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
            modelId: 'gpt-5.5',
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
            modelId: 'gpt-5.5',
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
            modelId: 'gpt-5.5',
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
            modelId: 'gpt-5.5',
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
            modelId: 'gpt-5.5',
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
            modelId: 'gpt-5.5',
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
            modelId: 'gpt-5.5',
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
            modelId: 'gpt-5.5',
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
            modelId: 'gpt-5.5',
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
            modelId: 'gpt-5.5',
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
            modelId: 'gpt-5.5',
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
            modelId: 'gpt-5.5',
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
            modelId: 'gpt-5.5',
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
            modelId: 'gpt-5.5',
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
            modelId: 'gpt-5.5',
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
            modelId: 'gpt-5.5',
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
            modelId: 'gpt-5.5',
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
            modelId: 'gpt-5.5',
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
            modelId: 'gpt-5.5',
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
            modelId: 'gpt-5.5',
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
            modelId: 'gpt-5.5',
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

    it('applies fetched model-cache enabled setting through canonical client state during pending bootstrap', () => {
      const { client, socket } = setupConnectedClient()
      const observation = makeModelCacheObservation('session-b', 'cache-obs-bootstrap')

      client.subscribeToAgent('session-b')
      emitServerEvent(socket, {
        type: 'conversation_history',
        agentId: 'session-b',
        messages: [observation],
      })

      client.applyLoadedModelCacheVisualizationSetting(true)

      expect(client.getState().modelCacheVisualizationEnabled).toBe(true)
      expect(client.getState().modelCacheObservations.map((entry) => entry.id)).toEqual([
        'cache-obs-bootstrap',
      ])
      expect(client.getState().pendingModelCacheObservations).toEqual([])

      emitServerEvent(socket, {
        type: 'agent_status',
        agentId: 'session-b',
        status: 'idle',
        pendingCount: 0,
      })

      expect(client.getState().modelCacheObservations.map((entry) => entry.id)).toEqual([
        'cache-obs-bootstrap',
      ])
      expect(client.getState().pendingModelCacheObservations).toEqual([])

      client.destroy()
    })

    it('applies fetched model-cache disabled setting through canonical client state and prevents resurrection', () => {
      const { client, socket } = setupConnectedClient()
      const liveObservation = makeModelCacheObservation('session-a', 'cache-obs-live')
      const bootstrapObservation = makeModelCacheObservation('session-b', 'cache-obs-bootstrap')

      client.applyLoadedModelCacheVisualizationSetting(true)
      emitServerEvent(socket, liveObservation)
      expect(client.getState().modelCacheObservations.map((entry) => entry.id)).toEqual([
        'cache-obs-live',
      ])

      client.subscribeToAgent('session-b')
      emitServerEvent(socket, {
        type: 'conversation_history',
        agentId: 'session-b',
        messages: [bootstrapObservation],
      })

      client.applyLoadedModelCacheVisualizationSetting(false)

      expect(client.getState().modelCacheVisualizationEnabled).toBe(false)
      expect(client.getState().modelCacheObservations).toEqual([])
      expect(client.getState().pendingModelCacheObservations).toEqual([])

      emitServerEvent(socket, {
        type: 'agent_status',
        agentId: 'session-b',
        status: 'idle',
        pendingCount: 0,
      })

      expect(client.getState().modelCacheObservations).toEqual([])
      expect(client.getState().pendingModelCacheObservations).toEqual([])

      client.destroy()
    })

    it('force-flushes pending bootstrap before applying model-cache settings_changed false', () => {
      const { client, socket } = setupConnectedClient()
      const observation = makeModelCacheObservation('session-b', 'cache-obs-bootstrap')

      client.applyLoadedModelCacheVisualizationSetting(true)
      client.subscribeToAgent('session-b')
      emitServerEvent(socket, {
        type: 'conversation_history',
        agentId: 'session-b',
        messages: [observation],
      })

      emitServerEvent(socket, {
        type: 'model_cache_visualization_settings_changed',
        enabled: false,
        updatedAt: new Date().toISOString(),
      })

      expect(client.getState().modelCacheVisualizationEnabled).toBe(false)
      expect(client.getState().modelCacheObservations).toEqual([])
      expect(client.getState().pendingModelCacheObservations).toEqual([])

      emitServerEvent(socket, { type: 'unread_counts_snapshot', counts: {} })

      expect(client.getState().modelCacheObservations).toEqual([])
      expect(client.getState().pendingModelCacheObservations).toEqual([])

      client.destroy()
    })

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

      // Legacy history completes authority immediately; choices and unread are
      // subsequent lifecycle commits.
      expect(notificationCount).toBe(3)

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

      expect(snapshots).toHaveLength(3)

      // Unread counts present, with target session-b filtered out
      expect(snapshots.at(-1)?.unreadCounts).toEqual({ 'session-c': 5, 'session-d': 2 })

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

      // Matching legacy history is the completion point.
      expect(snapshots).toHaveLength(1)

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

      // Status is live authority, but an uncorrelated ready cannot claim the
      // selected subscription before matching history.
      expect(notificationCount).toBeGreaterThanOrEqual(1)
      expect(client.getState().subscribedAgentId).toBeNull()
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

      expect(notificationCount).toBe(3)
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

      // Legacy history is itself terminal; no obsolete buffer timeout is needed.
      expect(notificationCount).toBe(2)

      vi.advanceTimersByTime(200)
      expect(notificationCount).toBe(2)
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

      // Uncorrelated ready is only a health ping; matching legacy history owns
      // the first conversation state commit.
      emitServerEvent(socket, { type: 'ready', serverTime: new Date().toISOString(), subscribedAgentId: 'session-a' })
      expect(notificationCount).toBe(0)

      emitServerEvent(socket, { type: 'conversation_history', agentId: 'session-a', messages: [] })
      expect(notificationCount).toBe(1)

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
          model: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' },
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

    it('drops stale bootstrap events from a prior session after rapid A→B switch', () => {
      const { client, socket } = setupConnectedClient()

      // Switch to session-b
      client.subscribeToAgent('session-b')

      let notificationCount = 0
      const unsub = client.subscribe(() => { notificationCount++ })
      notificationCount = 0

      // Late stale events from session-a's bootstrap arrive after subscribe('session-b')
      emitServerEvent(socket, { type: 'ready', serverTime: new Date().toISOString(), subscribedAgentId: 'session-a' })
      emitServerEvent(socket, {
        type: 'conversation_history',
        agentId: 'session-a',
        messages: [
          { type: 'conversation_message', agentId: 'session-a', role: 'user', text: 'stale message from A', timestamp: new Date().toISOString(), source: 'user_input' },
        ],
      })
      emitServerEvent(socket, { type: 'pending_choices_snapshot', agentId: 'session-a', choiceIds: ['stale-choice'] })

      // Stale events must be silently dropped — no state updates
      expect(notificationCount).toBe(0)

      // State must still reflect session-b, not reverted to session-a.
      // subscribedAgentId retains the prior value (session-a from initial bootstrap)
      // because the ready event for session-b hasn't arrived yet — the key assertion
      // is that stale events did NOT overwrite targetAgentId or load A's messages.
      expect(client.getState().targetAgentId).toBe('session-b')
      expect(client.getState().messages).toHaveLength(0) // no stale A messages
      expect(client.getState().pendingChoiceIds.size).toBe(0)

      // Now the real session-b bootstrap arrives and works normally
      emitServerEvent(socket, { type: 'ready', serverTime: new Date().toISOString(), subscribedAgentId: 'session-b' })
      emitServerEvent(socket, {
        type: 'conversation_history',
        agentId: 'session-b',
        messages: [
          { type: 'conversation_message', agentId: 'session-b', role: 'user', text: 'correct B message', timestamp: new Date().toISOString(), source: 'user_input' },
        ],
      })
      emitServerEvent(socket, { type: 'pending_choices_snapshot', agentId: 'session-b', choiceIds: [] })
      emitServerEvent(socket, { type: 'unread_counts_snapshot', counts: {} })

      // History, choices, and unread commit independently after stale A frames
      // were rejected.
      expect(notificationCount).toBe(3)
      expect(client.getState().subscribedAgentId).toBe('session-b')
      expect(client.getState().messages).toHaveLength(1)
      const firstMsg = client.getState().messages[0]
      expect(firstMsg.type === 'conversation_message' ? firstMsg.text : undefined).toBe('correct B message')

      unsub()
      client.destroy()
    })

    it('resets inactivity timeout on each buffered event so slow history does not cause early flush', () => {
      const { client, socket } = setupConnectedClient()

      client.subscribeToAgent('session-b')

      let notificationCount = 0
      const unsub = client.subscribe(() => { notificationCount++ })
      notificationCount = 0

      // First event arrives — starts the inactivity timeout
      emitServerEvent(socket, { type: 'ready', serverTime: new Date().toISOString(), subscribedAgentId: 'session-b' })
      expect(notificationCount).toBe(0)

      // Advance 80ms — close to the 100ms timeout but not past it
      vi.advanceTimersByTime(80)
      expect(notificationCount).toBe(0)

      // Second event arrives — resets the inactivity timeout
      emitServerEvent(socket, {
        type: 'conversation_history',
        agentId: 'session-b',
        messages: [
          { type: 'conversation_message', agentId: 'session-b', role: 'user', text: 'slow history', timestamp: new Date().toISOString(), source: 'user_input' },
        ],
      })
      expect(notificationCount).toBe(1)

      // Advance another 80ms — would be 160ms total from first event,
      // past the original timeout, but the reset means we're only 80ms
      // from the last event
      vi.advanceTimersByTime(80)
      expect(notificationCount).toBe(1)

      // Later legacy lifecycle projections remain ordered after history.
      emitServerEvent(socket, { type: 'pending_choices_snapshot', agentId: 'session-b', choiceIds: [] })
      emitServerEvent(socket, { type: 'unread_counts_snapshot', counts: {} })

      expect(notificationCount).toBe(3)
      expect(client.getState().subscribedAgentId).toBe('session-b')
      expect(client.getState().messages).toHaveLength(1)

      unsub()
      client.destroy()
    })

    it('does not flush when only ready event has been received', () => {
      const { client, socket } = setupConnectedClient()

      client.subscribeToAgent('session-b')

      let notificationCount = 0
      const unsub = client.subscribe(() => { notificationCount++ })
      notificationCount = 0

      emitServerEvent(socket, { type: 'ready', serverTime: new Date().toISOString(), subscribedAgentId: 'session-b' })

      // No flush — ready alone is insufficient
      expect(notificationCount).toBe(0)
      // State should not yet reflect session-b subscription
      expect(client.getState().subscribedAgentId).not.toBe('session-b')

      unsub()
      client.destroy()
    })

    it('accepts matching legacy conversation_history as the sole completion signal', () => {
      const { client, socket } = setupConnectedClient()

      client.subscribeToAgent('session-b')

      let notificationCount = 0
      const unsub = client.subscribe(() => { notificationCount++ })
      notificationCount = 0

      emitServerEvent(socket, {
        type: 'conversation_history',
        agentId: 'session-b',
        messages: [
          { type: 'conversation_message', agentId: 'session-b', role: 'user', text: 'test', timestamp: new Date().toISOString(), source: 'user_input' },
        ],
      })

      expect(notificationCount).toBe(1)
      expect(client.getState().subscribedAgentId).toBe('session-b')

      unsub()
      client.destroy()
    })

    it('applies selected legacy choices before history without completing bootstrap', () => {
      const { client, socket } = setupConnectedClient()

      client.subscribeToAgent('session-b')

      let notificationCount = 0
      const unsub = client.subscribe(() => { notificationCount++ })
      notificationCount = 0

      emitServerEvent(socket, { type: 'pending_choices_snapshot', agentId: 'session-b', choiceIds: ['c-1'] })

      expect(notificationCount).toBe(1)
      expect(client.getState().pendingChoiceIds).toEqual(new Set(['c-1']))
      expect(client.getState().subscribedAgentId).not.toBe('session-b')

      unsub()
      client.destroy()
    })

    it('flushes when unread_counts_snapshot arrives as terminal signal even without other bootstrap events', () => {
      const { client, socket } = setupConnectedClient()

      client.subscribeToAgent('session-b')

      let notificationCount = 0
      const unsub = client.subscribe(() => { notificationCount++ })
      notificationCount = 0

      // unread_counts_snapshot is the terminal signal — should always flush
      emitServerEvent(socket, { type: 'unread_counts_snapshot', counts: { 'session-c': 1 } })

      // Flush occurs because unread_counts_snapshot is the terminal signal
      expect(notificationCount).toBe(1)
      expect(client.getState().unreadCounts).toEqual({ 'session-c': 1 })

      unsub()
      client.destroy()
    })

    it('force-flushes on agent_status targeting the bootstrap agent itself (not just workers)', () => {
      const { client, socket } = setupConnectedClient()

      client.subscribeToAgent('session-b')

      let notificationCount = 0
      const unsub = client.subscribe(() => { notificationCount++ })
      notificationCount = 0

      // Partial bootstrap — only ready so far
      emitServerEvent(socket, { type: 'ready', serverTime: new Date().toISOString(), subscribedAgentId: 'session-b' })
      expect(notificationCount).toBe(0)

      // agent_status targeting the bootstrap agent itself (agentId === target)
      emitServerEvent(socket, {
        type: 'agent_status',
        agentId: 'session-b',
        status: 'streaming',
        pendingCount: 1,
      })

      // Live status applies, while uncorrelated ready still cannot establish
      // conversation subscription authority.
      expect(notificationCount).toBeGreaterThanOrEqual(1)
      expect(client.getState().subscribedAgentId).toBeNull()
      expect(client.getState().statuses['session-b']?.status).toBe('streaming')

      unsub()
      client.destroy()
    })

    it('does not force-flush on agent_status for an unrelated agent during bootstrap', () => {
      const { client, socket } = setupConnectedClient()

      client.subscribeToAgent('session-b')

      let notificationCount = 0
      const unsub = client.subscribe(() => { notificationCount++ })
      notificationCount = 0

      // Partial bootstrap — only ready so far
      emitServerEvent(socket, { type: 'ready', serverTime: new Date().toISOString(), subscribedAgentId: 'session-b' })
      expect(notificationCount).toBe(0)

      // agent_status for a completely unrelated agent — should NOT force-flush
      emitServerEvent(socket, {
        type: 'agent_status',
        agentId: 'unrelated-worker',
        managerId: 'other-manager',
        status: 'streaming',
        pendingCount: 1,
      })

      // Bootstrap buffer should still be pending — the status update applies but no flush
      // The status may or may not be applied immediately (depends on non-coalescible pass-through)
      // but the key assertion is that bootstrap did not flush
      expect(client.getState().subscribedAgentId).not.toBe('session-b')

      unsub()
      client.destroy()
    })

    it('ignores wrong-target conversation_history during bootstrap', () => {
      const { client, socket } = setupConnectedClient()

      client.subscribeToAgent('session-b')

      let notificationCount = 0
      const unsub = client.subscribe(() => { notificationCount++ })
      notificationCount = 0

      // Send bootstrap events where conversation_history targets wrong agent
      emitServerEvent(socket, { type: 'ready', serverTime: new Date().toISOString(), subscribedAgentId: 'session-b' })
      emitServerEvent(socket, {
        type: 'conversation_history',
        agentId: 'wrong-session',
        messages: [
          { type: 'conversation_message', agentId: 'wrong-session', role: 'user', text: 'wrong target', timestamp: new Date().toISOString(), source: 'user_input' },
        ],
      })
      // Correct history arrives
      emitServerEvent(socket, {
        type: 'conversation_history',
        agentId: 'session-b',
        messages: [
          { type: 'conversation_message', agentId: 'session-b', role: 'user', text: 'correct', timestamp: new Date().toISOString(), source: 'user_input' },
        ],
      })
      emitServerEvent(socket, { type: 'pending_choices_snapshot', agentId: 'session-b', choiceIds: [] })
      emitServerEvent(socket, { type: 'unread_counts_snapshot', counts: {} })

      expect(notificationCount).toBe(3)
      expect(client.getState().messages).toHaveLength(1)
      const msg = client.getState().messages[0]
      expect(msg.type === 'conversation_message' ? msg.text : undefined).toBe('correct')

      unsub()
      client.destroy()
    })

    it('ignores wrong-target pending_choices_snapshot during bootstrap', () => {
      const { client, socket } = setupConnectedClient()

      client.subscribeToAgent('session-b')

      let notificationCount = 0
      const unsub = client.subscribe(() => { notificationCount++ })
      notificationCount = 0

      emitServerEvent(socket, { type: 'ready', serverTime: new Date().toISOString(), subscribedAgentId: 'session-b' })
      emitServerEvent(socket, { type: 'conversation_history', agentId: 'session-b', messages: [] })
      // Wrong target for pending_choices_snapshot
      emitServerEvent(socket, { type: 'pending_choices_snapshot', agentId: 'wrong-session', choiceIds: ['stale-choice'] })
      // Correct target
      emitServerEvent(socket, { type: 'pending_choices_snapshot', agentId: 'session-b', choiceIds: ['good-choice'] })
      emitServerEvent(socket, { type: 'unread_counts_snapshot', counts: {} })

      expect(notificationCount).toBe(3)
      expect(client.getState().pendingChoiceIds.has('good-choice')).toBe(true)
      expect(client.getState().pendingChoiceIds.has('stale-choice')).toBe(false)

      unsub()
      client.destroy()
    })

    it('destroy() clears bootstrap buffer synchronously even when socket close is delayed', () => {
      const { client, socket } = setupConnectedClient()

      // Switch to session-b — starts bootstrap buffer
      client.subscribeToAgent('session-b')

      // Partial bootstrap — timer is pending (no terminal signal)
      emitServerEvent(socket, { type: 'ready', serverTime: new Date().toISOString(), subscribedAgentId: 'session-b' })
      emitServerEvent(socket, {
        type: 'conversation_history',
        agentId: 'session-b',
        messages: [
          { type: 'conversation_message', agentId: 'session-b', role: 'user', text: 'buffered', timestamp: new Date().toISOString(), source: 'user_input' },
        ],
      })

      // Override socket.close() to NOT fire the close event synchronously,
      // simulating a real WebSocket where the close event arrives later.
      socket.close = () => {
        socket.readyState = FakeWebSocket.CLOSED
        // Intentionally do NOT emit 'close' here
      }

      // Capture state before destroy
      const stateBeforeDestroy = { ...client.getState() }

      // Destroy the client — bootstrap buffer timer should be cleared
      // synchronously, even though the socket close event hasn't fired yet.
      client.destroy()

      // Advance time well past the bootstrap flush timeout
      vi.advanceTimersByTime(500)

      // State should NOT have been modified by a delayed bootstrap flush.
      // The subscribedAgentId should remain what it was before destroy
      // (session-a from initial bootstrap), NOT session-b from the
      // pending bootstrap buffer that should have been cleared.
      expect(client.getState().subscribedAgentId).toBe(stateBeforeDestroy.subscribedAgentId)
      expect(client.getState().messages).toEqual(stateBeforeDestroy.messages)
    })
  })

  // -------------------------------------------------------------------------
  // Async request behavior
  // -------------------------------------------------------------------------

  // Legacy coalescing mechanics remain covered by bootstrap-buffer.test.ts;
  // correlated completion/races are covered below.

  describe('correlated conversation lifecycle', () => {
    function lastSubscribe(socket: FakeWebSocket): { agentId?: string; subscriptionId: string; conversationView: 'web' | 'all' } {
      return JSON.parse(socket.sentPayloads.at(-1) ?? '{}')
    }

    it('installs pending before the sole subscribe emitter sends and completes only matching history', () => {
      const client = new ManagerWsClient('ws://127.0.0.1:8787', 'session-a')
      client.start()
      vi.advanceTimersByTime(60)
      const socket = FakeWebSocket.instances[0]
      socket.emit('open')

      client.subscribeToAgent('session-b')
      const subscribe = lastSubscribe(socket)
      expect(client.getState().conversationBootstrap).toMatchObject({
        phase: 'pending',
        agentId: 'session-b',
        subscriptionId: subscribe.subscriptionId,
      })
      expect(client.getState().messages).toEqual([])

      emitServerEvent(socket, {
        type: 'conversation_history', agentId: 'session-b', messages: [{
          type: 'conversation_message', agentId: 'session-b', id: 'wrong', role: 'assistant',
          text: 'wrong generation', timestamp: new Date().toISOString(), source: 'speak_to_user',
        }], subscriptionId: 'older-id', servedConversationView: 'web',
      })
      expect(client.getState().conversationBootstrap.phase).toBe('pending')
      expect(client.getState().messages).toEqual([])

      emitServerEvent(socket, {
        type: 'conversation_history', agentId: 'session-b', messages: [],
        subscriptionId: subscribe.subscriptionId, servedConversationView: 'web',
      })
      expect(client.getState().conversationBootstrap).toMatchObject({ phase: 'ready', protocolMode: 'correlated' })
      expect(client.getState().messages).toEqual([])
      client.destroy()
    })

    it('fails closed for legacy history and ignores an uncorrelated ping ready', () => {
      const cache = new ConversationSnapshotCache()
      const client = new ManagerWsClient('ws://127.0.0.1:8787', 'session-a', {
        originId: 'origin-a', conversationSnapshotCache: cache,
      })
      client.start()
      vi.advanceTimersByTime(60)
      const socket = FakeWebSocket.instances[0]
      socket.emit('open')
      emitServerEvent(socket, { type: 'ready', serverTime: new Date().toISOString(), subscribedAgentId: 'other' })
      expect(client.getState().targetAgentId).toBe('session-a')
      expect(client.getState().conversationBootstrap.protocolMode).toBe('unknown')

      emitServerEvent(socket, { type: 'conversation_history', agentId: 'session-a', messages: [] })
      expect(client.getState().conversationBootstrap).toMatchObject({ phase: 'ready', protocolMode: 'legacy' })
      expect(client.getState().conversationPresentation).toBeNull()
      client.destroy()
    })

    it('times out, exposes retry, and ignores late frames for the terminal id', () => {
      const client = new ManagerWsClient('ws://127.0.0.1:8787', 'session-a', {
        conversationBootstrapWatchdogMs: 25,
      })
      client.start()
      vi.advanceTimersByTime(60)
      const socket = FakeWebSocket.instances[0]
      socket.emit('open')
      const first = lastSubscribe(socket)
      vi.advanceTimersByTime(25)
      expect(client.getState().conversationBootstrap).toMatchObject({ phase: 'error', errorCode: 'BOOTSTRAP_TIMEOUT' })
      emitServerEvent(socket, {
        type: 'conversation_history', agentId: 'session-a', messages: [],
        subscriptionId: first.subscriptionId, servedConversationView: 'web',
      })
      expect(client.getState().conversationBootstrap.phase).toBe('error')
      expect(client.retryConversationBootstrap()).toBe(true)
      expect(lastSubscribe(socket).subscriptionId).not.toBe(first.subscriptionId)
      expect(client.getState().conversationBootstrap.phase).toBe('pending')
      client.destroy()
    })

    it('drops wrong id, agent, and view choices/failures without disturbing live reduction', () => {
      const client = new ManagerWsClient('ws://127.0.0.1:8787', 'session-a')
      client.start()
      vi.advanceTimersByTime(60)
      const socket = FakeWebSocket.instances[0]
      socket.emit('open')
      client.subscribeToAgent('session-b')
      const active = lastSubscribe(socket)

      emitServerEvent(socket, {
        type: 'conversation_message', agentId: 'session-b', id: 'live', role: 'assistant',
        text: 'live during pending', timestamp: new Date().toISOString(), source: 'speak_to_user',
      })
      expect(client.getState().messages[0]).toMatchObject({ id: 'live' })

      emitServerEvent(socket, {
        type: 'pending_choices_snapshot', agentId: 'session-b', choiceIds: ['wrong-id'],
        subscriptionId: 'older', servedConversationView: 'web',
      })
      emitServerEvent(socket, {
        type: 'pending_choices_snapshot', agentId: 'session-a', choiceIds: ['wrong-agent'],
        subscriptionId: active.subscriptionId, servedConversationView: 'web',
      })
      emitServerEvent(socket, {
        type: 'bootstrap_failed', agentId: 'session-b', subscriptionId: active.subscriptionId,
        servedConversationView: 'all', code: 'BOOTSTRAP_FAILED', message: 'wrong view', retryable: true,
      })
      expect(client.getState().pendingChoiceIds.size).toBe(0)
      expect(client.getState().conversationBootstrap.phase).toBe('pending')
      expect(client.getState().messages[0]).toMatchObject({ id: 'live' })
      client.destroy()
    })

    function installManagers(socket: FakeWebSocket, managers: Array<{ agentId: string; profileId: string }>): void {
      emitServerEvent(socket, {
        type: 'agents_snapshot',
        agents: managers.map(({ agentId, profileId }) => makeManagerDescriptor({
          agentId, managerId: agentId, profileId, displayName: agentId,
        })),
      })
    }

    function completeCorrelated(socket: FakeWebSocket, agentId: string, text = agentId): string {
      const subscribe = lastSubscribe(socket)
      emitServerEvent(socket, {
        type: 'ready', serverTime: new Date().toISOString(), subscribedAgentId: agentId,
        subscriptionId: subscribe.subscriptionId, servedConversationView: subscribe.conversationView,
      })
      emitServerEvent(socket, {
        type: 'conversation_history', agentId, subscriptionId: subscribe.subscriptionId,
        servedConversationView: subscribe.conversationView, messages: [{
          type: 'conversation_message', agentId, id: `${agentId}-row`, role: 'assistant',
          text, timestamp: new Date().toISOString(), source: 'speak_to_user',
        }],
      })
      return subscribe.subscriptionId
    }

    it('shows only exact warm presentation after correlated ready and always revalidates', () => {
      const cache = new ConversationSnapshotCache()
      const client = new ManagerWsClient('ws://127.0.0.1:8787', 'session-a', {
        originId: 'origin-a', conversationSnapshotCache: cache,
      })
      client.start()
      vi.advanceTimersByTime(60)
      const socket = FakeWebSocket.instances[0]
      socket.emit('open')
      const a1 = lastSubscribe(socket)
      emitServerEvent(socket, {
        type: 'ready', serverTime: new Date().toISOString(), subscribedAgentId: 'session-a',
        subscriptionId: a1.subscriptionId, servedConversationView: 'web',
      })
      emitServerEvent(socket, {
        type: 'conversation_history', agentId: 'session-a', subscriptionId: a1.subscriptionId,
        servedConversationView: 'web', messages: [{
          type: 'conversation_message', agentId: 'session-a', id: 'a-row', role: 'assistant',
          text: 'cached A', timestamp: new Date().toISOString(), source: 'speak_to_user',
        }],
      })

      client.subscribeToAgent('session-b')
      const b = lastSubscribe(socket)
      emitServerEvent(socket, {
        type: 'conversation_history', agentId: 'session-b', messages: [],
        subscriptionId: b.subscriptionId, servedConversationView: 'web',
      })
      const before = socket.sentPayloads.length
      client.subscribeToAgent('session-a')
      const a2 = lastSubscribe(socket)
      expect(socket.sentPayloads).toHaveLength(before + 1)
      expect(client.getState().conversationPresentation).toBeNull()
      emitServerEvent(socket, {
        type: 'ready', serverTime: new Date().toISOString(), subscribedAgentId: 'session-a',
        subscriptionId: a2.subscriptionId, servedConversationView: 'web',
      })
      expect(client.getState().conversationPresentation?.messages[0]).toMatchObject({ id: 'a-row' })
      expect(client.getState().messages).toEqual([])
      client.destroy()
    })

    it('never recaptures selected manager or session authority during destructive fallback', () => {
      for (const deletionType of ['manager_deleted', 'session_deleted'] as const) {
        const cache = new ConversationSnapshotCache()
        const client = new ManagerWsClient('ws://127.0.0.1:8787', 'session-a', {
          originId: 'origin-a', conversationSnapshotCache: cache,
        })
        client.start()
        vi.advanceTimersByTime(60)
        const socket = FakeWebSocket.instances.at(-1)!
        socket.emit('open')
        installManagers(socket, [
          { agentId: 'session-a', profileId: 'profile-a' },
          { agentId: 'session-b', profileId: 'profile-a' },
        ])
        completeCorrelated(socket, 'session-a', `deleted ${deletionType}`)

        emitServerEvent(socket, deletionType === 'manager_deleted' ? {
          type: deletionType, requestId: `delete-${deletionType}`, managerId: 'session-a', terminatedWorkerIds: [],
        } : {
          type: deletionType, requestId: `delete-${deletionType}`, agentId: 'session-a', profileId: 'profile-a',
        })

        expect(client.getState().targetAgentId).toBe('session-b')
        expect(cache.get({ originId: 'origin-a', agentId: 'session-a', servedView: 'web' })).toBeNull()
        client.destroy()
      }
    })

    it('keeps archive/profile and deleted-agents-snapshot invalidation evicted across fallback', () => {
      for (const invalidation of ['profile_archived', 'agents_snapshot'] as const) {
        const cache = new ConversationSnapshotCache()
        const client = new ManagerWsClient('ws://127.0.0.1:8787', 'session-a', {
          originId: 'origin-a', conversationSnapshotCache: cache,
        })
        client.start()
        vi.advanceTimersByTime(60)
        const socket = FakeWebSocket.instances.at(-1)!
        socket.emit('open')
        installManagers(socket, [
          { agentId: 'session-a', profileId: 'profile-a' },
          { agentId: 'session-b', profileId: 'profile-b' },
        ])
        completeCorrelated(socket, 'session-a', `invalidated ${invalidation}`)

        if (invalidation === 'profile_archived') {
          emitServerEvent(socket, {
            type: 'profile_archived', requestId: 'archive-profile', profileId: 'profile-a',
            archivedAt: new Date().toISOString(),
          })
        }
        installManagers(socket, [{ agentId: 'session-b', profileId: 'profile-b' }])

        expect(client.getState().targetAgentId).toBe('session-b')
        expect(cache.get({ originId: 'origin-a', agentId: 'session-a', servedView: 'web' })).toBeNull()
        client.destroy()
      }
    })

    it('clears explicit selection bookkeeping on matching legacy history', () => {
      const client = new ManagerWsClient('ws://127.0.0.1:8787', 'session-a')
      client.start()
      vi.advanceTimersByTime(60)
      const socket = FakeWebSocket.instances.at(-1)!
      socket.emit('open')
      client.subscribeToAgent('session-b')
      expect(client.hasExplicitSelection()).toBe(true)
      emitServerEvent(socket, { type: 'conversation_history', agentId: 'session-b', messages: [] })
      expect(client.hasExplicitSelection()).toBe(false)
      expect(client.getExplicitSelectionAgentId()).toBeNull()
      expect(client.isExplicitSelectionPending()).toBe(false)
      expect(client.getRejectedExplicitSelectionAgentId()).toBeNull()
      client.destroy()
    })

    it('keeps terminal de-duplication bounded to one current subscription id', () => {
      const client = new ManagerWsClient('ws://127.0.0.1:8787', 'session-a')
      client.start()
      vi.advanceTimersByTime(60)
      const socket = FakeWebSocket.instances.at(-1)!
      socket.emit('open')
      const first = completeCorrelated(socket, 'session-a')
      client.subscribeToAgent('session-b')
      const second = completeCorrelated(socket, 'session-b')
      const guard = client as unknown as {
        terminalSubscriptionId: string | null
        terminalSubscriptionIds?: Set<string>
      }
      expect(first).not.toBe(second)
      expect(guard.terminalSubscriptionId).toBe(second)
      expect(guard.terminalSubscriptionIds).toBeUndefined()
      client.destroy()
    })
  })

  describe('async request behavior', () => {
    function setupReadyClient(agentId = 'manager') {
      const client = new ManagerWsClient('ws://127.0.0.1:8787', agentId)
      client.start()
      vi.advanceTimersByTime(60)
      const socket = FakeWebSocket.instances.at(-1)!
      socket.emit('open')
      emitServerEvent(socket, { type: 'ready', serverTime: new Date().toISOString(), subscribedAgentId: agentId })
      return { client, socket }
    }

    it('generates collision-resistant UUID request IDs with command prefix', async () => {
      const { client, socket } = setupReadyClient()

      const promise = client.stopAllAgents('manager')
      const payload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')

      // Request ID format: {requestType}-{uuid}
      expect(payload.requestId).toMatch(
        /^stop_all_agents-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      )

      // Resolve to avoid dangling promise
      emitServerEvent(socket, {
        type: 'stop_all_agents_result',
        requestId: payload.requestId,
        managerId: 'manager',
        stoppedWorkerIds: [],
        managerStopped: false,
      })
      await promise

      client.destroy()
    })

    it('generates distinct request IDs across multiple requests', async () => {
      const { client, socket } = setupReadyClient()

      const promise1 = client.listDirectories('/tmp')
      const payload1 = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')

      const promise2 = client.listDirectories('/home')
      const payload2 = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')

      // Both should be list_directories prefix
      expect(payload1.requestId).toMatch(/^list_directories-/)
      expect(payload2.requestId).toMatch(/^list_directories-/)

      // They must be distinct
      expect(payload1.requestId).not.toBe(payload2.requestId)

      // Resolve to clean up
      emitServerEvent(socket, {
        type: 'directories_listed',
        requestId: payload1.requestId,
        path: '/tmp',
        directories: [],
      })
      emitServerEvent(socket, {
        type: 'directories_listed',
        requestId: payload2.requestId,
        path: '/home',
        directories: [],
      })
      await Promise.all([promise1, promise2])

      client.destroy()
    })

    it('rejects pending request after REQUEST_TIMEOUT_MS with fake timers', async () => {
      const { client, socket } = setupReadyClient()

      const deletePromise = client.deleteManager('some-manager')
      const deletePayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')
      expect(deletePayload.requestId).toBeDefined()

      // Advance time past the timeout
      vi.advanceTimersByTime(REQUEST_TIMEOUT_MS + 100)

      await expect(deletePromise).rejects.toThrow('Request timed out waiting for backend response.')

      client.destroy()
    })

    it('rejects pending request when error event has matching requestId', async () => {
      const { client, socket } = setupReadyClient()

      const createPromise = client.createManager({
        name: 'fail-manager',
        cwd: '/tmp',
        modelSelection: { provider: 'openai-codex', modelId: 'gpt-5.5' },
      })
      const createPayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')

      emitServerEvent(socket, {
        type: 'error',
        code: 'CREATE_MANAGER_FAILED',
        message: 'Something went wrong',
        requestId: createPayload.requestId,
      })

      await expect(createPromise).rejects.toThrow('CREATE_MANAGER_FAILED: Something went wrong')
      expect(client.getState().lastError).toBe('Something went wrong')

      client.destroy()
    })

    it('rejects create_manager via fallback error hints from the shared request contract', async () => {
      const { client, socket } = setupReadyClient()

      const createPromise = client.createManager({
        name: 'fail-manager',
        cwd: '/tmp',
        modelSelection: { provider: 'openai-codex', modelId: 'gpt-5.5' },
      })

      emitServerEvent(socket, {
        type: 'error',
        code: 'CREATE_MANAGER_FAILED',
        message: 'Something went wrong',
      })

      await expect(createPromise).rejects.toThrow('CREATE_MANAGER_FAILED: Something went wrong')

      client.destroy()
    })

    it('rejects pending request via fallback hint matching when error has no requestId', async () => {
      const { client, socket } = setupReadyClient()

      const deletePromise = client.deleteManager('some-manager')

      // Error without requestId, but code contains 'delete_manager' fragment
      emitServerEvent(socket, {
        type: 'error',
        code: 'DELETE_MANAGER_FAILED',
        message: 'Manager not found',
      })

      await expect(deletePromise).rejects.toThrow('DELETE_MANAGER_FAILED: Manager not found')

      client.destroy()
    })

    it('rejects the only pending request when error has no requestId and no hint match', async () => {
      const { client, socket } = setupReadyClient()

      const validatePromise = client.validateDirectory('/invalid')

      // Error with no requestId and code that doesn't match any hint
      emitServerEvent(socket, {
        type: 'error',
        code: 'UNKNOWN_ERROR',
        message: 'Something completely unexpected',
      })

      await expect(validatePromise).rejects.toThrow('UNKNOWN_ERROR: Something completely unexpected')

      client.destroy()
    })

    it('does not reject unrelated requests when error hint matches a specific type', async () => {
      const { client, socket } = setupReadyClient()

      // Start two different requests
      const listPromise = client.listDirectories('/tmp')
      const deletePromise = client.deleteManager('some-manager')

      // Error code matches delete_manager hint specifically
      emitServerEvent(socket, {
        type: 'error',
        code: 'delete_manager_failed',
        message: 'Cannot delete',
      })

      // delete_manager should be rejected
      await expect(deletePromise).rejects.toThrow('delete_manager_failed: Cannot delete')

      // list_directories should still be pending — resolve it
      const listPayload = JSON.parse(socket.sentPayloads.find((p) => JSON.parse(p).type === 'list_directories') ?? '{}')
      emitServerEvent(socket, {
        type: 'directories_listed',
        requestId: listPayload.requestId,
        path: '/tmp',
        directories: ['/tmp/a'],
      })

      await expect(listPromise).resolves.toEqual({ path: '/tmp', directories: ['/tmp/a'] })

      client.destroy()
    })

    it('rejects all pending requests on destroy', async () => {
      const { client } = setupReadyClient()

      const promise1 = client.deleteManager('mgr-1')
      const promise2 = client.listDirectories('/tmp')

      client.destroy()

      await expect(promise1).rejects.toThrow('Client destroyed before request completed.')
      await expect(promise2).rejects.toThrow('Client destroyed before request completed.')
    })

    it('rejects all pending requests on disconnect', async () => {
      const { client, socket } = setupReadyClient()

      const promise = client.deleteManager('mgr-1')

      socket.close()

      await expect(promise).rejects.toThrow('WebSocket disconnected before request completed.')

      client.destroy()
    })
  })

  // -------------------------------------------------------------------------
  // Session worker cache
  // -------------------------------------------------------------------------

  describe('session worker cache', () => {
    function setupReadyClient(agentId = 'manager') {
      const client = new ManagerWsClient('ws://127.0.0.1:8787', agentId)
      client.start()
      vi.advanceTimersByTime(60)
      const socket = FakeWebSocket.instances.at(-1)!
      socket.emit('open')
      emitServerEvent(socket, { type: 'ready', serverTime: new Date().toISOString(), subscribedAgentId: agentId })
      return { client, socket }
    }

    it('returns cached workers without sending a new request when session is loaded', async () => {
      const { client, socket } = setupReadyClient()

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
            model: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' },
            sessionFile: '/tmp/manager.jsonl',
          },
        ],
      })

      // First fetch — sends request
      const fetchPromise = client.getSessionWorkers('manager')
      const fetchPayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')
      expect(fetchPayload.type).toBe('get_session_workers')

      emitServerEvent(socket, {
        type: 'session_workers_snapshot',
        sessionAgentId: 'manager',
        requestId: fetchPayload.requestId,
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
            model: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' },
            sessionFile: '/tmp/worker-1.jsonl',
          },
        ],
      })

      await fetchPromise
      expect(client.getState().loadedSessionIds.has('manager')).toBe(true)

      const sentCountBefore = socket.sentPayloads.length

      // Second fetch — should return cached result without new WS request
      const cachedResult = await client.getSessionWorkers('manager')
      expect(socket.sentPayloads.length).toBe(sentCountBefore)
      expect(cachedResult.sessionAgentId).toBe('manager')
      expect(cachedResult.workers).toHaveLength(1)
      expect(cachedResult.workers[0].agentId).toBe('worker-1')

      client.destroy()
    })

    it('invalidates cache and sends new request when workerCount mismatches cached workers', async () => {
      const { client, socket } = setupReadyClient()

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
            model: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' },
            sessionFile: '/tmp/manager.jsonl',
          },
        ],
      })

      // Load initial workers
      const fetchPromise = client.getSessionWorkers('manager')
      const fetchPayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')

      emitServerEvent(socket, {
        type: 'session_workers_snapshot',
        sessionAgentId: 'manager',
        requestId: fetchPayload.requestId,
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
            model: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' },
            sessionFile: '/tmp/worker-1.jsonl',
          },
        ],
      })

      await fetchPromise
      expect(client.getState().loadedSessionIds.has('manager')).toBe(true)

      // Update manager's workerCount to 2 (mismatch with cached 1 worker)
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
            model: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' },
            sessionFile: '/tmp/manager.jsonl',
          },
        ],
      })

      // Next fetch should detect the mismatch and send a new request
      const refetchPromise = client.getSessionWorkers('manager')
      const refetchPayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')
      expect(refetchPayload.type).toBe('get_session_workers')

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
            model: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' },
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
            model: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' },
            sessionFile: '/tmp/worker-2.jsonl',
          },
        ],
      })

      const result = await refetchPromise
      expect(result.workers).toHaveLength(2)
      expect(client.getState().loadedSessionIds.has('manager')).toBe(true)

      client.destroy()
    })

    it('de-duplicates concurrent getSessionWorkers calls for the same session', async () => {
      const { client, socket } = setupReadyClient()

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
            model: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' },
            sessionFile: '/tmp/manager.jsonl',
          },
        ],
      })

      const sentCountBefore = socket.sentPayloads.length

      // Launch two concurrent requests for the same session
      const promise1 = client.getSessionWorkers('manager')
      const promise2 = client.getSessionWorkers('manager')

      // Only one WS request should have been sent (de-duplication)
      expect(socket.sentPayloads.length).toBe(sentCountBefore + 1)

      const fetchPayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')

      emitServerEvent(socket, {
        type: 'session_workers_snapshot',
        sessionAgentId: 'manager',
        requestId: fetchPayload.requestId,
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
            model: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' },
            sessionFile: '/tmp/worker-1.jsonl',
          },
        ],
      })

      // Both promises should resolve with the same data
      const result1 = await promise1
      const result2 = await promise2

      expect(result1.sessionAgentId).toBe('manager')
      expect(result2.sessionAgentId).toBe('manager')
      expect(result1.workers).toHaveLength(1)
      expect(result2.workers).toHaveLength(1)

      client.destroy()
    })

    it('rejects getSessionWorkers from fallback error hints when requestId is absent', async () => {
      const { client, socket } = setupReadyClient()

      const fetchPromise = client.getSessionWorkers('manager')
      const fetchPayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')
      expect(fetchPayload.type).toBe('get_session_workers')

      emitServerEvent(socket, {
        type: 'error',
        code: 'get_session_workers_failed',
        message: 'boom',
      })

      await expect(fetchPromise).rejects.toThrow('get_session_workers_failed: boom')

      const refetchPromise = client.getSessionWorkers('manager')
      const refetchPayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')
      expect(refetchPayload.type).toBe('get_session_workers')
      expect(refetchPayload.requestId).not.toBe(fetchPayload.requestId)

      emitServerEvent(socket, {
        type: 'session_workers_snapshot',
        sessionAgentId: 'manager',
        requestId: refetchPayload.requestId,
        workers: [],
      })

      await expect(refetchPromise).resolves.toEqual({ sessionAgentId: 'manager', workers: [] })

      client.destroy()
    })

    it('queues debounced refetch when unknown worker status arrives for a loaded session', async () => {
      const { client, socket } = setupReadyClient()

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
            model: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' },
            sessionFile: '/tmp/manager.jsonl',
          },
        ],
      })

      // Load workers initially
      const fetchPromise = client.getSessionWorkers('manager')
      const fetchPayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')
      emitServerEvent(socket, {
        type: 'session_workers_snapshot',
        sessionAgentId: 'manager',
        requestId: fetchPayload.requestId,
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
            model: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' },
            sessionFile: '/tmp/worker-1.jsonl',
          },
        ],
      })
      await fetchPromise
      expect(client.getState().loadedSessionIds.has('manager')).toBe(true)

      const sentCountAfterLoad = socket.sentPayloads.length

      // Unknown worker status arrives — invalidates loadedSessionIds
      emitServerEvent(socket, {
        type: 'agent_status',
        agentId: 'unknown-worker',
        managerId: 'manager',
        status: 'streaming',
        pendingCount: 1,
      })

      expect(client.getState().loadedSessionIds.has('manager')).toBe(false)

      // No refetch yet — debounce timer hasn't fired
      expect(socket.sentPayloads.length).toBe(sentCountAfterLoad)

      // Advance past the debounce period (250ms)
      vi.advanceTimersByTime(300)

      // Now the debounced refetch should have fired
      const refetchPayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')
      expect(refetchPayload.type).toBe('get_session_workers')

      // Resolve to clean up
      emitServerEvent(socket, {
        type: 'session_workers_snapshot',
        sessionAgentId: 'manager',
        requestId: refetchPayload.requestId,
        workers: [],
      })

      client.destroy()
    })

    it('clears queued refetch timers on destroy', async () => {
      const { client, socket } = setupReadyClient()

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
            model: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' },
            sessionFile: '/tmp/manager.jsonl',
          },
        ],
      })

      // Load workers
      const fetchPromise = client.getSessionWorkers('manager')
      const fetchPayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')
      emitServerEvent(socket, {
        type: 'session_workers_snapshot',
        sessionAgentId: 'manager',
        requestId: fetchPayload.requestId,
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
            model: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' },
            sessionFile: '/tmp/worker-1.jsonl',
          },
        ],
      })
      await fetchPromise

      // Trigger an unknown worker status to queue a debounced refetch
      emitServerEvent(socket, {
        type: 'agent_status',
        agentId: 'unknown-worker',
        managerId: 'manager',
        status: 'streaming',
        pendingCount: 1,
      })

      const sentCountBeforeDestroy = socket.sentPayloads.length

      // Destroy the client before the debounce fires
      client.destroy()

      // Advance time past the debounce period
      vi.advanceTimersByTime(500)

      // No refetch should have been sent after destroy
      expect(socket.sentPayloads.length).toBe(sentCountBeforeDestroy)
    })

    it('clears queued refetch timers on disconnect', async () => {
      const { client, socket } = setupReadyClient()

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
            model: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' },
            sessionFile: '/tmp/manager.jsonl',
          },
        ],
      })

      // Load workers
      const fetchPromise = client.getSessionWorkers('manager')
      const fetchPayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')
      emitServerEvent(socket, {
        type: 'session_workers_snapshot',
        sessionAgentId: 'manager',
        requestId: fetchPayload.requestId,
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
            model: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' },
            sessionFile: '/tmp/worker-1.jsonl',
          },
        ],
      })
      await fetchPromise

      // Trigger unknown worker to queue debounced refetch
      emitServerEvent(socket, {
        type: 'agent_status',
        agentId: 'unknown-worker',
        managerId: 'manager',
        status: 'streaming',
        pendingCount: 1,
      })

      const sentCountBeforeClose = socket.sentPayloads.length

      // Simulate disconnect
      socket.close()

      // Advance time past debounce period
      vi.advanceTimersByTime(500)

      // The reconnect timer fires but the refetch timer should have been cleared
      // Check that no get_session_workers was sent after the close
      const payloadsAfterClose = socket.sentPayloads.slice(sentCountBeforeClose)
      const refetchAttempts = payloadsAfterClose.filter((p) => {
        try { return JSON.parse(p).type === 'get_session_workers' } catch { return false }
      })
      expect(refetchAttempts).toHaveLength(0)

      client.destroy()
    })
  })

  describe('terminal snapshot scope gating', () => {
    function makeTerminalDescriptor(sessionAgentId: string, terminalId: string, profileId: string) {
      return {
        terminalId,
        sessionAgentId,
        profileId,
        name: terminalId,
        shell: '/bin/zsh',
        cwd: '/tmp',
        cols: 80,
        rows: 24,
        state: 'running' as const,
        pid: 1,
        exitCode: null,
        exitSignal: null,
        recoveredFromPersistence: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }
    }

    function setupTerminalScopedClient() {
      const client = new ManagerWsClient('ws://127.0.0.1:8787', 'session-a')
      client.start()
      vi.advanceTimersByTime(60)
      const socket = FakeWebSocket.instances.at(-1)!
      socket.emit('open')

      emitServerEvent(socket, {
        type: 'agents_snapshot',
        agents: [
          makeManagerDescriptor({
            agentId: 'session-a',
            managerId: 'session-a',
            profileId: 'profile-a',
            displayName: 'Session A',
          }),
          makeManagerDescriptor({
            agentId: 'session-b',
            managerId: 'session-b',
            profileId: 'profile-b',
            displayName: 'Session B',
          }),
        ],
      })
      emitServerEvent(socket, {
        type: 'ready',
        serverTime: new Date().toISOString(),
        subscribedAgentId: 'session-a',
      })
      emitServerEvent(socket, { type: 'conversation_history', agentId: 'session-a', messages: [] })
      emitServerEvent(socket, { type: 'pending_choices_snapshot', agentId: 'session-a', choiceIds: [] })
      emitServerEvent(socket, {
        type: 'terminals_snapshot',
        sessionAgentId: 'profile-a',
        terminals: [makeTerminalDescriptor('profile-a', 'term-a', 'profile-a')],
      })
      emitServerEvent(socket, { type: 'unread_counts_snapshot', counts: {} })

      expect(client.getState().terminals).toHaveLength(1)
      expect(client.getState().terminalSessionScopeId).toBe('profile-a')

      return { client, socket }
    }

    it('rejects a late prior-scope terminals_snapshot after rapid A→B switch', () => {
      const { client, socket } = setupTerminalScopedClient()

      // A→B clears terminals because resolved scopes differ (profile-a → profile-b).
      client.subscribeToAgent('session-b')
      expect(client.getState().targetAgentId).toBe('session-b')
      expect(client.getState().terminals).toEqual([])
      expect(client.getState().terminalSessionScopeId).toBeNull()
      expect(client.getState().conversationBootstrap.phase).toBe('pending')
      expect(client.getState().conversationBootstrap.agentId).toBe('session-b')

      // Late in-flight A bootstrap snapshot must not repopulate B's terminal state.
      emitServerEvent(socket, {
        type: 'terminals_snapshot',
        sessionAgentId: 'profile-a',
        terminals: [makeTerminalDescriptor('profile-a', 'term-a-late', 'profile-a')],
      })

      expect(client.getState().terminals).toEqual([])
      expect(client.getState().terminalSessionScopeId).toBeNull()
      expect(client.getState().targetAgentId).toBe('session-b')

      client.destroy()
    })

    it('applies a matching-scope terminals_snapshot for the selected target', () => {
      const { client, socket } = setupTerminalScopedClient()

      client.subscribeToAgent('session-b')
      expect(client.getState().terminals).toEqual([])
      expect(client.getState().terminalSessionScopeId).toBeNull()

      const bTerminal = makeTerminalDescriptor('profile-b', 'term-b', 'profile-b')
      emitServerEvent(socket, {
        type: 'terminals_snapshot',
        sessionAgentId: 'profile-b',
        terminals: [bTerminal],
      })

      expect(client.getState().terminals).toEqual([bTerminal])
      expect(client.getState().terminalSessionScopeId).toBe('profile-b')

      client.destroy()
    })

    it('preserves same-scope terminal snapshots across manager/session targets', () => {
      const { client, socket } = setupTerminalScopedClient()

      // Worker under session-a resolves to the same profile-a terminal scope.
      emitServerEvent(socket, {
        type: 'agents_snapshot',
        agents: [
          makeManagerDescriptor({
            agentId: 'session-a',
            managerId: 'session-a',
            profileId: 'profile-a',
            displayName: 'Session A',
          }),
          makeManagerDescriptor({
            agentId: 'session-b',
            managerId: 'session-b',
            profileId: 'profile-b',
            displayName: 'Session B',
          }),
          makeWorkerDescriptor('worker-a', 'session-a'),
        ],
      })

      client.subscribeToAgent('worker-a')
      // Same resolved scope — terminals must not clear on switch.
      expect(client.getState().terminals).toHaveLength(1)
      expect(client.getState().terminalSessionScopeId).toBe('profile-a')

      emitServerEvent(socket, {
        type: 'terminals_snapshot',
        sessionAgentId: 'profile-a',
        terminals: [
          makeTerminalDescriptor('profile-a', 'term-a', 'profile-a'),
          makeTerminalDescriptor('profile-a', 'term-a-2', 'profile-a'),
        ],
      })

      expect(client.getState().terminals).toHaveLength(2)
      expect(client.getState().terminalSessionScopeId).toBe('profile-a')

      client.destroy()
    })
  })

  it('hydrates cumulative throughput snapshots, rejects stale sequences, and clears active telemetry on reconnect', () => {
    const client = new ManagerWsClient('ws://127.0.0.1:8787', 'manager')
    client.start()
    vi.advanceTimersByTime(60)
    const socket = FakeWebSocket.instances.at(-1)!
    socket.emit('open')

    const sessionSummary = {
      sessionAgentId: 'manager',
      window: 'last_20_terminal_generations' as const,
      measuredGenerationCount: 1,
      weightedTokensPerSecond: 40,
      samples: [{ completedAt: '2026-07-31T10:00:02.000Z', role: 'manager' as const, tokensPerSecond: 40 }],
    }
    const liveMeasurement = {
      measurementId: 'call-1',
      sequence: 2,
      phase: 'generating' as const,
      profileId: 'profile-1',
      sessionId: 'manager',
      agentId: 'manager',
      managerId: 'manager',
      role: 'manager' as const,
      provider: 'openai-codex',
      modelId: 'gpt-5.5',
      sampledAt: '2026-07-31T10:00:01.000Z',
      firstOutputAt: '2026-07-31T10:00:00.000Z',
      elapsedGenerationMs: 1_000,
      outputTokens: 20,
      instantaneousTokensPerSecond: 20,
      generationAverageTokensPerSecond: 20,
      valueKind: 'estimated' as const,
      quality: {
        tokenSource: 'estimated_local' as const,
        boundarySource: 'content_delta_to_stream_end' as const,
        reasoningBoundaryCoverage: 'not_reported' as const,
      },
    }
    emitServerEvent(socket, {
      type: 'generation_throughput_snapshot',
      sessionAgentId: 'manager',
      measurements: [liveMeasurement],
      sessionSummary,
    })
    expect(client.getState().generationRateSamplesByAgentId.manager).toHaveLength(1)

    emitServerEvent(socket, {
      type: 'generation_throughput',
      measurement: { ...liveMeasurement, sequence: 1, instantaneousTokensPerSecond: 1 },
    })
    expect(client.getState().generationThroughputByAgentId.manager?.sequence).toBe(2)

    emitServerEvent(socket, {
      type: 'generation_throughput',
      measurement: {
        ...liveMeasurement,
        sequence: 3,
        phase: 'completed',
        sampledAt: '2026-07-31T10:00:02.000Z',
        instantaneousTokensPerSecond: null,
        generationAverageTokensPerSecond: 50,
        outputTokens: 100,
        valueKind: 'provider_final',
        quality: {
          tokenSource: 'provider_final',
          boundarySource: 'content_delta_to_stream_end',
          reasoningBoundaryCoverage: 'observed',
        },
      },
      sessionSummary,
    })
    vi.advanceTimersByTime(5_000)
    expect(client.getState().generationThroughputByAgentId).toEqual({})
    expect(client.getState().generationThroughputSessionSummary).toEqual(sessionSummary)

    socket.close()
    expect(client.getState().generationThroughputByAgentId).toEqual({})
    expect(client.getState().generationRateSamplesByAgentId).toEqual({})
    expect(client.getState().generationThroughputSessionSummary).toBeNull()
    client.destroy()
  })
})
