import type { ManagerProfile, ServerEvent } from '@forge/protocol'
import { describe, expect, it } from 'vitest'
import { WebSocket, type WebSocketServer } from 'ws'
import type { AgentDescriptor } from '../swarm/types.js'
import type { SwarmManager } from '../swarm/swarm-manager.js'
import type { SidebarPerfRecorder } from '../stats/sidebar-perf-types.js'
import { filterBuilderVisibleAgents } from '../ws/builder-visibility.js'
import { sendSubscriptionBootstrap } from '../ws/ws-bootstrap.js'
import { WsSubscriptions } from '../ws/ws-subscriptions.js'

const TEST_TIMESTAMP = '2026-01-01T00:00:00.000Z'
const TEST_CWD = '/tmp/forge-builder-visibility'
const NOOP_PERF_RECORDER: SidebarPerfRecorder = {
  recordDuration: () => {},
  increment: () => {},
  readSummary: () => ({ histograms: {}, counters: {} }),
  readRecentSlowEvents: () => [],
}

class FakeBootstrapSwarmManager {
  constructor(
    private readonly agents: AgentDescriptor[],
    private readonly profiles: ManagerProfile[],
  ) {}

  listBootstrapAgents(): AgentDescriptor[] {
    return this.agents.map((agent) => ({ ...agent }))
  }

  listProfiles(): ManagerProfile[] {
    return this.profiles.map((profile) => ({ ...profile }))
  }

  listUserProfiles(): ManagerProfile[] {
    return this.profiles.filter((profile) => profile.profileType !== 'system').map((profile) => ({ ...profile }))
  }

  getConversationHistory(): [] {
    return []
  }

  getConversationHistoryWithDiagnostics(): {
    history: []
    diagnostics: {
      cacheState: 'memory'
      historySource: 'memory'
      coldLoad: false
      fsReadOps: 0
      fsReadBytes: 0
      detail: 'test'
    }
  } {
    return {
      history: [],
      diagnostics: {
        cacheState: 'memory',
        historySource: 'memory',
        coldLoad: false,
        fsReadOps: 0,
        fsReadBytes: 0,
        detail: 'test',
      },
    }
  }

  getPendingChoiceIdsForSession(): [] {
    return []
  }
}

function createProfile(overrides: Partial<ManagerProfile> & Pick<ManagerProfile, 'profileId'>): ManagerProfile {
  return {
    profileId: overrides.profileId,
    displayName: overrides.displayName ?? overrides.profileId,
    defaultSessionAgentId: overrides.defaultSessionAgentId ?? `${overrides.profileId}-session`,
    defaultModel: overrides.defaultModel ?? {
      provider: 'openai-codex',
      modelId: 'gpt-5.3-codex',
      thinkingLevel: 'medium',
    },
    createdAt: overrides.createdAt ?? TEST_TIMESTAMP,
    updatedAt: overrides.updatedAt ?? TEST_TIMESTAMP,
    ...(overrides.profileType ? { profileType: overrides.profileType } : {}),
    ...(overrides.sortOrder !== undefined ? { sortOrder: overrides.sortOrder } : {}),
  }
}

function createAgent(overrides: Partial<AgentDescriptor> & Pick<AgentDescriptor, 'agentId'>): AgentDescriptor {
  const agentId = overrides.agentId

  return {
    agentId,
    displayName: overrides.displayName ?? agentId,
    role: overrides.role ?? 'manager',
    managerId: overrides.managerId ?? agentId,
    status: overrides.status ?? 'idle',
    createdAt: overrides.createdAt ?? TEST_TIMESTAMP,
    updatedAt: overrides.updatedAt ?? TEST_TIMESTAMP,
    cwd: overrides.cwd ?? TEST_CWD,
    model: overrides.model ?? {
      provider: 'openai-codex',
      modelId: 'gpt-5.3-codex',
      thinkingLevel: 'medium',
    },
    sessionFile: overrides.sessionFile ?? `${TEST_CWD}/${agentId}.jsonl`,
    ...(overrides.profileId ? { profileId: overrides.profileId } : {}),
    ...overrides,
  }
}

