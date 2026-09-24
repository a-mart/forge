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
  it('does not expose local history to restricted runtimes or when the service is absent', () => {
    expect(buildHistoryRecallTools({}, descriptor())).toEqual([])
    for (const overrides of [
      { sessionSurface: 'collab' }, { sessionPurpose: 'capture_check' }, { sessionPurpose: 'cortex_review' },
      { internalWorkerKind: 'codex_plugin' },
    ] as Partial<AgentDescriptor>[]) expect(buildHistoryRecallTools(host(), descriptor(overrides))).toEqual([])
  })
})
