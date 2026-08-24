import { describe, expect, it, vi } from 'vitest'
import type { ServerEvent } from '@forge/protocol'
import type { SidebarPerfRecorder } from '../stats/sidebar-perf-types.js'
import { WsSubscriptions } from '../ws/ws-subscriptions.js'
import { WebSocket } from 'ws'

// The bootstrap send sequence is async and flow-controls bootstrap-critical events (awaits socket
// drain between sends). Fire-and-forget bootstrap paths therefore settle across microtask
// boundaries, so flush the microtask queue before asserting on delivered events.
async function flushMicrotasks(ticks = 20): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    await Promise.resolve()
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

async function waitFor(predicate: () => boolean, timeoutMs = 200): Promise<void> {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for test condition.')
    }
    await delay(1)
  }
}

function createConversationHistory(agentId: string, count: number) {
  return Array.from({ length: count }, (_, index) => ({
    type: 'conversation_message' as const,
    agentId,
    role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
    text: `message-${index + 1}`,
    timestamp: `2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z`,
    source: index % 2 === 0 ? 'user_input' as const : 'system' as const,
  }))
}

function createConversationPage(messages = createConversationHistory('manager', 0)) {
  return {
    messages,
    page: {
      hasOlder: false,
      completeness: 'complete' as const,
      source: 'memory' as const,
      sourceRevision: 'fixture',
      pageBytes: Buffer.byteLength(JSON.stringify(messages), 'utf8'),
      scanBytes: 0,
    },
  }
}

function createPerfStub(): SidebarPerfRecorder {
  return {
    recordDuration: vi.fn(),
    increment: vi.fn(),
    readSummary: vi.fn(() => ({ histograms: {}, counters: {} })),
    readRecentSlowEvents: vi.fn(() => []),
  }
}

function createPlanSnapshotEvent(sessionAgentId: string): Extract<ServerEvent, { type: 'session_plan_snapshot' }> {
  return {
    type: 'session_plan_snapshot',
    sessionAgentId,
    profileId: 'profile-1',
    revision: 0,
    updatedAt: '2026-07-12T00:00:00.000Z',
    plan: [],
    diagnostics: { state: 'defaulted' },
  }
}

function createGoalSnapshotEvent(sessionAgentId: string): Extract<ServerEvent, { type: 'session_goal_snapshot' }> {
  return {
    type: 'session_goal_snapshot',
    sessionAgentId,
    profileId: 'profile-1',
    revision: 0,
    measuredAt: '2026-07-12T00:00:00.000Z',
    goal: null,
  }
}

