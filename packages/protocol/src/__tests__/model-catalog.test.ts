import { describe, expect, it } from 'vitest'
import {
  FORGE_MODEL_CATALOG,
  getCatalogContextWindow,
  getCatalogFamily,
  getCatalogFamilyForModel,
  getCatalogModel,
  getCatalogModelsByFamily,
  getCatalogProvider,
  getChangeManagerFamilies,
  getCreateManagerFamilies,
  getSpawnPresetFamilies,
  getSpecialistFamilies,
  inferCatalogFamily,
  inferCatalogProvider,
  isCatalogModelId,
} from '../model-catalog.js'

const VALID_REASONING_LEVELS = new Set(['none', 'low', 'medium', 'high', 'xhigh'])

const EXPECTED_FAMILIES = {
  'pi-codex': {
    provider: 'openai-codex',
    defaultModelId: 'gpt-5.3-codex',
    visibleInCreateManager: true,
    visibleInChangeManager: true,
    visibleInSpawnPreset: true,
    visibleInSpecialists: true,
  },
  'pi-5.4': {
    provider: 'openai-codex',
    defaultModelId: 'gpt-5.4',
    visibleInCreateManager: true,
    visibleInChangeManager: true,
    visibleInSpawnPreset: true,
    visibleInSpecialists: true,
  },
  'pi-opus': {
    provider: 'anthropic',
    defaultModelId: 'claude-opus-4-6',
    visibleInCreateManager: true,
    visibleInChangeManager: true,
    visibleInSpawnPreset: true,
    visibleInSpecialists: true,
  },
  'pi-grok': {
    provider: 'xai',
    defaultModelId: 'grok-4',
    visibleInCreateManager: false,
    visibleInChangeManager: false,
    visibleInSpawnPreset: true,
    visibleInSpecialists: true,
  },
  'codex-app': {
    provider: 'openai-codex-app-server',
    defaultModelId: 'default',
    visibleInCreateManager: false,
    visibleInChangeManager: false,
    visibleInSpawnPreset: true,
    visibleInSpecialists: false,
  },
} as const

const EXPECTED_MODELS = {
  'gpt-5.3-codex': {
    provider: 'openai-codex',
    familyId: 'pi-codex',
    contextWindow: 272_000,
    maxOutputTokens: 128_000,
    supportsReasoning: true,
    inputModes: ['text', 'image'],
  },
  'gpt-5.3-codex-spark': {
    provider: 'openai-codex',
    familyId: 'pi-codex',
    contextWindow: 128_000,
    maxOutputTokens: 128_000,
    supportsReasoning: true,
    inputModes: ['text'],
  },
  'gpt-5.4': {
    provider: 'openai-codex',
    familyId: 'pi-5.4',
    contextWindow: 272_000,
    maxOutputTokens: 128_000,
    supportsReasoning: true,
    inputModes: ['text', 'image'],
  },
  'gpt-5.4-mini': {
    provider: 'openai-codex',
    familyId: 'pi-5.4',
    contextWindow: 272_000,
    maxOutputTokens: 128_000,
    supportsReasoning: true,
    inputModes: ['text', 'image'],
  },
  'claude-opus-4-6': {
    provider: 'anthropic',
    familyId: 'pi-opus',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsReasoning: true,
    inputModes: ['text', 'image'],
  },
  'claude-sonnet-4-5-20250929': {
    provider: 'anthropic',
    familyId: 'pi-opus',
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    supportsReasoning: true,
    inputModes: ['text', 'image'],
  },
  'claude-haiku-4-5-20251001': {
    provider: 'anthropic',
    familyId: 'pi-opus',
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    supportsReasoning: true,
    inputModes: ['text', 'image'],
  },
  'grok-4': {
    provider: 'xai',
    familyId: 'pi-grok',
    contextWindow: 256_000,
    maxOutputTokens: 64_000,
    supportsReasoning: true,
    inputModes: ['text'],
  },
  'grok-4-fast': {
    provider: 'xai',
    familyId: 'pi-grok',
    contextWindow: 2_000_000,
    maxOutputTokens: 30_000,
    supportsReasoning: true,
    inputModes: ['text'],
  },
  'grok-4.20-0309-reasoning': {
    provider: 'xai',
    familyId: 'pi-grok',
    contextWindow: 2_000_000,
    maxOutputTokens: 30_000,
    supportsReasoning: true,
    inputModes: ['text'],
  },
  'grok-4.20-0309-non-reasoning': {
    provider: 'xai',
    familyId: 'pi-grok',
    contextWindow: 2_000_000,
    maxOutputTokens: 30_000,
    supportsReasoning: false,
    inputModes: ['text'],
  },
  default: {
    provider: 'openai-codex-app-server',
    familyId: 'codex-app',
    contextWindow: 1_048_576,
    maxOutputTokens: 128_000,
    supportsReasoning: true,
    inputModes: ['text'],
  },
} as const

