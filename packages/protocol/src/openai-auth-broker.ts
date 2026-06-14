export type OpenAICodexAuthMode = "local" | "central_broker"

export type OpenAIBrokerDegradedReason =
  | "unreachable"
  | "invalid_bearer"
  | "no_accounts"
  | "all_cooldown"
  | "auth_errors"
  | "usage_unavailable"
  | "token_shape_unverified"

export interface OpenAIBrokerAccountCounts {
  healthy: number
  cooldown: number
  auth_error: number
  disabled: number
  draining: number
  unknown: number
}

export interface OpenAIBrokerSettingsStatus {
  ok: boolean
  degraded?: OpenAIBrokerDegradedReason
  accounts?: OpenAIBrokerAccountCounts
  earliestResetAtMs?: number
  message?: string
  checkedAt: string
}

export interface OpenAIBrokerSettingsState {
  mode: OpenAICodexAuthMode
  effectiveMode: OpenAICodexAuthMode
  source: "settings" | "env" | "default"
  envOverride: boolean
  broker: {
    configured: boolean
    url?: string
    hasToken: boolean
    tokenMasked?: string
    clientId: string
    instanceId?: string
    instanceLabel?: string
    userLabel?: string
    timeoutMs: number
    status?: OpenAIBrokerSettingsStatus
  }
}

export interface UpdateOpenAIBrokerSettingsRequest {
  mode: OpenAICodexAuthMode
  broker?: {
    url?: string
    token?: string
    clearToken?: boolean
    clientId?: string
    instanceLabel?: string
    userLabel?: string
    timeoutMs?: number
  }
  testBeforeEnable?: boolean
}

export interface OpenAIBrokerSettingsResponse {
  settings: OpenAIBrokerSettingsState
}

export interface OpenAIBrokerTestResponse {
  ok: boolean
  status?: OpenAIBrokerSettingsStatus
  error?: string
}
