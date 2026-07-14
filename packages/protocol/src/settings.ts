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

/** Per-field origin for effective Remote Projects policy values. */
export type RemoteBuildSettingsFieldSource = 'environment' | 'settings'

export type RemoteBuildSettingsControlledField = 'enabled' | 'terminalsEnabled' | 'instanceName'

export interface RemoteBuildSettingsSources {
  enabled: RemoteBuildSettingsFieldSource
  terminalsEnabled: RemoteBuildSettingsFieldSource
  instanceName: RemoteBuildSettingsFieldSource
}

/**
 * Admin GET/PUT payload. `settings` is the effective runtime policy
 * (environment overrides win per field). `persistedSettings` is the v1 JSON
 * file contents; `updatedAt` remains the last persisted write.
 */
export interface RemoteBuildSettingsResponse {
  settings: RemoteBuildSettings
  persistedSettings: RemoteBuildSettings
  sources: RemoteBuildSettingsSources
}

export interface RemoteBuildSettingsMutationResponse extends RemoteBuildSettingsResponse {
  ok: true
}

/** Stable HTTP 409 body when a PUT touches an env-controlled field. */
export interface RemoteBuildSettingsEnvOverrideErrorBody {
  error: string
  code: 'REMOTE_BUILD_SETTINGS_ENV_OVERRIDE'
  controlledFields: RemoteBuildSettingsControlledField[]
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

export type SettingsAuthLoginEventName = 'auth_url' | 'device_code' | 'prompt' | 'select' | 'progress' | 'complete' | 'error'

export interface SettingsAuthLoginAuthUrlEvent {
  url: string
  instructions?: string
}

export interface SettingsAuthLoginPromptEvent {
  requestId?: string
  message: string
  placeholder?: string
}

export interface SettingsAuthLoginDeviceCodeEvent {
  requestId?: string
  userCode: string
  verificationUri: string
  intervalSeconds?: number
  expiresInSeconds?: number
}

export interface SettingsAuthLoginSelectOption {
  id: string
  label: string
}

export interface SettingsAuthLoginSelectEvent {
  requestId?: string
  message: string
  options: SettingsAuthLoginSelectOption[]
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
  device_code: SettingsAuthLoginDeviceCodeEvent
  prompt: SettingsAuthLoginPromptEvent
  select: SettingsAuthLoginSelectEvent
  progress: SettingsAuthLoginProgressEvent
  complete: SettingsAuthLoginCompleteEvent
  error: SettingsAuthLoginErrorEvent
}
