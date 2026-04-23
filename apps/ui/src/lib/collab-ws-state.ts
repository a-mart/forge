import type {
  AgentContextUsage,
  AgentDescriptor,
  AgentStatus,
  CollaborationBootstrapCurrentUser,
  CollaborationCategory,
  CollaborationChannel,
  CollaborationReadState,
  CollaborationSessionActivityEntry,
  CollaborationTranscriptMessage,
  CollaborationWorkspace,
  ChoiceAnswer,
  ChoiceQuestion,
  ChoiceRequestStatus,
} from '@forge/protocol'

// ---------------------------------------------------------------------------
// Collab choice request (mirrors builder pattern)
// ---------------------------------------------------------------------------

export interface CollabChoiceRequest {
  agentId: string
  choiceId: string
  questions: ChoiceQuestion[]
  status: ChoiceRequestStatus
  answers?: ChoiceAnswer[]
  timestamp: string
}

// ---------------------------------------------------------------------------
// Collab WS state — fully separate from Builder/Manager WS state
// ---------------------------------------------------------------------------

export interface CollabWsState {
  /** WebSocket connected flag */
  connected: boolean

  /** Workspace metadata (single-workspace for v1) */
  workspace: CollaborationWorkspace | null

  /** All categories for the active workspace */
  categories: CollaborationCategory[]

  /** All non-archived channels for the active workspace (includes readState from bootstrap) */
  channels: CollaborationChannel[]

  /** Authenticated collab user from bootstrap */
  currentUser: CollaborationBootstrapCurrentUser | null

  // --- Active channel state ---

  /** Currently selected channel ID (driven by route state) */
  activeChannelId: string | null

  /** Room-visible messages for the active channel */
  channelHistory: CollaborationTranscriptMessage[]

  /** True once the active channel history payload has been received */
  channelHistoryLoaded: boolean

  /** AI status for the active channel */
  channelStatus: 'idle' | 'responding' | 'thinking'

  /** Optional manager streaming timestamp for Builder-style elapsed indicators */
  channelStreamingStartedAt?: number

  /** Workers currently attached to the active channel's backing session */
  sessionWorkers: AgentDescriptor[]

  /** Recent worker/session activity for the active channel */
  sessionActivity: CollaborationSessionActivityEntry[]

  /** Live status map for workers in the active channel's backing session */
  sessionAgentStatuses: Record<string, {
    status: AgentStatus
    pendingCount: number
    contextUsage?: AgentContextUsage
    contextRecoveryInProgress?: boolean
    streamingStartedAt?: number
  }>

  /** Pending choice requests for the active channel */
  pendingChoiceRequests: CollabChoiceRequest[]

  // --- Unread / read-state tracking (server-authoritative per-channel) ---

  /** Server-authoritative read state keyed by channelId */
  channelReadStates: Record<string, CollaborationReadState>

  /** Unread counts derived from bootstrap + live activity events */
  channelUnreadCounts: Record<string, number>

  /** Last error message from the collab transport */
  lastError: string | null

  /** Last error code from the collab transport, when provided by the server */
  lastErrorCode: string | null

  /** True once the first bootstrap event has been received */
  hasBootstrapped: boolean
}

// ---------------------------------------------------------------------------
// Initial state factory
// ---------------------------------------------------------------------------

export function createInitialCollabWsState(): CollabWsState {
  return {
    connected: false,
    workspace: null,
    categories: [],
    channels: [],
    currentUser: null,
    activeChannelId: null,
    channelHistory: [],
    channelHistoryLoaded: false,
    channelStatus: 'idle',
    channelStreamingStartedAt: undefined,
    sessionWorkers: [],
    sessionActivity: [],
    sessionAgentStatuses: {},
    pendingChoiceRequests: [],
    channelReadStates: {},
    channelUnreadCounts: {},
    lastError: null,
    lastErrorCode: null,
    hasBootstrapped: false,
  }
}
