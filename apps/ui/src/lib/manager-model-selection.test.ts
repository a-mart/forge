import { describe, expect, it } from 'vitest'
import { getOpenRouterModelOverrideKey, type OpenRouterModelEntry } from '@forge/protocol'
import {
  buildCurrentModelFallbackRow,
  buildManagerModelRows,
  decodeManagerModelValue,
  encodeManagerModelValue,
  groupManagerModelRows,
} from './manager-model-selection'

function openRouterEntry(overrides: Partial<OpenRouterModelEntry> = {}): OpenRouterModelEntry {
  return {
    modelId: 'z-ai/glm-5.1',
    displayName: 'Z.ai: GLM 5.1',
    contextWindow: 202_752,
    maxOutputTokens: 202_752,
    supportsReasoning: true,
    supportedReasoningLevels: ['none', 'low', 'medium', 'high'],
    inputModes: ['text'],
    addedAt: '2026-04-03T00:00:00.000Z',
    supportsTools: true,
    ...overrides,
  }
}

describe('encodeManagerModelValue / decodeManagerModelValue', () => {
  it('round-trips provider and modelId', () => {
    const encoded = encodeManagerModelValue('anthropic', 'claude-opus-4-6')
    expect(encoded).toBe('anthropic::claude-opus-4-6')
    expect(decodeManagerModelValue(encoded)).toEqual({ provider: 'anthropic', modelId: 'claude-opus-4-6' })
  })

  it('returns undefined for invalid values', () => {
    expect(decodeManagerModelValue('')).toBeUndefined()
    expect(decodeManagerModelValue('no-separator')).toBeUndefined()
  })
})

describe('buildManagerModelRows provider availability gating', () => {
  it('marks managed-auth provider rows unavailable when providerAvailability is empty', () => {
    const rows = buildManagerModelRows('create', {}, {})

    // With empty providerAvailability, managed-auth providers should be unavailable
    const anthropicRows = rows.filter((r) => r.provider === 'anthropic')
    expect(anthropicRows.length).toBeGreaterThan(0)
    for (const row of anthropicRows) {
      expect(row.unavailableReason).toBeTruthy()
    }

    const codexRows = rows.filter((r) => r.provider === 'openai-codex')
    expect(codexRows.length).toBeGreaterThan(0)
    for (const row of codexRows) {
      expect(row.unavailableReason).toBeTruthy()
    }
  })

  it('marks managed-auth provider rows unavailable when providerAvailability is false', () => {
    const rows = buildManagerModelRows('create', {}, {
      'anthropic': false,
      'openai-codex': false,
    })

    const anthropicRows = rows.filter((r) => r.provider === 'anthropic')
    for (const row of anthropicRows) {
      expect(row.unavailableReason).toBeTruthy()
    }

    const codexRows = rows.filter((r) => r.provider === 'openai-codex')
    for (const row of codexRows) {
      expect(row.unavailableReason).toBeTruthy()
    }
  })

  it('marks managed-auth provider rows available when providerAvailability is true', () => {
    const rows = buildManagerModelRows('create', {}, {
      'anthropic': true,
      'openai-codex': true,
    })

    const anthropicRows = rows.filter((r) => r.provider === 'anthropic')
    expect(anthropicRows.length).toBeGreaterThan(0)
    for (const row of anthropicRows) {
      expect(row.unavailableReason).toBeUndefined()
    }

    const codexRows = rows.filter((r) => r.provider === 'openai-codex')
    expect(codexRows.length).toBeGreaterThan(0)
    for (const row of codexRows) {
      expect(row.unavailableReason).toBeUndefined()
    }
  })

  it('includes GPT-6 Astra without changing existing OpenAI defaults', () => {
    const rows = buildManagerModelRows('create', {}, { 'openai-codex': true })
    const astra = rows.find((row) => row.key === 'openai-codex::gpt-6-astra')

    expect(astra).toMatchObject({
      provider: 'openai-codex',
      familyId: 'pi-6',
      modelId: 'gpt-6-astra',
      displayName: 'GPT-6 Astra',
      supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultReasoningLevel: 'high',
    })
    expect(astra?.unavailableReason).toBeUndefined()
    expect(rows.find((row) => row.modelId === 'gpt-5.5')).toMatchObject({
      familyId: 'pi-5.5',
      modelId: 'gpt-5.5',
    })
    expect(rows.some((row) => row.familyId === 'pi-5.4' || row.modelId.startsWith('gpt-5.4'))).toBe(false)
  })

  it('includes native xAI Grok 4.6 as the default and preserves Grok 4.5 as a variant', () => {
    const rows = buildManagerModelRows('create', {}, { xai: true })
    const grokRows = rows.filter((row) => row.provider === 'xai')
    const grok46 = rows.find((row) => row.key === 'xai::grok-4.6')
    const grok45 = rows.find((row) => row.key === 'xai::grok-4.5')

    expect(grokRows.map((row) => row.modelId)).toEqual(['grok-4.6', 'grok-4.5'])
    for (const grok of [grok46, grok45]) {
      expect(grok).toMatchObject({
        provider: 'xai',
        familyId: 'pi-grok',
        supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh'],
        defaultReasoningLevel: 'high',
      })
      expect(grok?.unavailableReason).toBeUndefined()
    }
    expect(grok46).toMatchObject({ modelId: 'grok-4.6', displayName: 'Grok 4.6' })
    expect(grok45).toMatchObject({ modelId: 'grok-4.5', displayName: 'Grok 4.5' })
    expect(rows.some((row) => row.modelId === 'grok-build' || row.modelId === 'grok-composer-2.5-fast')).toBe(false)
  })

  it('gates native xAI manager rows on stored credential availability', () => {
    const rows = buildManagerModelRows('change', {}, {})
    const grokRows = rows.filter((row) => row.provider === 'xai')

    expect(grokRows.length).toBeGreaterThan(0)
    expect(grokRows.every((row) => row.unavailableReason)).toBe(true)
  })

  it('includes Claude Opus 5 with both xhigh and max reasoning levels', () => {
    const rows = buildManagerModelRows('create', {}, { anthropic: true })
    const opus = rows.find((row) => row.key === 'anthropic::claude-opus-5')

    expect(opus).toMatchObject({
      provider: 'anthropic',
      modelId: 'claude-opus-5',
      supportedReasoningLevels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
      defaultReasoningLevel: 'high',
    })
    expect(opus?.unavailableReason).toBeUndefined()
  })

  it('includes Claude Fable 5.1 as default and retains Claude Fable 5', () => {
    const rows = buildManagerModelRows('create', {}, { anthropic: true })
    const fable = rows.find((row) => row.key === 'anthropic::claude-fable-5-1')
    const priorFable = rows.find((row) => row.key === 'anthropic::claude-fable-5')

    expect(fable).toMatchObject({
      provider: 'anthropic',
      familyId: 'pi-fable',
      modelId: 'claude-fable-5-1',
      displayName: 'Claude Fable 5.1',
      supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultReasoningLevel: 'high',
    })
    expect(fable?.unavailableReason).toBeUndefined()
    expect(priorFable).toMatchObject({
      modelId: 'claude-fable-5',
      displayName: 'Claude Fable 5',
    })
  })

})

