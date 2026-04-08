import type { ManagerWsSessionEventContext } from '../types'
import type { ServerEvent } from '@forge/protocol'

export function handleSessionEvent(
  event: ServerEvent,
  context: ManagerWsSessionEventContext,
): boolean {
  switch (event.type) {
    case 'session_created':
      context.requestTracker.resolve('create_session', event.requestId, {
        sessionAgent: event.sessionAgent,
        profileId: event.profile.profileId,
      })
      return true

    case 'session_stopped':
      context.requestTracker.resolve('stop_session', event.requestId, {
        agentId: event.agentId,
      })
      return true

    case 'session_resumed':
      context.requestTracker.resolve('resume_session', event.requestId, {
        agentId: event.agentId,
      })
      return true

    case 'session_deleted':
      context.applySessionDeleted(event.agentId, event.profileId)
      context.requestTracker.resolve('delete_session', event.requestId, {
        agentId: event.agentId,
      })
      return true

    case 'session_cleared':
      context.requestTracker.resolve('clear_session', event.requestId, {
        agentId: event.agentId,
      })
      return true

    case 'session_renamed':
      context.requestTracker.resolve('rename_session', event.requestId, {
        agentId: event.agentId,
      })
      return true

    case 'session_pinned':
      context.requestTracker.resolve('pin_session', event.requestId, {
        pinnedAt: event.pinnedAt,
      })
      return true

    case 'profile_renamed':
      context.requestTracker.resolve('rename_profile', event.requestId, {
        profileId: event.profileId,
      })
      return true

    case 'session_forked':
      context.requestTracker.resolve('fork_session', event.requestId, {
        sourceAgentId: event.sourceAgentId,
        newSessionAgent: event.newSessionAgent,
      })
      return true

    case 'session_memory_merge_started':
      return true

    case 'session_memory_merged':
      context.requestTracker.resolve('merge_session_memory', event.requestId, {
        agentId: event.agentId,
        status: event.status,
        strategy: event.strategy,
        mergedAt: event.mergedAt,
        auditPath: event.auditPath,
      })
      return true

    case 'session_memory_merge_failed':
      if (event.requestId) {
        context.requestTracker.reject(
          'merge_session_memory',
          event.requestId,
          new Error(event.message || 'Session memory merge failed.'),
        )
      }
      return true

    default:
      return false
  }
}
