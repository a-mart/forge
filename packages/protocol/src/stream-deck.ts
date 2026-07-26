import type { AgentStatus } from './agents.js'

export const STREAM_DECK_PROTOCOL_VERSION = 1

export const STREAM_DECK_ACCESS_SCOPES = ['snapshot:read', 'actions:write'] as const
export type StreamDeckAccessScope = (typeof STREAM_DECK_ACCESS_SCOPES)[number]

export interface StreamDeckPairingRequestInput {
  deviceId: string
  deviceName: string
  pluginVersion: string
}

export interface StreamDeckPairingRequestCreated {
  requestId: string
  verificationCode: string
  claimSecret: string
  expiresAt: string
}

export interface StreamDeckPairingClaimRequest {
  claimSecret: string
}

export type StreamDeckPairingClaimResponse =
  | { status: 'pending' }
  | { status: 'denied' }
  | {
      status: 'approved'
      accessToken: string
      device: StreamDeckDeviceDescriptor
      scopes: StreamDeckAccessScope[]
    }

export interface StreamDeckPendingPairingDescriptor {
  requestId: string
  deviceId: string
  deviceName: string
  pluginVersion: string
  verificationCode: string
  createdAt: string
  expiresAt: string
}

export interface StreamDeckDeviceDescriptor {
  id: string
  deviceId: string
  deviceName: string
  pluginVersion: string
  createdAt: string
  lastUsedAt?: string
  revokedAt?: string
}

export interface StreamDeckSettingsSnapshot {
  pendingRequests: StreamDeckPendingPairingDescriptor[]
  devices: StreamDeckDeviceDescriptor[]
}

export const STREAM_DECK_ACTION_TYPES = [
  'send_prompt',
  'toggle_session',
  'stop_session',
  'resume_session',
  'smart_compact',
  'create_session',
  'mark_read',
] as const

export type StreamDeckActionType = (typeof STREAM_DECK_ACTION_TYPES)[number]

export interface StreamDeckProfileSummary {
  profileId: string
  displayName: string
  updatedAt: string
  sessionCount: number
  activeSessionCount: number
  unreadCount: number
}

export interface StreamDeckSessionSummary {
  agentId: string
  profileId: string
  profileName: string
  label: string
  status: AgentStatus
  updatedAt: string
  lastUserMessageAt?: string
  contextPercent: number
  workerCount: number
  activeWorkerCount: number
  pendingChoiceCount: number
  unreadCount: number
  compactionCount: number
}

export interface StreamDeckStatsSummary {
  tokensToday: number
  tokensLast7Days: number
  cacheHitRate: number
  currentlyActiveWorkers: number
  totalWorkersRun: number
  activeSessions: number
  linesAdded: number
  linesDeleted: number
  commits: number
}

export interface StreamDeckSnapshot {
  protocolVersion: typeof STREAM_DECK_PROTOCOL_VERSION
  serverTime: string
  serverVersion: string
  summary: {
    profileCount: number
    sessionCount: number
    runningSessionCount: number
    activeWorkerCount: number
    pendingChoiceCount: number
    unreadCount: number
  }
  focusSessionAgentId: string | null
  profiles: StreamDeckProfileSummary[]
  sessions: StreamDeckSessionSummary[]
  stats: StreamDeckStatsSummary | null
}

interface StreamDeckActionBase {
  requestId: string
  type: StreamDeckActionType
}

export type StreamDeckActionRequest =
  | (StreamDeckActionBase & {
      type: 'send_prompt'
      sessionAgentId: string
      text: string
      delivery?: 'auto' | 'followUp' | 'steer'
    })
  | (StreamDeckActionBase & {
      type: 'toggle_session' | 'stop_session' | 'resume_session' | 'smart_compact' | 'mark_read'
      sessionAgentId: string
    })
  | (StreamDeckActionBase & {
      type: 'create_session'
      profileId: string
      label?: string
    })

export type StreamDeckActionResponse =
  | {
      ok: true
      requestId: string
      type: StreamDeckActionType
      sessionAgentId?: string
      message: string
    }
  | {
      ok: false
      requestId: string | null
      code: string
      message: string
    }
