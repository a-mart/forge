import type { CliSessionMetadata } from './cli.js'
import { CATALOG_FAMILY_IDS } from './model-catalog.js'

export type AgentStatus = 'idle' | 'streaming' | 'terminated' | 'stopped' | 'error'

export const MANAGER_MODEL_PRESETS = CATALOG_FAMILY_IDS
export type ManagerModelPreset = string

export const MANAGER_REASONING_LEVELS = ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const
export type ManagerReasoningLevel = (typeof MANAGER_REASONING_LEVELS)[number]

export interface ManagerExactModelSelection {
  provider: string
  modelId: string
}

export interface ModelVariantInfo {
  modelId: string
  label: string
  /** Variant-specific levels when they differ from the family default (for example, discovered entitlements). */
  supportedReasoningLevels?: ManagerReasoningLevel[]
  /** Variant-specific default when advertised by the provider. */
  defaultReasoningLevel?: ManagerReasoningLevel
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

/** Active context-window occupancy, not per-request or billing usage. */
export interface AgentContextUsage {
  tokens: number
  contextWindow: number
  percent: number
}

export const PROJECT_AGENT_CAPABILITIES = ['create_session'] as const
export type ProjectAgentCapability = (typeof PROJECT_AGENT_CAPABILITIES)[number]

export const PROJECT_AGENT_SOURCE_TYPES = ['local', 'repo'] as const
export type ProjectAgentSourceType = (typeof PROJECT_AGENT_SOURCE_TYPES)[number]

export const PROJECT_AGENT_SOURCE_STATUSES = [
  'local',
  'valid',
  'missing',
  'invalid',
  'conflict',
  'wrong_workspace',
  'unavailable',
] as const
export type ProjectAgentSourceStatus = (typeof PROJECT_AGENT_SOURCE_STATUSES)[number]

export interface ProjectAgentSourceProblem {
  code: string
  message: string
  path?: string
}

export interface LocalProjectAgentSourceIdentity {
  type: 'local'
}

export interface RepoProjectAgentSourceIdentity {
  type: 'repo'
  workspaceKey: string
  forgeDirRealpath: string
  definitionId: string
  activatedAt: string
  /** Signature of the activated repo definition. Used to detect live prompt/reference drift. */
  signature?: string
}

export type ProjectAgentSourceIdentity = LocalProjectAgentSourceIdentity | RepoProjectAgentSourceIdentity

export type ProjectAgentSourceKind = ProjectAgentSourceIdentity['type']

export interface ProjectAgentInfo {
  handle: string
  whenToUse: string
  /** @deprecated Use PersistedProjectAgentConfig + prompt.md-backed storage instead. Local-source only. */
  systemPrompt?: string
  creatorSessionId?: string
  capabilities?: ProjectAgentCapability[]
  /** Public non-sensitive source marker for snapshots/bootstrap payloads. */
  sourceKind?: ProjectAgentSourceKind
  /** Durable source identity only. Computed source status belongs in snapshots/inventory/preflight DTOs. */
  source?: ProjectAgentSourceIdentity
}

export function isRepoProjectAgentSource(
  source: ProjectAgentSourceIdentity | undefined,
): source is RepoProjectAgentSourceIdentity {
  return source?.type === 'repo'
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

export const AGENT_MODEL_ORIGINS = ['profile_default', 'session_override'] as const
export type AgentModelOrigin = (typeof AGENT_MODEL_ORIGINS)[number]

export const SESSION_MODEL_UPDATE_MODES = ['inherit', 'override'] as const
export type SessionModelUpdateMode = (typeof SESSION_MODEL_UPDATE_MODES)[number]

export interface ManagerProfile {
  profileId: string
  displayName: string
  defaultSessionAgentId: string
  defaultModel: AgentModelDescriptor
  createdAt: string
  updatedAt: string
  archivedAt?: string
  profileType?: 'user' | 'system'
  sortOrder?: number
}

export type AgentSessionPurpose = 'cortex_review' | 'agent_creator' | 'capture_check'
export type AgentSessionSurface = 'builder' | 'collab'

export interface AgentCollaborationLink {
  workspaceId: string
  channelId: string
}

export const EXTERNAL_THREAD_TYPES = ['codex_app_server'] as const
export type ExternalThreadType = (typeof EXTERNAL_THREAD_TYPES)[number]

export interface CodexAppServerExternalThreadInfo {
  type: 'codex_app_server'
  threadId?: string
  persisted: true
  createdByMention: boolean
  lastTurnId?: string
}

export type ExternalThreadInfo = CodexAppServerExternalThreadInfo

export type InternalWorkerKind = 'codex_plugin'

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
  modelOrigin?: AgentModelOrigin
  sessionFile: string
  contextUsage?: AgentContextUsage
  profileId?: string
  sessionLabel?: string
  sessionPurpose?: AgentSessionPurpose
  sessionSurface?: AgentSessionSurface
  collab?: AgentCollaborationLink
  cli?: CliSessionMetadata
  pinnedAt?: string
  archivedAt?: string
  lastUserMessageAt?: string
  mergedAt?: string
  compactionCount?: number
  workerCount?: number
  activeWorkerCount?: number
  streamingStartedAt?: number
  pendingChoiceCount?: number
  specialistId?: string
  specialistTier?: import('./specialists.js').EffortTier
  specialistLens?: string
  specialistDisplayName?: string
  specialistColor?: string
  internalWorkerKind?: InternalWorkerKind
  projectAgent?: ProjectAgentInfo
  agentCreatorResult?: AgentCreatorResult
  webSearch?: boolean
  externalThread?: ExternalThreadInfo
}
