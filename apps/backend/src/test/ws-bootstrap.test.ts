import { describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import type { ServerEvent } from '@forge/protocol'
import {
  SIDEBAR_BOOTSTRAP_METRIC,
  SIDEBAR_SNAPSHOT_BUILD_METRIC,
} from '../stats/sidebar-perf-metrics.js'
import type { SidebarPerfRecorder } from '../stats/sidebar-perf-types.js'
import { sendSubscriptionBootstrap } from '../ws/ws-bootstrap.js'
import {
  MAX_WS_BUFFERED_AMOUNT_BYTES,
  sendWsEventWithBackpressure,
} from '../ws/ws-send.js'

function createPerfStub(): SidebarPerfRecorder {
  return {
    recordDuration: vi.fn(),
    increment: vi.fn(),
    readSummary: vi.fn(() => ({ histograms: {}, counters: {} })),
    readRecentSlowEvents: vi.fn(() => []),
  }
}

function createPlanSnapshotEvent(agentId: string): Extract<ServerEvent, { type: 'session_plan_snapshot' }> {
  return {
    type: 'session_plan_snapshot',
    sessionAgentId: agentId,
    profileId: 'profile-1',
    revision: 0,
    updatedAt: '2026-07-12T00:00:00.000Z',
    plan: [],
    diagnostics: { state: 'defaulted' },
  }
}

function createGoalSnapshotEvent(agentId: string): Extract<ServerEvent, { type: 'session_goal_snapshot' }> {
  return {
    type: 'session_goal_snapshot',
    sessionAgentId: agentId,
    profileId: 'profile-1',
    revision: 0,
    measuredAt: '2026-07-12T00:00:00.000Z',
    goal: null,
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
  it('includes the selected idle worker when the global bootstrap list omits it', async () => {
    const sent: ServerEvent[] = []
    const manager = {
      agentId: 'manager-1',
      managerId: 'manager-1',
      displayName: 'Manager',
      role: 'manager' as const,
      status: 'idle' as const,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      cwd: '/tmp',
      model: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' as const },
      sessionFile: '/tmp/manager-1.jsonl',
    }
    const worker = {
      ...manager,
      agentId: 'worker-1',
      managerId: 'manager-1',
      displayName: 'Worker',
      role: 'worker' as const,
      sessionFile: '/tmp/worker-1.jsonl',
    }

    await sendSubscriptionBootstrap({
      socket: {} as WebSocket,
      targetAgentId: worker.agentId,
      supportsConversationPaging: true,
      swarmManager: {
        listBootstrapAgents: () => [manager],
        getAgent: (agentId: string) => agentId === worker.agentId ? worker : manager,
        listProfiles: () => [],
        getConversationHistoryPage: () => ({
          messages: [],
          page: {
            hasOlder: false,
            completeness: 'complete',
            source: 'canonical',
            sourceRevision: 'fixture',
            pageBytes: 0,
            scanBytes: 0,
          },
        }),
        getPendingChoiceIdsForSession: () => [],
        getPendingChoiceRequestsForSession: () => [],
        getSessionPlanSnapshot: async (agentId: string) => createPlanSnapshotEvent(agentId),
        getSessionGoalSnapshot: async (agentId: string) => createGoalSnapshotEvent(agentId),
      } as any,
      integrationRegistry: null,
      terminalService: null,
      unreadTracker: null,
      perf: createPerfStub(),
      send: (_socket, event) => {
        sent.push(event)
        return Buffer.byteLength(JSON.stringify(event), 'utf8')
      },
      resolveTerminalScopeAgentId: () => undefined,
      resolveManagerContextAgentId: () => undefined,
      resolvePlanSnapshotSessionAgentId: (agentId) => agentId,
    })

    const snapshot = sent.find(
      (event): event is Extract<ServerEvent, { type: 'agents_snapshot' }> =>
        event.type === 'agents_snapshot',
    )
    expect(snapshot?.agents.map((agent) => agent.agentId)).toEqual(['manager-1', 'worker-1'])
  })

  it('retains the legacy full-history bootstrap for clients that do not advertise paging', async () => {
    const sent: ServerEvent[] = []
    const legacyHistory = Array.from({ length: 350 }, (_, index) => ({
      type: 'conversation_message' as const,
      id: `legacy-${index}`,
      agentId: 'manager-1',
      role: 'assistant' as const,
      text: `legacy ${index}`,
      timestamp: new Date(index).toISOString(),
      source: 'system' as const,
    }))
    const getConversationHistoryWithDiagnostics = vi.fn(() => ({
      history: legacyHistory,
      diagnostics: {
        cacheState: 'memory' as const,
        historySource: 'memory' as const,
        coldLoad: false,
        fsReadOps: 0,
        fsReadBytes: 0,
        sessionFileBytes: 0,
        cacheFileBytes: 0,
        persistedEntryCount: legacyHistory.length,
        cachedEntryCount: legacyHistory.length,
        sessionSummaryBytesScanned: 0,
        cacheReadMs: 0,
        sessionSummaryReadMs: 0,
      },
    }))
    const getConversationHistoryPage = vi.fn(() => ({
      messages: legacyHistory.slice(-200),
      page: {
        hasOlder: true,
        nextCursor: 'cursor',
        completeness: 'complete' as const,
        source: 'canonical' as const,
        sourceRevision: 'fixture',
        pageBytes: 100,
        scanBytes: 200,
      },
    }))

    await sendSubscriptionBootstrap({
      socket: {} as WebSocket,
      targetAgentId: 'manager-1',
      supportsConversationPaging: false,
      swarmManager: {
        listBootstrapAgents: () => [],
        listProfiles: () => [],
        getConversationHistoryWithDiagnostics,
        getConversationHistoryPage,
        getPendingChoiceIdsForSession: () => [],
        getPendingChoiceRequestsForSession: () => [],
        getSessionPlanSnapshot: async (agentId: string) => createPlanSnapshotEvent(agentId),
        getSessionGoalSnapshot: async (agentId: string) => createGoalSnapshotEvent(agentId),
      } as any,
      integrationRegistry: null,
      terminalService: null,
      unreadTracker: null,
      perf: createPerfStub(),
      send: (_socket, event) => {
        sent.push(event)
        return Buffer.byteLength(JSON.stringify(event), 'utf8')
      },
      resolveTerminalScopeAgentId: () => undefined,
      resolveManagerContextAgentId: () => undefined,
      resolvePlanSnapshotSessionAgentId: () => undefined,
    })

    const historyEvent = sent.find(
      (event): event is Extract<ServerEvent, { type: 'conversation_history' }> =>
        event.type === 'conversation_history',
    )
    expect(getConversationHistoryWithDiagnostics).toHaveBeenCalledWith('manager-1')
    expect(getConversationHistoryPage).not.toHaveBeenCalled()
    expect(historyEvent?.messages).toHaveLength(350)
    expect(historyEvent).not.toHaveProperty('page')
  })

  it('projects absent-capability bootstrap history onto the bounded legacy entry union', async () => {
    const sent: ServerEvent[] = []
    const rawToolPayload = 'raw-secret-tool-payload'.repeat(100)
    const history = [
      {
        type: 'conversation_message' as const,
        id: 'ordinary-message',
        agentId: 'manager-1',
        role: 'assistant' as const,
        text: 'ordinary message',
        timestamp: '2026-01-01T00:00:00.000Z',
        source: 'system' as const,
      },
      {
        type: 'agent_tool_call' as const,
        timelineEntryId: 'terminal-tool-row',
        agentId: 'manager-1',
        actorAgentId: 'manager-1',
        timestamp: '2026-01-01T00:00:01.000Z',
        kind: 'tool_execution_end' as const,
        toolName: 'bash',
        toolCallId: 'tool-1',
        text: rawToolPayload,
      },
      {
        type: 'plan_summary' as const,
        id: 'plan-1',
        agentId: 'manager-1',
        timestamp: '2026-01-01T00:00:02.000Z',
        updatedAt: '2026-01-01T00:00:02.000Z',
        revision: 1,
        plan: [{ step: 'Ship compatibility shield', status: 'in_progress' as const }],
      },
      createModelCacheObservationEvent('manager-1'),
    ]

    await sendSubscriptionBootstrap({
      socket: {} as WebSocket,
      targetAgentId: 'manager-1',
      swarmManager: {
        listBootstrapAgents: () => [],
        listProfiles: () => [],
        getConversationHistoryWithDiagnostics: () => ({
          history,
          diagnostics: {
            cacheState: 'memory' as const,
            historySource: 'memory' as const,
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
          },
        }),
        getPendingChoiceIdsForSession: () => [],
        getPendingChoiceRequestsForSession: () => [],
        getSessionPlanSnapshot: async (agentId: string) => createPlanSnapshotEvent(agentId),
        getSessionGoalSnapshot: async (agentId: string) => createGoalSnapshotEvent(agentId),
        isModelCacheVisualizationEnabled: () => true,
      } as any,
      integrationRegistry: null,
      terminalService: null,
      unreadTracker: null,
      perf: createPerfStub(),
      send: (_socket, event) => {
        sent.push(event)
        return Buffer.byteLength(JSON.stringify(event), 'utf8')
      },
      resolveTerminalScopeAgentId: () => undefined,
      resolveManagerContextAgentId: () => undefined,
      resolvePlanSnapshotSessionAgentId: () => undefined,
    })

    const historyEvent = sent.find(
      (event): event is Extract<ServerEvent, { type: 'conversation_history' }> =>
        event.type === 'conversation_history',
    )
    expect(historyEvent).not.toHaveProperty('page')
    expect(historyEvent?.messages.map((entry) => entry.type)).toEqual([
      'conversation_message',
      'conversation_log',
    ])
    expect(historyEvent?.messages[0]).toMatchObject({ id: 'ordinary-message', text: 'ordinary message' })
    expect(historyEvent?.messages[1]).toMatchObject({
      type: 'conversation_log',
      kind: 'tool_execution_end',
      toolName: 'bash',
      toolCallId: 'tool-1',
      text: 'Ran command',
    })
    expect(JSON.stringify(historyEvent)).not.toContain(rawToolPayload)
  })

  it('keeps current canonical entry types and page metadata for paging-capable bootstrap clients', async () => {
    const sent: ServerEvent[] = []
    const history = [
      {
        type: 'conversation_message' as const,
        id: 'ordinary-message',
        agentId: 'manager-1',
        role: 'assistant' as const,
        text: 'ordinary message',
        timestamp: '2026-01-01T00:00:00.000Z',
        source: 'system' as const,
      },
      {
        type: 'agent_tool_call' as const,
        agentId: 'manager-1',
        actorAgentId: 'manager-1',
        timestamp: '2026-01-01T00:00:01.000Z',
        kind: 'tool_execution_end' as const,
        toolName: 'bash',
        toolCallId: 'tool-1',
        text: 'raw payload',
      },
      {
        type: 'plan_summary' as const,
        id: 'plan-1',
        agentId: 'manager-1',
        timestamp: '2026-01-01T00:00:02.000Z',
        updatedAt: '2026-01-01T00:00:02.000Z',
        revision: 1,
        plan: [{ step: 'Ship compatibility shield', status: 'completed' as const }],
      },
      createModelCacheObservationEvent('manager-1'),
    ]

    await sendSubscriptionBootstrap({
      socket: {} as WebSocket,
      targetAgentId: 'manager-1',
      supportsConversationPaging: true,
      swarmManager: {
        listBootstrapAgents: () => [],
        listProfiles: () => [],
        getConversationHistoryPage: () => ({
          messages: history,
          page: {
            hasOlder: true,
            nextCursor: 'current-cursor',
            completeness: 'complete' as const,
            source: 'canonical' as const,
            sourceRevision: 'fixture',
            pageBytes: Buffer.byteLength(JSON.stringify(history), 'utf8'),
            scanBytes: 100,
          },
        }),
        getPendingChoiceIdsForSession: () => [],
        getPendingChoiceRequestsForSession: () => [],
        getSessionPlanSnapshot: async (agentId: string) => createPlanSnapshotEvent(agentId),
        getSessionGoalSnapshot: async (agentId: string) => createGoalSnapshotEvent(agentId),
      } as any,
      integrationRegistry: null,
      terminalService: null,
      unreadTracker: null,
      perf: createPerfStub(),
      send: (_socket, event) => {
        sent.push(event)
        return Buffer.byteLength(JSON.stringify(event), 'utf8')
      },
      resolveTerminalScopeAgentId: () => undefined,
      resolveManagerContextAgentId: () => undefined,
      resolvePlanSnapshotSessionAgentId: () => undefined,
    })

    const historyEvent = sent.find(
      (event): event is Extract<ServerEvent, { type: 'conversation_history' }> =>
        event.type === 'conversation_history',
    )
    expect(historyEvent?.messages.map((entry) => entry.type)).toEqual([
      'conversation_message',
      'activity_summary',
      'plan_summary',
      'model_cache_observation',
    ])
    expect(historyEvent?.messages[0]).toMatchObject({ id: 'ordinary-message', text: 'ordinary message' })
    expect(historyEvent?.page).toEqual({
      hasOlder: true,
      nextCursor: 'current-cursor',
      completeness: 'complete',
      source: 'canonical',
    })
  })

  it('does not trim a canonical page after its cursor has already advanced', async () => {
    const sent: ServerEvent[] = []
    const pagedMessages = Array.from({ length: 4 }, (_, index) => ({
      type: 'conversation_message' as const,
      id: `paged-${index}`,
      timelineEntryId: `row-${index}`,
      timelineSequence: index,
      agentId: 'manager-1',
      role: 'assistant' as const,
      text: `${index}:${'x'.repeat(60_000)}`,
      timestamp: new Date(index).toISOString(),
      source: 'system' as const,
    }))
    const pendingChoice = {
      type: 'choice_request' as const,
      agentId: 'manager-1',
      choiceId: 'large-pending-choice',
      questions: [{
        id: 'q1',
        question: 'y'.repeat(2_000_000),
        options: [{ id: 'continue', label: 'Continue' }],
      }],
      status: 'pending' as const,
      timestamp: '2026-01-01T00:00:00.000Z',
    }

    await sendSubscriptionBootstrap({
      socket: {} as WebSocket,
      targetAgentId: 'manager-1',
      supportsConversationPaging: true,
      swarmManager: {
        listBootstrapAgents: () => [],
        listProfiles: () => [],
        getConversationHistoryPage: () => ({
          messages: pagedMessages,
          page: {
            hasOlder: true,
            nextCursor: 'already-advanced-cursor',
            completeness: 'complete' as const,
            source: 'canonical' as const,
            sourceRevision: 'fixture',
            pageBytes: Buffer.byteLength(JSON.stringify(pagedMessages), 'utf8'),
            scanBytes: 256_000,
          },
        }),
        getPendingChoiceIdsForSession: () => [pendingChoice.choiceId],
        getPendingChoiceRequestsForSession: () => [pendingChoice],
        getSessionPlanSnapshot: async (agentId: string) => createPlanSnapshotEvent(agentId),
        getSessionGoalSnapshot: async (agentId: string) => createGoalSnapshotEvent(agentId),
      } as any,
      integrationRegistry: null,
      terminalService: null,
      unreadTracker: null,
      perf: createPerfStub(),
      send: (_socket, event) => {
        sent.push(event)
        return Buffer.byteLength(JSON.stringify(event), 'utf8')
      },
      resolveTerminalScopeAgentId: () => undefined,
      resolveManagerContextAgentId: () => undefined,
      resolvePlanSnapshotSessionAgentId: () => undefined,
    })

    const historyEvent = sent.find(
      (event): event is Extract<ServerEvent, { type: 'conversation_history' }> =>
        event.type === 'conversation_history',
    )
    expect(historyEvent?.messages.map((message) => message.type === 'conversation_message' ? message.id : message.type))
      .toEqual(pagedMessages.map((message) => message.id))
    expect(historyEvent?.page).toEqual({
      hasOlder: true,
      nextCursor: 'already-advanced-cursor',
      completeness: 'complete',
      source: 'canonical',
    })
    const pendingEvent = sent.find(
      (event): event is Extract<ServerEvent, { type: 'pending_choices_snapshot' }> =>
        event.type === 'pending_choices_snapshot',
    )
    expect(pendingEvent?.choiceIds).toEqual([pendingChoice.choiceId])
    expect(pendingEvent?.choices).toHaveLength(1)
    expect(Buffer.byteLength(JSON.stringify(pendingEvent), 'utf8')).toBeLessThan(1 * 1024 * 1024)
    expect(JSON.stringify(pendingEvent)).not.toContain('y'.repeat(10_000))
  })

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
      getSessionPlanSnapshot: vi.fn(async (agentId: string) => createPlanSnapshotEvent(agentId)),
      getSessionGoalSnapshot: vi.fn(async (agentId: string) => createGoalSnapshotEvent(agentId)),
    } as any

    const result = await sendSubscriptionBootstrap({
      socket: {} as any,
      targetAgentId: 'manager-1',
      supportsConversationPaging: false,
      swarmManager,
      integrationRegistry: null,
      terminalService: null,
      unreadTracker: null,
      perf,
      send,
      resolveTerminalScopeAgentId: () => undefined,
      resolveManagerContextAgentId: () => undefined,
      resolvePlanSnapshotSessionAgentId: (agentId) => agentId,
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
    expect(send).toHaveBeenCalledTimes(9)
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
      supportsConversationPaging: false,
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
        getSessionPlanSnapshot: async (agentId: string) => createPlanSnapshotEvent(agentId),
        getSessionGoalSnapshot: async (agentId: string) => createGoalSnapshotEvent(agentId),
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
      resolvePlanSnapshotSessionAgentId: () => undefined,
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
      supportsConversationPaging: true,
      swarmManager: {
        listBootstrapAgents: () => [],
        listProfiles: () => [],
        getConversationHistoryPage: () => ({
          messages: history,
          page: {
            hasOlder: false,
            completeness: 'complete' as const,
            source: 'canonical' as const,
            sourceRevision: 'fixture',
            pageBytes: Buffer.byteLength(JSON.stringify(history), 'utf8'),
            scanBytes: 0,
          },
        }),
        getPendingChoiceIdsForSession: () => [],
        getPendingChoiceRequestsForSession: () => [],
        getSessionPlanSnapshot: async (agentId: string) => createPlanSnapshotEvent(agentId),
        getSessionGoalSnapshot: async (agentId: string) => createGoalSnapshotEvent(agentId),
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
      resolvePlanSnapshotSessionAgentId: () => undefined,
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
      getSessionPlanSnapshot: vi.fn(async (agentId: string) => createPlanSnapshotEvent(agentId)),
      getSessionGoalSnapshot: vi.fn(async (agentId: string) => createGoalSnapshotEvent(agentId)),
    } as any

    await sendSubscriptionBootstrap({
      socket: {} as any,
      targetAgentId: 'manager-1',
      supportsConversationPaging: false,
      swarmManager,
      integrationRegistry: null,
      terminalService: null,
      unreadTracker: null,
      perf,
      send,
      resolveTerminalScopeAgentId: () => undefined,
      resolveManagerContextAgentId: () => undefined,
      resolvePlanSnapshotSessionAgentId: (agentId) => agentId,
    })

    const conversationHistoryEvent = send.mock.calls
      .map(([, event]) => event)
      .find((event): event is Extract<ServerEvent, { type: 'conversation_history' }> => event.type === 'conversation_history')
    expect(conversationHistoryEvent).toBeDefined()
    expect(conversationHistoryEvent?.messages.length).toBeLessThanOrEqual(history.length)
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
      getSessionPlanSnapshot: vi.fn(async (agentId: string) => createPlanSnapshotEvent(agentId)),
      getSessionGoalSnapshot: vi.fn(async (agentId: string) => createGoalSnapshotEvent(agentId)),
    } as any

    const result = await sendSubscriptionBootstrap({
      socket: {} as any,
      targetAgentId: 'manager-1',
      supportsConversationPaging: false,
      swarmManager,
      integrationRegistry: null,
      terminalService: null,
      unreadTracker: null,
      perf,
      send,
      resolveTerminalScopeAgentId: () => undefined,
      resolveManagerContextAgentId: () => undefined,
      resolvePlanSnapshotSessionAgentId: (agentId) => agentId,
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
    expect(send).toHaveBeenCalledTimes(7)
    expect(result).toEqual({
      agentsSnapshotSent: false,
      profilesSnapshotSent: false,
    })
  })

  it('sends plan and goal snapshots after pending choices and before terminals', async () => {
    const sentEvents: ServerEvent[] = []
    await sendSubscriptionBootstrap({
      socket: {} as any,
      targetAgentId: 'manager-1',
      supportsConversationPaging: false,
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
        getSessionPlanSnapshot: async (agentId: string) => ({
          ...createPlanSnapshotEvent(agentId),
          revision: 7,
        }),
        getSessionGoalSnapshot: async (agentId: string) => createGoalSnapshotEvent(agentId),
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
      resolvePlanSnapshotSessionAgentId: (agentId) => agentId,
    })

    expect(sentEvents.map((event) => event.type)).toEqual([
      'ready',
      'agents_snapshot',
      'profiles_snapshot',
      'conversation_history',
      'pending_choices_snapshot',
      'restart_recovery_snapshot',
      'session_plan_snapshot',
      'session_goal_snapshot',
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
      type: 'session_plan_snapshot',
      sessionAgentId: 'manager-1',
      revision: 7,
      plan: [],
    })
    expect(sentEvents[7]).toMatchObject({
      type: 'session_goal_snapshot',
      sessionAgentId: 'manager-1',
      goal: null,
    })
  })

  it('skips session_plan_snapshot for non-session bootstrap targets', async () => {
    const sentEvents: ServerEvent[] = []
    const getSessionPlanSnapshot = vi.fn(async (agentId: string) => createPlanSnapshotEvent(agentId))
    const getSessionGoalSnapshot = vi.fn(async (agentId: string) => createGoalSnapshotEvent(agentId))

    await sendSubscriptionBootstrap({
      socket: {} as any,
      targetAgentId: '__bootstrap_manager__',
      supportsConversationPaging: false,
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
        getSessionPlanSnapshot,
        getSessionGoalSnapshot,
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
      resolvePlanSnapshotSessionAgentId: () => undefined,
    })

    expect(getSessionPlanSnapshot).not.toHaveBeenCalled()
    expect(getSessionGoalSnapshot).not.toHaveBeenCalled()
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
      supportsConversationPaging: false,
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
        getSessionPlanSnapshot: async (agentId: string) => createPlanSnapshotEvent(agentId),
        getSessionGoalSnapshot: async (agentId: string) => createGoalSnapshotEvent(agentId),
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
      resolvePlanSnapshotSessionAgentId: (agentId) => agentId,
    })

    expect(sentEvents.find((event) => event.type === 'pending_choices_snapshot')).toEqual({
      type: 'pending_choices_snapshot',
      agentId: 'manager-1',
      choiceIds: ['legacy-choice-1'],
    })
  })

  it('flow-controls bootstrap-critical events over a backpressured socket instead of dropping them', async () => {
    // A fake socket that starts saturated (over the 1 MB cap) and drains on the next macrotask tick.
    let bufferedAmount = MAX_WS_BUFFERED_AMOUNT_BYTES + 750_000
    const sentTypes: string[] = []
    const socket = {
      _socket: { write: () => true },
      get readyState() {
        return WebSocket.OPEN
      },
      get bufferedAmount() {
        return bufferedAmount
      },
      send: vi.fn((data: string, cb?: (error?: Error) => void) => {
        sentTypes.push((JSON.parse(data) as ServerEvent).type)
        cb?.(undefined)
      }),
      terminate: vi.fn(),
    } as unknown as WebSocket

    // Relieve backpressure shortly after the bootstrap starts awaiting drain.
    const drainTimer = setInterval(() => {
      bufferedAmount = 0
    }, 5)

    const onDropSocket = vi.fn()
    try {
      await sendSubscriptionBootstrap({
        socket,
        targetAgentId: 'manager-1',
        supportsConversationPaging: false,
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
          getSessionPlanSnapshot: async (agentId: string) => createPlanSnapshotEvent(agentId),
          getSessionGoalSnapshot: async (agentId: string) => createGoalSnapshotEvent(agentId),
        } as any,
        integrationRegistry: null,
        terminalService: null,
        unreadTracker: null,
        perf: createPerfStub(),
        // Wire the real backpressure-aware sender so bootstrap-critical events await drain.
        send: (targetSocket, event) =>
          sendWsEventWithBackpressure({ socket: targetSocket, event, onDropSocket, timeoutMs: 2000 }),
        resolveTerminalScopeAgentId: () => undefined,
        resolveManagerContextAgentId: () => undefined,
        resolvePlanSnapshotSessionAgentId: (agentId) => agentId,
      })
    } finally {
      clearInterval(drainTimer)
    }

    // Every bootstrap-critical event was actually sent after drain (none dropped), and transient
    // backpressure never terminated the socket.
    expect(sentTypes).toContain('ready')
    expect(sentTypes).toContain('agents_snapshot')
    expect(sentTypes).toContain('profiles_snapshot')
    expect(sentTypes).toContain('conversation_history')
    expect(onDropSocket).not.toHaveBeenCalled()
    expect(socket.terminate).not.toHaveBeenCalled()
  })
})