describe('buildManagerModelRows OpenRouter dynamic entries', () => {
  it('excludes user-added OpenRouter models by default even when tools and auth are present', () => {
    const rows = buildManagerModelRows(
      'create',
      {},
      { openrouter: true },
      [openRouterEntry()],
    )

    expect(rows.some((row) => row.provider === 'openrouter')).toBe(false)
  })

  it('includes only managerEnabled tool-capable OpenRouter models with exact provider/modelId payloads', () => {
    const enabled = openRouterEntry()
    const disabled = openRouterEntry({
      modelId: 'deepseek/deepseek-chat',
      displayName: 'DeepSeek Chat',
    })
    const noTools = openRouterEntry({
      modelId: 'google/gemini-2.0-flash',
      displayName: 'Gemini 2.0 Flash',
      supportsTools: false,
    })
    const unverified = openRouterEntry({
      modelId: 'meta-llama/llama-3.1-8b-instruct',
      displayName: 'Llama 3.1 8B',
    })
    delete (unverified as { supportsTools?: boolean }).supportsTools

    const rows = buildManagerModelRows(
      'change',
      {
        [getOpenRouterModelOverrideKey(enabled.modelId)]: { managerEnabled: true },
        [getOpenRouterModelOverrideKey(disabled.modelId)]: { managerEnabled: false },
        [getOpenRouterModelOverrideKey(noTools.modelId)]: { managerEnabled: true },
        [getOpenRouterModelOverrideKey(unverified.modelId)]: { managerEnabled: true },
      },
      { openrouter: true },
      [enabled, disabled, noTools, unverified],
    )

    const openRouterRows = rows.filter((row) => row.provider === 'openrouter')
    expect(openRouterRows).toEqual([
      expect.objectContaining({
        key: 'openrouter::z-ai/glm-5.1',
        provider: 'openrouter',
        modelId: 'z-ai/glm-5.1',
        displayName: 'Z.ai: GLM 5.1',
        supportedReasoningLevels: ['none', 'low', 'medium', 'high'],
        defaultReasoningLevel: 'medium',
      }),
    ])
    expect(decodeManagerModelValue(openRouterRows[0].key)).toEqual({
      provider: 'openrouter',
      modelId: 'z-ai/glm-5.1',
    })
  })

  it('marks enabled OpenRouter rows unavailable when OpenRouter is not configured', () => {
    const model = openRouterEntry()
    const rows = buildManagerModelRows(
      'create',
      { [getOpenRouterModelOverrideKey(model.modelId)]: { managerEnabled: true } },
      { openrouter: false },
      [model],
    )

    expect(rows.find((row) => row.modelId === model.modelId)).toMatchObject({
      provider: 'openrouter',
      unavailableReason: 'Provider not configured',
    })
  })

  it('preserves an unavailable current OpenRouter model as a fallback row', () => {
    const model = openRouterEntry()
    const fallback = buildCurrentModelFallbackRow(
      'openrouter',
      model.modelId,
      'high',
      [model],
    )

    expect(fallback).toMatchObject({
      key: 'openrouter::z-ai/glm-5.1',
      provider: 'openrouter',
      providerDisplayName: 'OpenRouter',
      modelId: model.modelId,
      displayName: model.displayName,
      supportedReasoningLevels: ['none', 'low', 'medium', 'high'],
      defaultReasoningLevel: 'medium',
      unavailableReason: 'Not available for selection',
    })
  })
})

describe('groupManagerModelRows', () => {
  it('groups rows by provider preserving order', () => {
    const rows = buildManagerModelRows('create', {}, {
      'anthropic': true,
      'openai-codex': true,
    })

    const available = rows.filter((r) => !r.unavailableReason)
    const groups = groupManagerModelRows(available)

    // Should have at least Anthropic and OpenAI Codex groups
    const providerIds = groups.map((g) => g.provider)
    expect(providerIds).toContain('anthropic')
    expect(providerIds).toContain('openai-codex')

    // Each group should have non-empty rows
    for (const group of groups) {
      expect(group.rows.length).toBeGreaterThan(0)
      // All rows in a group share the same provider
      for (const row of group.rows) {
        expect(row.provider).toBe(group.provider)
      }
    }
  })
})
