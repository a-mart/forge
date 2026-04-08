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

    case 'manager_deleted':
      context.applyManagerDeleted(event.managerId)
      context.requestTracker.resolve('delete_manager', event.requestId, {
        managerId: event.managerId,
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
