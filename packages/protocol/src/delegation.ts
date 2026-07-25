import type { ManagerReasoningLevel } from './agents.js'

export const MANAGER_POSTURES = ['delegation_first', 'hands_on'] as const
export type ManagerPosture = (typeof MANAGER_POSTURES)[number]

export const MANAGER_POSTURE_ORIGINS = [
  'product_default',
  'project_default',
  'session_override',
] as const
export type ManagerPostureOrigin = (typeof MANAGER_POSTURE_ORIGINS)[number]

export const DELEGATION_ROSTER_ORIGINS = [
  'global_default',
  'project_default',
  'session_override',
] as const
export type DelegationRosterOrigin = (typeof DELEGATION_ROSTER_ORIGINS)[number]

export const DELEGATION_BEHAVIOR_MODES = [
  'general',
  'plan',
  'correctness-review',
  'design-review',
  'research',
] as const
export type DelegationBehaviorMode = (typeof DELEGATION_BEHAVIOR_MODES)[number]

export interface DelegationAvailabilityFallback {
  provider: string
  modelId: string
  reasoningLevel: ManagerReasoningLevel
}

export interface DelegationRoute {
  routeId: string
  label: string
  useWhen: string
  avoidWhen?: string
  color?: string
  provider: string
  modelId: string
  reasoningLevel: ManagerReasoningLevel
  availabilityFallback?: DelegationAvailabilityFallback
  capabilityEscalationRouteId?: string
}

export interface DelegationRoster {
  rosterId: string
  revision: number
  name: string
  description?: string
  defaultRouteId: string
  modeRoutes?: Partial<Record<DelegationBehaviorMode, string>>
  routes: DelegationRoute[]
}

export interface DelegationRosterSettings {
  version: 1
  defaultRosterId: string
  rosters: DelegationRoster[]
}
