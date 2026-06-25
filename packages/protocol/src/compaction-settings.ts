import type { ManagerExactModelSelection, ManagerReasoningLevel } from './agents.js'

export interface CompactionSettings {
  model: ManagerExactModelSelection
  reasoningLevel: ManagerReasoningLevel
  timeoutMs: number
  updatedAt: string | null
}

export interface CompactionSettingsAvailability {
  providerConfigured: boolean
  modelValid: boolean
  reasoningSupported: boolean
}

export interface CompactionTimeoutConstraints {
  min: number
  max: number
  default: number
}

export interface CompactionSettingsConstraints {
  timeoutMs: CompactionTimeoutConstraints
}

export interface GetCompactionSettingsResponse {
  settings: CompactionSettings
  availability: CompactionSettingsAvailability
  defaults: CompactionSettings
  constraints: CompactionSettingsConstraints
}

export interface UpdateCompactionSettingsRequest {
  model?: ManagerExactModelSelection
  reasoningLevel?: ManagerReasoningLevel
  timeoutMs?: number
}

export interface UpdateCompactionSettingsResponse {
  ok: true
  settings: CompactionSettings
  availability: CompactionSettingsAvailability
}
