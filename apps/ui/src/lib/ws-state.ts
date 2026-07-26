import type {
  AgentContextUsage,
  AgentDescriptor,
  BrowserHostConnectionSnapshot,
  BrowserSessionSnapshot,
  AgentStatus,
  ConversationEntry,
  ConversationHistoryPageMetadata,
  ManagerProfile,
  RemoteUpdateAwarenessProjectSnapshot,
  ProjectPresenceViewer,
  SessionPlanSnapshotEvent,
  SessionGoalSnapshotEvent,
  SecureSessionSnapshot,
  RestartRecoverySnapshot,
  TerminalDescriptor,
  CodexElicitationRequestEvent,
  BuilderTimelineChannelView,
  StreamDeckNavigationRequestedEvent,
} from '@forge/protocol'
import type { ConversationPresentationSnapshot } from './ws-client/conversation-snapshot-cache'
import type { ConversationSubscriptionReason } from './ws-client/conversation-bootstrap-metrics'

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

export type ConversationBootstrapPhase = 'idle' | 'pending' | 'ready' | 'error'
export type BootstrapProtocolMode = 'unknown' | 'correlated' | 'legacy'

export interface ConversationBootstrapState {
  phase: ConversationBootstrapPhase
  agentId: string | null
  subscriptionId: string | null
  requestedView: BuilderTimelineChannelView
  servedView: BuilderTimelineChannelView | null
  reason: ConversationSubscriptionReason | null
  protocolMode: BootstrapProtocolMode
  startedAt: number | null
  errorCode?: string
  errorMessage?: string
}

export interface BrowserPanelRevealRequest {
  sessionAgentId: string
  profileId: string
  tabId: string
  hostGeneration: number
  sequence: number
}

export interface ManagerWsState {
  connected: boolean
  /** Monotonic transport-open generation; increments even if reconnect state is React-batched. */
  connectionEpoch: number
  targetAgentId: string | null
  subscribedAgentId: string | null
  /** Explicit lifecycle for the selected conversation bootstrap. */
  conversationBootstrap: ConversationBootstrapState
  /** Frozen, passive cache overlay. Never used as reducer or command authority. */
  conversationPresentation: ConversationPresentationSnapshot | null
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
  /** Ephemeral only: never reconstructed from conversation history. */
  codexElicitations: CodexElicitationRequestEvent[]
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
  /** Secure execution authority keyed by manager session id. */
  secureSessionSnapshots: Record<string, SecureSessionSnapshot>
  restartRecovery: RestartRecoverySnapshot | null
  /** Session whose cached plan snapshot is suppressed until a fresh bootstrap/live snapshot arrives. */
  planSnapshotLoadingSessionId: string | null
  goalSnapshotLoadingSessionId: string | null
  /** Session whose cached secure snapshot is suppressed until fresh authority arrives. */
  secureSessionSnapshotLoadingSessionId: string | null
  /** Latest secure-secret catalog invalidation for this backend connection epoch. */
  secureSecretCatalogRevision: number | null
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
  /** Local Builder projection for the currently subscribed project only. */
  remoteUpdateAwarenessSnapshot: RemoteUpdateAwarenessProjectSnapshot | null
  /** Backend host metadata for the current transport epoch. */
  browserHost: BrowserHostConnectionSnapshot
  /** Canonical browser snapshots keyed by Forge manager session id. */
  browserSessions: Record<string, BrowserSessionSnapshot>
  /** True after the current host generation received its all-session hydration. */
  browserHostHydrated: boolean
  /** Durable unacknowledged intent projected onto the current authoritative host generation. */
  browserPanelRevealRequest: BrowserPanelRevealRequest | null
  /** Latest authenticated local Stream Deck request for the desktop shell. */
  streamDeckNavigationRequest: StreamDeckNavigationRequestedEvent | null
  /** Metadata is retained during reconnect but marked stale until bootstrap. */
  browserMetadataStale: boolean
}

export function createInitialManagerWsState(targetAgentId: string | null): ManagerWsState {
  return {
    connected: false,
    connectionEpoch: 0,
    targetAgentId,
    subscribedAgentId: null,
    conversationBootstrap: {
      phase: 'idle',
      agentId: targetAgentId,
      subscriptionId: null,
      requestedView: 'web',
      servedView: null,
      reason: null,
      protocolMode: 'unknown',
      startedAt: null,
    },
    conversationPresentation: null,
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
    codexElicitations: [],
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
    secureSessionSnapshots: {},
    restartRecovery: null,
    planSnapshotLoadingSessionId: null,
    goalSnapshotLoadingSessionId: null,
    secureSessionSnapshotLoadingSessionId: null,
    secureSecretCatalogRevision: null,
    hasReceivedAgentsSnapshot: false,
    hasReceivedProfilesSnapshot: false,
    promptChangeKey: 0,
    specialistChangeKey: 0,
    modelConfigChangeKey: 0,
    modelCacheVisualizationEnabled: false,
    remoteUpdateAwarenessSnapshot: null,
    browserHost: {
      connected: false,
      hostId: null,
      hostGeneration: null,
      focused: false,
      capabilities: null,
      connectedAt: null,
    },
    browserSessions: {},
    browserHostHydrated: false,
    browserPanelRevealRequest: null,
    streamDeckNavigationRequest: null,
    browserMetadataStale: false,
  }
}
