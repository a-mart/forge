import type { MessageSourceView } from '@/components/chat/ChatHeader'

/**
 * Default Web/All channel filter for the Builder chat header.
 * Selected workers default to All so worker-visible rows are not hidden;
 * managers (and unset selection) keep the existing Web default.
 */
export function defaultMessageSourceViewForAgentRole(
  role: 'manager' | 'worker' | null | undefined,
): MessageSourceView {
  return role === 'worker' ? 'all' : 'web'
}
