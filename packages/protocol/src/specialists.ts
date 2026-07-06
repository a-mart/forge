export type SpecialistSourceKind = 'builtin' | 'global' | 'profile' | 'channel' | 'workspace'
export type SpecialistTargetSpace = 'builder' | 'collaboration'
export type SpecialistAvailabilityCode = 'ok' | 'invalid_model' | 'missing_auth'
export type EffortTier = 'light' | 'fast' | 'standard' | 'deep' | 'max'

export interface TierConfig {
  tier: EffortTier
  displayName: string
  description: string
  color: string
  modelId: string
  provider: string
  reasoningLevel?: string
  fallbackModelId?: string
  fallbackProvider?: string
  fallbackReasoningLevel?: string
}

export interface ResolvedSpecialistDefinition {
  specialistId: string
  displayName: string
  color: string
  enabled: boolean
  whenToUse: string
  modelId?: string
  provider?: string
  reasoningLevel?: string
  fallbackModelId?: string
  fallbackProvider?: string
  fallbackReasoningLevel?: string
  builtin: boolean
  pinned: boolean
  webSearch?: boolean
  targetSpace: SpecialistTargetSpace[]
  promptBody: string
  sourceKind: SpecialistSourceKind
  sourcePath?: string
  available: boolean
  availabilityCode: SpecialistAvailabilityCode
  availabilityMessage?: string
  shadowsGlobal: boolean
  conflictWarning?: string
  defaultTier?: EffortTier
}
