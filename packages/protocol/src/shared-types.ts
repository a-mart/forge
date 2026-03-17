export type AgentStatus = 'idle' | 'streaming' | 'terminated' | 'stopped' | 'error'

export const MANAGER_MODEL_PRESETS = ['pi-codex', 'pi-5.4', 'pi-opus', 'codex-app'] as const
export type ManagerModelPreset = (typeof MANAGER_MODEL_PRESETS)[number]

export const MANAGER_REASONING_LEVELS = ['none', 'low', 'medium', 'high', 'xhigh'] as const
export type ManagerReasoningLevel = (typeof MANAGER_REASONING_LEVELS)[number]

export interface AgentContextUsage {
  tokens: number
  contextWindow: number
  percent: number
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
}

export type AgentSessionPurpose = 'cortex_review'

export interface AgentDescriptor {
  agentId: string
  managerId: string
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
  mergedAt?: string
  workerCount?: number
  activeWorkerCount?: number
}

export type CortexReviewRunTrigger = 'manual' | 'scheduled'
export type CortexReviewRunStatus = 'queued' | 'running' | 'completed' | 'blocked' | 'stopped'
export type CortexReviewRunAxis = 'transcript' | 'memory' | 'feedback'

export type CortexReviewRunScope =
  | { mode: 'all' }
  | {
      mode: 'session'
      profileId: string
      sessionId: string
      axes?: CortexReviewRunAxis[]
    }

export interface CortexReviewRunRecord {
  runId: string
  trigger: CortexReviewRunTrigger
  scope: CortexReviewRunScope
  scopeLabel: string
  requestText: string
  requestedAt: string
  status: CortexReviewRunStatus
  sessionAgentId: string | null
  activeWorkerCount: number
  latestCloseout: string | null
  queuePosition?: number | null
  blockedReason?: string | null
  scheduleName?: string | null
}

export type SessionMemoryMergeStatus = 'applied' | 'skipped'
export type SessionMemoryMergeAttemptStatus = SessionMemoryMergeStatus | 'failed'
export type SessionMemoryMergeStrategy =
  | 'llm'
  | 'seed'
  | 'template_noop'
  | 'idempotent_noop'
  | 'no_change'
export type SessionMemoryMergeFailureStage =
  | 'prepare'
  | 'read_inputs'
  | 'llm'
  | 'write_profile_memory'
  | 'refresh_session_meta_stats'
  | 'record_attempt'
  | 'write_audit'
  | 'save_store'

export interface SessionMemoryMergeResult {
  agentId: string
  status: SessionMemoryMergeStatus
  strategy: SessionMemoryMergeStrategy
  mergedAt?: string
  auditPath: string
}

export interface SessionWorkerMeta {
  id: string
  model: string | null
  status: 'idle' | 'streaming' | 'terminated'
  createdAt: string
  terminatedAt: string | null
  tokens: {
    input: number | null
    output: number | null
  }
}

export interface SessionMeta {
  sessionId: string
  profileId: string
  label: string | null
  model: {
    provider: string | null
    modelId: string | null
  }
  createdAt: string
  updatedAt: string
  cwd: string | null

  promptFingerprint: string | null
  promptComponents:
    | {
        archetype: string | null
        agentsFile: string | null
        skills: string[]
        memoryFile: string | null
        profileMemoryFile: string | null
      }
    | null

  workers: SessionWorkerMeta[]

  cortexReviewedAt?: string
  cortexReviewedBytes?: number
  cortexReviewedMemoryBytes?: number
  cortexReviewedMemoryAt?: string | null
  feedbackFileSize?: string | null
  lastFeedbackAt?: string | null
  cortexReviewedFeedbackBytes?: number
  cortexReviewedFeedbackAt?: string | null
  memoryMergeAttemptCount?: number
  lastMemoryMergeAttemptId?: string | null
  lastMemoryMergeAttemptAt?: string | null
  lastMemoryMergeAppliedAt?: string | null
  lastMemoryMergeStatus?: SessionMemoryMergeAttemptStatus | null
  lastMemoryMergeStrategy?: SessionMemoryMergeStrategy | null
  lastMemoryMergeFailureStage?: SessionMemoryMergeFailureStage | null
  lastMemoryMergeSourceHash?: string | null
  lastMemoryMergeProfileHashBefore?: string | null
  lastMemoryMergeProfileHashAfter?: string | null
  lastMemoryMergeAppliedSourceHash?: string | null
  lastMemoryMergeError?: string | null

  stats: {
    totalWorkers: number
    activeWorkers: number
    totalTokens: {
      input: number | null
      output: number | null
    }
    sessionFileSize: string | null
    memoryFileSize: string | null
  }
}

export type DeliveryMode = 'auto' | 'followUp' | 'steer'
export type AcceptedDeliveryMode = 'prompt' | 'followUp' | 'steer'

export type MessageChannel = 'web' | 'slack' | 'telegram'

export interface MessageSourceContext {
  channel: MessageChannel
  channelId?: string
  userId?: string
  messageId?: string
  threadTs?: string
  integrationProfileId?: string
  channelType?: 'dm' | 'channel' | 'group' | 'mpim'
  teamId?: string
}

export type MessageTargetContext = Pick<
  MessageSourceContext,
  'channel' | 'channelId' | 'userId' | 'threadTs' | 'integrationProfileId'
>

export interface DirectoryItem {
  name: string
  path: string
}

// ── Prompt Centralization ─────────────────────────────────

export type PromptCategory = 'archetype' | 'operational'

export type PromptSourceLayer = 'profile' | 'repo' | 'builtin'

export interface PromptVariableDeclaration {
  name: string
  description: string
}

export interface PromptListEntry {
  category: PromptCategory
  promptId: string
  displayName: string
  description: string
  activeLayer: PromptSourceLayer
  hasProfileOverride: boolean
  variables: PromptVariableDeclaration[]
}

export interface PromptContentResponse {
  category: PromptCategory
  promptId: string
  content: string
  sourceLayer: PromptSourceLayer
  sourcePath: string
  variables: PromptVariableDeclaration[]
}

export type CortexPromptSurfaceKind = 'registry' | 'file'
export type CortexPromptSurfaceGroup = 'system' | 'seed' | 'live' | 'scratch'
export type CortexPromptSurfaceRuntimeEffect =
  | 'futureSeedOnly'
  | 'liveImmediate'
  | 'liveInjected'
  | 'scratchOnly'
export type CortexPromptResetMode = 'profileOverride' | 'reseedFromTemplate' | 'none'

export interface CortexPromptSurfaceSeedPrompt {
  category: PromptCategory
  promptId: string
}

export interface CortexPromptSurfaceListEntry {
  surfaceId: string
  title: string
  description: string
  group: CortexPromptSurfaceGroup
  kind: CortexPromptSurfaceKind
  editable: boolean
  resetMode: CortexPromptResetMode
  runtimeEffect: CortexPromptSurfaceRuntimeEffect
  warning?: string
  category?: PromptCategory
  promptId?: string
  activeLayer?: PromptSourceLayer
  filePath?: string
  sourcePath?: string
  lastModifiedAt?: string
  seedPrompt?: CortexPromptSurfaceSeedPrompt | null
}

export interface CortexPromptSurfaceContentResponse extends CortexPromptSurfaceListEntry {
  content: string
}

export interface CortexPromptSurfaceListResponse {
  enabled: boolean
  surfaces: CortexPromptSurfaceListEntry[]
}
