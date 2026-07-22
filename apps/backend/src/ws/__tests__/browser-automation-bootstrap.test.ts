import type { BrowserSessionSnapshot, ServerEvent } from '@forge/protocol'
import { describe, expect, it, vi } from 'vitest'
import type { WebSocket } from 'ws'
import type { SidebarPerfRecorder } from '../../stats/sidebar-perf-types.js'
import { sendSubscriptionBootstrap } from '../ws-bootstrap.js'

const snapshot: BrowserSessionSnapshot = {
  schemaVersion: 1, sessionAgentId: 'session', profileId: 'project', hostingState: 'hosted', tabs: [], activeTabId: null, defaultTabId: null,
  panelVisible: false, recentActions: [], revision: 7, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
}

function perf(): SidebarPerfRecorder {
  return { recordDuration: vi.fn(), increment: vi.fn(), readSummary: vi.fn(() => ({ histograms: {}, counters: {} })), readRecentSlowEvents: vi.fn(() => []) }
}
function manager() {
  const agent = {
    agentId: 'session', managerId: 'session', displayName: 'Session', role: 'manager' as const, status: 'idle' as const,
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), cwd: '/repo',
    model: { provider: 'test', modelId: 'test', thinkingLevel: 'off' as const }, sessionFile: '/session.jsonl', profileId: 'project',
  }
  return {
    listBootstrapAgents: () => [agent], getAgent: () => agent, listProfiles: () => [],
    getConversationHistoryWithDiagnostics: () => ({ history: [], diagnostics: {} }),
    getPendingChoiceIdsForSession: () => [], getPendingChoiceRequestsForSession: () => [], getRestartRecoverySnapshot: () => null,
    getSessionPlanSnapshot: async () => ({ type: 'session_plan_snapshot', sessionAgentId: 'session', profileId: 'project', revision: 0, updatedAt: null, plan: [], diagnostics: { state: 'defaulted' } }),
    getSessionGoalSnapshot: async () => ({ type: 'session_goal_snapshot', sessionAgentId: 'session', profileId: 'project', revision: 0, measuredAt: new Date(0).toISOString(), goal: null }),
  }
}

describe('browser selected-session bootstrap', () => {
  it('emits the canonical browser session snapshot during each fresh subscription', async () => {
    const events: ServerEvent[] = []
    const getSessionSnapshot = vi.fn(async () => snapshot)
    await sendSubscriptionBootstrap({
      socket: {} as WebSocket,
      targetAgentId: 'session',
      swarmManager: manager() as never,
      browserAutomationService: { getSessionSnapshot } as never,
      terminalService: null,
      unreadTracker: null,
      perf: perf(),
      send: (_socket, event) => { events.push(event); return 1 },
      resolveTerminalScopeAgentId: () => undefined,
      resolvePlanSnapshotSessionAgentId: () => 'session',
      resolveBrowserSessionAgentId: () => 'session',
    })
    expect(getSessionSnapshot).toHaveBeenCalledWith('project', 'session')
    expect(events.filter((event) => event.type === 'browser_session_snapshot')).toEqual([{ type: 'browser_session_snapshot', snapshot }])
    expect(events.findIndex((event) => event.type === 'browser_session_snapshot')).toBeGreaterThan(events.findIndex((event) => event.type === 'ready'))
  })
})
