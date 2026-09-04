import type { ManagerReasoningLevel } from './agents.js'

export const WORK_MODE_ID_MAX_LENGTH = 64

/**
 * Extensible, bounded identity used by discovery transports. It intentionally
 * remains wider than ManagerPosture so clients can preserve future server IDs.
 */
export type WorkModeId = string

export interface WorkModeDefinition<Id extends string = string> {
  id: Id
  label: string
  description: string
  selectable: boolean
  productDefault: boolean
}

/** Authoritative server-known Work Mode inventory and presentation metadata. */
export const WORK_MODE_DEFINITIONS = [
  {
    id: 'delegation_first',
    label: 'Delegate first',
    description: 'Delegates substantial implementation, mutation, investigation, and multi-step analysis while retaining small read-only orientation and acceptance checks.',
    selectable: true,
    productDefault: true,
  },
  {
    id: 'adaptive',
    label: 'Adaptive',
    description: 'Chooses ownership outcome by outcome, balancing continuity and rapid iteration against independence, parallelism, specialization, and efficiency.',
    selectable: true,
    productDefault: false,
  },
  {
    id: 'hands_on',
    label: 'Hands-on',
    description: 'Owns one cohesive bounded outcome directly and delegates when parallelism, isolation, specialization, diversity, or independent review adds material value.',
    selectable: true,
    productDefault: false,
  },
] as const satisfies readonly WorkModeDefinition[]

export type ManagerPosture = (typeof WORK_MODE_DEFINITIONS)[number]['id']

function workModeDefinitionIds<
  const Definitions extends readonly WorkModeDefinition[],
>(definitions: Definitions): {
  [Index in keyof Definitions]: Definitions[Index] extends WorkModeDefinition<infer Id> ? Id : never
} {
  return definitions.map((definition) => definition.id) as {
    [Index in keyof Definitions]: Definitions[Index] extends WorkModeDefinition<infer Id> ? Id : never
  }
}

/** Closed backend ingress/persistence values, derived from WORK_MODE_DEFINITIONS. */
export const MANAGER_POSTURES = workModeDefinitionIds(WORK_MODE_DEFINITIONS)

function resolveDefaultManagerPosture(): ManagerPosture {
  const defaults = WORK_MODE_DEFINITIONS.filter((definition) => definition.productDefault)
  if (defaults.length !== 1 || !defaults[0]) {
    throw new Error('WORK_MODE_DEFINITIONS must contain exactly one product default')
  }
  return defaults[0].id
}

export const DEFAULT_MANAGER_POSTURE: ManagerPosture = resolveDefaultManagerPosture()

export function isWorkModeId(value: unknown): value is WorkModeId {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= WORK_MODE_ID_MAX_LENGTH
    && /^[a-z][a-z0-9_-]*$/.test(value)
}

export function isManagerPosture(value: unknown): value is ManagerPosture {
  return isWorkModeId(value) && MANAGER_POSTURES.includes(value as ManagerPosture)
}

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
  /** Task-instruction contract this roster specialist normally uses. */
  behaviorMode?: DelegationBehaviorMode
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
