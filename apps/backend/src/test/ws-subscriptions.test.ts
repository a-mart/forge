import { describe, expect, it, vi } from 'vitest'
import type { ServerEvent } from '@forge/protocol'
import type { SidebarPerfRecorder } from '../stats/sidebar-perf-types.js'
import { WsSubscriptions } from '../ws/ws-subscriptions.js'
import { WebSocket } from 'ws'

// The bootstrap send sequence is async and flow-controls bootstrap-critical events (awaits socket
// drain between sends). Fire-and-forget bootstrap paths (queueSubscriptionBootstrap) therefore settle
// across microtask boundaries, so flush the microtask queue before asserting on delivered events.
async function flushMicrotasks(ticks = 20): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    await Promise.resolve()
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

function createTaskSnapshotEvent(sessionAgentId: string): Extract<ServerEvent, { type: 'session_task_state_snapshot' }> {
  return {
    type: 'session_task_state_snapshot',
    sessionAgentId,
    profileId: 'profile-1',
    revision: 0,
    activeWorkPlan: null,
    recentWorkPlans: [],
    recentWorkPlanCount: 0,
    recentWorkPlansTruncated: false,
    diagnostics: { state: 'defaulted' },
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
    getPendingChoiceIdsForSession: () => [],
    getPendingChoiceRequestsForSession: () => [],
    getSessionTaskStateSnapshot: async (sessionAgentId: string) => createTaskSnapshotEvent(sessionAgentId),
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

describe('WsSubscriptions snapshot delivery tracking', () => {
  it('sends full snapshots on first subscribe and skips them on same-socket resubscribe when versions match', async () => {
    const manager = createManagerStub()
    const socket = createSocket()
    const sentEvents: ServerEvent[] = []
    const subscriptions = new WsSubscriptions({
      swarmManager: manager as any,
      integrationRegistry: null,
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
      'conversation_history',
      'pending_choices_snapshot',
      'restart_recovery_snapshot',
      'session_task_state_snapshot',
      'terminals_snapshot',
    ])

    sentEvents.length = 0
    await subscriptions.handleSubscribe(socket, 'session-1')

    expect(getEventTypes(sentEvents)).toEqual([
      'ready',
      'conversation_history',
      'pending_choices_snapshot',
      'restart_recovery_snapshot',
      'session_task_state_snapshot',
      'terminals_snapshot',
    ])
  })

  it('resends snapshots on resubscribe after versions change', async () => {
    const manager = createManagerStub()
    const socket = createSocket()
    const sentEvents: ServerEvent[] = []
    const subscriptions = new WsSubscriptions({
      swarmManager: manager as any,
      integrationRegistry: null,
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
      integrationRegistry: null,
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
      'conversation_history',
      'pending_choices_snapshot',
      'restart_recovery_snapshot',
      'session_task_state_snapshot',
      'terminals_snapshot',
    ])
  })

  it('resets delivered versions when a socket is removed', async () => {
    const manager = createManagerStub()
    const socket = createSocket()
    const sentEvents: ServerEvent[] = []
    const subscriptions = new WsSubscriptions({
      swarmManager: manager as any,
      integrationRegistry: null,
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
      integrationRegistry: null,
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

  it('resends snapshots when resolveSubscribedAgentId falls back after the subscribed agent disappears', async () => {
    const manager = createManagerStub()
    const socket = createSocket()
    const sentEvents: ServerEvent[] = []
    const subscriptions = new WsSubscriptions({
      swarmManager: manager as any,
      integrationRegistry: null,
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

  it('skips session_task_state_snapshot for bootstrap placeholder and worker subscriptions', async () => {
    const bootstrapSocket = createSocket()
    const workerSocket = createSocket()
    const bootstrapEvents: ServerEvent[] = []
    const workerEvents: ServerEvent[] = []
    const getSessionTaskStateSnapshot = vi.fn(async (sessionAgentId: string) => createTaskSnapshotEvent(sessionAgentId))
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
      getPendingChoiceIdsForSession: () => [],
      getPendingChoiceRequestsForSession: () => [],
      getSessionTaskStateSnapshot,
      getAgentsSnapshotVersion: () => 0,
      getProfilesSnapshotVersion: () => 0,
    }
    const subscriptions = new WsSubscriptions({
      swarmManager: manager as any,
      integrationRegistry: null,
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

    expect(getSessionTaskStateSnapshot).not.toHaveBeenCalled()
    expect(getEventTypes(bootstrapEvents)).toEqual([
      'ready',
      'agents_snapshot',
      'profiles_snapshot',
      'conversation_history',
      'pending_choices_snapshot',
      'restart_recovery_snapshot',
      'terminals_snapshot',
    ])
    expect(getEventTypes(workerEvents)).toEqual([
      'ready',
      'agents_snapshot',
      'profiles_snapshot',
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
      integrationRegistry: null,
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
      integrationRegistry: null,
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
