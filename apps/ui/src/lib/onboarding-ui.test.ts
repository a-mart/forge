import { describe, expect, it } from 'vitest'
import type { AgentDescriptor } from '@forge/protocol'
import { hasProjectManagers } from './onboarding-ui'

function manager(agentId: string, overrides: Partial<AgentDescriptor> = {}): AgentDescriptor {
  return {
    agentId,
    managerId: agentId,
    displayName: agentId,
    role: 'manager',
    status: 'idle',
    createdAt: '2026-03-18T00:00:00.000Z',
    updatedAt: '2026-03-18T00:00:00.000Z',
    cwd: '/tmp',
    model: {
      provider: 'openai-codex',
      modelId: 'gpt-5.3-codex',
      thinkingLevel: 'high',
    },
    sessionFile: `/tmp/${agentId}.jsonl`,
    ...overrides,
  }
}

describe('hasProjectManagers', () => {
  it('ignores the root cortex manager', () => {
    expect(
      hasProjectManagers([
        manager('cortex', { profileId: 'cortex', archetypeId: 'cortex' }),
      ]),
    ).toBe(false)
  })

  it('returns true when a non-cortex manager exists', () => {
    expect(
      hasProjectManagers([
        manager('cortex', { profileId: 'cortex', archetypeId: 'cortex' }),
        manager('project-alpha', { profileId: 'project-alpha', archetypeId: 'manager' }),
      ]),
    ).toBe(true)
  })
})
