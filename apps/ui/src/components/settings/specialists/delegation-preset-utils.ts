import {
  DELEGATION_BEHAVIOR_MODES,
  type DelegationBehaviorMode,
  type DelegationRoster,
  type DelegationRosterSettings,
  type DelegationRoute,
} from '@forge/protocol'

export const TASK_TYPE_LABELS: Record<DelegationBehaviorMode, string> = {
  general: 'Build & execute',
  plan: 'Planning',
  'correctness-review': 'Correctness review',
  'design-review': 'Design review',
  research: 'Research',
}

export const TASK_TYPE_DESCRIPTIONS: Record<DelegationBehaviorMode, string> = {
  general: 'Implementation, debugging, focused fixes, and other outcome-oriented work.',
  plan: 'Task breakdown, implementation planning, sequencing, and risk analysis.',
  'correctness-review': 'Bug hunting, regression analysis, edge cases, and contract validation.',
  'design-review': 'Maintainability, API design, architecture, and consistency review.',
  research: 'Fact-checking, documentation lookup, source gathering, and technical investigation.',
}

export function cloneDelegationSettings(
  settings: DelegationRosterSettings,
): DelegationRosterSettings {
  return {
    version: 1,
    defaultRosterId: settings.defaultRosterId,
    rosters: settings.rosters.map(clonePreset),
  }
}

export function clonePreset(preset: DelegationRoster): DelegationRoster {
  return {
    ...preset,
    modeRoutes: preset.modeRoutes ? { ...preset.modeRoutes } : undefined,
    routes: preset.routes.map(clonePolicy),
  }
}

export function clonePolicy(policy: DelegationRoute): DelegationRoute {
  return {
    ...policy,
    availabilityFallback: policy.availabilityFallback
      ? { ...policy.availabilityFallback }
      : undefined,
  }
}

export function selectedPolicyIdForTask(
  preset: DelegationRoster,
  taskType: DelegationBehaviorMode,
): string {
  return preset.modeRoutes?.[taskType] ?? preset.defaultRouteId
}

export function tasksUsingPolicy(
  preset: DelegationRoster,
  policyId: string,
): DelegationBehaviorMode[] {
  return DELEGATION_BEHAVIOR_MODES.filter(
    (taskType) => selectedPolicyIdForTask(preset, taskType) === policyId,
  )
}

export function taskAssignmentLabel(
  preset: DelegationRoster,
  specialistId: string,
): string {
  const assigned = tasksUsingPolicy(preset, specialistId)
  if (
    assigned.length === 2
    && assigned.includes('correctness-review')
    && assigned.includes('design-review')
  ) {
    return 'Review'
  }
  const behaviorMode = behaviorModeForSpecialist(preset, specialistId)
  return TASK_TYPE_LABELS[behaviorMode]
}

export function behaviorModeForSpecialist(
  preset: DelegationRoster,
  specialistId: string,
): DelegationBehaviorMode {
  const specialist = preset.routes.find((candidate) => candidate.routeId === specialistId)
  if (specialist?.behaviorMode) return specialist.behaviorMode
  return tasksUsingPolicy(preset, specialistId)[0] ?? 'general'
}

export function isDefaultSpecialistForTask(
  preset: DelegationRoster,
  specialistId: string,
): boolean {
  const behaviorMode = behaviorModeForSpecialist(preset, specialistId)
  return selectedPolicyIdForTask(preset, behaviorMode) === specialistId
}

export function setDefaultSpecialistForTask(
  preset: DelegationRoster,
  specialistId: string,
): DelegationRoster {
  const behaviorMode = behaviorModeForSpecialist(preset, specialistId)
  return {
    ...preset,
    ...(behaviorMode === 'general' ? { defaultRouteId: specialistId } : {}),
    modeRoutes: {
      ...preset.modeRoutes,
      [behaviorMode]: specialistId,
    },
  }
}

