import type {
  AgentContextUsage,
  AgentDescriptor,
  AgentStatus,
  ConversationEntry,
  ManagerProfile,
  PlaywrightDiscoverySettings,
  PlaywrightDiscoverySnapshot,
  SlackStatusEvent,
  TelegramStatusEvent,
} from '@forge/protocol'

export type ConversationHistoryEntry = Extract<
  ConversationEntry,
  { type: 'conversation_message' | 'conversation_log' }
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
  agents: AgentDescriptor[]
  loadedSessionIds: Set<string>
  profiles: ManagerProfile[]
  statuses: Record<string, { status: AgentStatus; pendingCount: number; contextUsage?: AgentContextUsage; contextRecoveryInProgress?: boolean; streamingStartedAt?: number }>
  lastError: string | null
  lastSuccess: string | null
  slackStatus: SlackStatusEvent | null
  telegramStatus: TelegramStatusEvent | null
  playwrightSnapshot: PlaywrightDiscoverySnapshot | null
  playwrightSettings: PlaywrightDiscoverySettings | null
  unreadCounts: Record<string, number>
  hasReceivedAgentsSnapshot: boolean
  /** Monotonically increasing counter bumped on prompt-related WS events */
  promptChangeKey: number
}

export function createInitialManagerWsState(targetAgentId: string | null): ManagerWsState {
  return {
    connected: false,
    targetAgentId,
    subscribedAgentId: null,
    messages: [],
    activityMessages: [],
    agents: [],
    loadedSessionIds: new Set(),
    profiles: [],
    statuses: {},
    lastError: null,
    lastSuccess: null,
    slackStatus: null,
    telegramStatus: null,
    playwrightSnapshot: null,
    playwrightSettings: null,
    unreadCounts: {},
    hasReceivedAgentsSnapshot: false,
    promptChangeKey: 0,
  }
}
