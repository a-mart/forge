import type {
  AgentDescriptor,
  ManagerProfile,
  SessionMemoryMergeFailureStage,
  SessionMemoryMergeResult,
  SessionMemoryMergeStrategy,
} from './shared-types.js'

export interface SessionCreatedEvent {
  type: 'session_created'
  profile: ManagerProfile
  sessionAgent: AgentDescriptor
  requestId?: string
}

export interface SessionStoppedEvent {
  type: 'session_stopped'
  agentId: string
  profileId: string
  terminatedWorkerIds: string[]
  requestId?: string
}

export interface SessionResumedEvent {
  type: 'session_resumed'
  agentId: string
  profileId: string
  requestId?: string
}

export interface SessionDeletedEvent {
  type: 'session_deleted'
  agentId: string
  profileId: string
  terminatedWorkerIds: string[]
  requestId?: string
}

export interface SessionClearedEvent {
  type: 'session_cleared'
  agentId: string
  requestId?: string
}

export interface SessionRenamedEvent {
  type: 'session_renamed'
  agentId: string
  label: string
  requestId?: string
}

export interface SessionPinnedEvent {
  type: 'session_pinned'
  agentId: string
  pinned: boolean
  pinnedAt: string | null
  requestId?: string
}

export interface SessionForkedEvent {
  type: 'session_forked'
  sourceAgentId: string
  newSessionAgent: AgentDescriptor
  profile: ManagerProfile
  fromMessageId?: string
  requestId?: string
}

export interface SessionMemoryMergeStartedEvent {
  type: 'session_memory_merge_started'
  agentId: string
  requestId?: string
}

export interface SessionMemoryMergedEvent extends SessionMemoryMergeResult {
  type: 'session_memory_merged'
  requestId?: string
}

export interface SessionMemoryMergeFailedEvent {
  type: 'session_memory_merge_failed'
  agentId: string
  message: string
  status: 'failed'
  strategy?: SessionMemoryMergeStrategy
  stage?: SessionMemoryMergeFailureStage
  auditPath?: string
  requestId?: string
}
