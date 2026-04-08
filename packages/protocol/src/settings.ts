export const SHARED_INTEGRATION_MANAGER_ID = '__shared__'

export type SettingsAuthProviderId = 'anthropic' | 'openai-codex' | 'xai' | 'openrouter'

export type SettingsAuthProviderAuthType = 'api_key' | 'oauth' | 'unknown'

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

export interface SettingsAuthProvider {
  provider: SettingsAuthProviderId
  configured: boolean
  authType?: SettingsAuthProviderAuthType
  maskedValue?: string
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
}

export interface SettingsAuthLoginEventPayload {
  auth_url: SettingsAuthLoginAuthUrlEvent
  prompt: SettingsAuthLoginPromptEvent
  progress: SettingsAuthLoginProgressEvent
  complete: SettingsAuthLoginCompleteEvent
  error: SettingsAuthLoginErrorEvent
}