function createBrowserSessionChangedEvent(sessionAgentId: string): Extract<ServerEvent, { type: 'browser_session_changed' }> {
  const timestamp = '2026-07-12T00:00:00.000Z'
  return {
    type: 'browser_session_changed',
    reason: 'automation',
    snapshot: {
      schemaVersion: 2,
      sessionAgentId,
      profileId: 'profile-1',
      hostingState: 'hosted',
      tabs: [],
      activeTabId: null,
      defaultTabId: null,
      panelVisible: false,
      recentActions: [],
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  }
}

function createManagerStub() {
  let agentsSnapshotVersion = 0
  let profilesSnapshotVersion = 0

  const descriptors = new Map<string, any>([
    ['manager', {
      agentId: 'manager',
      displayName: 'Manager',
      role: 'manager',
      managerId: 'manager',
      profileId: 'profile-1',
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
    }],
    ['session-1', {
      agentId: 'session-1',
      displayName: 'Session 1',
      role: 'manager',
      managerId: 'manager',
      profileId: 'profile-1',
      status: 'idle',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      cwd: '/tmp',
      model: {
        provider: 'openai-codex',
        modelId: 'gpt-5.5',
        thinkingLevel: 'medium',
      },
      sessionFile: '/tmp/session-1.jsonl',
      sessionLabel: 'Session 1',
    }],
    ['worker-1', {
      agentId: 'worker-1',
      displayName: 'Worker 1',
      role: 'worker',
      managerId: 'manager',
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
    }],
  ])

  const profiles = [{ profileId: 'profile-1', label: 'Profile 1', createdAt: '2026-01-01T00:00:00.000Z' }]

  return {
    getConfig: () => ({ managerId: 'manager' }),
    getAgent: (agentId: string) => descriptors.get(agentId),
    listAgents: () => Array.from(descriptors.values()),
    listBootstrapAgents: () => Array.from(descriptors.values()).filter((descriptor) => descriptor.role === 'manager'),
    listProfiles: () => profiles,
    getConversationHistoryWithDiagnostics: () => ({
      history: [],
      diagnostics: {
        cacheState: 'miss' as const,
        historySource: 'session_file' as const,
        coldLoad: false,
        fsReadOps: 0,
        fsReadBytes: 0,
        sessionFileBytes: 0,
        cacheFileBytes: 0,
        persistedEntryCount: 0,
        cachedEntryCount: 0,
        sessionSummaryBytesScanned: 0,
        cacheReadMs: 0,
        sessionSummaryReadMs: 0,
        detail: undefined,
      },
    }),
    getConversationHistory: () => [],
    getConversationHistoryPage: () => createConversationPage(),
    getPendingChoiceIdsForSession: () => [],
    getPendingChoiceRequestsForSession: () => [],
    getSessionPlanSnapshot: async (sessionAgentId: string) => createPlanSnapshotEvent(sessionAgentId),
    getSessionGoalSnapshot: async (sessionAgentId: string) => createGoalSnapshotEvent(sessionAgentId),
    getAgentsSnapshotVersion: () => agentsSnapshotVersion,
    getProfilesSnapshotVersion: () => profilesSnapshotVersion,
    bumpAgentsSnapshotVersion: () => {
      agentsSnapshotVersion += 1
    },
    bumpProfilesSnapshotVersion: () => {
      profilesSnapshotVersion += 1
    },
    deleteAgent: (agentId: string) => {
      descriptors.delete(agentId)
    },
  }
}

function createSocket(): WebSocket {
  return { readyState: WebSocket.OPEN } as WebSocket
}

function getEventTypes(events: ServerEvent[]): string[] {
  return events.map((event) => event.type)
}

describe('WsSubscriptions session-scoped live delivery', () => {
  it('isolates manager-owned browser state from sibling sessions while preserving profile-scoped delivery', () => {
    const descriptors = new Map<string, any>([
      ['profile-1', { agentId: 'profile-1', role: 'manager', profileId: 'profile-1' }],
      ['session-1', { agentId: 'session-1', role: 'manager', profileId: 'profile-1' }],
      ['worker-root', { agentId: 'worker-root', role: 'worker', managerId: 'profile-1' }],
      ['profile-2', { agentId: 'profile-2', role: 'manager', profileId: 'profile-2' }],
    ])
    const manager = { ...createManagerStub(), getAgent: (agentId: string) => descriptors.get(agentId) }
    const rootSocket = createSocket()
    const siblingSocket = createSocket()
    const workerSocket = createSocket()
    const otherProfileSocket = createSocket()
    const sockets = [rootSocket, siblingSocket, workerSocket, otherProfileSocket]
    const events = new Map(sockets.map((socket) => [socket, [] as ServerEvent[]]))
    const subscriptions = new WsSubscriptions({
      swarmManager: manager as any,
      allowNonManagerSubscriptions: true,
      terminalService: null,
      unreadTracker: null,
      perf: createPerfStub(),
      send: (socket, event) => {
        events.get(socket)!.push(event)
        return Buffer.byteLength(JSON.stringify(event), 'utf8')
      },
      getServer: () => ({ clients: new Set(sockets) }) as any,
    })
    subscriptions.subscriptions.set(rootSocket, 'profile-1')
    subscriptions.subscriptions.set(siblingSocket, 'session-1')
    subscriptions.subscriptions.set(workerSocket, 'worker-root')
    subscriptions.subscriptions.set(otherProfileSocket, 'profile-2')

    const rootBrowserEvent = createBrowserSessionChangedEvent('profile-1')
    subscriptions.broadcastToManagerSession('profile-1', rootBrowserEvent)
    expect(events.get(rootSocket)).toEqual([rootBrowserEvent])
    expect(events.get(workerSocket)).toEqual([rootBrowserEvent])
    expect(events.get(siblingSocket)).toEqual([])
    expect(events.get(otherProfileSocket)).toEqual([])

    for (const delivered of events.values()) delivered.length = 0
    const siblingBrowserEvent = createBrowserSessionChangedEvent('session-1')
    subscriptions.broadcastToManagerSession('session-1', siblingBrowserEvent)
    expect(events.get(siblingSocket)).toEqual([siblingBrowserEvent])
    expect(events.get(rootSocket)).toEqual([])
    expect(events.get(workerSocket)).toEqual([])
    expect(events.get(otherProfileSocket)).toEqual([])

    for (const delivered of events.values()) delivered.length = 0
    const profileScopedEvent = createGoalSnapshotEvent('profile-1')
    subscriptions.broadcastToSession('profile-1', profileScopedEvent)
    expect(events.get(rootSocket)).toEqual([profileScopedEvent])
    expect(events.get(siblingSocket)).toEqual([profileScopedEvent])
    expect(events.get(workerSocket)).toEqual([profileScopedEvent])
    expect(events.get(otherProfileSocket)).toEqual([])
  })
})

describe('WsSubscriptions snapshot delivery tracking', () => {
  it('echoes goal-control capability acceptance and strips shared correlation for every observer', async () => {
    const manager = createManagerStub()
    const legacySocket = createSocket()
    const capableSocket = createSocket()
    const legacyEvents: ServerEvent[] = []
    const capableEvents: ServerEvent[] = []
    const subscriptions = new WsSubscriptions({
      swarmManager: manager as any,
      allowNonManagerSubscriptions: true,
      terminalService: null,
      unreadTracker: null,
      perf: createPerfStub(),
      send: (socket, event) => {
        if (socket === legacySocket) legacyEvents.push(event)
        if (socket === capableSocket) capableEvents.push(event)
        return Buffer.byteLength(JSON.stringify(event), 'utf8')
      },
      getServer: () => ({ clients: new Set([legacySocket, capableSocket]) }) as any,
    })

    await subscriptions.handleSubscribe(legacySocket, 'manager')
    await subscriptions.handleSubscribe(capableSocket, 'manager', undefined, false, 'all', true)

    expect(legacyEvents.find((event) => event.type === 'ready')).toEqual(expect.not.objectContaining({
      goalControlRequestId: true,
    }))
    expect(capableEvents.find((event) => event.type === 'ready')).toMatchObject({
      type: 'ready',
      goalControlRequestId: true,
    })

    legacyEvents.length = 0
    capableEvents.length = 0
    subscriptions.broadcastToExactSubscription('manager', {
      ...createGoalSnapshotEvent('manager'),
      requestId: 'goal-control-1',
    })

    expect(legacyEvents).toEqual([createGoalSnapshotEvent('manager')])
    expect(capableEvents).toEqual([createGoalSnapshotEvent('manager')])
  })

  it('applies the negotiated Builder view to live conversation events', async () => {
    const manager = createManagerStub()
    const socket = createSocket()
    const sentEvents: ServerEvent[] = []
    const subscriptions = new WsSubscriptions({
      swarmManager: manager as any,
      allowNonManagerSubscriptions: true,
      terminalService: null,
      unreadTracker: null,
      perf: createPerfStub(),
      send: (_socket, event) => {
        sentEvents.push(event)
        return Buffer.byteLength(JSON.stringify(event), 'utf8')
      },
      getServer: () => ({ clients: new Set([socket]) }) as any,
    })
    const activity: Extract<ServerEvent, { type: 'activity_summary' }> = {
      type: 'activity_summary',
      schemaVersion: 1,
      itemId: 'tool:manager:1',
      agentId: 'manager',
      actorAgentId: 'manager',
      timestamp: '2026-01-01T00:00:00.000Z',
      kind: 'tool_activity',
      status: 'completed',
      displaySummary: 'Ran command',
    }

    await subscriptions.handleSubscribe(socket, 'manager', undefined, true, 'web')
    sentEvents.length = 0
    subscriptions.broadcastToSubscribed(activity)
    expect(sentEvents).toEqual([])

    subscriptions.broadcastToSubscribed({
      type: 'agent_tool_call',
      agentId: 'manager',
      actorAgentId: 'worker-1',
      timestamp: '2026-01-01T00:00:01.000Z',
      kind: 'tool_execution_end',
      toolName: 'read',
      toolCallId: 'worker-tool',
      text: 'private worker detail',
    })
    expect(sentEvents).toMatchObject([{
      type: 'activity_summary',
      itemId: 'tool:manager:worker-tool',
      agentId: 'manager',
      actorAgentId: 'worker-1',
      displaySummary: 'Read file',
    }])

    await subscriptions.handleSubscribe(socket, 'manager', undefined, true, 'all')
    sentEvents.length = 0
    subscriptions.broadcastToSubscribed(activity)
    expect(sentEvents).toEqual([activity])
  })

  it('uses the bootstrap capability policy for live new-only entries without changing ordinary messages', async () => {
    const manager = createManagerStub()
    const legacySocket = createSocket()
    const currentSocket = createSocket()
    const legacyEvents: ServerEvent[] = []
    const currentEvents: ServerEvent[] = []
    const subscriptions = new WsSubscriptions({
      swarmManager: manager as any,
      allowNonManagerSubscriptions: true,
      terminalService: null,
      unreadTracker: null,
      perf: createPerfStub(),
      send: (socket, event) => {
        if (socket === legacySocket) legacyEvents.push(event)
        if (socket === currentSocket) currentEvents.push(event)
        return Buffer.byteLength(JSON.stringify(event), 'utf8')
      },
      getServer: () => ({ clients: new Set([legacySocket, currentSocket]) }) as any,
    })

    await subscriptions.handleSubscribe(legacySocket, 'manager', undefined, false)
    await subscriptions.handleSubscribe(currentSocket, 'manager', undefined, true)
    legacyEvents.length = 0
    currentEvents.length = 0

    subscriptions.broadcastToSubscribed({
      type: 'conversation_message',
      id: 'ordinary-live-message',
      agentId: 'manager',
      role: 'assistant',
      text: 'ordinary live message',
      timestamp: '2026-01-01T00:00:00.000Z',
      source: 'system',
    })
    subscriptions.broadcastToSubscribed({
      type: 'activity_summary',
      schemaVersion: 1,
      itemId: 'tool:manager:live-tool',
      agentId: 'manager',
      actorAgentId: 'manager',
      timestamp: '2026-01-01T00:00:01.000Z',
      kind: 'tool_activity',
      status: 'completed',
      toolName: 'bash',
      correlationId: 'live-tool',
      displaySummary: 'Ran command',
    })
    subscriptions.broadcastToSubscribed({
      type: 'plan_summary',
      id: 'live-plan',
      agentId: 'manager',
      timestamp: '2026-01-01T00:00:02.000Z',
      updatedAt: '2026-01-01T00:00:02.000Z',
      revision: 1,
      plan: [{ step: 'Ship compatibility shield', status: 'in_progress' }],
    })
    subscriptions.broadcastToSubscribed({
      type: 'model_cache_observation',
      id: 'live-cache-observation',
      agentId: 'manager',
      timestamp: '2026-01-01T00:00:03.000Z',
      runtimeType: 'pi',
      provider: 'openai',
      modelId: 'gpt-5',
      tokens: {
        promptInputTokens: 2000,
        cachedInputTokens: 1600,
        cacheWriteInputTokens: 0,
        uncachedInputTokens: 400,
        outputTokens: 120,
        totalTokens: 2120,
        normalization: 'raw_input_tokens_total',
      },
      classification: {
        version: 1,
        status: 'hit',
        cachedRatio: 0.8,
        thresholdTokens: 1024,
        hitRatioThreshold: 0.8,
      },
    })

    expect(legacyEvents.map((event) => event.type)).toEqual([
      'conversation_message',
      'conversation_log',
    ])
    expect(legacyEvents[0]).toMatchObject({ id: 'ordinary-live-message', text: 'ordinary live message' })
    expect(legacyEvents[1]).toMatchObject({
      type: 'conversation_log',
      kind: 'tool_execution_end',
      toolCallId: 'live-tool',
      text: 'Ran command',
    })
    expect(currentEvents.map((event) => event.type)).toEqual([
      'conversation_message',
      'activity_summary',
      'plan_summary',
      'model_cache_observation',
    ])
    expect(currentEvents[0]).toMatchObject({ id: 'ordinary-live-message', text: 'ordinary live message' })
  })

  it('sends full snapshots on first subscribe and skips them on same-socket resubscribe when versions match', async () => {
    const manager = createManagerStub()
    const socket = createSocket()
    const sentEvents: ServerEvent[] = []
    const subscriptions = new WsSubscriptions({
      swarmManager: manager as any,
      allowNonManagerSubscriptions: true,
      terminalService: null,
      unreadTracker: null,
      perf: createPerfStub(),
      send: (_socket, event) => {
        sentEvents.push(event)
        return Buffer.byteLength(JSON.stringify(event), 'utf8')
      },
      getServer: () => ({ clients: new Set([socket]) }) as any,
    })

    await subscriptions.handleSubscribe(socket, 'manager')
    expect(getEventTypes(sentEvents)).toEqual([
      'ready',
      'agents_snapshot',
      'profiles_snapshot',
      'session_attention_snapshot',
      'conversation_history',
      'pending_choices_snapshot',
      'restart_recovery_snapshot',
      'session_plan_snapshot',
      'session_goal_snapshot',
      'terminals_snapshot',
    ])

    sentEvents.length = 0
    await subscriptions.handleSubscribe(socket, 'session-1')

    expect(getEventTypes(sentEvents)).toEqual([
      'ready',
      'session_attention_snapshot',
      'conversation_history',
      'pending_choices_snapshot',
      'restart_recovery_snapshot',
      'session_plan_snapshot',
      'session_goal_snapshot',
      'terminals_snapshot',
    ])
  })

  it('resends the agents snapshot when selecting an idle worker omitted from the global list', async () => {
    const manager = createManagerStub()
    const socket = createSocket()
    const sentEvents: ServerEvent[] = []
    const subscriptions = new WsSubscriptions({
      swarmManager: manager as any,
      allowNonManagerSubscriptions: true,
      terminalService: null,
      unreadTracker: null,
      perf: createPerfStub(),
      send: (_socket, event) => {
        sentEvents.push(event)
        return Buffer.byteLength(JSON.stringify(event), 'utf8')
      },
      getServer: () => ({ clients: new Set([socket]) }) as any,
    })

    await subscriptions.handleSubscribe(socket, 'manager')
    sentEvents.length = 0

    await subscriptions.handleSubscribe(socket, 'worker-1')

    const firstWorkerSnapshot = sentEvents.find(
      (event): event is Extract<ServerEvent, { type: 'agents_snapshot' }> =>
        event.type === 'agents_snapshot',
    )
    expect(firstWorkerSnapshot?.agents.map((agent) => agent.agentId)).toContain('worker-1')

    sentEvents.length = 0
    await subscriptions.handleSubscribe(socket, 'worker-1')
    expect(getEventTypes(sentEvents)).not.toContain('agents_snapshot')
  })

  it('resends snapshots on resubscribe after versions change', async () => {
    const manager = createManagerStub()
    const socket = createSocket()
    const sentEvents: ServerEvent[] = []
    const subscriptions = new WsSubscriptions({
      swarmManager: manager as any,
      allowNonManagerSubscriptions: true,
      terminalService: null,
      unreadTracker: null,
      perf: createPerfStub(),
      send: (_socket, event) => {
        sentEvents.push(event)
        return Buffer.byteLength(JSON.stringify(event), 'utf8')
      },
      getServer: () => ({ clients: new Set([socket]) }) as any,
    })

    await subscriptions.handleSubscribe(socket, 'manager')
    sentEvents.length = 0

    manager.bumpAgentsSnapshotVersion()
    manager.bumpProfilesSnapshotVersion()

    await subscriptions.handleSubscribe(socket, 'session-1')

    expect(getEventTypes(sentEvents)).toContain('agents_snapshot')
    expect(getEventTypes(sentEvents)).toContain('profiles_snapshot')
  })

  it('updates delivered versions after live broadcasts so the next resubscribe still skips snapshots', async () => {
    const manager = createManagerStub()
    const socket = createSocket()
    const sentEvents: ServerEvent[] = []
    const subscriptions = new WsSubscriptions({
      swarmManager: manager as any,
      allowNonManagerSubscriptions: true,
      terminalService: null,
      unreadTracker: null,
      perf: createPerfStub(),
      send: (_socket, event) => {
        sentEvents.push(event)
        return Buffer.byteLength(JSON.stringify(event), 'utf8')
      },
      getServer: () => ({ clients: new Set([socket]) }) as any,
    })

    await subscriptions.handleSubscribe(socket, 'manager')
    sentEvents.length = 0

    manager.bumpAgentsSnapshotVersion()
    subscriptions.broadcastToSubscribed({
      type: 'agents_snapshot',
      agents: manager.listBootstrapAgents(),
    })
    manager.bumpProfilesSnapshotVersion()
    subscriptions.broadcastToSubscribed({
      type: 'profiles_snapshot',
      profiles: manager.listProfiles(),
    })

    sentEvents.length = 0
    await subscriptions.handleSubscribe(socket, 'session-1')

    expect(getEventTypes(sentEvents)).toEqual([
      'ready',
      'session_attention_snapshot',
      'conversation_history',
      'pending_choices_snapshot',
      'restart_recovery_snapshot',
      'session_plan_snapshot',
      'session_goal_snapshot',
      'terminals_snapshot',
    ])
  })

  it('resets delivered versions when a socket is removed', async () => {
    const manager = createManagerStub()
    const socket = createSocket()
    const sentEvents: ServerEvent[] = []
    const subscriptions = new WsSubscriptions({
      swarmManager: manager as any,
      allowNonManagerSubscriptions: true,
      terminalService: null,
      unreadTracker: null,
      perf: createPerfStub(),
      send: (_socket, event) => {
        sentEvents.push(event)
        return Buffer.byteLength(JSON.stringify(event), 'utf8')
      },
      getServer: () => ({ clients: new Set([socket]) }) as any,
    })

    await subscriptions.handleSubscribe(socket, 'manager')
    subscriptions.remove(socket)
    sentEvents.length = 0

    await subscriptions.handleSubscribe(socket, 'manager')

    expect(getEventTypes(sentEvents)).toContain('agents_snapshot')
    expect(getEventTypes(sentEvents)).toContain('profiles_snapshot')
  })

  it('resends snapshots when a deleted subscribed agent falls back to another session', async () => {
    const manager = createManagerStub()
    const socket = createSocket()
    const sentEvents: ServerEvent[] = []
    const subscriptions = new WsSubscriptions({
      swarmManager: manager as any,
      allowNonManagerSubscriptions: true,
      terminalService: null,
      unreadTracker: null,
      perf: createPerfStub(),
      send: (_socket, event) => {
        sentEvents.push(event)
        return Buffer.byteLength(JSON.stringify(event), 'utf8')
      },
      getServer: () => ({ clients: new Set([socket]) }) as any,
    })

    await subscriptions.handleSubscribe(socket, 'session-1')
    sentEvents.length = 0
    manager.deleteAgent('session-1')

    subscriptions.handleDeletedAgentSubscriptions(new Set(['session-1']))
    await flushMicrotasks()

    expect(getEventTypes(sentEvents)).toContain('ready')
    expect(getEventTypes(sentEvents)).toContain('agents_snapshot')
    expect(getEventTypes(sentEvents)).toContain('profiles_snapshot')
  })

  it('suppresses deleted-agent implicit fallback bootstrap for correlation-capable sockets', async () => {
    const manager = createManagerStub()
    const socket = createSocket()
    const sentEvents: ServerEvent[] = []
    const subscriptions = new WsSubscriptions({
      swarmManager: manager as any,
      allowNonManagerSubscriptions: true,
      terminalService: null,
      unreadTracker: null,
      perf: createPerfStub(),
      send: (_socket, event) => {
        sentEvents.push(event)
        return Buffer.byteLength(JSON.stringify(event), 'utf8')
      },
      getServer: () => ({ clients: new Set([socket]) }) as any,
    })

    await subscriptions.handleSubscribe(socket, 'session-1', undefined, true, 'web', false, 'session-1:initial')
    sentEvents.length = 0
    manager.deleteAgent('session-1')

    subscriptions.handleDeletedAgentSubscriptions(new Set(['session-1']))
    await flushMicrotasks()

    expect(subscriptions.getSubscribedAgentId(socket)).toBe('__bootstrap_manager__')
    expect(getEventTypes(sentEvents)).not.toContain('ready')
    expect(getEventTypes(sentEvents)).not.toContain('conversation_history')
  })

  it('cancels an id-bearing pending target with TARGET_REMOVED instead of bootstrapping a fallback', async () => {
    const manager = createManagerStub()
    const socket = createSocket()
    const sentEvents: ServerEvent[] = []
    const pauseAfterProfilesSnapshot = createDeferred<void>()
    let paused = false
    const subscriptions = new WsSubscriptions({
      swarmManager: manager as any,
      allowNonManagerSubscriptions: true,
      terminalService: null,
      unreadTracker: null,
      perf: createPerfStub(),
      send: (_socket, event) => {
        sentEvents.push(event)
        return Buffer.byteLength(JSON.stringify(event), 'utf8')
      },
      sendBootstrapCritical: async (_socket, event) => {
        sentEvents.push(event)
        if (!paused && event.type === 'profiles_snapshot') {
          paused = true
          await pauseAfterProfilesSnapshot.promise
        }
        return Buffer.byteLength(JSON.stringify(event), 'utf8')
      },
      getServer: () => ({ clients: new Set([socket]) }) as any,
    })

    const subscribe = subscriptions.handleSubscribe(
      socket,
      'session-1',
      undefined,
      true,
      'all',
      false,
      'removed-while-pending',
    )
    await waitFor(() => paused)
    manager.deleteAgent('session-1')
    subscriptions.handleDeletedAgentSubscriptions(new Set(['session-1']))
    pauseAfterProfilesSnapshot.resolve()
    await subscribe
    await flushMicrotasks()

    expect(sentEvents.filter((event) => event.type === 'bootstrap_failed')).toEqual([{
      type: 'bootstrap_failed',
      agentId: 'session-1',
      subscriptionId: 'removed-while-pending',
      servedConversationView: 'all',
      code: 'TARGET_REMOVED',
      message: 'Agent session-1 was removed during bootstrap.',
      retryable: false,
      stage: 'target_resolution',
    }])
    expect(sentEvents.filter((event) => event.type === 'ready')).toHaveLength(1)
    expect(sentEvents.filter((event) => event.type === 'conversation_history')).toHaveLength(0)
  })

  it('treats A→B→A as a new latest generation instead of joining the stale A bootstrap', async () => {
    const manager = createManagerStub()
    const socket = createSocket()
    let currentBootstrapTarget: string | null = null
    const pauseAfterInitialProfilesSnapshot = createDeferred<void>()
    let initialProfilesSnapshotPaused = false
    const recordedBootstrapEvents: Array<{
      type: string
      targetAgentId: string
      subscriptionId?: string
      servedConversationView?: string
    }> = []

    const subscriptions = new WsSubscriptions({
      swarmManager: manager as any,
      allowNonManagerSubscriptions: true,
      terminalService: null,
      unreadTracker: null,
      perf: createPerfStub(),
      send: (_socket, event) => Buffer.byteLength(JSON.stringify(event), 'utf8'),
      sendBootstrapCritical: async (_socket, event) => {
        if (event.type === 'ready') {
          currentBootstrapTarget = event.subscribedAgentId
        }

        recordedBootstrapEvents.push({
          type: event.type,
          targetAgentId: event.type === 'ready' ? event.subscribedAgentId : currentBootstrapTarget ?? 'unknown',
          subscriptionId: 'subscriptionId' in event ? event.subscriptionId : undefined,
          servedConversationView: 'servedConversationView' in event ? event.servedConversationView : undefined,
        })

        if (!initialProfilesSnapshotPaused && currentBootstrapTarget === 'manager' && event.type === 'profiles_snapshot') {
          initialProfilesSnapshotPaused = true
          await pauseAfterInitialProfilesSnapshot.promise
        }

        return Buffer.byteLength(JSON.stringify(event), 'utf8')
      },
      getServer: () => ({ clients: new Set([socket]) }) as any,
    })

    const firstSubscribe = subscriptions.handleSubscribe(socket, 'manager', undefined, true, 'all', false, 'A1')
    await waitFor(() => initialProfilesSnapshotPaused)
    const secondSubscribe = subscriptions.handleSubscribe(socket, 'session-1', undefined, true, 'all', false, 'B2')
    const thirdSubscribe = subscriptions.handleSubscribe(socket, 'manager', undefined, true, 'all', false, 'A3')
    pauseAfterInitialProfilesSnapshot.resolve()

    await Promise.all([firstSubscribe, secondSubscribe, thirdSubscribe])

    expect(subscriptions.getSubscribedAgentId(socket)).toBe('manager')
    expect(
      recordedBootstrapEvents
        .filter((event) => event.type === 'ready')
        .map((event) => event.targetAgentId),
    ).toEqual(['manager', 'manager'])
    expect(
      recordedBootstrapEvents
        .filter((event) => event.type === 'ready')
        .map((event) => event.subscriptionId),
    ).toEqual(['A1', 'A3'])
    expect(
      recordedBootstrapEvents
        .filter((event) => event.type === 'conversation_history')
        .map((event) => ({ targetAgentId: event.targetAgentId, subscriptionId: event.subscriptionId })),
    ).toEqual([{ targetAgentId: 'manager', subscriptionId: 'A3' }])
    expect(recordedBootstrapEvents.some((event) => event.targetAgentId === 'session-1')).toBe(false)
  })

  it('keeps delayed Web→All→Web bootstrap generations distinctly correlated', async () => {
    const manager = createManagerStub()
    const socket = createSocket()
    const pauseAfterInitialProfilesSnapshot = createDeferred<void>()
    let initialProfilesSnapshotPaused = false
    const correlatedFrames: Array<{
      type: string
      subscriptionId?: string
      servedConversationView?: string
    }> = []

    const subscriptions = new WsSubscriptions({
      swarmManager: manager as any,
      allowNonManagerSubscriptions: true,
      terminalService: null,
      unreadTracker: null,
      perf: createPerfStub(),
      send: (_socket, event) => Buffer.byteLength(JSON.stringify(event), 'utf8'),
      sendBootstrapCritical: async (_socket, event) => {
        correlatedFrames.push({
          type: event.type,
          subscriptionId: 'subscriptionId' in event ? event.subscriptionId : undefined,
          servedConversationView: 'servedConversationView' in event ? event.servedConversationView : undefined,
        })
        if (!initialProfilesSnapshotPaused && event.type === 'profiles_snapshot') {
          initialProfilesSnapshotPaused = true
          await pauseAfterInitialProfilesSnapshot.promise
        }
        return Buffer.byteLength(JSON.stringify(event), 'utf8')
      },
      getServer: () => ({ clients: new Set([socket]) }) as any,
    })

    const web1 = subscriptions.handleSubscribe(socket, 'manager', undefined, true, 'web', false, 'Web1')
    await waitFor(() => initialProfilesSnapshotPaused)
    const all2 = subscriptions.handleSubscribe(socket, 'manager', undefined, true, 'all', false, 'All2')
    const web3 = subscriptions.handleSubscribe(socket, 'manager', undefined, true, 'web', false, 'Web3')
    pauseAfterInitialProfilesSnapshot.resolve()
    await Promise.all([web1, all2, web3])

    expect(correlatedFrames.filter((event) => event.type === 'ready')).toMatchObject([
      { subscriptionId: 'Web1', servedConversationView: 'web' },
      { subscriptionId: 'Web3', servedConversationView: 'web' },
    ])
    expect(correlatedFrames.filter((event) => event.type === 'conversation_history')).toMatchObject([
      { subscriptionId: 'Web3', servedConversationView: 'web' },
    ])
    expect(correlatedFrames.some((event) => event.subscriptionId === 'All2')).toBe(false)
  })

  it('starts a new bootstrap when the same target subscribe changes messageCount', async () => {
    const manager = createManagerStub()
    manager.getConversationHistoryPage = vi.fn((agentId: string, options?: { limit?: number }) => {
      const history = createConversationHistory(agentId, 120)
      return createConversationPage(history.slice(-(options?.limit ?? history.length)))
    })

    const socket = createSocket()
    let currentBootstrapTarget: string | null = null
    const pauseAfterInitialProfilesSnapshot = createDeferred<void>()
    let initialProfilesSnapshotPaused = false
    const historyMessageCounts: number[] = []
    const readyTargets: string[] = []

    const subscriptions = new WsSubscriptions({
      swarmManager: manager as any,
      allowNonManagerSubscriptions: true,
      terminalService: null,
      unreadTracker: null,
      perf: createPerfStub(),
      send: (_socket, event) => Buffer.byteLength(JSON.stringify(event), 'utf8'),
      sendBootstrapCritical: async (_socket, event) => {
        if (event.type === 'ready') {
          currentBootstrapTarget = event.subscribedAgentId
          readyTargets.push(event.subscribedAgentId)
        }

        if (event.type === 'conversation_history') {
          historyMessageCounts.push(event.messages.length)
        }

        if (!initialProfilesSnapshotPaused && currentBootstrapTarget === 'manager' && event.type === 'profiles_snapshot') {
          initialProfilesSnapshotPaused = true
          await pauseAfterInitialProfilesSnapshot.promise
        }

        return Buffer.byteLength(JSON.stringify(event), 'utf8')
      },
      getServer: () => ({ clients: new Set([socket]) }) as any,
    })

    const firstSubscribe = subscriptions.handleSubscribe(socket, 'manager', 7, true)
    await waitFor(() => initialProfilesSnapshotPaused)
    const secondSubscribe = subscriptions.handleSubscribe(socket, 'manager', 25, true)
    pauseAfterInitialProfilesSnapshot.resolve()

    await Promise.all([firstSubscribe, secondSubscribe])

    expect(readyTargets).toEqual(['manager', 'manager'])
    expect(historyMessageCounts).toEqual([25])
  })

  it('cancels a delayed bootstrap when the socket is removed', async () => {
    const manager = createManagerStub()
    const socket = createSocket()
    const sentEvents: ServerEvent[] = []
    let currentBootstrapTarget: string | null = null
    const pauseAfterProfilesSnapshot = createDeferred<void>()
    let profilesSnapshotPaused = false

    const subscriptions = new WsSubscriptions({
      swarmManager: manager as any,
      allowNonManagerSubscriptions: true,
      terminalService: null,
      unreadTracker: null,
      perf: createPerfStub(),
      send: (_socket, event) => {
        sentEvents.push(event)
        return Buffer.byteLength(JSON.stringify(event), 'utf8')
      },
      sendBootstrapCritical: async (_socket, event) => {
        if (event.type === 'ready') {
          currentBootstrapTarget = event.subscribedAgentId
        }

        sentEvents.push(event)
        if (!profilesSnapshotPaused && currentBootstrapTarget === 'manager' && event.type === 'profiles_snapshot') {
          profilesSnapshotPaused = true
          await pauseAfterProfilesSnapshot.promise
        }

        return Buffer.byteLength(JSON.stringify(event), 'utf8')
      },
      getServer: () => ({ clients: new Set([socket]) }) as any,
    })

    const subscribePromise = subscriptions.handleSubscribe(socket, 'manager')
    await waitFor(() => profilesSnapshotPaused)
    subscriptions.remove(socket)
    pauseAfterProfilesSnapshot.resolve()
    await subscribePromise
    await flushMicrotasks(20)

    expect(subscriptions.getSubscribedAgentId(socket)).toBeUndefined()
    expect(getEventTypes(sentEvents)).toEqual(['ready', 'agents_snapshot', 'profiles_snapshot'])
    expect((subscriptions as any).bootstrapControllers.size).toBe(0)
  })

  it('cancels delayed bootstraps on clear without detached follow-up drains', async () => {
    const manager = createManagerStub()
    const socket = createSocket()
    const sentEvents: ServerEvent[] = []
    let currentBootstrapTarget: string | null = null
    const pauseAfterProfilesSnapshot = createDeferred<void>()
    let profilesSnapshotPaused = false

    const subscriptions = new WsSubscriptions({
      swarmManager: manager as any,
      allowNonManagerSubscriptions: true,
      terminalService: null,
      unreadTracker: null,
      perf: createPerfStub(),
      send: (_socket, event) => {
        sentEvents.push(event)
        return Buffer.byteLength(JSON.stringify(event), 'utf8')
      },
      sendBootstrapCritical: async (_socket, event) => {
        if (event.type === 'ready') {
          currentBootstrapTarget = event.subscribedAgentId
        }

        sentEvents.push(event)
        if (!profilesSnapshotPaused && currentBootstrapTarget === 'manager' && event.type === 'profiles_snapshot') {
          profilesSnapshotPaused = true
          await pauseAfterProfilesSnapshot.promise
        }

        return Buffer.byteLength(JSON.stringify(event), 'utf8')
      },
      getServer: () => ({ clients: new Set([socket]) }) as any,
    })

    const subscribePromise = subscriptions.handleSubscribe(socket, 'manager')
    await waitFor(() => profilesSnapshotPaused)
    subscriptions.clear()
    pauseAfterProfilesSnapshot.resolve()
    await subscribePromise
    await flushMicrotasks(20)

    expect(subscriptions.getSubscribedAgentId(socket)).toBeUndefined()
    expect(getEventTypes(sentEvents)).toEqual(['ready', 'agents_snapshot', 'profiles_snapshot'])
    expect((subscriptions as any).bootstrapControllers.size).toBe(0)
  })

  it('preserves legacy validation errors and correlates id-bearing validation failures', async () => {
    const manager = createManagerStub()
    const legacySocket = createSocket()
    const capableSocket = createSocket()
    const legacyEvents: ServerEvent[] = []
    const capableEvents: ServerEvent[] = []
    const subscriptions = new WsSubscriptions({
      swarmManager: manager as any,
      allowNonManagerSubscriptions: true,
      terminalService: null,
      unreadTracker: null,
      perf: createPerfStub(),
      send: (socket, event) => {
        if (socket === legacySocket) legacyEvents.push(event)
        if (socket === capableSocket) capableEvents.push(event)
        return Buffer.byteLength(JSON.stringify(event), 'utf8')
      },
      getServer: () => ({ clients: new Set([legacySocket, capableSocket]) }) as any,
    })

    await subscriptions.handleSubscribe(legacySocket, 'missing')
    await subscriptions.handleSubscribe(capableSocket, 'missing', undefined, true, 'web', false, 'unknown-7')

    expect(legacyEvents).toEqual([expect.objectContaining({ type: 'error', code: 'UNKNOWN_AGENT' })])
    expect(capableEvents).toEqual([{
      type: 'bootstrap_failed',
      agentId: 'missing',
      subscriptionId: 'unknown-7',
      servedConversationView: 'web',
      code: 'UNKNOWN_AGENT',
      message: 'Agent missing does not exist.',
      retryable: false,
      stage: 'subscription_validation',
    }])

    const unsupportedEvents: ServerEvent[] = []
    const unsupportedSubscriptions = new WsSubscriptions({
      swarmManager: manager as any,
      allowNonManagerSubscriptions: false,
      terminalService: null,
      unreadTracker: null,
      perf: createPerfStub(),
      send: (_socket, event) => {
        unsupportedEvents.push(event)
        return Buffer.byteLength(JSON.stringify(event), 'utf8')
      },
      getServer: () => ({ clients: new Set([capableSocket]) }) as any,
    })
    await unsupportedSubscriptions.handleSubscribe(
      capableSocket,
      'worker-1',
      undefined,
      true,
      'all',
      false,
      'unsupported-8',
    )
    expect(unsupportedEvents).toEqual([expect.objectContaining({
      type: 'bootstrap_failed',
      agentId: 'worker-1',
      subscriptionId: 'unsupported-8',
      servedConversationView: 'all',
      code: 'SUBSCRIPTION_NOT_SUPPORTED',
    })])
  })

  it('does not retry a failed generation until a later subscribe explicitly retries it', async () => {
    const manager = createManagerStub()
    const sentEvents: ServerEvent[] = []
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const socket = createSocket()
    const unhandledRejections: unknown[] = []
    const handleUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason)
    }
    process.on('unhandledRejection', handleUnhandledRejection)

    try {
      manager.getSessionPlanSnapshot = vi.fn(async () => {
        throw new Error('persistent plan snapshot failure')
      })

      const subscriptions = new WsSubscriptions({
        swarmManager: manager as any,
        allowNonManagerSubscriptions: true,
        terminalService: null,
        unreadTracker: null,
        perf: createPerfStub(),
        send: (_socket, event) => {
          sentEvents.push(event)
          return Buffer.byteLength(JSON.stringify(event), 'utf8')
        },
        getServer: () => ({ clients: new Set([socket]) }) as any,
      })

      await subscriptions.handleSubscribe(socket, 'manager', undefined, true, 'web', false, 'failure-1')
      await flushMicrotasks(20)
      await delay(20)

      expect(manager.getSessionPlanSnapshot).toHaveBeenCalledTimes(1)
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(unhandledRejections).toEqual([])
      expect(getEventTypes(sentEvents)).not.toContain('session_plan_snapshot')
      expect(getEventTypes(sentEvents)).not.toContain('session_goal_snapshot')
      expect(sentEvents.filter((event) => event.type === 'bootstrap_failed')).toEqual([{
        type: 'bootstrap_failed',
        agentId: 'manager',
        subscriptionId: 'failure-1',
        servedConversationView: 'web',
        code: 'BOOTSTRAP_FAILED',
        message: 'Conversation bootstrap failed.',
        retryable: true,
        stage: 'bootstrap',
      }])
      expect(getEventTypes(sentEvents)).not.toContain('terminals_snapshot')
      expect((subscriptions as any).bootstrapControllers.size).toBe(0)

      sentEvents.length = 0
      manager.getSessionPlanSnapshot = vi.fn(async (sessionAgentId: string) => createPlanSnapshotEvent(sessionAgentId))

      await subscriptions.handleSubscribe(socket, 'manager', undefined, true, 'web', false, 'retry-2')

      expect(getEventTypes(sentEvents)).toContain('session_plan_snapshot')
      expect(getEventTypes(sentEvents)).toContain('session_goal_snapshot')
      expect(getEventTypes(sentEvents)).toContain('terminals_snapshot')
      expect(warnSpy).toHaveBeenCalledTimes(1)
    } finally {
      process.off('unhandledRejection', handleUnhandledRejection)
      warnSpy.mockRestore()
    }
  })

  it('does not emit failure for a generation superseded before its delayed build rejects', async () => {
    const manager = createManagerStub()
    const firstPlanStarted = createDeferred<void>()
    const rejectFirstPlan = createDeferred<void>()
    let planCalls = 0
    manager.getSessionPlanSnapshot = vi.fn(async (sessionAgentId: string) => {
      planCalls += 1
      if (planCalls === 1) {
        firstPlanStarted.resolve()
        await rejectFirstPlan.promise
        throw new Error('superseded plan failure')
      }
      return createPlanSnapshotEvent(sessionAgentId)
    })

    const socket = createSocket()
    const sentEvents: ServerEvent[] = []
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const subscriptions = new WsSubscriptions({
      swarmManager: manager as any,
      allowNonManagerSubscriptions: true,
      terminalService: null,
      unreadTracker: null,
      perf: createPerfStub(),
      send: (_socket, event) => {
        sentEvents.push(event)
        return Buffer.byteLength(JSON.stringify(event), 'utf8')
      },
      getServer: () => ({ clients: new Set([socket]) }) as any,
    })

    try {
      const first = subscriptions.handleSubscribe(socket, 'manager', undefined, true, 'web', false, 'old-1')
      await firstPlanStarted.promise
      const second = subscriptions.handleSubscribe(socket, 'session-1', undefined, true, 'all', false, 'new-2')
      rejectFirstPlan.resolve()
      await Promise.all([first, second])

      expect(sentEvents.filter((event) => event.type === 'bootstrap_failed')).toEqual([])
      expect(warnSpy).not.toHaveBeenCalled()
      expect(sentEvents.filter((event) => event.type === 'conversation_history')).toEqual(expect.arrayContaining([
        expect.objectContaining({
          agentId: 'session-1',
          subscriptionId: 'new-2',
          servedConversationView: 'all',
        }),
      ]))
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('cancels the last deleted manager bootstrap instead of finishing stale history', async () => {
    const manager = createManagerStub()
    manager.deleteAgent('session-1')

    const socket = createSocket()
    const sentEvents: ServerEvent[] = []
    let currentBootstrapTarget: string | null = null
    const pauseAfterProfilesSnapshot = createDeferred<void>()
    let profilesSnapshotPaused = false

    const subscriptions = new WsSubscriptions({
      swarmManager: manager as any,
      allowNonManagerSubscriptions: true,
      terminalService: null,
      unreadTracker: null,
      perf: createPerfStub(),
      send: (_socket, event) => {
        sentEvents.push(event)
        return Buffer.byteLength(JSON.stringify(event), 'utf8')
      },
      sendBootstrapCritical: async (_socket, event) => {
        if (event.type === 'ready') {
          currentBootstrapTarget = event.subscribedAgentId
        }

        sentEvents.push(event)
        if (!profilesSnapshotPaused && currentBootstrapTarget === 'manager' && event.type === 'profiles_snapshot') {
          profilesSnapshotPaused = true
          await pauseAfterProfilesSnapshot.promise
        }

        return Buffer.byteLength(JSON.stringify(event), 'utf8')
      },
      getServer: () => ({ clients: new Set([socket]) }) as any,
    })

    const subscribePromise = subscriptions.handleSubscribe(socket, 'manager')
    await waitFor(() => profilesSnapshotPaused)
    manager.deleteAgent('manager')
    subscriptions.handleDeletedAgentSubscriptions(new Set(['manager']))
    pauseAfterProfilesSnapshot.resolve()
    await subscribePromise
    await flushMicrotasks(20)

    expect(subscriptions.getSubscribedAgentId(socket)).toBe('__bootstrap_manager__')
    expect(getEventTypes(sentEvents)).toEqual(['ready', 'agents_snapshot', 'profiles_snapshot'])
    expect((subscriptions as any).bootstrapControllers.size).toBe(0)
  })

  it('serializes deletion rehome, same-target subscribe, and stale deleted-target subscribe without interleaving bootstraps', async () => {
    const manager = createManagerStub()
    const socket = createSocket()
    const sentEvents: ServerEvent[] = []
    let bootstrapSequenceCount = 0
    let currentBootstrapSequenceId = 0
    let currentBootstrapTarget: string | null = null
    let pauseAfterProfilesSnapshot = createDeferred<void>()
    let profilesSnapshotPaused = false
    const recordedBootstrapEvents: Array<{ type: string; targetAgentId: string; sequenceId: number }> = []

    const subscriptions = new WsSubscriptions({
      swarmManager: manager as any,
      allowNonManagerSubscriptions: true,
      terminalService: null,
      unreadTracker: null,
      perf: createPerfStub(),
      send: (_socket, event) => {
        sentEvents.push(event)
        return Buffer.byteLength(JSON.stringify(event), 'utf8')
      },
      sendBootstrapCritical: async (_socket, event) => {
        sentEvents.push(event)

        if (event.type === 'ready') {
          bootstrapSequenceCount += 1
          currentBootstrapSequenceId = bootstrapSequenceCount
          currentBootstrapTarget = event.subscribedAgentId
        }

        recordedBootstrapEvents.push({
          type: event.type,
          targetAgentId: event.type === 'ready' ? event.subscribedAgentId : currentBootstrapTarget ?? 'unknown',
          sequenceId: currentBootstrapSequenceId,
        })

        if (!profilesSnapshotPaused && currentBootstrapTarget === 'manager' && event.type === 'profiles_snapshot') {
          profilesSnapshotPaused = true
          await pauseAfterProfilesSnapshot.promise
        }

        return Buffer.byteLength(JSON.stringify(event), 'utf8')
      },
      getServer: () => ({ clients: new Set([socket]) }) as any,
    })

    await subscriptions.handleSubscribe(socket, 'session-1')
    sentEvents.length = 0
    bootstrapSequenceCount = 0
    currentBootstrapSequenceId = 0
    currentBootstrapTarget = null
    recordedBootstrapEvents.length = 0
    pauseAfterProfilesSnapshot = createDeferred<void>()
    profilesSnapshotPaused = false

    manager.deleteAgent('session-1')

    subscriptions.handleDeletedAgentSubscriptions(new Set(['session-1']))
    await waitFor(() => profilesSnapshotPaused)
    const sameTargetSubscribe = subscriptions.handleSubscribe(socket, 'manager')
    const staleDeletedTargetSubscribe = subscriptions.handleSubscribe(socket, 'session-1')
    pauseAfterProfilesSnapshot.resolve()

    await Promise.all([sameTargetSubscribe, staleDeletedTargetSubscribe])
    await flushMicrotasks(20)

    const readyEvents = sentEvents.filter(
      (event): event is Extract<ServerEvent, { type: 'ready' }> => event.type === 'ready',
    )
    expect(readyEvents.map((event) => event.subscribedAgentId)).toEqual(['manager', 'manager'])

    const historyEvents = sentEvents.filter((event) => event.type === 'conversation_history')
    expect(historyEvents).toHaveLength(1)
    expect(historyEvents[0]).toMatchObject({ agentId: 'manager' })

    const errorEvents = sentEvents.filter((event) => event.type === 'error')
    expect(errorEvents).toHaveLength(1)
    expect(errorEvents[0]).toMatchObject({
      code: 'UNKNOWN_AGENT',
    })

    expect(new Set(recordedBootstrapEvents.map((event) => event.sequenceId))).toEqual(new Set([1, 2]))
    const firstSecondSequenceIndex = recordedBootstrapEvents.findIndex((event) => event.sequenceId === 2)
    expect(firstSecondSequenceIndex).toBeGreaterThan(0)
    expect(recordedBootstrapEvents.slice(firstSecondSequenceIndex).every((event) => event.sequenceId === 2)).toBe(true)
    expect(recordedBootstrapEvents.some((event) => event.targetAgentId === 'session-1')).toBe(false)
    expect(
      recordedBootstrapEvents.some(
        (event) => event.targetAgentId === 'manager' && event.type === 'conversation_history',
      ),
    ).toBe(true)
  })

  it('resends snapshots when resolveSubscribedAgentId falls back after the subscribed agent disappears', async () => {
    const manager = createManagerStub()
    const socket = createSocket()
    const sentEvents: ServerEvent[] = []
    const subscriptions = new WsSubscriptions({
      swarmManager: manager as any,
      allowNonManagerSubscriptions: true,
      terminalService: null,
      unreadTracker: null,
      perf: createPerfStub(),
      send: (_socket, event) => {
        sentEvents.push(event)
        return Buffer.byteLength(JSON.stringify(event), 'utf8')
      },
      getServer: () => ({ clients: new Set([socket]) }) as any,
    })

    await subscriptions.handleSubscribe(socket, 'session-1')
    sentEvents.length = 0
    manager.deleteAgent('session-1')

    expect(subscriptions.resolveSubscribedAgentId(socket)).toBe('manager')
    await flushMicrotasks()
    expect(getEventTypes(sentEvents)).toContain('ready')
    expect(getEventTypes(sentEvents)).toContain('agents_snapshot')
    expect(getEventTypes(sentEvents)).toContain('profiles_snapshot')
  })

  it('suppresses resolveSubscribedAgentId implicit fallback bootstrap for capable sockets', async () => {
    const manager = createManagerStub()
    const socket = createSocket()
    const sentEvents: ServerEvent[] = []
    const subscriptions = new WsSubscriptions({
      swarmManager: manager as any,
      allowNonManagerSubscriptions: true,
      terminalService: null,
      unreadTracker: null,
      perf: createPerfStub(),
      send: (_socket, event) => {
        sentEvents.push(event)
        return Buffer.byteLength(JSON.stringify(event), 'utf8')
      },
      getServer: () => ({ clients: new Set([socket]) }) as any,
    })

    await subscriptions.handleSubscribe(socket, 'session-1', undefined, true, 'all', false, 'resolve-initial')
    sentEvents.length = 0
    manager.deleteAgent('session-1')

    expect(subscriptions.resolveSubscribedAgentId(socket)).toBe('__bootstrap_manager__')
    await flushMicrotasks()
    expect(getEventTypes(sentEvents)).not.toContain('ready')
    expect(getEventTypes(sentEvents)).not.toContain('conversation_history')
  })

  it('skips session_plan_snapshot for bootstrap placeholder and worker subscriptions', async () => {
    const bootstrapSocket = createSocket()
    const workerSocket = createSocket()
    const bootstrapEvents: ServerEvent[] = []
    const workerEvents: ServerEvent[] = []
    const getSessionPlanSnapshot = vi.fn(async (sessionAgentId: string) => createPlanSnapshotEvent(sessionAgentId))
    const manager = {
      getConfig: () => ({}),
      getAgent: (agentId: string) => {
        if (agentId === 'worker-1') {
          return {
            agentId: 'worker-1',
            displayName: 'Worker 1',
            role: 'worker',
            managerId: 'manager',
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
          }
        }
        return undefined
      },
      listAgents: () => [],
      listBootstrapAgents: () => [],
      listProfiles: () => [],
      getConversationHistoryWithDiagnostics: () => ({
        history: [],
        diagnostics: {
          cacheState: 'miss' as const,
          historySource: 'session_file' as const,
          coldLoad: false,
          fsReadOps: 0,
          fsReadBytes: 0,
          sessionFileBytes: 0,
          cacheFileBytes: 0,
          persistedEntryCount: 0,
          cachedEntryCount: 0,
          sessionSummaryBytesScanned: 0,
          cacheReadMs: 0,
          sessionSummaryReadMs: 0,
          detail: undefined,
        },
      }),
      getConversationHistoryPage: () => createConversationPage(),
      getPendingChoiceIdsForSession: () => [],
      getPendingChoiceRequestsForSession: () => [],
      getSessionPlanSnapshot,
      getAgentsSnapshotVersion: () => 0,
      getProfilesSnapshotVersion: () => 0,
    }
    const subscriptions = new WsSubscriptions({
      swarmManager: manager as any,
      allowNonManagerSubscriptions: true,
      terminalService: null,
      unreadTracker: null,
      perf: createPerfStub(),
      send: (socket, event) => {
        if (socket === bootstrapSocket) {
          bootstrapEvents.push(event)
        }
        if (socket === workerSocket) {
          workerEvents.push(event)
        }
        return Buffer.byteLength(JSON.stringify(event), 'utf8')
      },
      getServer: () => ({ clients: new Set([bootstrapSocket, workerSocket]) }) as any,
    })

    await subscriptions.handleSubscribe(bootstrapSocket)
    await subscriptions.handleSubscribe(workerSocket, 'worker-1')

    expect(getSessionPlanSnapshot).not.toHaveBeenCalled()
    expect(getEventTypes(bootstrapEvents)).toEqual([
      'ready',
      'agents_snapshot',
      'profiles_snapshot',
      'session_attention_snapshot',
      'conversation_history',
      'pending_choices_snapshot',
      'restart_recovery_snapshot',
      'terminals_snapshot',
    ])
    expect(getEventTypes(workerEvents)).toEqual([
      'ready',
      'agents_snapshot',
      'profiles_snapshot',
      'session_attention_snapshot',
      'conversation_history',
      'pending_choices_snapshot',
      'restart_recovery_snapshot',
      'terminals_snapshot',
    ])
  })
})

describe('WsSubscriptions choice_request delivery', () => {
  it('delivers worker-origin choice_request to manager session subscribers via sessionAgentId', async () => {
    const manager = createManagerStub()
    const managerSocket = createSocket()
    const otherSessionSocket = createSocket()
    const managerEvents: ServerEvent[] = []
    const otherSessionEvents: ServerEvent[] = []
    const subscriptions = new WsSubscriptions({
      swarmManager: manager as any,
      allowNonManagerSubscriptions: true,
      terminalService: null,
      unreadTracker: null,
      perf: createPerfStub(),
      send: (socket, event) => {
        if (socket === managerSocket) {
          managerEvents.push(event)
        }
        if (socket === otherSessionSocket) {
          otherSessionEvents.push(event)
        }
        return Buffer.byteLength(JSON.stringify(event), 'utf8')
      },
      getServer: () => ({ clients: new Set([managerSocket, otherSessionSocket]) }) as any,
    })

    await subscriptions.handleSubscribe(managerSocket, 'manager')
    await subscriptions.handleSubscribe(otherSessionSocket, 'session-1')
    managerEvents.length = 0
    otherSessionEvents.length = 0

    subscriptions.broadcastToSubscribed({
      type: 'choice_request',
      agentId: 'worker-1',
      sessionAgentId: 'manager',
      choiceId: 'choice-worker-1',
      questions: [{ id: 'q1', question: 'Pick one', options: [{ id: 'a', label: 'A' }] }],
      status: 'pending',
      timestamp: '2026-01-01T00:00:00.000Z',
    })

    expect(managerEvents).toEqual([
      expect.objectContaining({
        type: 'choice_request',
        agentId: 'worker-1',
        sessionAgentId: 'manager',
        choiceId: 'choice-worker-1',
      }),
    ])
    expect(otherSessionEvents).toEqual([])
  })

  it('does not broaden conversation_message delivery beyond agentId', async () => {
    const manager = createManagerStub()
    const managerSocket = createSocket()
    const managerEvents: ServerEvent[] = []
    const subscriptions = new WsSubscriptions({
      swarmManager: manager as any,
      allowNonManagerSubscriptions: true,
      terminalService: null,
      unreadTracker: null,
      perf: createPerfStub(),
      send: (_socket, event) => {
        managerEvents.push(event)
        return Buffer.byteLength(JSON.stringify(event), 'utf8')
      },
      getServer: () => ({ clients: new Set([managerSocket]) }) as any,
    })

    await subscriptions.handleSubscribe(managerSocket, 'manager')
    managerEvents.length = 0

    subscriptions.broadcastToSubscribed({
      type: 'conversation_message',
      agentId: 'worker-1',
      role: 'assistant',
      text: 'worker-only message',
      timestamp: '2026-01-01T00:00:00.000Z',
      source: 'speak_to_user',
    })

    expect(managerEvents).toEqual([])
  })
})
