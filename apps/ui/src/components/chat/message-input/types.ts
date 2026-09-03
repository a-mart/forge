import type {
  AgentModelDescriptor,
  AgentModelOrigin,
  ConversationAttachment,
  ConversationReplyTargetInput,
  ManagerExactModelSelection,
  ManagerPosture,
  ManagerPostureOrigin,
  ManagerReasoningLevel,
  DelegationRosterOrigin,
  SessionModelUpdateMode,
} from '@forge/protocol'
import type { RefObject } from 'react'
import type { SettingsApiClient } from '@/components/settings/settings-api-client'
import type { SlashCommand } from '@/components/settings/slash-commands-api'
import type { SecureSessionPickerConfig } from '../secure-session/types'
import type { ProjectAgentSuggestion } from './mention-types'

export type { ProjectAgentSuggestion } from './mention-types'
export type { SecureSessionPickerConfig } from '../secure-session/types'

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
  /** Bump from `model_config_changed` so the existing model-config fetch refreshes. */
  modelConfigChangeKey?: number
  onUpdate: (
    sessionAgentId: string,
    mode: SessionModelUpdateMode,
    modelSelection?: ManagerExactModelSelection,
    reasoningLevel?: ManagerReasoningLevel,
  ) => void | Promise<void>
}

export interface SessionCoordinationPickerConfig {
  originId: string
  httpClientRef: RefObject<SettingsApiClient | null>
  sessionAgentId: string
  profileId: string
  managerPosture: ManagerPosture
  managerPostureOrigin?: ManagerPostureOrigin
  projectDefaultManagerPosture?: ManagerPosture
  delegationRosterId?: string
  delegationRosterOrigin?: DelegationRosterOrigin
  projectDefaultDelegationRosterId?: string
  disabled?: boolean
  onUpdateProjectDefaults: (
    profileId: string,
    updates: {
      managerPosture?: ManagerPosture | null
      delegationRosterId?: string | null
    },
  ) => void | Promise<void>
  onUpdateSession: (
    sessionAgentId: string,
    updates: {
      managerPosture?: { mode: 'inherit' } | { mode: 'override'; value: ManagerPosture }
      delegationRoster?: { mode: 'inherit' } | { mode: 'override'; rosterId: string }
    },
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
  /** Builder manager sessions only: work mode and roster controls. */
  sessionCoordinationPicker?: SessionCoordinationPickerConfig
  /** Builder-local Secure Session controls. Transport and secret values stay outside the composer. */
  secureSessionPicker?: SecureSessionPickerConfig
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
