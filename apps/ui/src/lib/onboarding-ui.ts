import type { AgentDescriptor, OnboardingState, OnboardingStatus } from '@forge/protocol'
import { DEFAULT_MANAGER_AGENT_ID, type AppRouteState } from '@/hooks/index-page/use-route-state'

export const ROOT_CORTEX_AGENT_ID = 'cortex'

export function onboardingNeedsAttention(status: OnboardingStatus | null | undefined): boolean {
  return status === 'not_started' || status === 'active'
}

export function onboardingShowsPostSetupCta(status: OnboardingStatus | null | undefined): boolean {
  return status === 'completed' || status === 'deferred'
}

export function hasProjectManagers(agents: AgentDescriptor[]): boolean {
  return agents.some((agent) => {
    if (agent.role !== 'manager') return false
    if (agent.agentId === ROOT_CORTEX_AGENT_ID) return false
    if (agent.profileId === ROOT_CORTEX_AGENT_ID) return false
    return agent.archetypeId !== 'cortex'
  })
}

export function shouldAutoRouteToCortexOnboarding(options: {
  routeState: AppRouteState
  onboardingState: Pick<OnboardingState, 'status'> | null
  hasExplicitSelection: boolean
  agents: AgentDescriptor[]
}): boolean {
  const { routeState, onboardingState, hasExplicitSelection, agents } = options

  if (routeState.view !== 'chat') {
    return false
  }

  if (routeState.agentId !== DEFAULT_MANAGER_AGENT_ID) {
    return false
  }

  if (hasExplicitSelection) {
    return false
  }

  if (!onboardingNeedsAttention(onboardingState?.status)) {
    return false
  }

  return agents.some((agent) => agent.agentId === ROOT_CORTEX_AGENT_ID)
}
