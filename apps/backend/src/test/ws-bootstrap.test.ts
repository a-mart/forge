import { describe, expect, it, vi } from 'vitest'
import type { ServerEvent } from '@forge/protocol'
import {
  SIDEBAR_BOOTSTRAP_METRIC,
  SIDEBAR_SNAPSHOT_BUILD_METRIC,
} from '../stats/sidebar-perf-metrics.js'
import type { SidebarPerfRecorder } from '../stats/sidebar-perf-types.js'
import { sendSubscriptionBootstrap } from '../ws/ws-bootstrap.js'

function createPerfStub(): SidebarPerfRecorder {
  return {
    recordDuration: vi.fn(),
    increment: vi.fn(),
    readSummary: vi.fn(() => ({ histograms: {}, counters: {} })),
    readRecentSlowEvents: vi.fn(() => []),
  }
}

function createTaskSnapshotEvent(agentId: string): Extract<ServerEvent, { type: 'session_task_state_snapshot' }> {
  return {
    type: 'session_task_state_snapshot',
    sessionAgentId: agentId,
    profileId: 'profile-1',
    revision: 0,
    activeWorkPlan: null,
    recentWorkPlans: [],
    recentWorkPlanCount: 0,
    recentWorkPlansTruncated: false,
    diagnostics: { state: 'defaulted' },
  }
}

function createModelCacheObservationEvent(agentId: string): Extract<ServerEvent, { type: 'model_cache_observation' }> {
  return {
    type: 'model_cache_observation',
    agentId,
    id: 'cache-obs-1',
    timestamp: '2026-01-01T00:00:00.000Z',
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
  }
}

