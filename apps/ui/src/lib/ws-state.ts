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
} from '@middleman/protocol'

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
  profiles: ManagerProfile[]
  statuses: Record<string, { status: AgentStatus; pendingCount: number; contextUsage?: AgentContextUsage }>
  lastError: string | null
  lastSuccess: string | null
  slackStatus: SlackStatusEvent | null
  telegramStatus: TelegramStatusEvent | null
  playwrightSnapshot: PlaywrightDiscoverySnapshot | null
  playwrightSettings: PlaywrightDiscoverySettings | null
  unreadCounts: Record<string, number>
  /** Monotonically increasing counter bumped on each prompt_changed WS event */
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
    profiles: [],
    statuses: {},
    lastError: null,
    lastSuccess: null,
    slackStatus: null,
    telegramStatus: null,
    playwrightSnapshot: null,
    playwrightSettings: null,
    unreadCounts: {},
    promptChangeKey: 0,
  }
}
