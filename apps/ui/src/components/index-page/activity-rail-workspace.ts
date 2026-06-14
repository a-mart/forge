/** @vitest-environment jsdom */

export function isActivityRailWorkspaceAvailable(
  activeAgentId: string | null,
  activeManagerAgent: { agentId: string } | null,
): boolean {
  return Boolean(activeAgentId && activeManagerAgent)
}

export function resolveChatRailTargetAgentId(
  activeAgentId: string | null,
  activeAgent: { agentId: string; role: 'manager' | 'worker'; managerId?: string } | null,
  activeManagerAgent: { agentId: string } | null,
): string | null {
  if (activeAgent?.role === 'worker') {
    return activeManagerAgent?.agentId ?? activeAgent.managerId ?? null
  }

  return activeAgent?.agentId ?? activeAgentId
}
