/* ------------------------------------------------------------------ */
/*  Shared types for settings components                              */
/* ------------------------------------------------------------------ */

export interface SettingsEnvVariable {
  name: string
  description?: string
  required: boolean
  helpUrl?: string
  skillName: string
  isSet: boolean
  maskedValue?: string
}

export type SettingsAuthProviderId = 'anthropic' | 'openai-codex'

export interface SettingsAuthProvider {
  provider: SettingsAuthProviderId
  configured: boolean
  authType?: 'api_key' | 'oauth' | 'unknown'
  maskedValue?: string
}

export type SettingsAuthOAuthFlowStatus =
  | 'idle'
  | 'starting'
  | 'waiting_for_auth'
  | 'waiting_for_code'
  | 'complete'
  | 'error'

export interface SettingsAuthOAuthFlowState {
  status: SettingsAuthOAuthFlowStatus
  authUrl?: string
  instructions?: string
  promptMessage?: string
  promptPlaceholder?: string
  progressMessage?: string
  errorMessage?: string
  codeValue: string
  isSubmittingCode: boolean
}

export interface SlackSettingsConfig {
  profileId: string
  enabled: boolean
  mode: 'socket'
  appToken: string | null
  botToken: string | null
  hasAppToken: boolean
  hasBotToken: boolean
  listen: {
    dm: boolean
    channelIds: string[]
    includePrivateChannels: boolean
  }
  response: {
    respondInThread: boolean
    replyBroadcast: boolean
    wakeWords: string[]
  }
  attachments: {
    maxFileBytes: number
    allowImages: boolean
    allowText: boolean
    allowBinary: boolean
  }
}

export interface SlackChannelDescriptor {
  id: string
  name: string
  isPrivate: boolean
  isMember: boolean
}

export interface SlackDraft {
  enabled: boolean
  appToken: string
  botToken: string
  listenDm: boolean
  channelIds: string[]
  includePrivateChannels: boolean
  respondInThread: boolean
  replyBroadcast: boolean
  maxFileBytes: string
  allowImages: boolean
  allowText: boolean
  allowBinary: boolean
}

export interface TelegramSettingsConfig {
  profileId: string
  enabled: boolean
  mode: 'polling'
  botToken: string | null
  hasBotToken: boolean
  allowedUserIds: string[]
  polling: {
    timeoutSeconds: number
    limit: number
    dropPendingUpdatesOnStart: boolean
  }
  delivery: {
    parseMode: 'HTML'
    disableLinkPreview: boolean
    replyToInboundMessageByDefault: boolean
  }
  attachments: {
    maxFileBytes: number
    allowImages: boolean
    allowText: boolean
    allowBinary: boolean
  }
}

export interface TelegramDraft {
  enabled: boolean
  botToken: string
  allowedUserIds: string[]
  timeoutSeconds: string
  limit: string
  dropPendingUpdatesOnStart: boolean
  disableLinkPreview: boolean
  replyToInboundMessageByDefault: boolean
  maxFileBytes: string
  allowImages: boolean
  allowText: boolean
  allowBinary: boolean
}
