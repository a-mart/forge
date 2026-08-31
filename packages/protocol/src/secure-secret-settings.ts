import {
  SECURE_SECRET_ABSOLUTE_MAX_PROJECT_DEFAULTS,
  SECURE_SECRET_MAX_PROJECT_DEFAULTS,
  SECURE_SECRET_MIN_PROJECT_DEFAULTS,
} from './secure-sessions.js'

export interface SecureSecretSettings {
  maxProjectDefaults: number
  updatedAt: string | null
}

export interface SecureSecretSettingsConstraints {
  maxProjectDefaults: {
    min: number
    max: number
    default: number
  }
}

export interface GetSecureSecretSettingsResponse {
  settings: SecureSecretSettings
  defaults: SecureSecretSettings
  constraints: SecureSecretSettingsConstraints
}

export interface UpdateSecureSecretSettingsRequest {
  maxProjectDefaults?: number
}

export interface UpdateSecureSecretSettingsResponse {
  ok: true
  settings: SecureSecretSettings
}

export function getSecureSecretSettingsConstraints(): SecureSecretSettingsConstraints {
  return {
    maxProjectDefaults: {
      min: SECURE_SECRET_MIN_PROJECT_DEFAULTS,
      max: SECURE_SECRET_ABSOLUTE_MAX_PROJECT_DEFAULTS,
      default: SECURE_SECRET_MAX_PROJECT_DEFAULTS,
    },
  }
}
