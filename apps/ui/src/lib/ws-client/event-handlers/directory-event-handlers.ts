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
        requestedPath: event.requestedPath,
        resolvedPath: event.resolvedPath,
        parentPath: event.parentPath,
        roots: event.roots,
        entries: event.entries,
      })
      return true

    case 'directory_validated':
      context.requestTracker.resolve('validate_directory', event.requestId, {
        path: event.path,
        valid: event.valid,
        message: event.message ?? null,
        resolvedPath: event.resolvedPath,
        roots: event.roots,
      })
      return true

    case 'directory_created':
      context.requestTracker.resolve('create_directory', event.requestId, {
        path: event.path,
        parentPath: event.parentPath,
        name: event.name,
        roots: event.roots,
      })
      return true

    case 'directory_picked':
      context.requestTracker.resolve('pick_directory', event.requestId, event.path ?? null)
      return true

    default:
      return false
  }
}
