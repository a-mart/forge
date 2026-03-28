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

export type SettingsAuthProviderId = 'anthropic' | 'openai-codex' | 'xai'

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

/* ------------------------------------------------------------------ */
/*  Skill metadata                                                    */
/* ------------------------------------------------------------------ */

export interface SkillInfo {
  name: string
  description: string
  envCount: number
  hasRichConfig: boolean
}

/* ------------------------------------------------------------------ */
/*  Chrome CDP types                                                  */
/* ------------------------------------------------------------------ */

export interface ChromeCdpConfig {
  contextId: string | null
  urlAllow: string[]
  urlBlock: string[]
}

export interface ChromeCdpStatus {
  connected: boolean
  port?: number
  browser?: string
  version?: string
  tabCount?: number
  error?: string
}

export interface ChromeCdpProfile {
  contextId: string
  tabCount: number
  sampleUrls: string[]
  isDefault: boolean
}

export interface ChromeCdpPreviewTab {
  targetId: string
  title: string
  url: string
}
