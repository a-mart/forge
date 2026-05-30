import type { AgentDescriptor } from '@forge/protocol'

export function shouldEnableCodexMention(
  activeAgent: Pick<AgentDescriptor, 'role'> | null | undefined,
): boolean {
  return activeAgent?.role === 'manager'
}