function createBroadcastHarness(profiles: ManagerProfile[]): {
  socket: WebSocket
  sentEvents: ServerEvent[]
  subscriptions: WsSubscriptions
} {
  const socket = { readyState: WebSocket.OPEN } as WebSocket
  const sentEvents: ServerEvent[] = []
  const swarmManager = {
    listProfiles: () => profiles.map((profile) => ({ ...profile })),
    getAgentsSnapshotVersion: () => 0,
    getProfilesSnapshotVersion: () => 0,
  } as unknown as SwarmManager

  const subscriptions = new WsSubscriptions({
    swarmManager,
    integrationRegistry: null,
    playwrightDiscovery: null,
    allowNonManagerSubscriptions: true,
    terminalService: null,
    unreadTracker: null,
    perf: NOOP_PERF_RECORDER,
    send: (_socket, event) => {
      sentEvents.push(event)
    },
    getServer: () => ({ clients: new Set([socket]) }) as unknown as WebSocketServer,
  })

  subscriptions.subscriptions.set(socket, 'manager')

  return { socket, sentEvents, subscriptions }
}

describe('Builder visibility filtering', () => {
  it('includes Cortex while hiding collaboration/system entries from Builder bootstrap snapshots', () => {
    const userProfile = createProfile({ profileId: 'manager' })
    const cortexProfile = createProfile({ profileId: 'cortex', profileType: 'system' })
    const collaborationProfile = createProfile({ profileId: '_collaboration', profileType: 'system' })
    const builderManager = createAgent({
      agentId: 'manager',
      profileId: userProfile.profileId,
    })
    const cortexRootSession = createAgent({
      agentId: 'cortex',
      profileId: cortexProfile.profileId,
    })
    const cortexReviewSession = createAgent({
      agentId: 'cortex--review',
      profileId: cortexProfile.profileId,
      sessionPurpose: 'cortex_review',
    })
    const collaborationSession = createAgent({
      agentId: '_collaboration',
      profileId: collaborationProfile.profileId,
    })
    const collabSurfaceSession = {
      ...createAgent({
        agentId: 'manager--collab',
        profileId: userProfile.profileId,
      }),
      sessionSurface: 'collab' as const,
    } as AgentDescriptor
    const userProfileSession = createAgent({
      agentId: 'manager--s2',
      profileId: userProfile.profileId,
    })
    const sentEvents: ServerEvent[] = []

    sendSubscriptionBootstrap({
      socket: {} as WebSocket,
      targetAgentId: builderManager.agentId,
      swarmManager: new FakeBootstrapSwarmManager(
        [builderManager, cortexRootSession, cortexReviewSession, collaborationSession, collabSurfaceSession, userProfileSession],
        [userProfile, cortexProfile, collaborationProfile],
      ) as never,
      integrationRegistry: null,
      playwrightDiscovery: null,
      terminalService: null,
      unreadTracker: null,
      perf: NOOP_PERF_RECORDER,
      send: (_socket, event) => {
        sentEvents.push(event)
      },
      resolveTerminalScopeAgentId: () => undefined,
      resolveManagerContextAgentId: () => undefined,
    })

    const agentsSnapshot = sentEvents.find((event) => event.type === 'agents_snapshot')
    expect(agentsSnapshot?.type).toBe('agents_snapshot')
    if (!agentsSnapshot || agentsSnapshot.type !== 'agents_snapshot') {
      throw new Error('Expected agents_snapshot event')
    }
    expect(agentsSnapshot.agents.map((agent) => agent.agentId)).toEqual([
      'manager',
      'cortex',
      'cortex--review',
      'manager--s2',
    ])

    const profilesSnapshot = sentEvents.find((event) => event.type === 'profiles_snapshot')
    expect(profilesSnapshot?.type).toBe('profiles_snapshot')
    if (!profilesSnapshot || profilesSnapshot.type !== 'profiles_snapshot') {
      throw new Error('Expected profiles_snapshot event')
    }
    expect(profilesSnapshot.profiles.map((profile) => profile.profileId)).toEqual(['manager', 'cortex'])
  })

  it('includes Cortex while hiding collaboration/system sessions from live agents_snapshot broadcasts', () => {
    const userProfile = createProfile({ profileId: 'manager' })
    const cortexProfile = createProfile({ profileId: 'cortex', profileType: 'system' })
    const collaborationProfile = createProfile({ profileId: '_collaboration', profileType: 'system' })
    const builderManager = createAgent({
      agentId: 'manager',
      profileId: userProfile.profileId,
    })
    const cortexRootSession = createAgent({
      agentId: 'cortex',
      profileId: cortexProfile.profileId,
    })
    const cortexReviewSession = createAgent({
      agentId: 'cortex--review',
      profileId: cortexProfile.profileId,
      sessionPurpose: 'cortex_review',
    })
    const collaborationSession = createAgent({
      agentId: '_collaboration',
      profileId: collaborationProfile.profileId,
    })
    const collabSurfaceSession = {
      ...createAgent({
        agentId: 'manager--collab',
        profileId: userProfile.profileId,
      }),
      sessionSurface: 'collab' as const,
    } as AgentDescriptor
    const userProfileSession = createAgent({
      agentId: 'manager--s2',
      profileId: userProfile.profileId,
    })
    const { sentEvents, subscriptions } = createBroadcastHarness([userProfile, cortexProfile, collaborationProfile])

    const event: ServerEvent = {
      type: 'agents_snapshot',
      agents: [builderManager, cortexRootSession, cortexReviewSession, collaborationSession, collabSurfaceSession, userProfileSession],
    }

    subscriptions.broadcastToSubscribed(event)

    expect(event.type).toBe('agents_snapshot')
    if (event.type !== 'agents_snapshot') {
      throw new Error('Expected agents_snapshot test event')
    }
    expect(event.agents.map((agent) => agent.agentId)).toEqual([
      'manager',
      'cortex',
      'cortex--review',
      '_collaboration',
      'manager--collab',
      'manager--s2',
    ])

    const snapshot = sentEvents[0]
    expect(snapshot?.type).toBe('agents_snapshot')
    if (!snapshot || snapshot.type !== 'agents_snapshot') {
      throw new Error('Expected filtered agents_snapshot event')
    }
    expect(snapshot.agents.map((agent) => agent.agentId)).toEqual([
      'manager',
      'cortex',
      'cortex--review',
      'manager--s2',
    ])
  })

  it('includes Cortex while hiding collaboration/system profiles from live profiles_snapshot broadcasts', () => {
    const userProfile = createProfile({ profileId: 'manager' })
    const cortexProfile = createProfile({ profileId: 'cortex', profileType: 'system' })
    const collaborationProfile = createProfile({ profileId: '_collaboration', profileType: 'system' })
    const { sentEvents, subscriptions } = createBroadcastHarness([userProfile, cortexProfile, collaborationProfile])

    subscriptions.broadcastToSubscribed({
      type: 'profiles_snapshot',
      profiles: [userProfile, cortexProfile, collaborationProfile],
    })

    const snapshot = sentEvents[0]
    expect(snapshot?.type).toBe('profiles_snapshot')
    if (!snapshot || snapshot.type !== 'profiles_snapshot') {
      throw new Error('Expected filtered profiles_snapshot event')
    }
    expect(snapshot.profiles.map((profile) => profile.profileId)).toEqual(['manager', 'cortex'])
  })

  it('keeps Builder sessions visible while hiding collab-surface and non-Cortex system sessions', () => {
    const builderManager = createAgent({
      agentId: 'manager',
      profileId: 'manager',
    })
    const siblingSession = createAgent({
      agentId: 'manager--s2',
      profileId: 'manager',
    })
    const cortexSession = createAgent({
      agentId: 'cortex',
      profileId: 'cortex',
    })
    const collaborationSession = createAgent({
      agentId: '_collaboration',
      profileId: '_collaboration',
    })
    const collabSurfaceSession = {
      ...createAgent({
        agentId: 'manager--collab',
        profileId: 'manager',
      }),
      sessionSurface: 'collab' as const,
    } as AgentDescriptor

    const visible = filterBuilderVisibleAgents(
      [builderManager, siblingSession, cortexSession, collaborationSession, collabSurfaceSession],
      new Set(['cortex', '_collaboration']),
    )

    expect(visible.map((agent) => agent.agentId)).toEqual(['manager', 'manager--s2', 'cortex'])
    expect(visible.some((agent) => agent.profileId === '_collaboration')).toBe(false)
    expect(visible.some((agent) => (agent as { sessionSurface?: string }).sessionSurface === 'collab')).toBe(false)
  })
})
