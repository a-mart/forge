import type {
  ChromeCdpConfig,
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
  | 'waiting_for_select'
  | 'complete'
  | 'error'

export interface SettingsAuthOAuthFlowState {
  status: SettingsAuthOAuthFlowStatus
  authUrl?: string
  instructions?: string
  promptMessage?: string
  promptPlaceholder?: string
  selectOptions?: Array<{ id: string; label: string }>
  pendingRequestId?: string
  progressMessage?: string
  errorMessage?: string
  codeValue: string
  isSubmittingCode: boolean
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

