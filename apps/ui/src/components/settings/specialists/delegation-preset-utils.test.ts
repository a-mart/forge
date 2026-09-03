import { describe, expect, it } from 'vitest'
import type { DelegationRoster } from '@forge/protocol'
import {
  addPolicy,
  behaviorModeForSpecialist,
  duplicatePolicy,
  isDefaultSpecialistForTask,
  removePolicy,
  selectedPolicyIdForTask,
  setDefaultSpecialistForTask,
  setSpecialistBehaviorMode,
  taskAssignmentLabel,
  tasksUsingPolicy,
} from './delegation-preset-utils'

const PRESET: DelegationRoster = {
  rosterId: 'balanced',
  revision: 1,
  name: 'Balanced',
  defaultRouteId: 'fast-builder',
  modeRoutes: {
    general: 'fast-builder',
    plan: 'balanced',
    research: 'balanced',
    'correctness-review': 'independent',
    'design-review': 'independent',
  },
  routes: [
    {
      routeId: 'fast-builder',
      label: 'Fast',
      behaviorMode: 'general',
      useWhen: 'Bounded work.',
      provider: 'openai-codex',
      modelId: 'gpt-5.6-terra',
      reasoningLevel: 'medium',
      capabilityEscalationRouteId: 'balanced',
    },
    {
      routeId: 'balanced',
      label: 'Balanced',
      behaviorMode: 'research',
      useWhen: 'Ordinary work.',
      provider: 'anthropic',
      modelId: 'claude-sonnet-5',
      reasoningLevel: 'high',
    },
    {
      routeId: 'independent',
      label: 'Independent',
      behaviorMode: 'correctness-review',
      useWhen: 'Independent judgment.',
      provider: 'anthropic',
      modelId: 'claude-opus-5',
      reasoningLevel: 'high',
    },
  ],
}

describe('roster utilities', () => {
  it('resolves task defaults and reports every task using a specialist', () => {
    expect(selectedPolicyIdForTask(PRESET, 'general')).toBe('fast-builder')
    expect(tasksUsingPolicy(PRESET, 'balanced')).toEqual(['plan', 'research'])
    expect(tasksUsingPolicy(PRESET, 'independent')).toEqual([
      'correctness-review',
      'design-review',
    ])
    expect(taskAssignmentLabel(PRESET, 'independent')).toBe('Review')
    expect(taskAssignmentLabel(PRESET, 'fast-builder')).toBe('Build & execute')
  })

  it('adds and duplicates specialists without changing task defaults', () => {
    const added = addPolicy(PRESET)
    const duplicated = duplicatePolicy(PRESET, 'independent')

    expect(added.preset.routes).toHaveLength(4)
    expect(added.preset.modeRoutes).toEqual(PRESET.modeRoutes)
    expect(added.preset.routes.at(-1)).toMatchObject({
      routeId: added.policyId,
      capabilityEscalationRouteId: undefined,
    })
    expect(duplicated.preset.routes.at(-1)).toMatchObject({
      routeId: duplicated.policyId,
      label: 'Independent copy',
      capabilityEscalationRouteId: undefined,
    })
  })

  it('uses a specialist task type and can make an alternative the task default', () => {
    const alternative = {
      ...PRESET.routes[0]!,
      routeId: 'general-deep',
      label: 'General deep',
    }
    const preset = { ...PRESET, routes: [...PRESET.routes, alternative] }

    expect(behaviorModeForSpecialist(preset, alternative.routeId)).toBe('general')
    expect(isDefaultSpecialistForTask(preset, alternative.routeId)).toBe(false)

    const updated = setDefaultSpecialistForTask(preset, alternative.routeId)
    expect(updated.defaultRouteId).toBe(alternative.routeId)
    expect(updated.modeRoutes?.general).toBe(alternative.routeId)
    expect(isDefaultSpecialistForTask(updated, alternative.routeId)).toBe(true)
  })

  it('moves a default specialist to a new task without leaving its prior task unmapped', () => {
    const updated = setSpecialistBehaviorMode(PRESET, 'balanced', 'plan')

    expect(behaviorModeForSpecialist(updated, 'balanced')).toBe('plan')
    expect(selectedPolicyIdForTask(updated, 'research')).toBe('fast-builder')
    expect(selectedPolicyIdForTask(updated, 'plan')).toBe('balanced')
  })

  it('removes a policy without leaving dangling task mappings or escalation targets', () => {
    const removedBalanced = removePolicy(PRESET, 'balanced')

    expect(removedBalanced.routes.map((policy) => policy.routeId))
      .toEqual(['fast-builder', 'independent'])
    expect(selectedPolicyIdForTask(removedBalanced, 'plan')).toBe('fast-builder')
    expect(selectedPolicyIdForTask(removedBalanced, 'research')).toBe('fast-builder')
    expect(removedBalanced.routes.find((policy) => policy.routeId === 'fast-builder'))
      .not.toHaveProperty('capabilityEscalationRouteId')
  })
})
