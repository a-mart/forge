import type { ManagerWsProjectAgentEventContext } from '../types'
import type { ServerEvent } from '@forge/protocol'

export function handleProjectAgentEvent(
  event: ServerEvent,
  context: ManagerWsProjectAgentEventContext,
): boolean {
  switch (event.type) {
    case 'session_project_agent_updated':
      if (event.requestId) {
        context.requestTracker.resolve('set_session_project_agent', event.requestId, {
          agentId: event.agentId,
          profileId: event.profileId,
          projectAgent: event.projectAgent,
        })
      }
      return true

    case 'project_agent_config':
      if (event.requestId) {
        context.requestTracker.resolve('get_project_agent_config', event.requestId, {
          agentId: event.agentId,
          config: event.config,
          systemPrompt: event.systemPrompt,
          references: event.references,
        })
      }
      return true

    case 'project_agent_references':
      if (event.requestId) {
        context.requestTracker.resolve('list_project_agent_references', event.requestId, {
          agentId: event.agentId,
          references: event.references,
        })
      }
      return true

    case 'project_agent_reference':
      if (event.requestId) {
        context.requestTracker.resolve('get_project_agent_reference', event.requestId, {
          agentId: event.agentId,
          fileName: event.fileName,
          content: event.content,
        })
      }
      return true

    case 'project_agent_reference_saved':
      if (event.requestId) {
        context.requestTracker.resolve('set_project_agent_reference', event.requestId, {
          agentId: event.agentId,
          fileName: event.fileName,
        })
      }
      return true

    case 'project_agent_reference_deleted':
      if (event.requestId) {
        context.requestTracker.resolve('delete_project_agent_reference', event.requestId, {
          agentId: event.agentId,
          fileName: event.fileName,
        })
      }
      return true

    case 'project_agent_recommendations':
      context.requestTracker.resolve('request_project_agent_recommendations', event.requestId, {
        agentId: event.agentId,
        whenToUse: event.whenToUse,
        systemPrompt: event.systemPrompt,
      })
      return true

    case 'project_agent_recommendations_error':
      if (event.requestId) {
        context.requestTracker.reject(
          'request_project_agent_recommendations',
          event.requestId,
          new Error(event.message || 'Failed to generate project agent recommendations.'),
        )
      }
      return true

    default:
      return false
  }
}
