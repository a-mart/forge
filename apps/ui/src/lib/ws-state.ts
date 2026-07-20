import type {
  AgentContextUsage,
  AgentDescriptor,
  AgentStatus,
  ConversationEntry,
  ConversationHistoryPageMetadata,
  ManagerProfile,
  ProjectPresenceViewer,
  SessionPlanSnapshotEvent,
  SessionGoalSnapshotEvent,
  RestartRecoverySnapshot,
  TerminalDescriptor,
} from '@forge/protocol'

export type ConversationHistoryEntry = Extract<
  ConversationEntry,
  { type: 'conversation_message' | 'conversation_log' | 'choice_request' | 'plan_summary' }
>
export type ModelCacheObservationEntry = Extract<
  ConversationEntry,
  { type: 'model_cache_observation' }
>
export type AgentActivityEntry = Extract<
  ConversationEntry,
  { type: 'agent_message' | 'agent_tool_call' | 'activity_summary' }
>

export interface ConversationHistoryMutation {
  revision: number
  kind: 'replace' | 'prepend'
}

export interface ManagerWsState {
  connected: boolean
  /** Monotonic transport-open generation; increments even if reconnect state is React-batched. */
  connectionEpoch: number
  targetAgentId: string | null
  subscribedAgentId: string | null
  messages: ConversationHistoryEntry[]
  activityMessages: AgentActivityEntry[]
  conversationPage: ConversationHistoryPageMetadata | null
  conversationPageLoading: boolean
  /** Request id for the one older-page response allowed to mutate the active timeline. */
  conversationPageRequestId: string | null
  /** Explicit transport mutation so the viewport never has to infer replace vs prepend. */
  conversationHistoryMutation: ConversationHistoryMutation | null
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
  unreadCounts: Record<string, number>
  /** Latest local-instance order invalidation; the full preference is refetched over HTTP. */
  builderSidebarOrderRevision: number | null
  /** Wave R presence: connected member identities per session (SPEC §4.7). */
  projectPresence: Record<string, ProjectPresenceViewer[]>
  terminals: TerminalDescriptor[]
  terminalSessionScopeId: string | null
  planSnapshots: Record<string, SessionPlanSnapshotEvent>
  goalSnapshots: Record<string, SessionGoalSnapshotEvent>
  restartRecovery: RestartRecoverySnapshot | null
  /** Session whose cached plan snapshot is suppressed until a fresh bootstrap/live snapshot arrives. */
  planSnapshotLoadingSessionId: string | null
  goalSnapshotLoadingSessionId: string | null
  hasReceivedAgentsSnapshot: boolean
  /** True only after the current connection bootstrap has delivered the full profile inventory. */
  hasReceivedProfilesSnapshot: boolean
  /** Monotonically increasing counter bumped on prompt-related WS events */
  promptChangeKey: number
  /** Monotonically increasing counter bumped on specialist_roster_changed WS events */
  specialistChangeKey: number
  /** Monotonically increasing counter bumped on model_config_changed WS events */
  modelConfigChangeKey: number
  /** Prompt/model cache visualization toggle; defaults to off. */
  modelCacheVisualizationEnabled: boolean
}

export function createInitialManagerWsState(targetAgentId: string | null): ManagerWsState {
  return {
    connected: false,
    connectionEpoch: 0,
    targetAgentId,
    subscribedAgentId: null,
    messages: [],
    activityMessages: [],
    conversationPage: null,
    conversationPageLoading: false,
    conversationPageRequestId: null,
    conversationHistoryMutation: null,
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
    unreadCounts: {},
    builderSidebarOrderRevision: null,
    projectPresence: {},
    terminals: [],
    terminalSessionScopeId: null,
    planSnapshots: {},
    goalSnapshots: {},
    restartRecovery: null,
    planSnapshotLoadingSessionId: null,
    goalSnapshotLoadingSessionId: null,
    hasReceivedAgentsSnapshot: false,
    hasReceivedProfilesSnapshot: false,
    promptChangeKey: 0,
    specialistChangeKey: 0,
    modelConfigChangeKey: 0,
    modelCacheVisualizationEnabled: false,
  }
}