describe('sendSubscriptionBootstrap', () => {
  it('records sidebar.bootstrap once with diagnostics from the current history load', async () => {
    const perf = createPerfStub()
    const send = vi.fn((_: unknown, event: ServerEvent) => Buffer.byteLength(JSON.stringify(event), 'utf8'))
    const historyResult = {
      history: [
        {
          type: 'conversation_message',
          agentId: 'manager-1',
          role: 'assistant',
          text: 'persisted history',
          timestamp: '2026-01-01T00:00:00.000Z',
          source: 'system',
        },
      ],
      diagnostics: {
        cacheState: 'metadata_entries_mismatch' as const,
        historySource: 'cache_rebuild' as const,
        coldLoad: true,
        fsReadOps: 2,
        fsReadBytes: 256,
        sessionFileBytes: 128,
        cacheFileBytes: 64,
        persistedEntryCount: 1,
        cachedEntryCount: 1,
        sessionSummaryBytesScanned: 128,
        cacheReadMs: 1,
        sessionSummaryReadMs: 2,
        detail: 'fixture',
      },
    }

    const swarmManager = {
      listBootstrapAgents: () => [
        {
          agentId: 'manager-1',
          displayName: 'Manager',
          role: 'manager',
          managerId: 'manager-1',
          status: 'idle',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: '/tmp',
          model: {
            provider: 'openai-codex',
            modelId: 'gpt-5.5',
            thinkingLevel: 'medium',
          },
          sessionFile: '/tmp/manager-1.jsonl',
        },
      ],
      listProfiles: () => [],
      getConversationHistoryWithDiagnostics: vi.fn(() => historyResult),
      getPendingChoiceIdsForSession: vi.fn(() => ['choice-1']),
      getPendingChoiceRequestsForSession: vi.fn(() => [
        {
          type: 'choice_request' as const,
          agentId: 'worker-1',
          sessionAgentId: 'manager-1',
          choiceId: 'choice-1',
          questions: [{ id: 'q1', question: 'Pick one', options: [{ id: 'a', label: 'A' }] }],
          status: 'pending' as const,
          timestamp: '2026-01-01T00:00:00.000Z',
        },
      ]),
      getSessionTaskStateSnapshot: vi.fn(async (agentId: string) => createTaskSnapshotEvent(agentId)),
    } as any

    const result = await sendSubscriptionBootstrap({
      socket: {} as any,
      targetAgentId: 'manager-1',
      swarmManager,
      integrationRegistry: null,
      terminalService: null,
      unreadTracker: null,
      perf,
      send,
      resolveTerminalScopeAgentId: () => undefined,
      resolveManagerContextAgentId: () => undefined,
      resolveTaskSnapshotSessionAgentId: (agentId) => agentId,
    })

    const recordDuration = vi.mocked(perf.recordDuration)
    const bootstrapCalls = recordDuration.mock.calls.filter(([metricName]) => metricName === SIDEBAR_BOOTSTRAP_METRIC)
    expect(bootstrapCalls).toHaveLength(1)
    expect(recordDuration.mock.calls.some(([metricName]) => metricName === SIDEBAR_SNAPSHOT_BUILD_METRIC)).toBe(true)

    const [, durationMs, bootstrapOptions] = bootstrapCalls[0]
    expect(durationMs).toBeGreaterThanOrEqual(0)
    expect(bootstrapOptions?.labels).toMatchObject({
      historySource: 'cache_rebuild',
      cacheState: 'metadata_entries_mismatch',
    })
    expect(bootstrapOptions?.fields).toMatchObject({
      targetAgentId: 'manager-1',
      historyDetail: 'fixture',
      historyEntriesReturned: 2,
      pendingChoiceCount: 1,
      snapshotSkipped: false,
    })
    const pendingChoicesSnapshot = vi
      .mocked(send)
      .mock.calls.find(([, event]) => (event as ServerEvent).type === 'pending_choices_snapshot')?.[1] as
      | Extract<ServerEvent, { type: 'pending_choices_snapshot' }>
      | undefined
    expect(pendingChoicesSnapshot).toMatchObject({
      type: 'pending_choices_snapshot',
      agentId: 'manager-1',
      choiceIds: ['choice-1'],
      choices: [
        expect.objectContaining({
          type: 'choice_request',
          agentId: 'worker-1',
          sessionAgentId: 'manager-1',
          choiceId: 'choice-1',
          status: 'pending',
        }),
      ],
    })
    expect(bootstrapOptions?.fields).not.toHaveProperty('agentId')
    expect(send).toHaveBeenCalledTimes(8)
    expect(result).toEqual({
      agentsSnapshotSent: true,
      profilesSnapshotSent: true,
    })
  })

  it('filters model cache observations from bootstrap while visualization is disabled', async () => {
    const sentEvents: ServerEvent[] = []
    const history = [
      {
        type: 'conversation_message' as const,
        agentId: 'manager-1',
        role: 'assistant' as const,
        text: 'persisted history',
        timestamp: '2026-01-01T00:00:00.000Z',
        source: 'system' as const,
      },
      createModelCacheObservationEvent('manager-1'),
    ]

    await sendSubscriptionBootstrap({
      socket: {} as any,
      targetAgentId: 'manager-1',
      swarmManager: {
        listBootstrapAgents: () => [],
        listProfiles: () => [],
        getConversationHistoryWithDiagnostics: () => ({
          history,
          diagnostics: {
            cacheState: 'hit' as const,
            historySource: 'cache_hit' as const,
            coldLoad: false,
            fsReadOps: 0,
            fsReadBytes: 0,
            sessionFileBytes: 0,
            cacheFileBytes: 0,
            persistedEntryCount: history.length,
            cachedEntryCount: history.length,
            sessionSummaryBytesScanned: 0,
            cacheReadMs: 0,
            sessionSummaryReadMs: 0,
            detail: undefined,
          },
        }),
        getPendingChoiceIdsForSession: () => [],
        getPendingChoiceRequestsForSession: () => [],
        getSessionTaskStateSnapshot: async (agentId: string) => createTaskSnapshotEvent(agentId),
        isModelCacheVisualizationEnabled: () => false,
      } as any,
      integrationRegistry: null,
      terminalService: null,
      unreadTracker: null,
      perf: createPerfStub(),
      send: (_socket, event) => {
        sentEvents.push(event)
        return Buffer.byteLength(JSON.stringify(event), 'utf8')
      },
      resolveTerminalScopeAgentId: () => undefined,
      resolveManagerContextAgentId: () => undefined,
      resolveTaskSnapshotSessionAgentId: () => undefined,
    })

    const conversationHistoryEvent = sentEvents.find(
      (event): event is Extract<ServerEvent, { type: 'conversation_history' }> => event.type === 'conversation_history',
    )
    expect(conversationHistoryEvent?.messages).toHaveLength(1)
    expect(conversationHistoryEvent?.messages.some((entry) => entry.type === 'model_cache_observation')).toBe(false)
  })

  it('includes model cache observations in bootstrap while visualization is enabled', async () => {
    const sentEvents: ServerEvent[] = []
    const modelCacheObservation = createModelCacheObservationEvent('manager-1')
    const history = [
      {
        type: 'conversation_message' as const,
        agentId: 'manager-1',
        role: 'assistant' as const,
        text: 'persisted history',
        timestamp: '2026-01-01T00:00:00.000Z',
        source: 'system' as const,
      },
      modelCacheObservation,
    ]

    await sendSubscriptionBootstrap({
      socket: {} as any,
      targetAgentId: 'manager-1',
      swarmManager: {
        listBootstrapAgents: () => [],
        listProfiles: () => [],
        getConversationHistoryWithDiagnostics: () => ({
          history,
          diagnostics: {
            cacheState: 'hit' as const,
            historySource: 'cache_hit' as const,
            coldLoad: false,
            fsReadOps: 0,
            fsReadBytes: 0,
            sessionFileBytes: 0,
            cacheFileBytes: 0,
            persistedEntryCount: history.length,
            cachedEntryCount: history.length,
            sessionSummaryBytesScanned: 0,
            cacheReadMs: 0,
            sessionSummaryReadMs: 0,
            detail: undefined,
          },
        }),
        getPendingChoiceIdsForSession: () => [],
        getPendingChoiceRequestsForSession: () => [],
        getSessionTaskStateSnapshot: async (agentId: string) => createTaskSnapshotEvent(agentId),
        isModelCacheVisualizationEnabled: () => true,
      } as any,
      integrationRegistry: null,
      terminalService: null,
      unreadTracker: null,
      perf: createPerfStub(),
      send: (_socket, event) => {
        sentEvents.push(event)
        return Buffer.byteLength(JSON.stringify(event), 'utf8')
      },
      resolveTerminalScopeAgentId: () => undefined,
      resolveManagerContextAgentId: () => undefined,
      resolveTaskSnapshotSessionAgentId: () => undefined,
    })

    const conversationHistoryEvent = sentEvents.find(
      (event): event is Extract<ServerEvent, { type: 'conversation_history' }> => event.type === 'conversation_history',
    )
    expect(conversationHistoryEvent?.messages).toEqual(expect.arrayContaining([modelCacheObservation]))
  })

  it('prioritizes visible transcript entries for oversized bootstrap history and records matching metrics', async () => {
    const perf = createPerfStub()
    const send = vi.fn((_: unknown, event: ServerEvent) => Buffer.byteLength(JSON.stringify(event), 'utf8'))
    const bigText = 'x'.repeat(20_000)
    const history = [
      ...Array.from({ length: 80 }, (_, index) => ({
        type: 'agent_tool_call' as const,
        agentId: 'manager-1',
        actorAgentId: 'worker-1',
        timestamp: '2026-01-01T00:00:00.000Z',
        kind: 'tool_execution_update' as const,
        text: `activity-${index}:${bigText}`,
      })),
      {
        type: 'conversation_message' as const,
        agentId: 'manager-1',
        role: 'user' as const,
        text: 'visible-user',
        timestamp: '2026-01-01T00:00:00.000Z',
        source: 'user_input' as const,
      },
      {
        type: 'choice_request' as const,
        agentId: 'manager-1',
        choiceId: 'visible-choice',
        questions: [],
        status: 'pending' as const,
        timestamp: '2026-01-01T00:00:00.000Z',
      },
      {
        type: 'conversation_message' as const,
        agentId: 'manager-1',
        role: 'assistant' as const,
        text: 'visible-assistant',
        timestamp: '2026-01-01T00:00:00.000Z',
        source: 'speak_to_user' as const,
      },
    ]
    const swarmManager = {
      listBootstrapAgents: vi.fn(() => []),
      listProfiles: vi.fn(() => []),
      getConversationHistoryWithDiagnostics: vi.fn(() => ({
        history,
        diagnostics: {
          cacheState: 'hit' as const,
          historySource: 'cache_hit' as const,
          coldLoad: false,
          fsReadOps: 0,
          fsReadBytes: 0,
          sessionFileBytes: 0,
          cacheFileBytes: 0,
          persistedEntryCount: history.length,
          cachedEntryCount: history.length,
          sessionSummaryBytesScanned: 0,
          cacheReadMs: 0,
          sessionSummaryReadMs: 0,
          detail: undefined,
        },
      })),
      getPendingChoiceIdsForSession: vi.fn(() => []),
      getPendingChoiceRequestsForSession: vi.fn(() => []),
      getSessionTaskStateSnapshot: vi.fn(async (agentId: string) => createTaskSnapshotEvent(agentId)),
    } as any

    await sendSubscriptionBootstrap({
      socket: {} as any,
      targetAgentId: 'manager-1',
      swarmManager,
      integrationRegistry: null,
      terminalService: null,
      unreadTracker: null,
      perf,
      send,
      resolveTerminalScopeAgentId: () => undefined,
      resolveManagerContextAgentId: () => undefined,
      resolveTaskSnapshotSessionAgentId: (agentId) => agentId,
    })

    const conversationHistoryEvent = send.mock.calls
      .map(([, event]) => event)
      .find((event): event is Extract<ServerEvent, { type: 'conversation_history' }> => event.type === 'conversation_history')
    expect(conversationHistoryEvent).toBeDefined()
    expect(conversationHistoryEvent?.messages.length).toBeLessThan(history.length)
    expect(conversationHistoryEvent?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'conversation_message', text: 'visible-user' }),
      expect.objectContaining({ type: 'choice_request', choiceId: 'visible-choice' }),
      expect.objectContaining({ type: 'conversation_message', text: 'visible-assistant' }),
    ]))
    expect(conversationHistoryEvent?.messages.some((entry) => 'text' in entry && entry.text.startsWith('activity-0:'))).toBe(false)

    const recordDuration = vi.mocked(perf.recordDuration)
    const bootstrapCalls = recordDuration.mock.calls.filter(([metricName]) => metricName === SIDEBAR_BOOTSTRAP_METRIC)
    expect(bootstrapCalls).toHaveLength(1)
    expect(bootstrapCalls[0][2]?.fields).toMatchObject({
      historyEntriesReturned: conversationHistoryEvent?.messages.length,
      persistedEntryCount: history.length,
      cachedEntryCount: history.length,
    })
  })

  it('records skipped snapshot metrics when connection-scoped snapshots are omitted', async () => {
    const perf = createPerfStub()
    const send = vi.fn((_: unknown, event: ServerEvent) => Buffer.byteLength(JSON.stringify(event), 'utf8'))
    const swarmManager = {
      listBootstrapAgents: vi.fn(() => []),
      listProfiles: vi.fn(() => []),
      getConversationHistoryWithDiagnostics: vi.fn(() => ({
        history: [],
        diagnostics: {
          cacheState: 'hit' as const,
          historySource: 'cache_hit' as const,
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
      })),
      getPendingChoiceIdsForSession: vi.fn(() => []),
      getPendingChoiceRequestsForSession: vi.fn(() => []),
      getSessionTaskStateSnapshot: vi.fn(async (agentId: string) => createTaskSnapshotEvent(agentId)),
    } as any

    const result = await sendSubscriptionBootstrap({
      socket: {} as any,
      targetAgentId: 'manager-1',
      swarmManager,
      integrationRegistry: null,
      terminalService: null,
      unreadTracker: null,
      perf,
      send,
      resolveTerminalScopeAgentId: () => undefined,
      resolveManagerContextAgentId: () => undefined,
      resolveTaskSnapshotSessionAgentId: (agentId) => agentId,
      includeAgentsSnapshot: false,
      includeProfilesSnapshot: false,
    })

    const recordDuration = vi.mocked(perf.recordDuration)
    const bootstrapCalls = recordDuration.mock.calls.filter(([metricName]) => metricName === SIDEBAR_BOOTSTRAP_METRIC)
    expect(bootstrapCalls).toHaveLength(1)
    expect(recordDuration.mock.calls.some(([metricName]) => metricName === SIDEBAR_SNAPSHOT_BUILD_METRIC)).toBe(false)

    const [, , bootstrapOptions] = bootstrapCalls[0]
    expect(bootstrapOptions?.fields).toMatchObject({
      snapshotSkipped: true,
      agentsSnapshotBuildMs: 0,
      agentsSnapshotPayloadBytes: 0,
      profilesSnapshotBuildMs: 0,
      profilesSnapshotPayloadBytes: 0,
    })
    expect(send).toHaveBeenCalledTimes(6)
    expect(result).toEqual({
      agentsSnapshotSent: false,
      profilesSnapshotSent: false,
    })
  })

  it('sends session_task_state_snapshot after pending choices and before terminals', async () => {
    const sentEvents: ServerEvent[] = []
    await sendSubscriptionBootstrap({
      socket: {} as any,
      targetAgentId: 'manager-1',
      swarmManager: {
        listBootstrapAgents: () => [],
        listProfiles: () => [],
        getConversationHistoryWithDiagnostics: () => ({
          history: [],
          diagnostics: {
            cacheState: 'hit' as const,
            historySource: 'cache_hit' as const,
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
        getPendingChoiceIdsForSession: () => ['choice-1'],
        getPendingChoiceRequestsForSession: () => [
          {
            type: 'choice_request' as const,
            agentId: 'worker-1',
            sessionAgentId: 'manager-1',
            choiceId: 'choice-1',
            questions: [{ id: 'q1', question: 'Worker choice?', options: [{ id: 'a', label: 'A' }] }],
            status: 'pending' as const,
            timestamp: '2026-01-01T00:00:00.000Z',
          },
        ],
        getSessionTaskStateSnapshot: async (agentId: string) => ({
          ...createTaskSnapshotEvent(agentId),
          revision: 7,
        }),
      } as any,
      integrationRegistry: null,
      terminalService: null,
      unreadTracker: null,
      perf: createPerfStub(),
      send: (_socket, event) => {
        sentEvents.push(event)
        return Buffer.byteLength(JSON.stringify(event), 'utf8')
      },
      resolveTerminalScopeAgentId: () => undefined,
      resolveManagerContextAgentId: () => undefined,
      resolveTaskSnapshotSessionAgentId: (agentId) => agentId,
    })

    expect(sentEvents.map((event) => event.type)).toEqual([
      'ready',
      'agents_snapshot',
      'profiles_snapshot',
      'conversation_history',
      'pending_choices_snapshot',
      'restart_recovery_snapshot',
      'session_task_state_snapshot',
      'terminals_snapshot',
    ])
    expect(sentEvents[4]).toMatchObject({
      type: 'pending_choices_snapshot',
      agentId: 'manager-1',
      choiceIds: ['choice-1'],
      choices: [
        expect.objectContaining({
          agentId: 'worker-1',
          sessionAgentId: 'manager-1',
          choiceId: 'choice-1',
        }),
      ],
    })
    expect(sentEvents[6]).toMatchObject({
      type: 'session_task_state_snapshot',
      sessionAgentId: 'manager-1',
      revision: 7,
      activeWorkPlan: null,
      recentWorkPlans: [],
      diagnostics: { state: 'defaulted' },
    })
  })

  it('skips session_task_state_snapshot for non-session bootstrap targets', async () => {
    const sentEvents: ServerEvent[] = []
    const getSessionTaskStateSnapshot = vi.fn(async (agentId: string) => createTaskSnapshotEvent(agentId))

    await sendSubscriptionBootstrap({
      socket: {} as any,
      targetAgentId: '__bootstrap_manager__',
      swarmManager: {
        listBootstrapAgents: () => [],
        listProfiles: () => [],
        getConversationHistoryWithDiagnostics: () => ({
          history: [],
          diagnostics: {
            cacheState: 'hit' as const,
            historySource: 'cache_hit' as const,
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
      } as any,
      integrationRegistry: null,
      terminalService: null,
      unreadTracker: null,
      perf: createPerfStub(),
      send: (_socket, event) => {
        sentEvents.push(event)
        return Buffer.byteLength(JSON.stringify(event), 'utf8')
      },
      resolveTerminalScopeAgentId: () => undefined,
      resolveManagerContextAgentId: () => undefined,
      resolveTaskSnapshotSessionAgentId: () => undefined,
    })

    expect(getSessionTaskStateSnapshot).not.toHaveBeenCalled()
    expect(sentEvents.map((event) => event.type)).toEqual([
      'ready',
      'agents_snapshot',
      'profiles_snapshot',
      'conversation_history',
      'pending_choices_snapshot',
      'restart_recovery_snapshot',
      'terminals_snapshot',
    ])
  })

  it('falls back to pending choice ids when full pending requests are unavailable', async () => {
    const sentEvents: ServerEvent[] = []

    await sendSubscriptionBootstrap({
      socket: {} as any,
      targetAgentId: 'manager-1',
      swarmManager: {
        listBootstrapAgents: () => [],
        listProfiles: () => [],
        getConversationHistoryWithDiagnostics: () => ({
          history: [],
          diagnostics: {
            cacheState: 'hit' as const,
            historySource: 'cache_hit' as const,
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
        getPendingChoiceRequestsForSession: () => [],
        getPendingChoiceIdsForSession: () => ['legacy-choice-1'],
        getSessionTaskStateSnapshot: async (agentId: string) => createTaskSnapshotEvent(agentId),
      } as any,
      integrationRegistry: null,
      terminalService: null,
      unreadTracker: null,
      perf: createPerfStub(),
      send: (_socket, event) => {
        sentEvents.push(event)
        return Buffer.byteLength(JSON.stringify(event), 'utf8')
      },
      resolveTerminalScopeAgentId: () => undefined,
      resolveManagerContextAgentId: () => undefined,
      resolveTaskSnapshotSessionAgentId: (agentId) => agentId,
    })

    expect(sentEvents.find((event) => event.type === 'pending_choices_snapshot')).toEqual({
      type: 'pending_choices_snapshot',
      agentId: 'manager-1',
      choiceIds: ['legacy-choice-1'],
    })
  })
})
