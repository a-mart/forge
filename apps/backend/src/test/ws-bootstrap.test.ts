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

describe('sendSubscriptionBootstrap', () => {
  it('records sidebar.bootstrap once with diagnostics from the current history load', () => {
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
            modelId: 'gpt-5.3-codex',
            thinkingLevel: 'medium',
          },
          sessionFile: '/tmp/manager-1.jsonl',
        },
      ],
      listProfiles: () => [],
      getConversationHistoryWithDiagnostics: vi.fn(() => historyResult),
      getPendingChoiceIdsForSession: vi.fn(() => ['choice-1']),
    } as any

    sendSubscriptionBootstrap({
      socket: {} as any,
      targetAgentId: 'manager-1',
      swarmManager,
      integrationRegistry: null,
      playwrightDiscovery: null,
      terminalService: null,
      unreadTracker: null,
      perf,
      send,
      resolveTerminalScopeAgentId: () => undefined,
      resolveManagerContextAgentId: () => undefined,
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
    })
    expect(bootstrapOptions?.fields).not.toHaveProperty('agentId')
    expect(send).toHaveBeenCalledTimes(6)
  })
})
