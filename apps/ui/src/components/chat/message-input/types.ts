import type { ConversationAttachment } from '@forge/protocol'
import type { SlashCommand } from '@/components/settings/slash-commands-api'

export interface ProjectAgentSuggestion {
  agentId: string
  handle: string
  displayName: string
  whenToUse: string
}

export interface MessageInputProps {
  onSend: (message: string, attachments?: ConversationAttachment[]) => void | boolean | Promise<boolean>
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
