import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchModelPresets, getSupportedReasoningLevelsForModelId } from './model-preset'
import { createBuilderSettingsApiClient } from '@/components/settings/settings-api-client'

const client = createBuilderSettingsApiClient('ws://127.0.0.1:47187')

afterEach(() => {
  vi.restoreAllMocks()
})

describe('fetchModelPresets', () => {
  it('keeps dynamic OpenRouter preset ids only when explicitly allowed', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [
          {
            presetId: 'pi-5.5',
            displayName: 'GPT-5.5',
            provider: 'openai-codex',
            modelId: 'gpt-5.5',
            defaultReasoningLevel: 'xhigh',
            supportedReasoningLevels: ['none', 'low', 'medium', 'high', 'xhigh'],
          },
          {
            presetId: 'openrouter:anthropic/claude-3.5-sonnet',
            displayName: 'Claude 3.5 Sonnet',
            provider: 'openrouter',
            modelId: 'anthropic/claude-3.5-sonnet',
            defaultReasoningLevel: 'medium',
            supportedReasoningLevels: ['none', 'low', 'medium', 'high'],
          },
        ],
      }),
    } as Response)

    await expect(fetchModelPresets(client)).resolves.toEqual([
      expect.objectContaining({ presetId: 'pi-5.5' }),
    ])

    await expect(
      fetchModelPresets(client, { allowDynamicPresetIds: true }),
    ).resolves.toEqual([
      expect.objectContaining({ presetId: 'pi-5.5' }),
      expect.objectContaining({ presetId: 'openrouter:anthropic/claude-3.5-sonnet' }),
    ])
  })

  it('uses authenticated per-variant reasoning metadata for discovered models', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [{
          presetId: 'pi-grok',
          displayName: 'Grok 4.5',
          provider: 'xai',
          modelId: 'grok-4.5',
          defaultReasoningLevel: 'high',
          supportedReasoningLevels: ['low', 'medium', 'high'],
          variants: [{
            modelId: 'grok-composer-2.5-fast',
            label: 'Grok Composer 2.5 Fast',
            defaultReasoningLevel: 'high',
            supportedReasoningLevels: ['low', 'high'],
          }],
        }],
      }),
    } as Response)

    const presets = await fetchModelPresets(client)
    expect(getSupportedReasoningLevelsForModelId(
      'grok-composer-2.5-fast',
      presets,
      'xai',
    )).toEqual(['low', 'high'])
  })
})
