import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchModelPresets } from './model-preset'

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
            presetId: 'pi-codex',
            displayName: 'GPT-5.3 Codex',
            provider: 'openai-codex',
            modelId: 'gpt-5.3-codex',
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

    await expect(fetchModelPresets('ws://127.0.0.1:47187')).resolves.toEqual([
      expect.objectContaining({ presetId: 'pi-codex' }),
    ])

    await expect(
      fetchModelPresets('ws://127.0.0.1:47187', { allowDynamicPresetIds: true }),
    ).resolves.toEqual([
      expect.objectContaining({ presetId: 'pi-codex' }),
      expect.objectContaining({ presetId: 'openrouter:anthropic/claude-3.5-sonnet' }),
    ])
  })
})
