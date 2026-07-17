import type {
  AgentModelDescriptor,
  AgentModelOrigin,
  ConversationAttachment,
  ConversationReplyTargetInput,
  ManagerExactModelSelection,
  ManagerReasoningLevel,
  SessionModelUpdateMode,
} from '@forge/protocol'
import type { RefObject } from 'react'
import type { SettingsApiClient } from '@/components/settings/settings-api-client'
import type { SlashCommand } from '@/components/settings/slash-commands-api'
import type { ProjectAgentSuggestion } from './mention-types'

export type { ProjectAgentSuggestion } from './mention-types'

export interface MessageInputSendOptions {
  replyTo?: ConversationReplyTargetInput
}

export interface SessionModelPickerConfig {
  originId: string
  httpClientRef: RefObject<SettingsApiClient | null>
  sessionAgentId: string
  sessionLabel: string
  currentModel: AgentModelDescriptor
  modelOrigin?: AgentModelOrigin
  profileDefaultModel?: AgentModelDescriptor
  disabled?: boolean
  onUpdate: (
    sessionAgentId: string,
    mode: SessionModelUpdateMode,
    modelSelection?: ManagerExactModelSelection,
    reasoningLevel?: ManagerReasoningLevel,
  ) => void | Promise<void>
}

export interface MessageInputProps {
  onSend: (message: string, attachments?: ConversationAttachment[], options?: MessageInputSendOptions) => void | boolean | Promise<boolean>
  onSubmitted?: () => void
  isLoading: boolean
  disabled?: boolean
  placeholderOverride?: string
  agentLabel?: string
  allowWhileLoading?: boolean
  wsUrl?: string
  agentId?: string
  /** Override draft storage key. Defaults to `agentId`. Builder uses agentId; collab uses channel-based keys. */
  draftKey?: string
  slashCommands?: SlashCommand[]
  projectAgents?: ProjectAgentSuggestion[]
  /** Builder/web only: expose synthetic leading @Codex mention target in autocomplete. */
  enableCodexMention?: boolean
  /** Manager session id for Codex app/tool catalog fetches. */
  managerAgentId?: string
  replyTarget?: ConversationReplyTargetInput | null
  onClearReplyTarget?: () => void
  /** Builder manager sessions only: compact access to the existing session model override flow. */
  sessionModelPicker?: SessionModelPickerConfig
}

export interface MessageInputHandle {
  setInput: (value: string) => void
  focus: () => void
  addFiles: (files: File[]) => Promise<void>
  addTerminalContext: (context: import('@/components/terminal/TerminalViewport').TerminalSelectionContext) => void
  /** Restore the last successfully cleared submission (text + attachments). Returns true if restoration happened. */
  restoreLastSubmission: () => boolean
}

export const TEXTAREA_MAX_HEIGHT = 186
export const ACTIVE_WAVEFORM_BAR_COUNT = 16
export const OPENAI_KEY_REQUIRED_MESSAGE = 'OpenAI API key required \u2014 add it in Settings.'
