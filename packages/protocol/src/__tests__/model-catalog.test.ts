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
  getDefaultManagerEnabled,
  getEffectiveCompactionEnabled,
  getEffectiveManagerEnabled,
  getSpawnPresetFamilies,
  getSpecialistFamilies,
  inferCatalogFamily,
  inferCatalogProvider,
  isCatalogModelCompactionSupported,
  isCatalogModelId,
  isCatalogModelManagerSupported,
  isCompactionModelSelectionSupported,
} from '../model-catalog.js'

const VALID_REASONING_LEVELS = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])

const EXPECTED_FAMILIES = {
  'pi-codex': {
    provider: 'openai-codex',
    defaultModelId: 'gpt-5.5',
    visibleInCreateManager: false,
    visibleInChangeManager: false,
    visibleInSpawnPreset: false,
    visibleInSpecialists: false,
  },
  'pi-5.5': {
    provider: 'openai-codex',
    defaultModelId: 'gpt-5.5',
    visibleInCreateManager: true,
    visibleInChangeManager: true,
    visibleInSpawnPreset: true,
    visibleInSpecialists: true,
  },
  'pi-5.6': {
    provider: 'openai-codex',
    defaultModelId: 'gpt-5.6-sol',
    visibleInCreateManager: true,
    visibleInChangeManager: true,
    visibleInSpawnPreset: true,
    visibleInSpecialists: true,
  },
  'pi-codex-spark': {
    provider: 'openai-codex',
    defaultModelId: 'gpt-5.3-codex-spark',
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
    defaultModelId: 'claude-opus-4-8',
    visibleInCreateManager: true,
    visibleInChangeManager: true,
    visibleInSpawnPreset: true,
    visibleInSpecialists: true,
  },
  'pi-sonnet': {
    provider: 'anthropic',
    defaultModelId: 'claude-sonnet-5',
    visibleInCreateManager: true,
    visibleInChangeManager: true,
    visibleInSpawnPreset: true,
    visibleInSpecialists: true,
  },
  'pi-fable': {
    provider: 'anthropic',
    defaultModelId: 'claude-fable-5',
    visibleInCreateManager: true,
    visibleInChangeManager: true,
    visibleInSpawnPreset: true,
    visibleInSpecialists: true,
  },
  'sdk-opus': {
    provider: 'claude-sdk',
    defaultModelId: 'claude-opus-4-8',
    visibleInCreateManager: true,
    visibleInChangeManager: true,
    visibleInSpawnPreset: true,
    visibleInSpecialists: true,
  },
  'sdk-sonnet': {
    provider: 'claude-sdk',
    defaultModelId: 'claude-sonnet-5',
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
  'cursor-composer': {
    provider: 'cursor-sdk',
    defaultModelId: 'composer-2.5',
    visibleInCreateManager: true,
    visibleInChangeManager: true,
    visibleInSpawnPreset: true,
    visibleInSpecialists: true,
  },
  'cursor-grok-45': {
    provider: 'cursor-sdk',
    defaultModelId: 'grok-4.5',
    visibleInCreateManager: true,
    visibleInChangeManager: true,
    visibleInSpawnPreset: true,
    visibleInSpecialists: true,
  },
} as const

const EXPECTED_MODELS = {
  'gpt-5.5': {
    provider: 'openai-codex',
    familyId: 'pi-5.5',
    contextWindow: 272_000,
    maxOutputTokens: 128_000,
    supportsReasoning: true,
    inputModes: ['text', 'image'],
  },
  'gpt-5.6-sol': {
    provider: 'openai-codex',
    familyId: 'pi-5.6',
    contextWindow: 272_000,
    maxOutputTokens: 128_000,
    supportsReasoning: true,
    inputModes: ['text', 'image'],
  },
  'gpt-5.6-terra': {
    provider: 'openai-codex',
    familyId: 'pi-5.6',
    contextWindow: 272_000,
    maxOutputTokens: 128_000,
    supportsReasoning: true,
    inputModes: ['text', 'image'],
  },
  'gpt-5.6-luna': {
    provider: 'openai-codex',
    familyId: 'pi-5.6',
    contextWindow: 272_000,
    maxOutputTokens: 128_000,
    supportsReasoning: true,
    inputModes: ['text', 'image'],
  },
  'gpt-5.3-codex-spark': {
    provider: 'openai-codex',
    familyId: 'pi-codex-spark',
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
  'claude-opus-4-8': {
    provider: 'anthropic',
    familyId: 'pi-opus',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsReasoning: true,
    inputModes: ['text', 'image'],
  },
  'claude-opus-4-7': {
    provider: 'anthropic',
    familyId: 'pi-opus',
    contextWindow: 1_000_000,
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
  'claude-sonnet-5': {
    provider: 'anthropic',
    familyId: 'pi-sonnet',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsReasoning: true,
    inputModes: ['text', 'image'],
  },
  'claude-sonnet-4-5-20250929': {
    provider: 'anthropic',
    familyId: 'pi-sonnet',
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
    supportsReasoning: true,
    inputModes: ['text', 'image'],
  },
  'claude-fable-5': {
    provider: 'anthropic',
    familyId: 'pi-fable',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
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
  'claude-sdk/claude-opus-4-8': {
    provider: 'claude-sdk',
    familyId: 'sdk-opus',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsReasoning: true,
    inputModes: ['text', 'image'],
  },
  'claude-sdk/claude-opus-4-7': {
    provider: 'claude-sdk',
    familyId: 'sdk-opus',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsReasoning: true,
    inputModes: ['text', 'image'],
  },
  'claude-sdk/claude-opus-4-6': {
    provider: 'claude-sdk',
    familyId: 'sdk-opus',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsReasoning: true,
    inputModes: ['text', 'image'],
  },
  'claude-sdk/claude-sonnet-5': {
    provider: 'claude-sdk',
    familyId: 'sdk-sonnet',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsReasoning: true,
    inputModes: ['text', 'image'],
  },
  'claude-sdk/claude-sonnet-4-5-20250929': {
    provider: 'claude-sdk',
    familyId: 'sdk-sonnet',
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    supportsReasoning: true,
    inputModes: ['text', 'image'],
  },
  'claude-sdk/claude-haiku-4-5-20251001': {
    provider: 'claude-sdk',
    familyId: 'sdk-opus',
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
  'cursor-sdk/composer-2.5': {
    provider: 'cursor-sdk',
    familyId: 'cursor-composer',
    contextWindow: 200_000,
    maxOutputTokens: 16_384,
    supportsReasoning: false,
    inputModes: ['text'],
  },
  'cursor-sdk/grok-4.5': {
    provider: 'cursor-sdk',
    familyId: 'cursor-grok-45',
    contextWindow: 500_000,
    maxOutputTokens: 64_000,
    supportsReasoning: true,
    inputModes: ['text', 'image'],
  },
  'cursor-sdk/grok-4.5-fast': {
    provider: 'cursor-sdk',
    familyId: 'cursor-grok-45',
    contextWindow: 500_000,
    maxOutputTokens: 64_000,
    supportsReasoning: true,
    inputModes: ['text', 'image'],
  },
} as const

describe('model-catalog', () => {
  it('contains the expected curated providers, families, and model set', () => {
    expect(Object.keys(FORGE_MODEL_CATALOG.providers)).toEqual([
      'openai-codex',
      'anthropic',
      'claude-sdk',
      'xai',
      'openrouter',
      'cursor-sdk',
    ])
    expect(Object.keys(FORGE_MODEL_CATALOG.families)).toEqual(Object.keys(EXPECTED_FAMILIES))
    expect(Object.keys(FORGE_MODEL_CATALOG.models)).toEqual(Object.keys(EXPECTED_MODELS))
    expect(Object.keys(FORGE_MODEL_CATALOG.models)).toHaveLength(27)
    expect(FORGE_MODEL_CATALOG.models).not.toHaveProperty('gpt-5.3-codex')
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
    expect(getCatalogModel('claude-fable-5')).toMatchObject({
      isFamilyDefault: true,
      supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultReasoningLevel: 'high',
      thinkingLevelMap: { off: null, xhigh: 'xhigh', max: 'max' },
      webSearchCapability: 'none',
      enabledByDefault: true,
      piUpstreamId: 'claude-fable-5',
      intentionalDivergenceNotes: null,
    })
    expect(getCatalogModel('claude-fable-5')?.supportedReasoningLevels).not.toContain('none')
    expect(getCatalogProvider('xai')?.projectionScope).toBe('full-upstream-provider')
    expect(getCatalogProvider('claude-sdk')).toMatchObject({
      availabilityMode: 'managed-auth',
      piProjectionMode: 'none',
    })
    expect(getCatalogProvider('openrouter')).toMatchObject({
      availabilityMode: 'external',
      piProjectionMode: 'custom-provider-merge',
      piApiProtocol: 'openai-completions',
    })
    expect(getCatalogProvider('cursor-sdk')).toMatchObject({
      availabilityMode: 'managed-auth',
      piProjectionMode: 'none',
      projectionScope: 'catalog-only',
    })
  })

  it('documents the intentional xAI divergences from Pi upstream', () => {
    expect(getCatalogModel('grok-4-fast')?.intentionalDivergenceNotes).toContain('text-only')
    expect(getCatalogModel('gpt-5.6-sol')?.intentionalDivergenceNotes).toContain('Pending Pi upstream')
    expect(getCatalogModel('claude-opus-4-8')?.intentionalDivergenceNotes).toContain('Pending Pi upstream')
    expect(getCatalogModel('claude-sonnet-5')?.intentionalDivergenceNotes).toContain('Pending Pi upstream')
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
      expect(model.catalogId ?? model.modelId).toBe(modelId)
    }
  })

  it('removes legacy Cursor ACP from the catalog while keeping Cursor SDK provider-qualified', () => {
    expect(getCatalogProvider('cursor-acp')).toBeUndefined()
    expect(getCatalogFamily('cursor-acp')).toBeUndefined()
    expect(getCatalogModel('cursor-acp/default')).toBeUndefined()
    expect(getCatalogModel('default', 'cursor-acp')).toBeUndefined()
    expect(getCatalogModel('default')).toBeUndefined()
    expect(inferCatalogProvider('default')).toBeNull()

    expect(getCatalogModel('cursor-sdk/composer-2.5')).toMatchObject({
      catalogId: 'cursor-sdk/composer-2.5',
      modelId: 'composer-2.5',
      provider: 'cursor-sdk',
      familyId: 'cursor-composer',
      supportsReasoning: false,
    })
    expect(getCatalogModel('cursor-sdk/grok-4.5')).toMatchObject({
      catalogId: 'cursor-sdk/grok-4.5',
      modelId: 'grok-4.5',
      provider: 'cursor-sdk',
      familyId: 'cursor-grok-45',
      supportsReasoning: true,
    })
    expect(getCatalogModel('grok-4.5', 'cursor-sdk')).toMatchObject({
      catalogId: 'cursor-sdk/grok-4.5',
      provider: 'cursor-sdk',
    })
    expect(getCatalogModel('grok-4.5')).toBeUndefined()
  })

  it('makes Cursor SDK accessible across manager and specialist surfaces', () => {
    expect(getCatalogFamily('cursor-sdk')).toBeUndefined()
    expect(getCatalogFamily('cursor-composer')).toMatchObject({
      visibleInCreateManager: true,
      visibleInChangeManager: true,
      visibleInSpawnPreset: true,
      visibleInSpecialists: true,
    })
    expect(getCatalogFamily('cursor-grok-45')).toMatchObject({
      visibleInCreateManager: true,
      visibleInChangeManager: true,
      visibleInSpawnPreset: true,
      visibleInSpecialists: true,
    })
    expect(getCatalogFamily('cursor-acp')).toBeUndefined()
    expect(getSpecialistFamilies().map((family) => family.familyId)).toContain('cursor-composer')
    expect(getSpecialistFamilies().map((family) => family.familyId)).toContain('cursor-grok-45')
    expect(getCreateManagerFamilies().map((family) => family.familyId)).toContain('cursor-composer')
    expect(getCreateManagerFamilies().map((family) => family.familyId)).toContain('cursor-grok-45')
    expect(getChangeManagerFamilies().map((family) => family.familyId)).toContain('cursor-composer')
    expect(getChangeManagerFamilies().map((family) => family.familyId)).toContain('cursor-grok-45')
    expect(getSpawnPresetFamilies().map((family) => family.familyId)).toContain('cursor-composer')
    expect(getSpawnPresetFamilies().map((family) => family.familyId)).toContain('cursor-grok-45')
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

  it('ensures each family resolves a default model', () => {
    for (const family of Object.values(FORGE_MODEL_CATALOG.families)) {
      const familyModels = getCatalogModelsByFamily(family.familyId)
      const explicitDefaultModel = familyModels.find((model) => model.isFamilyDefault)
      const resolvedDefaultModel = explicitDefaultModel ?? getCatalogModel(family.defaultModelId, family.provider)

      expect(resolvedDefaultModel?.modelId).toBe(family.defaultModelId)
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
    expect(getCatalogModel('gpt-5.6-sol')?.displayName).toBe('GPT-5.6 Sol')
    expect(getCatalogModel('gpt-5.6-sol')?.supportedReasoningLevels).toEqual(['low', 'medium', 'high', 'max', 'ultra'])
    expect(getCatalogModel('gpt-5.6-terra')?.supportedReasoningLevels).toEqual(['low', 'medium', 'high'])
    expect(getCatalogModel('gpt-5.6-luna')?.supportedReasoningLevels).toEqual(['low', 'medium', 'high'])
    expect(getCatalogModel('gpt-5.5')?.displayName).toBe('GPT-5.5')
    expect(getCatalogModel(' GPT-5.3-CODEX ')).toBeUndefined()
    expect(getCatalogFamily('pi-grok')?.defaultModelId).toBe('grok-4')
    expect(getCatalogProvider('xai')?.projectionScope).toBe('full-upstream-provider')
    expect(getCatalogFamilyForModel('claude-opus-4-6')?.familyId).toBe('pi-opus')
    expect(getCatalogFamilyForModel('claude-sonnet-5')?.familyId).toBe('pi-sonnet')
    expect(getCatalogFamilyForModel('claude-sonnet-5', 'anthropic')?.familyId).toBe('pi-sonnet')
    expect(getCatalogFamilyForModel('claude-fable-5', 'anthropic')?.familyId).toBe('pi-fable')
    expect(getCatalogFamilyForModel('claude-sonnet-4-5-20250929', 'claude-sdk')?.familyId).toBe('sdk-sonnet')
    expect(getCatalogFamilyForModel('claude-sonnet-5', 'claude-sdk')?.familyId).toBe('sdk-sonnet')
    expect(getCatalogModel('claude-sonnet-4-5-20250929', 'claude-sdk')?.displayName).toBe('Claude Sonnet 4.5 (SDK)')
    expect(getCatalogModel('claude-sonnet-5', 'claude-sdk')?.displayName).toBe('Claude Sonnet 5 (SDK)')
    expect(getCatalogModel('claude-sdk/claude-sonnet-4-5-20250929')?.provider).toBe('claude-sdk')
    expect(getCatalogContextWindow('grok-4-fast')).toBe(2_000_000)
    expect(getCatalogContextWindow('default')).toBeUndefined()
    expect(getCatalogContextWindow('default', 'cursor-acp')).toBeUndefined()
    expect(getCatalogModel('composer-2.5', 'cursor-sdk')).toMatchObject({
      catalogId: 'cursor-sdk/composer-2.5',
      provider: 'cursor-sdk',
      familyId: 'cursor-composer',
    })
    expect(getCatalogModel('grok-4.5-fast', 'cursor-sdk')).toMatchObject({
      catalogId: 'cursor-sdk/grok-4.5-fast',
      provider: 'cursor-sdk',
      familyId: 'cursor-grok-45',
    })
    expect(inferCatalogFamily('cursor-sdk', 'composer-2.5')).toBe('cursor-composer')
    expect(inferCatalogFamily('cursor-sdk', 'grok-4.5')).toBe('cursor-grok-45')
    expect(inferCatalogProvider('gpt-5.4')).toBe('openai-codex')
    expect(inferCatalogProvider('gpt-5.5')).toBe('openai-codex')
    expect(inferCatalogProvider('gpt-5.6-sol')).toBe('openai-codex')
    expect(inferCatalogProvider('gpt-5.4-nano')).toBeNull()
    expect(inferCatalogFamily('openai-codex', 'gpt-5.4-mini')).toBe('pi-5.4')
    expect(inferCatalogFamily('openai-codex', 'gpt-5.5')).toBe('pi-5.5')
    expect(inferCatalogFamily('openai-codex', 'gpt-5.6-sol')).toBe('pi-5.6')
    expect(inferCatalogFamily('claude-sdk', 'claude-sonnet-4-5-20250929')).toBe('sdk-sonnet')
    expect(inferCatalogFamily('claude-sdk', 'claude-sonnet-5')).toBe('sdk-sonnet')
    expect(inferCatalogFamily('anthropic', 'claude-sonnet-5')).toBe('pi-sonnet')
    expect(inferCatalogFamily('anthropic', 'claude-sonnet-4-5-20250929')).toBe('pi-sonnet')
    expect(inferCatalogFamily('anthropic', 'claude-fable-5')).toBe('pi-fable')
    expect(inferCatalogFamily('claude-sdk', 'claude-opus-4-8')).toBe('sdk-opus')
    expect(inferCatalogFamily('xai', 'grok-3')).toBe('pi-grok')
    expect(inferCatalogFamily('anthropic', 'grok-4')).toBeUndefined()
    expect(isCatalogModelId('default')).toBe(false)
    expect(isCatalogModelId('gpt-5.4-nano')).toBe(false)
  })

  it('derives manager-selectable exact model availability from family support, global enabled, and managerEnabled overrides', () => {
    const anthropicOpus47 = getCatalogModel('claude-opus-4-7', 'anthropic')
    const sdkOpus47 = getCatalogModel('claude-opus-4-7', 'claude-sdk')
    const grok = getCatalogModel('grok-4', 'xai')

    expect(anthropicOpus47).toBeDefined()
    expect(sdkOpus47).toBeDefined()
    expect(grok).toBeDefined()

    if (!anthropicOpus47 || !sdkOpus47 || !grok) {
      throw new Error('Expected manager model helper fixtures to exist in the catalog')
    }

    expect(isCatalogModelManagerSupported(anthropicOpus47, 'create')).toBe(true)
    expect(isCatalogModelManagerSupported(sdkOpus47, 'change')).toBe(true)
    expect(getDefaultManagerEnabled(anthropicOpus47, 'create')).toBe(true)
    expect(getDefaultManagerEnabled(sdkOpus47, 'change')).toBe(true)
    expect(getEffectiveManagerEnabled(anthropicOpus47, undefined, 'create')).toBe(true)
    expect(getEffectiveManagerEnabled(sdkOpus47, undefined, 'change')).toBe(true)
    expect(getEffectiveManagerEnabled(anthropicOpus47, { managerEnabled: false }, 'create')).toBe(false)
    expect(getEffectiveManagerEnabled(sdkOpus47, { enabled: false }, 'change')).toBe(false)
    expect(isCatalogModelManagerSupported(grok, 'create')).toBe(false)
    expect(getDefaultManagerEnabled(grok, 'create')).toBe(false)
    expect(getEffectiveManagerEnabled(grok, { managerEnabled: true }, 'create')).toBe(false)
  })

  it('derives compaction eligibility from the dedicated provider allowlist instead of manager visibility', () => {
    const anthropicOpus47 = getCatalogModel('claude-opus-4-7', 'anthropic')
    const sdkSonnet = getCatalogModel('claude-sonnet-4-5-20250929', 'claude-sdk')
    const grok = getCatalogModel('grok-4', 'xai')

    expect(anthropicOpus47).toBeDefined()
    expect(sdkSonnet).toBeDefined()
    expect(grok).toBeDefined()

    if (!anthropicOpus47 || !sdkSonnet || !grok) {
      throw new Error('Expected compaction model helper fixtures to exist in the catalog')
    }

    expect(isCatalogModelCompactionSupported(anthropicOpus47)).toBe(true)
    expect(isCatalogModelCompactionSupported(sdkSonnet)).toBe(false)
    expect(isCatalogModelCompactionSupported(grok)).toBe(false)
    expect(isCompactionModelSelectionSupported('claude-opus-4-7', 'anthropic')).toBe(true)
    expect(isCompactionModelSelectionSupported('grok-4', 'xai')).toBe(false)
    expect(isCompactionModelSelectionSupported('claude-sonnet-4-5-20250929', 'claude-sdk')).toBe(false)
    expect(getEffectiveCompactionEnabled(anthropicOpus47, undefined)).toBe(true)
    expect(getEffectiveCompactionEnabled(grok, undefined)).toBe(false)
  })

  it('returns the expected visibility subsets', () => {
    expect(getCreateManagerFamilies().map((family) => family.familyId)).toEqual([
      'pi-5.5',
      'pi-5.6',
      'pi-codex-spark',
      'pi-5.4',
      'pi-opus',
      'pi-sonnet',
      'pi-fable',
      'sdk-opus',
      'sdk-sonnet',
      'cursor-composer',
      'cursor-grok-45',
    ])

    expect(getChangeManagerFamilies().map((family) => family.familyId)).toEqual([
      'pi-5.5',
      'pi-5.6',
      'pi-codex-spark',
      'pi-5.4',
      'pi-opus',
      'pi-sonnet',
      'pi-fable',
      'sdk-opus',
      'sdk-sonnet',
      'cursor-composer',
      'cursor-grok-45',
    ])

    expect(getSpawnPresetFamilies().map((family) => family.familyId)).toEqual([
      'pi-5.5',
      'pi-5.6',
      'pi-codex-spark',
      'pi-5.4',
      'pi-opus',
      'pi-sonnet',
      'pi-fable',
      'sdk-opus',
      'sdk-sonnet',
      'pi-grok',
      'cursor-composer',
      'cursor-grok-45',
    ])

    expect(getSpecialistFamilies().map((family) => family.familyId)).toEqual([
      'pi-5.5',
      'pi-5.6',
      'pi-codex-spark',
      'pi-5.4',
      'pi-opus',
      'pi-sonnet',
      'pi-fable',
      'sdk-opus',
      'sdk-sonnet',
      'pi-grok',
      'cursor-composer',
      'cursor-grok-45',
    ])
  })
})
