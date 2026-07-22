import { describe, expect, it } from 'vitest'
import { shouldRevealBrowserPanel } from './activity-rail-workspace'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('BuilderSurface browser reveal policy', () => {
  it('reveals only the selected local Electron session at the current generation/revision', () => {
    const request = { sessionAgentId: 'session-1', hostGeneration: 4, revision: 8 }
    expect(shouldRevealBrowserPanel({ electronHostAvailable: true, selectedSessionAgentId: 'session-1', request, currentHostGeneration: 4, currentRevision: 8 })).toBe(true)
    expect(shouldRevealBrowserPanel({ electronHostAvailable: false, selectedSessionAgentId: 'session-1', request, currentHostGeneration: 4, currentRevision: 8 })).toBe(false)
    expect(shouldRevealBrowserPanel({ electronHostAvailable: true, selectedSessionAgentId: 'background', request, currentHostGeneration: 4, currentRevision: 8 })).toBe(false)
    expect(shouldRevealBrowserPanel({ electronHostAvailable: true, selectedSessionAgentId: 'session-1', request, currentHostGeneration: 3, currentRevision: 8 })).toBe(false)
    expect(shouldRevealBrowserPanel({ electronHostAvailable: true, selectedSessionAgentId: 'session-1', request, currentHostGeneration: 4, currentRevision: 9 })).toBe(false)
  })
})
