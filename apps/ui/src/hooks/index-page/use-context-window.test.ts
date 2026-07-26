import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { AgentDescriptor, ConversationEntry } from '@forge/protocol'

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

import {
  contextWindowForAgent,
  estimateUsedTokens,
  resolveAuthoritativeContextUsage,
  resolveContextWindowDisplay,
  toContextWindowUsage,
} from './use-context-window'

function makeAgent(overrides: Partial<AgentDescriptor> = {}): AgentDescriptor {
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
      modelId: 'claude-sonnet-5',
      thinkingLevel: 'medium',
    },
    sessionFile: '/tmp/project/session.jsonl',
    ...overrides,
  }
}

function conversationMessage(text: string): ConversationEntry {
  return {
    type: 'conversation_message',
    agentId: 'agent-1',
    role: 'user',
    text,
    timestamp: '2026-01-01T00:00:00.000Z',
    source: 'user_input',
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
      'claude-sonnet-5',
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

describe('resolveContextWindowDisplay', () => {
  beforeEach(() => {
    getCatalogContextWindowSpy.mockReturnValue(200_000)
  })

  it('prefers authoritative runtime usage from live status over transcript estimates', () => {
    const agent = makeAgent()

    expect(
      resolveContextWindowDisplay({
        activeAgent: agent,
        activeAgentId: agent.agentId,
        messages: [conversationMessage('x'.repeat(40_000))],
        statusEntry: {
          status: 'streaming',
          pendingCount: 0,
          contextUsage: { tokens: 900, contextWindow: 200_000, percent: 0.45 },
        },
        hadAuthoritativeUsage: false,
      }).display,
    ).toEqual({
      mode: 'known',
      usedTokens: 900,
      contextWindow: 200_000,
    })
  })

  it('uses transcript estimates for fresh sessions without authoritative usage', () => {
    const agent = makeAgent()
    const messages = [conversationMessage('hello world')]

    expect(
      resolveContextWindowDisplay({
        activeAgent: agent,
        activeAgentId: agent.agentId,
        messages,
        statusEntry: { status: 'idle', pendingCount: 0 },
        hadAuthoritativeUsage: false,
      }).display,
    ).toEqual({
      mode: 'known',
      usedTokens: estimateUsedTokens(messages),
      contextWindow: 200_000,
    })
  })

  it('shows updating while context recovery is active without authoritative usage', () => {
    const agent = makeAgent({
      contextUsage: { tokens: 150_000, contextWindow: 200_000, percent: 75 },
    })

    expect(
      resolveContextWindowDisplay({
        activeAgent: agent,
        activeAgentId: agent.agentId,
        messages: [conversationMessage('hello world')],
        statusEntry: {
          status: 'streaming',
          pendingCount: 0,
          contextRecoveryInProgress: true,
        },
        hadAuthoritativeUsage: false,
      }).display,
    ).toEqual({
      mode: 'updating',
      contextWindow: 200_000,
    })
  })

  it('ignores stale descriptor usage when live status exists without contextUsage', () => {
    const agent = makeAgent({
      contextUsage: { tokens: 150_000, contextWindow: 200_000, percent: 75 },
    })

    expect(
      resolveAuthoritativeContextUsage(
        { status: 'streaming', pendingCount: 0, contextRecoveryInProgress: true },
        agent,
      ),
    ).toBeNull()

    expect(
      resolveContextWindowDisplay({
        activeAgent: agent,
        activeAgentId: agent.agentId,
        messages: [conversationMessage('hello world')],
        statusEntry: {
          status: 'streaming',
          pendingCount: 0,
          contextRecoveryInProgress: true,
        },
        hadAuthoritativeUsage: true,
      }).display,
    ).toEqual({
      mode: 'updating',
      contextWindow: 200_000,
    })
  })

  it('uses persisted descriptor usage only when no live status entry exists', () => {
    const agent = makeAgent({
      contextUsage: { tokens: 5_000, contextWindow: 200_000, percent: 2.5 },
    })

    expect(resolveAuthoritativeContextUsage(undefined, agent)).toEqual({
      usedTokens: 5_000,
      contextWindow: 200_000,
    })

    expect(
      resolveContextWindowDisplay({
        activeAgent: agent,
        activeAgentId: agent.agentId,
        messages: [conversationMessage('hello world')],
        statusEntry: undefined,
        hadAuthoritativeUsage: false,
      }).display,
    ).toEqual({
      mode: 'known',
      usedTokens: 5_000,
      contextWindow: 200_000,
    })
  })

  it('shows updating after authoritative usage becomes unknown while streaming', () => {
    const agent = makeAgent()

    expect(
      resolveContextWindowDisplay({
        activeAgent: agent,
        activeAgentId: agent.agentId,
        messages: [conversationMessage('hello world')],
        statusEntry: { status: 'streaming', pendingCount: 0 },
        hadAuthoritativeUsage: true,
      }).display,
    ).toEqual({
      mode: 'updating',
      contextWindow: 200_000,
    })
  })

  it('falls back to transcript estimates when idle with no refresh expected', () => {
    const agent = makeAgent()
    const messages = [conversationMessage('hello world')]

    const result = resolveContextWindowDisplay({
      activeAgent: agent,
      activeAgentId: agent.agentId,
      messages,
      statusEntry: { status: 'idle', pendingCount: 0 },
      hadAuthoritativeUsage: true,
    })

    expect(result.display).toEqual({
      mode: 'known',
      usedTokens: estimateUsedTokens(messages),
      contextWindow: 200_000,
    })
    expect(result.hadAuthoritativeUsage).toBe(false)
  })

  it('returns to known usage once authoritative runtime usage arrives again', () => {
    const agent = makeAgent()

    const result = resolveContextWindowDisplay({
      activeAgent: agent,
      activeAgentId: agent.agentId,
      messages: [conversationMessage('hello world')],
      statusEntry: {
        status: 'idle',
        pendingCount: 0,
        contextUsage: { tokens: 12_000, contextWindow: 200_000, percent: 6 },
      },
      hadAuthoritativeUsage: true,
    })

    expect(result.display).toEqual({
      mode: 'known',
      usedTokens: 12_000,
      contextWindow: 200_000,
    })
    expect(result.hadAuthoritativeUsage).toBe(true)
  })
})
