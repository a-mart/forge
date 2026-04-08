import type { ManagerWsSystemEventContext } from '../types'
import type { ServerEvent } from '@forge/protocol'

export function handleSystemEvent(
  event: ServerEvent,
  context: ManagerWsSystemEventContext,
): boolean {
  switch (event.type) {
    case 'error':
      context.updateState({ lastError: event.message })
      context.pushSystemMessage(`${event.code}: ${event.message}`)
      context.rejectPendingFromError(event.code, event.message, event.requestId)
      return true

    default:
      return false
  }
}
