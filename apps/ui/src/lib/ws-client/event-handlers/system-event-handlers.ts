import type { ManagerWsSystemEventContext } from '../types'
import type { ServerEvent } from '@forge/protocol'

export function handleSystemEvent(
  event: ServerEvent,
  context: ManagerWsSystemEventContext,
): boolean {
  switch (event.type) {
    case 'error':
      // Directory browser commands are request-scoped utilities, not agent
      // failures. Their errors belong to the initiating dialog only.
      if (context.isPendingDirectoryRequest(event.requestId)) {
        context.rejectPendingFromError(event.code, event.message, event.requestId)
        return true
      }
      context.updateState({ lastError: event.message })
      context.pushSystemMessage(`${event.code}: ${event.message}`)
      context.rejectPendingFromError(event.code, event.message, event.requestId)
      return true

    case 'restart_recovery_snapshot':
      context.updateState({ restartRecovery: event.snapshot })
      return true

    default:
      return false
  }
}
