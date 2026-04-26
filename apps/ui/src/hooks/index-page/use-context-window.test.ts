import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { AgentDescriptor } from '@forge/protocol'

const { getCatalogContextWindowSpy } = vi.hoisted(() => ({
  getCatalogContextWindowSpy: vi.fn(),
}))

vi.mock('@forge/protocol', async () => {
  const actual = await vi.importActual<typeof import('@forge/protocol')>('@forge/protocol')
  return {
    ...actual,
    getCatalogContextWindow: getCatalogContextWindowSpy,
  }
})

import { contextWindowForAgent, toContextWindowUsage } from './use-context-window'

function makeAgent(): AgentDescriptor {
  return {
    agentId: 'agent-1',
    managerId: 'agent-1',
    displayName: 'Claude SDK Worker',
    role: 'worker',
    status: 'idle',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cwd: '/tmp/project',
    model: {
      provider: 'claude-sdk',
      modelId: 'claude-sonnet-4-5-20250929',
      thinkingLevel: 'medium',
    },
    sessionFile: '/tmp/project/session.jsonl',
  }
}

describe('contextWindowForAgent', () => {
  beforeEach(() => {
    getCatalogContextWindowSpy.mockReset()
  })

  it('passes provider-aware catalog lookup inputs for fallback estimation', () => {
    getCatalogContextWindowSpy.mockReturnValue(200_000)

    expect(contextWindowForAgent(makeAgent())).toBe(200_000)
    expect(getCatalogContextWindowSpy).toHaveBeenCalledWith(
      'claude-sonnet-4-5-20250929',
      'claude-sdk',
    )
  })
})

describe('toContextWindowUsage', () => {
  it('rejects implausibly large persisted context usage values', () => {
    expect(
      toContextWindowUsage({
        tokens: 10_649_236,
        contextWindow: 200_000,
        percent: 100,
      }),
    ).toBeNull()
  })

  it('keeps normal context usage values', () => {
    expect(
      toContextWindowUsage({
        tokens: 17_448,
        contextWindow: 200_000,
        percent: 8.724,
      }),
    ).toEqual({
      usedTokens: 17_448,
      contextWindow: 200_000,
    })
  })
})
