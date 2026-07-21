/** @vitest-environment jsdom */

const ACTIVITY_RAIL_MEDIA_QUERY = '(min-width: 768px)'

export function isActivityRailViewportAvailable(): boolean {
  return typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(ACTIVITY_RAIL_MEDIA_QUERY).matches
}

export function isActivityRailWorkspaceAvailable(
  activeAgentId: string | null,
  activeManagerAgent: { agentId: string } | null,
): boolean {
  return Boolean(activeAgentId && activeManagerAgent)
}

export function resolveSourceControlDeepLinkPresentation(
  activeAgentId: string | null,
  activeManagerAgent: { agentId: string } | null,
  activityRailViewportAvailable = isActivityRailViewportAvailable(),
): 'inline' | 'modal' {
  return activityRailViewportAvailable &&
    isActivityRailWorkspaceAvailable(activeAgentId, activeManagerAgent)
    ? 'inline'
    : 'modal'
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
