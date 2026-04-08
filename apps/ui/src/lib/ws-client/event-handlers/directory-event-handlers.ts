import type { ManagerWsDirectoryEventContext } from '../types'
import type { ServerEvent } from '@forge/protocol'

export function handleDirectoryEvent(
  event: ServerEvent,
  context: ManagerWsDirectoryEventContext,
): boolean {
  switch (event.type) {
    case 'directories_listed':
      context.requestTracker.resolve('list_directories', event.requestId, {
        path: event.path,
        directories: event.directories,
      })
      return true

    case 'directory_validated':
      context.requestTracker.resolve('validate_directory', event.requestId, {
        path: event.path,
        valid: event.valid,
        message: event.message ?? null,
        resolvedPath: event.resolvedPath,
      })
      return true

    case 'directory_picked':
      context.requestTracker.resolve('pick_directory', event.requestId, event.path ?? null)
      return true

    default:
      return false
  }
}
