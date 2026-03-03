export type AgentStatus = 'idle' | 'streaming' | 'terminated' | 'stopped' | 'error'

export const MANAGER_MODEL_PRESETS = ['pi-codex', 'pi-opus', 'codex-app'] as const
export type ManagerModelPreset = (typeof MANAGER_MODEL_PRESETS)[number]

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
  mergedAt?: string
}

export interface SessionWorkerMeta {
  id: string
  model: string | null
  status: 'running' | 'idle' | 'streaming' | 'terminated'
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
