import { describe, expect, it } from 'vitest'
import { MANAGER_SELECTION_CATALOG_VERSION } from '@forge/protocol'
import {
  buildCatalogCurrentModelFallbackRow,
  decodeManagerSelectionCatalog,
  projectManagerModelRows,
  projectSelectableManagerModelRows,
  projectWorkModeOptions,
  resolveCreateManagerDefault,
  workModeLabel,
} from './manager-selection-catalog'
import {
  FUTURE_MODEL,
  FUTURE_WORK_MODE,
  makeManagerSelectionCatalog,
} from './manager-selection-catalog.fixture'

describe('manager selection catalog decoder and projections', () => {
  it('accepts server-defined future models, Fable 5.1, and future Work Modes', () => {
    const input = makeManagerSelectionCatalog({
      models: [
        ...makeManagerSelectionCatalog().models,
        FUTURE_MODEL,
      ],
      workModes: [
        ...makeManagerSelectionCatalog().workModes,
        FUTURE_WORK_MODE,
      ],
    })

    const catalog = decodeManagerSelectionCatalog(structuredClone(input))
    const rows = projectSelectableManagerModelRows(catalog, 'change')

    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'anthropic', modelId: 'claude-fable-5-1', displayName: 'Claude Fable 5.1' }),
      expect.objectContaining({ provider: 'future-labs', modelId: 'oracle-9', displayName: 'Oracle 9' }),
    ]))
    expect(projectWorkModeOptions(catalog, 'review_led')).toContainEqual(FUTURE_WORK_MODE)
  })

  it('projects only the server snapshot and preserves disabled provider state', () => {
    const disabledFuture = {
      ...FUTURE_MODEL,
      surfaces: {
        create: { selectable: false as const, unavailableReason: 'provider_not_configured' as const },
        change: { selectable: false as const, unavailableReason: 'provider_not_configured' as const },
      },
    }
    const catalog = makeManagerSelectionCatalog({
      models: [disabledFuture],
      defaults: { workModeId: 'delegation_first' },
    })

    expect(projectManagerModelRows(catalog, 'change')).toEqual([
      expect.objectContaining({
        provider: 'future-labs',
        modelId: 'oracle-9',
        unavailableReason: 'Provider not configured',
      }),
    ])
    expect(projectSelectableManagerModelRows(catalog, 'change')).toEqual([])
  })

  it('uses the advertised create default and leaves the model unset when the server omits one', () => {
    const catalog = makeManagerSelectionCatalog({
      models: [FUTURE_MODEL, ...makeManagerSelectionCatalog().models],
      defaults: {
        createManagerModel: {
          provider: 'future-labs',
          modelId: 'oracle-9',
          reasoningId: 'low',
        },
        workModeId: 'delegation_first',
      },
    })
    const rows = projectSelectableManagerModelRows(catalog, 'create')

    expect(resolveCreateManagerDefault(catalog, rows)).toEqual({
      provider: 'future-labs',
      modelId: 'oracle-9',
      reasoningLevel: 'low',
    })
    expect(resolveCreateManagerDefault({
      ...catalog,
      defaults: { workModeId: 'delegation_first' },
    }, rows)).toBeUndefined()
  })

  it('keeps unknown current model and Work Mode IDs honest and read-only', () => {
    const catalog = makeManagerSelectionCatalog()

    expect(buildCatalogCurrentModelFallbackRow(
      catalog,
      'future-provider',
      'future-model',
      'high',
    )).toMatchObject({
      provider: 'future-provider',
      modelId: 'future-model',
      displayName: 'future-model',
      unavailableReason: 'Not available for selection',
    })
    expect(projectWorkModeOptions(catalog, 'review_led')).toContainEqual({
      id: 'review_led',
      label: 'Review Led',
      description: '',
      selectable: false,
      unavailableReason: 'unsupported',
    })
    expect(workModeLabel(catalog, 'review_led')).toBe('Review Led')
  })

  it('rejects unsupported versions and malformed entries instead of using a partial snapshot', () => {
    expect(() => decodeManagerSelectionCatalog({
      ...makeManagerSelectionCatalog(),
      version: MANAGER_SELECTION_CATALOG_VERSION + 1,
    })).toThrow('Unsupported manager selection catalog version')

    const malformed = makeManagerSelectionCatalog()
    malformed.models[0] = {
      ...malformed.models[0]!,
      label: '',
    }
    expect(() => decodeManagerSelectionCatalog(malformed)).toThrow('Invalid manager selection catalog')

    const invalidDefault = makeManagerSelectionCatalog({
      defaults: {
        createManagerModel: {
          provider: 'future-labs',
          modelId: 'not-advertised',
          reasoningId: 'high',
        },
        workModeId: 'delegation_first',
      },
    })
    expect(() => decodeManagerSelectionCatalog(invalidDefault)).toThrow('Invalid manager selection catalog')
  })

  it('rejects contradictory selectable/unavailableReason combinations', () => {
    const catalog = makeManagerSelectionCatalog()
    const model = catalog.models[0]!
    const selectableWithReason: unknown = {
      ...catalog,
      models: [{
        ...model,
        surfaces: {
          create: { selectable: true, unavailableReason: 'disabled' },
          change: { selectable: true },
        },
      }],
    }
    expect(() => decodeManagerSelectionCatalog(selectableWithReason)).toThrow('Invalid manager selection catalog')

    const unselectableWithoutReason: unknown = {
      ...catalog,
      models: [{
        ...model,
        surfaces: {
          create: { selectable: false },
          change: { selectable: true },
        },
      }],
    }
    expect(() => decodeManagerSelectionCatalog(unselectableWithoutReason)).toThrow('Invalid manager selection catalog')

    const workModeWithReason: unknown = {
      ...catalog,
      workModes: [{
        id: 'delegation_first',
        label: 'Delegate first',
        description: 'Delegates substantial implementation.',
        selectable: true,
        unavailableReason: 'deprecated',
      }],
    }
    expect(() => decodeManagerSelectionCatalog(workModeWithReason)).toThrow('Invalid manager selection catalog')

    const workModeWithoutReason: unknown = {
      ...catalog,
      workModes: [{
        id: 'delegation_first',
        label: 'Delegate first',
        description: 'Delegates substantial implementation.',
        selectable: false,
      }],
      defaults: {
        createManagerModel: catalog.defaults.createManagerModel,
        workModeId: 'adaptive',
      },
    }
    expect(() => decodeManagerSelectionCatalog(workModeWithoutReason)).toThrow('Invalid manager selection catalog')
  })
})
