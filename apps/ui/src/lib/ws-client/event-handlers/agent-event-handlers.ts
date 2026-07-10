import type { ManagerWsAgentEventContext } from '../types'
import type { ServerEvent } from '@forge/protocol'

export function handleAgentEvent(event: ServerEvent, context: ManagerWsAgentEventContext): boolean {
  switch (event.type) {
    case 'agent_status':
      context.applyAgentStatus(event)
      return true

    case 'agents_snapshot':
      context.applyAgentsSnapshot(event.agents)
      return true

    case 'session_workers_snapshot':
      context.applySessionWorkersSnapshot(event.sessionAgentId, event.workers, event.requestId)
      return true

    case 'manager_created':
      context.applyManagerCreated(event.manager)
      context.requestTracker.resolve('create_manager', event.requestId, event.manager)
      return true

    case 'repository_project_creation_progress':
      context.onRepositoryProjectCreationProgress?.(event)
      return true

    case 'repository_project_created':
      context.applyManagerCreated(event.manager)
      context.requestTracker.resolve('create_repository_project', event.requestId, {
        manager: event.manager,
        repositoryPath: event.repositoryPath,
      })
      return true

    case 'repository_project_creation_cancelled':
      if (event.requestId) {
        context.requestTracker.reject(
          'create_repository_project',
          event.requestId,
          Object.assign(new Error('Clone was cancelled.'), { code: 'clone_cancelled' }),
        )
      }
      return true

    case 'repository_project_creation_cancel_result':
      context.requestTracker.resolve('cancel_repository_project_creation', event.requestId, {
        operationRequestId: event.operationRequestId,
        accepted: event.accepted,
        tooLate: event.tooLate,
      })
      return true

    case 'manager_deleted':
      context.applyManagerDeleted(event.managerId)
      context.requestTracker.resolve('delete_manager', event.requestId, {
        managerId: event.managerId,
      })
      return true

    case 'profile_default_model_updated':
      context.requestTracker.resolve('update_profile_default_model', event.requestId, {
        profileId: event.profileId,
      })
      return true

    case 'manager_model_updated':
      context.requestTracker.resolve('update_manager_model', event.requestId, {
        managerId: event.managerId,
      })
      return true

    case 'manager_cwd_updated':
      context.requestTracker.resolve('update_manager_cwd', event.requestId, {
        managerId: event.managerId,
        cwd: event.cwd,
      })
      return true

    case 'stop_all_agents_result': {
      const stoppedWorkerIds = event.stoppedWorkerIds ?? event.terminatedWorkerIds ?? []
      const managerStopped = event.managerStopped ?? event.managerTerminated ?? false

      context.requestTracker.resolve('stop_all_agents', event.requestId, {
        managerId: event.managerId,
        stoppedWorkerIds,
        managerStopped,
      })
      return true
    }

    default:
      return false
  }
}
