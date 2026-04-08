import type {
  PersistedProjectAgentConfig,
  ProjectAgentInfo,
} from './shared-types.js'

export interface SessionProjectAgentUpdatedEvent {
  type: 'session_project_agent_updated'
  agentId: string
  profileId: string
  projectAgent: ProjectAgentInfo | null
  requestId?: string
}

export interface ProjectAgentRecommendationsEvent {
  type: 'project_agent_recommendations'
  agentId: string
  whenToUse: string
  systemPrompt: string
  requestId?: string
}

export interface ProjectAgentRecommendationsErrorEvent {
  type: 'project_agent_recommendations_error'
  agentId: string
  message: string
  requestId?: string
}

export interface ProjectAgentConfigEvent {
  type: 'project_agent_config'
  agentId: string
  config: PersistedProjectAgentConfig
  systemPrompt: string | null
  references: string[]
  requestId?: string
}

export interface ProjectAgentReferencesEvent {
  type: 'project_agent_references'
  agentId: string
  references: string[]
  requestId?: string
}

export interface ProjectAgentReferenceEvent {
  type: 'project_agent_reference'
  agentId: string
  fileName: string
  content: string
  requestId?: string
}

export interface ProjectAgentReferenceSavedEvent {
  type: 'project_agent_reference_saved'
  agentId: string
  fileName: string
  requestId?: string
}

export interface ProjectAgentReferenceDeletedEvent {
  type: 'project_agent_reference_deleted'
  agentId: string
  fileName: string
  requestId?: string
}