export function setSpecialistBehaviorMode(
  preset: DelegationRoster,
  specialistId: string,
  behaviorMode: DelegationBehaviorMode,
): DelegationRoster {
  const previousMode = behaviorModeForSpecialist(preset, specialistId)
  const routes = preset.routes.map((specialist) => (
    specialist.routeId === specialistId
      ? { ...specialist, behaviorMode }
      : specialist
  ))
  const modeRoutes = { ...preset.modeRoutes }

  if (selectedPolicyIdForTask(preset, previousMode) === specialistId) {
    const replacement = routes.find(
      (specialist) =>
        specialist.routeId !== specialistId
        && behaviorModeForSpecialist({ ...preset, routes }, specialist.routeId) === previousMode,
    )
    if (previousMode === 'general') {
      const replacementId = replacement?.routeId
        ?? routes.find((specialist) => specialist.routeId !== specialistId)?.routeId
        ?? specialistId
      modeRoutes.general = replacementId
    } else if (replacement) {
      modeRoutes[previousMode] = replacement.routeId
    } else {
      modeRoutes[previousMode] = preset.defaultRouteId
    }
  }

  return {
    ...preset,
    routes,
    modeRoutes,
  }
}

export function addPolicy(preset: DelegationRoster): {
  preset: DelegationRoster
  policyId: string
} {
  const policyId = nextId(
    'roster-specialist',
    new Set(preset.routes.map((policy) => policy.routeId)),
  )
  const source = preset.routes.find((policy) => policy.routeId === preset.defaultRouteId)
    ?? preset.routes[0]!
  return {
    policyId,
    preset: {
      ...preset,
      routes: [
        ...preset.routes,
        {
          ...clonePolicy(source),
          routeId: policyId,
          label: `New specialist ${preset.routes.length + 1}`,
          behaviorMode: source.behaviorMode ?? 'general',
          useWhen: 'Describe when this specialist materially improves the delegated outcome.',
          avoidWhen: undefined,
          capabilityEscalationRouteId: undefined,
        },
      ],
    },
  }
}

export function duplicatePolicy(
  preset: DelegationRoster,
  policyId: string,
): {
  preset: DelegationRoster
  policyId: string
} {
  const source = preset.routes.find((policy) => policy.routeId === policyId)
    ?? preset.routes[0]!
  const nextPolicyId = nextId(
    `${source.routeId}-copy`,
    new Set(preset.routes.map((policy) => policy.routeId)),
  )
  return {
    policyId: nextPolicyId,
    preset: {
      ...preset,
      routes: [
        ...preset.routes,
        {
          ...clonePolicy(source),
          routeId: nextPolicyId,
          label: `${source.label} copy`,
          capabilityEscalationRouteId: undefined,
        },
      ],
    },
  }
}

export function removePolicy(
  preset: DelegationRoster,
  policyId: string,
): DelegationRoster {
  if (preset.routes.length <= 1) return preset
  const routes = preset.routes.filter((policy) => policy.routeId !== policyId)
  const replacement = routes[0]!.routeId
  const defaultRouteId = preset.defaultRouteId === policyId
    ? replacement
    : preset.defaultRouteId
  const modeRoutes = Object.fromEntries(
    DELEGATION_BEHAVIOR_MODES.map((taskType) => {
      const configured = selectedPolicyIdForTask(preset, taskType)
      return [taskType, configured === policyId ? defaultRouteId : configured]
    }),
  ) as DelegationRoster['modeRoutes']

  return {
    ...preset,
    routes: routes.map((policy) => {
      if (policy.capabilityEscalationRouteId !== policyId) return policy
      const {
        capabilityEscalationRouteId: _removedEscalation,
        ...policyWithoutEscalation
      } = policy
      return policyWithoutEscalation
    }),
    defaultRouteId,
    modeRoutes,
  }
}

export function nextId(base: string, existing: Set<string>): string {
  const normalized = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'item'
  let candidate = normalized
  let suffix = 2
  while (existing.has(candidate)) {
    candidate = `${normalized}-${suffix}`
    suffix += 1
  }
  return candidate
}
