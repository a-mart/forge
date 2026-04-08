export type SpecialistSourceKind = 'builtin' | 'global' | 'profile'
export type SpecialistAvailabilityCode = 'ok' | 'invalid_model' | 'missing_auth'

export interface ResolvedSpecialistDefinition {
  specialistId: string
  displayName: string
  color: string
  enabled: boolean
  whenToUse: string
  modelId: string
  provider: string
  reasoningLevel?: string
  fallbackModelId?: string
  fallbackProvider?: string
  fallbackReasoningLevel?: string
  builtin: boolean
  pinned: boolean
  webSearch?: boolean
  promptBody: string
  sourceKind: SpecialistSourceKind
  sourcePath?: string
  available: boolean
  availabilityCode: SpecialistAvailabilityCode
  availabilityMessage?: string
  shadowsGlobal: boolean
}
