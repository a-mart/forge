import type { ConversationAttachment } from '@forge/protocol'
import type { SlashCommand } from '@/components/settings/slash-commands-api'

export interface ProjectAgentSuggestion {
  agentId: string
  handle: string
  displayName: string
  whenToUse: string
}

export interface MessageInputProps {
  onSend: (message: string, attachments?: ConversationAttachment[]) => void
  onSubmitted?: () => void
  isLoading: boolean
  disabled?: boolean
  placeholderOverride?: string
  agentLabel?: string
  allowWhileLoading?: boolean
  wsUrl?: string
  agentId?: string
  slashCommands?: SlashCommand[]
  projectAgents?: ProjectAgentSuggestion[]
}

export interface MessageInputHandle {
  setInput: (value: string) => void
  focus: () => void
  addFiles: (files: File[]) => Promise<void>
  addTerminalContext: (context: import('@/components/terminal/TerminalViewport').TerminalSelectionContext) => void
}

export const TEXTAREA_MAX_HEIGHT = 186
export const ACTIVE_WAVEFORM_BAR_COUNT = 16
export const OPENAI_KEY_REQUIRED_MESSAGE = 'OpenAI API key required \u2014 add it in Settings.'
