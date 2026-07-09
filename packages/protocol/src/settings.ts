export const SHARED_INTEGRATION_MANAGER_ID = '__shared__'

export type SettingsAuthProviderId = 'anthropic' | 'openai-codex' | 'xai' | 'openrouter' | 'cursor-sdk'

export type SettingsAuthProviderAuthType = 'api_key' | 'oauth' | 'unknown'
export type SettingsAuthProviderSource = 'auth_file' | 'env' | 'secrets' | 'pool' | 'central_broker'

export interface SettingsEnvVariable {
  name: string
  description?: string
  required: boolean
  helpUrl?: string
  skillName: string
  isSet: boolean
  maskedValue?: string
}

export interface SettingsEnvResponse {
  variables: SettingsEnvVariable[]
}

export interface SettingsEnvMutationResponse extends SettingsEnvResponse {
  ok: true
}

export interface NotificationSettings {
  muteCliOriginatedNotifications: boolean
  updatedAt: string | null
}

export interface UpdateNotificationSettingsRequest {
  muteCliOriginatedNotifications?: boolean
}

export interface NotificationSettingsResponse {
  settings: NotificationSettings
}

export interface NotificationSettingsMutationResponse extends NotificationSettingsResponse {
  ok: true
}

/**
 * Remote-projects (Wave R) instance settings. `enabled` is the product kill
 * switch: nothing member-facing activates while it is false. Admin-only writes.
 */
export interface RemoteBuildSettings {
  enabled: boolean
  terminalsEnabled: boolean
  /** Admin-set display name; null falls back to the host name at read time. */
  instanceName: string | null
  updatedAt: string | null
}

export interface UpdateRemoteBuildSettingsRequest {
  enabled?: boolean
  terminalsEnabled?: boolean
  instanceName?: string | null
}

export interface RemoteBuildSettingsResponse {
  settings: RemoteBuildSettings
}

export interface RemoteBuildSettingsMutationResponse extends RemoteBuildSettingsResponse {
  ok: true
}

export interface SettingsAuthProvider {
  provider: SettingsAuthProviderId
  configured: boolean
  authType?: SettingsAuthProviderAuthType
  maskedValue?: string
  source?: SettingsAuthProviderSource
  readOnly?: boolean
  statusDetail?: string
}

export interface SettingsAuthResponse {
  providers: SettingsAuthProvider[]
}

export interface SettingsAuthMutationResponse extends SettingsAuthResponse {
  ok: true
}

export type SettingsAuthLoginProviderId = Extract<SettingsAuthProviderId, 'anthropic' | 'openai-codex'>

export type SettingsAuthLoginEventName = 'auth_url' | 'prompt' | 'progress' | 'complete' | 'error'

export interface SettingsAuthLoginAuthUrlEvent {
  url: string
  instructions?: string
}

export interface SettingsAuthLoginPromptEvent {
  message: string
  placeholder?: string
}

export interface SettingsAuthLoginProgressEvent {
  message: string
}

export interface SettingsAuthLoginCompleteEvent {
  provider: SettingsAuthLoginProviderId
  status: 'connected'
}

export interface SettingsAuthLoginErrorEvent {
  message: string
  code?: string
}

export interface SettingsAuthLoginEventPayload {
  auth_url: SettingsAuthLoginAuthUrlEvent
  prompt: SettingsAuthLoginPromptEvent
  progress: SettingsAuthLoginProgressEvent
  complete: SettingsAuthLoginCompleteEvent
  error: SettingsAuthLoginErrorEvent
}
