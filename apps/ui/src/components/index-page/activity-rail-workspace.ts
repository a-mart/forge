/** @vitest-environment jsdom */

export function isActivityRailWorkspaceAvailable(
  activeAgentId: string | null,
  activeManagerAgent: { agentId: string } | null,
): boolean {
  return Boolean(activeAgentId && activeManagerAgent)
}
