import { describe, expect, it } from 'vitest'
import type { AgentDescriptor } from '@forge/protocol'
import { DEFAULT_MANAGER_AGENT_ID } from '@/hooks/index-page/use-route-state'
import { ROOT_CORTEX_AGENT_ID, shouldAutoRouteToCortexOnboarding } from './onboarding-ui'

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

describe('shouldAutoRouteToCortexOnboarding', () => {
  const agents = [
    manager(ROOT_CORTEX_AGENT_ID, { profileId: ROOT_CORTEX_AGENT_ID, archetypeId: 'cortex' }),
    manager('project-alpha', { profileId: 'project-alpha' }),
  ]

  it('routes default first-launch chat selection to Cortex when onboarding is needed', () => {
    expect(
      shouldAutoRouteToCortexOnboarding({
        routeState: { view: 'chat', agentId: DEFAULT_MANAGER_AGENT_ID },
        onboardingState: { status: 'active' },
        hasExplicitSelection: false,
        agents,
      }),
    ).toBe(true)

    expect(
      shouldAutoRouteToCortexOnboarding({
        routeState: { view: 'chat', agentId: DEFAULT_MANAGER_AGENT_ID },
        onboardingState: { status: 'not_started' },
        hasExplicitSelection: false,
        agents,
      }),
    ).toBe(true)
  })

  it('keeps normal routing once onboarding is completed or migrated', () => {
    expect(
      shouldAutoRouteToCortexOnboarding({
        routeState: { view: 'chat', agentId: DEFAULT_MANAGER_AGENT_ID },
        onboardingState: { status: 'completed' },
        hasExplicitSelection: false,
        agents,
      }),
    ).toBe(false)

    expect(
      shouldAutoRouteToCortexOnboarding({
        routeState: { view: 'chat', agentId: DEFAULT_MANAGER_AGENT_ID },
        onboardingState: { status: 'migrated' },
        hasExplicitSelection: false,
        agents,
      }),
    ).toBe(false)
  })
})
