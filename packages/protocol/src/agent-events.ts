import type {
  AgentContextUsage,
  AgentDescriptor,
  AgentStatus,
} from './shared-types.js'

export interface AgentStatusEvent {
  type: 'agent_status'
  agentId: string
  managerId?: string
  status: AgentStatus
  pendingCount: number
  contextUsage?: AgentContextUsage
  contextRecoveryInProgress?: boolean
  streamingStartedAt?: number
}

export interface AgentsSnapshotEvent {
  type: 'agents_snapshot'
  agents: AgentDescriptor[]
}

export interface SessionWorkersSnapshotEvent {
  type: 'session_workers_snapshot'
  sessionAgentId: string
  workers: AgentDescriptor[]
  requestId?: string
}
