import { describe, expect, it, vi } from 'vitest'
import { buildHistoryRecallTools } from '../history-recall-tool.js'
import type { AgentDescriptor } from '../types.js'

const descriptor = (overrides: Partial<AgentDescriptor> = {}) => ({
  agentId: 'worker', managerId: 'session', role: 'worker', ...overrides,
} as AgentDescriptor)
const host = () => ({
  searchHistory: vi.fn(async () => ({ scope: 'session' as const, results: [], complete: true, warnings: [] })),
  readHistory: vi.fn(),
})

describe('history recall tool', () => {
  it('gives ordinary workers and managers the same session/project search interface', async () => {
    for (const role of ['worker', 'manager'] as const) {
      const h = host()
      const [tool] = buildHistoryRecallTools(h, descriptor({ role }))
      expect(tool.name).toBe('history')
      const result = await tool.execute('call', { op: 'search', query: 'old failure', scope: 'project' })
      expect(h.searchHistory).toHaveBeenCalledWith('worker', { query: 'old failure', scope: 'project' })
      expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({ scope: 'session', results: [], complete: true, warnings: [] }) }])
    }
  })
  it('reads a qualified reference without another permission request', async () => {
    const h = host()
    const ref = { sessionAgentId: 'other-session', actorAgentId: 'other-worker', entryId: 'entry', sourceVersion: 'generation' }
    h.readHistory.mockResolvedValue({ entry: { ref, text: 'evidence' }, before: [], after: [], warnings: [] })
    await buildHistoryRecallTools(h, descriptor())[0].execute('call', { op: 'read', ref, offset: 100, maxChars: 500 })
    expect(h.readHistory).toHaveBeenCalledWith('worker', { ref, offset: 100, maxChars: 500 })
  })
  it('discovers sessions without requiring another approval and keeps search/read working without that host method', async () => {
    const h = {
      ...host(),
      listHistorySessions: vi.fn(async () => ({ scope: 'project' as const, results: [], warnings: [], coverage: {
        catalogHydration: 'partial' as const, state: 'building' as const, catalogRevision: 0,
        pendingSourceCount: 1, unreadableSourceCount: 0, omittedEligibleText: false,
      } })),
    }
    const [tool] = buildHistoryRecallTools(h, descriptor())
    await tool.execute('call', { op: 'sessions', query: 'mobile', scope: 'project' })
    expect(h.listHistorySessions).toHaveBeenCalledWith('worker', { query: 'mobile', scope: 'project' })
    await tool.execute('call', { op: 'search', query: 'mobile', order: 'newest' })
    expect(h.searchHistory).toHaveBeenCalledWith('worker', { query: 'mobile', order: 'newest' })
  })
  it('routes query-free windows/items and explicit literal filters through the same caller', async () => {
    const h = { ...host(), listHistoryWindows: vi.fn(async () => ({ results: [], complete: true, warnings: [] })),
      listHistoryItems: vi.fn(async () => ({ results: [], complete: true, warnings: [] })) }
    const [tool] = buildHistoryRecallTools(h, descriptor())
    await tool.execute('windows', { op: 'windows', actorAgentId: 'worker', limit: 5 })
    expect(h.listHistoryWindows).toHaveBeenCalledWith('worker', { actorAgentId: 'worker', limit: 5 })
    await tool.execute('items', { op: 'items', windowId: 'window:initial', role: 'user' })
    expect(h.listHistoryItems).toHaveBeenCalledWith('worker', { windowId: 'window:initial', role: 'user' })
    await tool.execute('literal', { op: 'search', query: 'foo-bar', mode: 'literal', caseSensitive: true })
    expect(h.searchHistory).toHaveBeenCalledWith('worker', { query: 'foo-bar', mode: 'literal', caseSensitive: true })
  })
  it('does not expose local history to restricted runtimes or when the service is absent', () => {
    expect(buildHistoryRecallTools({}, descriptor())).toEqual([])
    for (const overrides of [
      { sessionSurface: 'collab' }, { sessionPurpose: 'capture_check' }, { sessionPurpose: 'cortex_review' },
      { internalWorkerKind: 'codex_plugin' },
    ] as Partial<AgentDescriptor>[]) expect(buildHistoryRecallTools(host(), descriptor(overrides))).toEqual([])
  })
})
