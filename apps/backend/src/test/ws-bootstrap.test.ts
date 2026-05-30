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
      historyEntriesReturned: 1,
      pendingChoiceCount: 1,
      snapshotSkipped: false,
    })
    expect(bootstrapOptions?.fields).not.toHaveProperty('agentId')
    expect(send).toHaveBeenCalledTimes(7)
    expect(result).toEqual({
      agentsSnapshotSent: true,
      profilesSnapshotSent: true,
    })
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
    expect(send).toHaveBeenCalledTimes(5)
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
      'session_task_state_snapshot',
      'terminals_snapshot',
    ])
    expect(sentEvents[5]).toMatchObject({
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
      'terminals_snapshot',
    ])
  })
})
