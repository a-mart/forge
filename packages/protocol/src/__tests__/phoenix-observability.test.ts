import { describe, expect, it } from 'vitest'
import {
  PHOENIX_OBSERVABILITY_CONTENT_MODES,
  type PhoenixObservabilitySettings,
} from '../phoenix-observability.js'

it('exports Phoenix observability DTO shapes', () => {
  const settings: PhoenixObservabilitySettings = {
    enabled: false,
    endpoint: 'http://127.0.0.1:6006/v1/traces',
    projectName: 'default',
    contentMode: 'rich',
    capture: {
      prompts: true,
      modelInputs: true,
      modelOutputs: true,
      toolInputs: true,
      toolResults: true,
      feedbackComments: true,
      imageData: false,
    },
    privacy: {
      redactionEnabled: true,
      includeDisplayNames: false,
      identifierMode: 'stable_hash',
      pathMode: 'basename_and_hash',
      maxContentChars: 32768,
      maxAttributeChars: 32768,
      maxSpanContentChars: 131072,
      extraRedactionPatterns: [],
    },
    export: {
      batchMaxQueueSize: 512,
      batchMaxExportBatchSize: 64,
      scheduledDelayMs: 2000,
      exportTimeoutMs: 3000,
      concurrencyLimit: 1,
    },
    updatedAt: null,
  }

  expect(PHOENIX_OBSERVABILITY_CONTENT_MODES).toEqual(['rich', 'metadata_only'])
  expect(settings.contentMode).toBe('rich')
})

describe('root barrel', () => {
  it('re-exports Phoenix observability types at runtime constants level', async () => {
    const barrel = await import('../index.js')
    expect(barrel.PHOENIX_OBSERVABILITY_CONTENT_MODES).toEqual(['rich', 'metadata_only'])
  })
})
