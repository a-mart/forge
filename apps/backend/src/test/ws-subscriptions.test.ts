import { describe, expect, it, vi } from 'vitest'
import type { ServerEvent } from '@forge/protocol'
import type { SidebarPerfRecorder } from '../stats/sidebar-perf-types.js'
import { WsSubscriptions } from '../ws/ws-subscriptions.js'
import { WebSocket } from 'ws'

function createPerfStub(): SidebarPerfRecorder {
  return {
    recordDuration: vi.fn(),
    increment: vi.fn(),
    readSummary: vi.fn(() => ({ histograms: {}, counters: {} })),
    readRecentSlowEvents: vi.fn(() => []),
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
        modelId: 'gpt-5.3-codex',
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
        modelId: 'gpt-5.3-codex',
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

function createPlaywrightDiscoveryStub(sequence = 0) {
  let currentSequence = sequence
  return {
    getSnapshot: () => ({
      updatedAt: '2026-01-01T00:00:00.000Z',
      lastScanStartedAt: null,
      lastScanCompletedAt: null,
      scanDurationMs: null,
      sequence: currentSequence,
      serviceStatus: 'disabled',
      settings: {
        enabled: false,
        effectiveEnabled: false,
        source: 'default',
        scanRoots: [],
        pollIntervalMs: 1000,
        socketProbeTimeoutMs: 1000,
        staleSessionThresholdMs: 1000,
      },
      rootsScanned: [],
      summary: {
        totalSessions: 0,
        activeSessions: 0,
        inactiveSessions: 0,
        staleSessions: 0,
        errorSessions: 0,
      },
      sessions: [],
      warnings: [],
      lastError: null,
    }),
    getSettings: () => ({
      enabled: false,
      effectiveEnabled: false,
      source: 'default',
      scanRoots: [],
      pollIntervalMs: 1000,
      socketProbeTimeoutMs: 1000,
      staleSessionThresholdMs: 1000,
    }),
    setSequence: (next: number) => {
      currentSequence = next
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
    const playwrightDiscovery = createPlaywrightDiscoveryStub(7)
    const socket = createSocket()
    const sentEvents: ServerEvent[] = []
    const subscriptions = new WsSubscriptions({
      swarmManager: manager as any,
      integrationRegistry: null,
      playwrightDiscovery: playwrightDiscovery as any,
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
      'playwright_discovery_snapshot',
      'playwright_discovery_settings_updated',
      'conversation_history',
      'pending_choices_snapshot',
      'terminals_snapshot',
    ])

    sentEvents.length = 0
    await subscriptions.handleSubscribe(socket, 'session-1')

    expect(getEventTypes(sentEvents)).toEqual([
      'ready',
      'conversation_history',
      'pending_choices_snapshot',
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
      playwrightDiscovery: null,
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
    const playwrightDiscovery = createPlaywrightDiscoveryStub(2)
    const socket = createSocket()
    const sentEvents: ServerEvent[] = []
    const subscriptions = new WsSubscriptions({
      swarmManager: manager as any,
      integrationRegistry: null,
      playwrightDiscovery: playwrightDiscovery as any,
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
    playwrightDiscovery.setSequence(3)
    subscriptions.broadcastToSubscribed({
      type: 'playwright_discovery_updated',
      snapshot: playwrightDiscovery.getSnapshot(),
    })

    sentEvents.length = 0
    await subscriptions.handleSubscribe(socket, 'session-1')

    expect(getEventTypes(sentEvents)).toEqual([
      'ready',
      'conversation_history',
      'pending_choices_snapshot',
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
      playwrightDiscovery: null,
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
      playwrightDiscovery: null,
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
      playwrightDiscovery: null,
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
    expect(getEventTypes(sentEvents)).toContain('ready')
    expect(getEventTypes(sentEvents)).toContain('agents_snapshot')
    expect(getEventTypes(sentEvents)).toContain('profiles_snapshot')
  })
})
