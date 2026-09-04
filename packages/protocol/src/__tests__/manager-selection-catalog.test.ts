import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  DEFAULT_MANAGER_POSTURE,
  MANAGER_POSTURES,
  MANAGER_SELECTION_CATALOG_LIMITS,
  MANAGER_SELECTION_CATALOG_VERSION,
  WORK_MODE_DEFINITIONS,
  isManagerPosture,
  isWorkModeId,
  type AgentDescriptor,
  type ClientCommand,
  type ManagerProfile,
  type ManagerSelectionCatalogResponse,
  type ProjectDelegationDefaultsUpdatedEvent,
  type SessionDelegationUpdatedEvent,
  type WorkModeId,
} from '../index.js'

describe('manager selection catalog contract', () => {
  it('derives the closed backend posture set and product default from one Work Mode table', () => {
    expect(MANAGER_POSTURES).toEqual(WORK_MODE_DEFINITIONS.map((definition) => definition.id))
    expect(MANAGER_POSTURES).toEqual(['delegation_first', 'adaptive', 'hands_on'])
    expect(WORK_MODE_DEFINITIONS.filter((definition) => definition.productDefault)).toHaveLength(1)
    expect(DEFAULT_MANAGER_POSTURE).toBe('delegation_first')
    expect(WORK_MODE_DEFINITIONS.find((definition) => definition.id === 'adaptive')).toMatchObject({
      label: 'Adaptive',
      selectable: true,
    })
  })

  it('keeps transport Work Mode IDs extensible while server-known ManagerPosture stays closed', () => {
    const futureId = 'review_led' satisfies WorkModeId
    expect(isWorkModeId(futureId)).toBe(true)
    expect(isManagerPosture(futureId)).toBe(false)
    expect(isManagerPosture('adaptive')).toBe(true)
    expect(isWorkModeId('UPPERCASE')).toBe(false)
    expect(isWorkModeId(`a${'x'.repeat(64)}`)).toBe(false)
    expectTypeOf(futureId).toExtend<WorkModeId>()
    expectTypeOf<AgentDescriptor['managerPosture']>().toEqualTypeOf<WorkModeId | undefined>()
    expectTypeOf<ManagerProfile['defaultManagerPosture']>().toEqualTypeOf<WorkModeId | undefined>()
    expectTypeOf<ProjectDelegationDefaultsUpdatedEvent['managerPosture']>().toEqualTypeOf<WorkModeId | undefined>()
    expectTypeOf<SessionDelegationUpdatedEvent['managerPosture']>().toEqualTypeOf<WorkModeId>()
    expectTypeOf<Extract<ClientCommand, { type: 'update_project_delegation_defaults' }>['managerPosture']>()
      .toEqualTypeOf<WorkModeId | null | undefined>()
    expectTypeOf<Extract<ClientCommand, { type: 'update_session_delegation' }>['managerPosture']>()
      .toEqualTypeOf<{ mode: 'inherit' } | { mode: 'override'; value: WorkModeId } | undefined>()
  })

  it('defines a bounded V1 exact-model projection with opaque Work Mode IDs', () => {
    const fixture = {
      version: MANAGER_SELECTION_CATALOG_VERSION,
      revision: 'msc-v1-example',
      models: [{
        provider: 'anthropic',
        providerLabel: 'Anthropic',
        modelId: 'claude-fable-5-1',
        label: 'Claude Fable 5.1',
        familyId: 'pi-fable',
        familyLabel: 'Claude Fable 5.1',
        reasoningOptions: [
          { id: 'low', label: 'Low' },
          { id: 'high', label: 'High' },
        ],
        defaultReasoningId: 'high',
        surfaces: {
          create: { selectable: false, unavailableReason: 'provider_not_configured' },
          change: { selectable: true },
        },
      }],
      workModes: [{
        id: 'review_led',
        label: 'Review led',
        description: 'A future server-defined mode.',
        selectable: true,
      }],
      defaults: {
        createManagerModel: {
          provider: 'anthropic',
          modelId: 'claude-fable-5-1',
          reasoningId: 'high',
        },
        workModeId: 'review_led',
      },
    } satisfies ManagerSelectionCatalogResponse

    expect(fixture.version).toBe(1)
    expect(MANAGER_SELECTION_CATALOG_LIMITS).toMatchObject({
      maxModels: 128,
      maxWorkModes: 16,
      maxReasoningOptionsPerModel: 8,
    })
  })
})
