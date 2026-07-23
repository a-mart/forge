import { describe, expect, it } from 'vitest'
import { shouldRevealBrowserPanel } from './activity-rail-workspace'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('BuilderSurface browser reveal policy', () => {
  it('reveals only the selected local Electron session at the intent host generation', () => {
    const request = { sessionAgentId: 'session-1', hostGeneration: 4, sequence: 8 }
    expect(shouldRevealBrowserPanel({ electronHostAvailable: true, selectedSessionAgentId: 'session-1', request, currentHostGeneration: 4 })).toBe(true)
    expect(shouldRevealBrowserPanel({ electronHostAvailable: false, selectedSessionAgentId: 'session-1', request, currentHostGeneration: 4 })).toBe(false)
    expect(shouldRevealBrowserPanel({ electronHostAvailable: true, selectedSessionAgentId: 'background', request, currentHostGeneration: 4 })).toBe(false)
    expect(shouldRevealBrowserPanel({ electronHostAvailable: true, selectedSessionAgentId: 'session-1', request, currentHostGeneration: 3 })).toBe(false)
  })
})
