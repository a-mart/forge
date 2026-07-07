import type {
  AgentContextUsage,
  AgentDescriptor,
  AgentStatus,
  ConversationEntry,
  ManagerProfile,
  ProjectPresenceViewer,
  SessionTaskStateSnapshotEvent,
  RestartRecoverySnapshot,
  TelegramStatusEvent,
  TerminalDescriptor,
} from '@forge/protocol'

export type ConversationHistoryEntry = Extract<
  ConversationEntry,
  { type: 'conversation_message' | 'conversation_log' | 'choice_request' | 'work_plan_created' }
>
export type ModelCacheObservationEntry = Extract<
  ConversationEntry,
  { type: 'model_cache_observation' }
>
export type AgentActivityEntry = Extract<
  ConversationEntry,
  { type: 'agent_message' | 'agent_tool_call' }
>

export interface ManagerWsState {
  connected: boolean
  targetAgentId: string | null
  subscribedAgentId: string | null
  messages: ConversationHistoryEntry[]
  activityMessages: AgentActivityEntry[]
  /** Persisted cache observations for header UI; not rendered as chat rows. */
  modelCacheObservations: ModelCacheObservationEntry[]
  /** Bootstrap/live observations held until persisted setting is loaded. */
  pendingModelCacheObservations: ModelCacheObservationEntry[]
  /** False until GET/WS confirms server setting; avoids dropping bootstrap while unknown. */
  modelCacheVisualizationSettingLoaded: boolean
  /** Choice IDs with pending status for the current session */
  pendingChoiceIds: Set<string>
  agents: AgentDescriptor[]
  loadedSessionIds: Set<string>
  profiles: ManagerProfile[]
  statuses: Record<string, { status: AgentStatus; pendingCount: number; contextUsage?: AgentContextUsage; contextRecoveryInProgress?: boolean; streamingStartedAt?: number }>
  lastError: string | null
  lastSuccess: string | null
  telegramStatus: TelegramStatusEvent | null
  unreadCounts: Record<string, number>
  /** Wave R presence: connected member identities per session (SPEC §4.7). */
  projectPresence: Record<string, ProjectPresenceViewer[]>
  terminals: TerminalDescriptor[]
  terminalSessionScopeId: string | null
  taskSnapshots: Record<string, SessionTaskStateSnapshotEvent>
  restartRecovery: RestartRecoverySnapshot | null
  /** Session whose cached task snapshot is suppressed until a fresh bootstrap/live snapshot arrives. */
  taskSnapshotLoadingSessionId: string | null
  hasReceivedAgentsSnapshot: boolean
  /** Monotonically increasing counter bumped on prompt-related WS events */
  promptChangeKey: number
  /** Monotonically increasing counter bumped on specialist_roster_changed WS events */
  specialistChangeKey: number
  /** Monotonically increasing counter bumped on model_config_changed WS events */
  modelConfigChangeKey: number
  /** Global Active Work Plans feature toggle; defaults to enabled. */
  workPlansEnabled: boolean
  /** Prompt/model cache visualization toggle; defaults to off. */
  modelCacheVisualizationEnabled: boolean
}

export function createInitialManagerWsState(targetAgentId: string | null): ManagerWsState {
  return {
    connected: false,
    targetAgentId,
    subscribedAgentId: null,
    messages: [],
    activityMessages: [],
    modelCacheObservations: [],
    pendingModelCacheObservations: [],
    modelCacheVisualizationSettingLoaded: false,
    pendingChoiceIds: new Set(),
    agents: [],
    loadedSessionIds: new Set(),
    profiles: [],
    statuses: {},
    lastError: null,
    lastSuccess: null,
    telegramStatus: null,
    unreadCounts: {},
    projectPresence: {},
    terminals: [],
    terminalSessionScopeId: null,
    taskSnapshots: {},
    restartRecovery: null,
    taskSnapshotLoadingSessionId: null,
    hasReceivedAgentsSnapshot: false,
    promptChangeKey: 0,
    specialistChangeKey: 0,
    modelConfigChangeKey: 0,
    workPlansEnabled: false,
    modelCacheVisualizationEnabled: false,
  }
}