describe('model-catalog', () => {
  it('contains the expected curated providers, families, and model set', () => {
    expect(Object.keys(FORGE_MODEL_CATALOG.providers)).toEqual([
      'openai-codex',
      'anthropic',
      'xai',
      'openrouter',
      'openai-codex-app-server',
    ])
    expect(Object.keys(FORGE_MODEL_CATALOG.families)).toEqual(Object.keys(EXPECTED_FAMILIES))
    expect(Object.keys(FORGE_MODEL_CATALOG.models)).toEqual(Object.keys(EXPECTED_MODELS))
    expect(Object.keys(FORGE_MODEL_CATALOG.models)).toHaveLength(12)
    expect(FORGE_MODEL_CATALOG.models).not.toHaveProperty('gpt-5.4-nano')
  })

  it('matches the approved family visibility matrix', () => {
    for (const [familyId, expected] of Object.entries(EXPECTED_FAMILIES)) {
      expect(getCatalogFamily(familyId)).toMatchObject(expected)
    }
  })

  it('matches the approved model metadata matrix', () => {
    for (const [modelId, expected] of Object.entries(EXPECTED_MODELS)) {
      expect(getCatalogModel(modelId)).toMatchObject(expected)
    }

    expect(getCatalogModel('gpt-5.3-codex-spark')?.inputModes).toEqual(['text'])
    expect(getCatalogProvider('xai')?.projectionScope).toBe('full-upstream-provider')
    expect(getCatalogProvider('openrouter')).toMatchObject({
      availabilityMode: 'external',
      piProjectionMode: 'custom-provider-merge',
      piApiProtocol: 'openai-completions',
    })
  })

  it('documents the intentional xAI divergences from Pi upstream', () => {
    expect(getCatalogModel('grok-4-fast')?.intentionalDivergenceNotes).toContain('text-only')
    expect(getCatalogModel('grok-4.20-0309-reasoning')?.intentionalDivergenceNotes).toContain(
      'text-only',
    )
    expect(getCatalogModel('grok-4.20-0309-non-reasoning')?.intentionalDivergenceNotes).toContain(
      'text-only',
    )
  })

  it('stores unique model IDs that match their record keys', () => {
    const entries = Object.entries(FORGE_MODEL_CATALOG.models)
    const keys = entries.map(([modelId]) => modelId)

    expect(new Set(keys).size).toBe(keys.length)
    for (const [modelId, model] of entries) {
      expect(model.modelId).toBe(modelId)
    }
  })

  it('ensures all models reference valid families', () => {
    const familyIds = new Set(Object.keys(FORGE_MODEL_CATALOG.families))

    for (const model of Object.values(FORGE_MODEL_CATALOG.models)) {
      expect(familyIds.has(model.familyId)).toBe(true)
    }
  })

  it('ensures all models reference valid providers', () => {
    const providerIds = new Set(Object.keys(FORGE_MODEL_CATALOG.providers))

    for (const model of Object.values(FORGE_MODEL_CATALOG.models)) {
      expect(providerIds.has(model.provider)).toBe(true)
    }
  })

  it('ensures all families reference valid providers', () => {
    const providerIds = new Set(Object.keys(FORGE_MODEL_CATALOG.providers))

    for (const family of Object.values(FORGE_MODEL_CATALOG.families)) {
      expect(providerIds.has(family.provider)).toBe(true)
    }
  })

  it('ensures each family has exactly one default model', () => {
    for (const familyId of Object.keys(FORGE_MODEL_CATALOG.families)) {
      const defaultModels = getCatalogModelsByFamily(familyId).filter((model) => model.isFamilyDefault)
      expect(defaultModels).toHaveLength(1)
    }
  })

  it("ensures each family's default model matches its defaultModelId", () => {
    for (const family of Object.values(FORGE_MODEL_CATALOG.families)) {
      const defaultModel = getCatalogModelsByFamily(family.familyId).find((model) => model.isFamilyDefault)

      expect(defaultModel?.modelId).toBe(family.defaultModelId)
    }
  })

  it('ensures all context windows are positive integers', () => {
    for (const model of Object.values(FORGE_MODEL_CATALOG.models)) {
      expect(Number.isInteger(model.contextWindow)).toBe(true)
      expect(model.contextWindow).toBeGreaterThan(0)
    }
  })

  it('ensures all max output token values are positive integers', () => {
    for (const model of Object.values(FORGE_MODEL_CATALOG.models)) {
      expect(Number.isInteger(model.maxOutputTokens)).toBe(true)
      expect(model.maxOutputTokens).toBeGreaterThan(0)
    }
  })

  it('ensures supported reasoning levels stay within the allowed set', () => {
    for (const model of Object.values(FORGE_MODEL_CATALOG.models)) {
      for (const reasoningLevel of model.supportedReasoningLevels) {
        expect(VALID_REASONING_LEVELS.has(reasoningLevel)).toBe(true)
      }
    }
  })

  it('provides working lookup helpers', () => {
    expect(getCatalogModel('gpt-5.3-codex')?.displayName).toBe('GPT-5.3 Codex')
    expect(getCatalogModel(' GPT-5.3-CODEX ')?.displayName).toBe('GPT-5.3 Codex')
    expect(getCatalogFamily('pi-grok')?.defaultModelId).toBe('grok-4')
    expect(getCatalogProvider('xai')?.projectionScope).toBe('full-upstream-provider')
    expect(getCatalogFamilyForModel('claude-opus-4-6')?.familyId).toBe('pi-opus')
    expect(getCatalogContextWindow('grok-4-fast')).toBe(2_000_000)
    expect(inferCatalogProvider('gpt-5.4')).toBe('openai-codex')
    expect(inferCatalogProvider('gpt-5.4-nano')).toBeNull()
    expect(inferCatalogFamily('openai-codex', 'gpt-5.4-mini')).toBe('pi-5.4')
    expect(inferCatalogFamily('xai', 'grok-3')).toBe('pi-grok')
    expect(inferCatalogFamily('anthropic', 'grok-4')).toBeUndefined()
    expect(isCatalogModelId('default')).toBe(true)
    expect(isCatalogModelId('gpt-5.4-nano')).toBe(false)
  })

  it('returns the expected visibility subsets', () => {
    expect(getCreateManagerFamilies().map((family) => family.familyId)).toEqual([
      'pi-codex',
      'pi-5.4',
      'pi-opus',
    ])

    expect(getChangeManagerFamilies().map((family) => family.familyId)).toEqual([
      'pi-codex',
      'pi-5.4',
      'pi-opus',
    ])

    expect(getSpawnPresetFamilies().map((family) => family.familyId)).toEqual([
      'pi-codex',
      'pi-5.4',
      'pi-opus',
      'pi-grok',
      'codex-app',
    ])

    expect(getSpecialistFamilies().map((family) => family.familyId)).toEqual([
      'pi-codex',
      'pi-5.4',
      'pi-opus',
      'pi-grok',
    ])
  })
})
