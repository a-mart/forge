import type { AgentDescriptor } from '@forge/protocol'

export function shouldEnableCodexMention(
  activeAgent: Pick<AgentDescriptor, 'role' | 'sessionSurface' | 'collab'> | null | undefined,
): boolean {
  if (activeAgent?.role !== 'manager') {
    return false
  }

  if (activeAgent.sessionSurface === 'collab' || activeAgent.collab) {
    return false
  }

  return true
}
