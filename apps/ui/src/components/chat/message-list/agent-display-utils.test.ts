import { describe, expect, it } from 'vitest'
import type { AgentDescriptor } from '@forge/protocol'
import { buildAgentDisplayMap } from './agent-display-utils'

function makeAgent(overrides: Partial<AgentDescriptor> & { agentId: string }): AgentDescriptor {
  return {
    displayName: overrides.agentId,
    role: 'worker',
    managerId: 'manager',
    status: 'idle',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cwd: '/tmp',
    model: { provider: 'anthropic', modelId: 'claude-opus-4-6', thinkingLevel: 'high' },
    sessionFile: '/tmp/session.jsonl',
    ...overrides,
  }
}

describe('buildAgentDisplayMap', () => {
  it('returns empty map for no agents', () => {
    const map = buildAgentDisplayMap([])
    expect(map.size).toBe(0)
  })

  it('uses displayName as primaryLabel when available', () => {
    const agent = makeAgent({ agentId: 'w1', displayName: 'Backend specialist' })
    const map = buildAgentDisplayMap([agent])
    expect(map.get('w1')?.primaryLabel).toBe('Backend specialist')
  })

  it('falls back to agentId when displayName is missing', () => {
    const agent = makeAgent({ agentId: 'worker-abc', displayName: undefined })
    const map = buildAgentDisplayMap([agent])
    expect(map.get('worker-abc')?.primaryLabel).toBe('worker-abc')
  })

  it('falls back to agentId when displayName is whitespace', () => {
    const agent = makeAgent({ agentId: 'worker-abc', displayName: '  ' })
    const map = buildAgentDisplayMap([agent])
    expect(map.get('worker-abc')?.primaryLabel).toBe('worker-abc')
  })

  it('builds secondaryLabel from specialist and model metadata', () => {
    const agent = makeAgent({
      agentId: 'w1',
      specialistDisplayName: 'Docs worker',
      model: { provider: 'anthropic', modelId: 'claude-opus-4-6', thinkingLevel: 'high' },
    })
    const map = buildAgentDisplayMap([agent])
    const meta = map.get('w1')!
    expect(meta.secondaryLabel).toBe('Docs worker · anthropic/claude-opus-4-6 · high')
  })

  it('omits thinkingLevel when none', () => {
    const agent = makeAgent({
      agentId: 'w1',
      model: { provider: 'openai-codex', modelId: 'gpt-5.3-codex', thinkingLevel: 'none' },
    })
    const map = buildAgentDisplayMap([agent])
    const meta = map.get('w1')!
    expect(meta.secondaryLabel).toBe('openai-codex/gpt-5.3-codex')
  })

  it('returns null secondaryLabel when no metadata is available', () => {
    const agent = makeAgent({
      agentId: 'w1',
      specialistDisplayName: undefined,
      model: undefined as any,
    })
    const map = buildAgentDisplayMap([agent])
    expect(map.get('w1')?.secondaryLabel).toBeNull()
  })

  it('includes specialistColor when present', () => {
    const agent = makeAgent({ agentId: 'w1', specialistColor: '#ff0000' })
    const map = buildAgentDisplayMap([agent])
    expect(map.get('w1')?.specialistColor).toBe('#ff0000')
  })

  it('returns null specialistColor when absent', () => {
    const agent = makeAgent({ agentId: 'w1', specialistColor: undefined })
    const map = buildAgentDisplayMap([agent])
    expect(map.get('w1')?.specialistColor).toBeNull()
  })

  it('title includes raw agentId and all metadata', () => {
    const agent = makeAgent({
      agentId: 'w1',
      displayName: 'Backend specialist',
      specialistDisplayName: 'Backend',
      model: { provider: 'anthropic', modelId: 'claude-opus-4-6', thinkingLevel: 'high' },
    })
    const map = buildAgentDisplayMap([agent])
    const title = map.get('w1')!.title
    expect(title).toContain('w1')
    expect(title).toContain('Backend specialist')
    expect(title).toContain('anthropic/claude-opus-4-6')
  })
})
