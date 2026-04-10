import { CATALOG_FAMILY_IDS } from './model-catalog.js'

export type AgentStatus = 'idle' | 'streaming' | 'terminated' | 'stopped' | 'error'

export const MANAGER_MODEL_PRESETS = CATALOG_FAMILY_IDS
export type ManagerModelPreset = string

export const MANAGER_REASONING_LEVELS = ['none', 'low', 'medium', 'high', 'xhigh'] as const
export type ManagerReasoningLevel = (typeof MANAGER_REASONING_LEVELS)[number]

export interface ModelVariantInfo {
  modelId: string
  label: string
}

export interface ModelPresetInfo {
  presetId: ManagerModelPreset
  displayName: string
  provider: string
  modelId: string
  defaultReasoningLevel: ManagerReasoningLevel
  supportedReasoningLevels: ManagerReasoningLevel[]
  webSearch?: boolean
  variants?: ModelVariantInfo[]
}

export interface AgentContextUsage {
  tokens: number
  contextWindow: number
  percent: number
}

export const PROJECT_AGENT_CAPABILITIES = ['create_session'] as const
export type ProjectAgentCapability = (typeof PROJECT_AGENT_CAPABILITIES)[number]

export interface ProjectAgentInfo {
  handle: string
  whenToUse: string
  /** @deprecated Use PersistedProjectAgentConfig + prompt.md-backed storage instead. */
  systemPrompt?: string
  creatorSessionId?: string
  capabilities?: ProjectAgentCapability[]
}

export interface PersistedProjectAgentConfig {
  version: number
  agentId: string
  handle: string
  whenToUse: string
  creatorSessionId?: string
  capabilities?: ProjectAgentCapability[]
  promotedAt: string
  updatedAt: string
}

export interface AgentCreatorResult {
  createdAgentId: string
  createdHandle: string
  createdAt: string
}

export interface AgentModelDescriptor {
  provider: string
  modelId: string
  thinkingLevel: string
}

export interface ManagerProfile {
  profileId: string
  displayName: string
  defaultSessionAgentId: string
  createdAt: string
  updatedAt: string
  sortOrder?: number
}

export type AgentSessionPurpose = 'cortex_review' | 'agent_creator'

export interface AgentDescriptor {
  agentId: string
  managerId: string
  creatorAgentId?: string
  displayName: string
  role: 'manager' | 'worker'
  archetypeId?: string
  status: AgentStatus
  createdAt: string
  updatedAt: string
  cwd: string
  model: AgentModelDescriptor
  sessionFile: string
  contextUsage?: AgentContextUsage
  profileId?: string
  sessionLabel?: string
  sessionPurpose?: AgentSessionPurpose
  pinnedAt?: string
  mergedAt?: string
  compactionCount?: number
  workerCount?: number
  activeWorkerCount?: number
  streamingStartedAt?: number
  pendingChoiceCount?: number
  specialistId?: string
  specialistDisplayName?: string
  specialistColor?: string
  projectAgent?: ProjectAgentInfo
  agentCreatorResult?: AgentCreatorResult
  webSearch?: boolean
}
