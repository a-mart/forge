import type { AgentDescriptor, ManagerProfile } from '@forge/protocol'

export function isSessionModelPickerEligible(
  agent: AgentDescriptor | null | undefined,
  profile: ManagerProfile | null | undefined,
): agent is AgentDescriptor & { role: 'manager' } {
  return Boolean(
    agent?.role === 'manager' &&
    agent.sessionSurface !== 'collab' &&
    profile &&
    profile.profileId === agent.profileId &&
    profile.profileType !== 'system',
  )
}
