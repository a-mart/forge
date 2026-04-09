import type {
  ChromeCdpConfig,
  ChromeCdpPreviewTab,
  ChromeCdpProfile,
  ChromeCdpStatus,
  SettingsAuthProvider,
  SettingsAuthProviderId,
  SettingsEnvVariable,
} from '@forge/protocol'

/* ------------------------------------------------------------------ */
/*  Shared types for settings components                              */
/* ------------------------------------------------------------------ */

export type {
  ChromeCdpConfig,
  ChromeCdpPreviewTab,
  ChromeCdpProfile,
  ChromeCdpStatus,
}

export type {
  SettingsAuthProvider,
  SettingsAuthProviderId,
  SettingsEnvVariable,
}

type SettingsAuthOAuthFlowStatus =
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
  description?: string
  envCount: number
  hasRichConfig: boolean
}

