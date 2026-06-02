import { describe, expect, it } from 'vitest'
import type { AgentDescriptor } from '../types.js'
import {
  areModelCacheTokenFactsConsistent,
  buildModelCacheObservationFromMessageEnd,
  captureModelCacheObservationFromRuntimeEvent,
  isIntermediateToolUseModelCacheMessageEnd,
  classifyModelCache,
  extractModelCacheTokenFacts,
  isModelCacheClassificationConsistent,
  isSupportedModelCacheProvider,
  normalizeModelCacheProvider,
  resolveModelCacheObservationId,
} from '../runtime/model-cache-observation.js'

const baseDescriptor: AgentDescriptor = {
  agentId: 'manager-1',
  displayName: 'Manager',
  role: 'manager',
  managerId: 'manager-1',
  status: 'idle',
  profileId: 'profile-1',
  model: { provider: 'openai', modelId: 'gpt-5', thinkingLevel: 'medium' },
  cwd: '/tmp',
  sessionFile: '/tmp/session.jsonl',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

describe('model-cache-observation', () => {
  it('recognizes supported providers', () => {
    expect(normalizeModelCacheProvider('openai')).toBe('openai')
    expect(normalizeModelCacheProvider('openai-codex')).toBe('openai-codex')
    expect(normalizeModelCacheProvider('anthropic')).toBeNull()
    expect(isSupportedModelCacheProvider('openai')).toBe(true)
  })

  it('uses raw input total without double-counting cached tokens', () => {
    const tokens = extractModelCacheTokenFacts({
      input_tokens: 5000,
      cache_read_input_tokens: 4000,
      output_tokens: 200,
    })
    expect(tokens).toEqual({
      promptInputTokens: 5000,
      cachedInputTokens: 4000,
      cacheWriteInputTokens: 0,
      uncachedInputTokens: 1000,
      outputTokens: 200,
      totalTokens: 5200,
      normalization: 'raw_input_tokens_total',
    })
    expect(classifyModelCache(tokens!)?.status).toBe('hit')
  })

  it('uses normalized Pi components when raw totals are absent', () => {
    const tokens = extractModelCacheTokenFacts({
      input: 500,
      cacheRead: 1200,
      cacheWrite: 100,
      output: 80,
      totalTokens: 1880,
    })
    expect(tokens).toEqual({
      promptInputTokens: 1800,
      cachedInputTokens: 1200,
      cacheWriteInputTokens: 100,
      uncachedInputTokens: 500,
      outputTokens: 80,
      totalTokens: 1880,
      normalization: 'normalized_components',
    })
    expect(classifyModelCache(tokens!)?.status).toBe('partial')
  })

  it('skips ineligible prompt sizes below 1024 tokens', () => {
    expect(
      extractModelCacheTokenFacts({
        input_tokens: 900,
        cache_read_input_tokens: 0,
      }),
    ).toBeNull()
  })

  it('classifies miss, partial, and hit', () => {
    const miss = extractModelCacheTokenFacts({ input_tokens: 2000, cache_read_input_tokens: 0 })
    const partial = extractModelCacheTokenFacts({ input_tokens: 2000, cache_read_input_tokens: 500 })
    const hit = extractModelCacheTokenFacts({ input_tokens: 2000, cache_read_input_tokens: 1700 })

    expect(classifyModelCache(miss!)?.status).toBe('miss')
    expect(classifyModelCache(partial!)?.status).toBe('partial')
    expect(classifyModelCache(hit!)?.status).toBe('hit')
  })

  it('assigns stable ids from turnId or generates one at emission', () => {
    expect(resolveModelCacheObservationId({ id: 'custom-id' })).toBe('custom-id')
    expect(resolveModelCacheObservationId({ turnId: 'turn-abc' })).toBe('turn-abc')
    expect(resolveModelCacheObservationId({})).toMatch(/^[0-9a-f]{8}$/i)
  })

  it('builds observations from eligible assistant message_end payloads', () => {
    const observation = buildModelCacheObservationFromMessageEnd({
      agentId: 'manager-1',
      timestamp: '2026-06-02T12:00:00.000Z',
      descriptor: baseDescriptor,
      turnId: 'turn-1',
      message: {
        role: 'assistant',
        provider: 'openai-codex',
        modelId: 'gpt-5.5',
        usage: { input_tokens: 3000, cache_read_input_tokens: 2500, output_tokens: 120 },
      },
    })

    expect(observation).toMatchObject({
      type: 'model_cache_observation',
      agentId: 'manager-1',
      runtimeType: 'pi',
      provider: 'openai-codex',
      modelId: 'gpt-5.5',
      turnId: 'turn-1',
      id: 'turn-1',
      classification: { status: 'hit', version: 1 },
    })
  })

  it('rejects inconsistent usage where cached + write exceeds prompt input', () => {
    expect(
      extractModelCacheTokenFacts({
        input_tokens: 2000,
        cache_read_input_tokens: 1500,
        cache_creation_input_tokens: 800,
      }),
    ).toBeNull()
  })

  it('rejects raw totals where cached plus write consume the full prompt budget with no room', () => {
    expect(
      extractModelCacheTokenFacts({
        input_tokens: 1500,
        cache_read_input_tokens: 1500,
        cache_creation_input_tokens: 500,
      }),
    ).toBeNull()
  })

  it('validates token and classification consistency helpers', () => {
    const tokens = extractModelCacheTokenFacts({
      input_tokens: 2000,
      cache_read_input_tokens: 500,
    })
    expect(tokens).not.toBeNull()
    expect(areModelCacheTokenFactsConsistent(tokens!)).toBe(true)

    const classification = classifyModelCache(tokens!)
    expect(classification).not.toBeNull()
    expect(isModelCacheClassificationConsistent(tokens!, classification!)).toBe(true)

    expect(
      isModelCacheClassificationConsistent(tokens!, {
        ...classification!,
        status: 'hit',
      }),
    ).toBe(false)
  })

  it('returns null for unsupported providers', () => {
    const observation = buildModelCacheObservationFromMessageEnd({
      agentId: 'manager-1',
      timestamp: '2026-06-02T12:00:00.000Z',
      descriptor: {
        ...baseDescriptor,
        model: { provider: 'anthropic', modelId: 'claude-opus-4', thinkingLevel: 'high' },
      },
      message: {
        role: 'assistant',
        usage: { input_tokens: 3000, cache_read_input_tokens: 2500, output_tokens: 120 },
      },
    })

    expect(observation).toBeNull()
  })

  it('captureModelCacheObservationFromRuntimeEvent fails closed when disabled or runtime missing', () => {
    const message = {
      role: 'assistant',
      provider: 'openai',
      modelId: 'gpt-5',
      usage: { input_tokens: 3000, cache_read_input_tokens: 2500, output_tokens: 120 },
    }
    const effectiveEvent = { type: 'message_end', message } as const
    const piRuntime = { runtimeType: 'pi' } as const

    expect(
      captureModelCacheObservationFromRuntimeEvent({
        agentId: 'manager-1',
        descriptor: baseDescriptor,
        effectiveEvent,
        runtime: piRuntime as never,
        timestamp: '2026-06-02T12:00:00.000Z',
        enabled: false,
      }),
    ).toBeNull()

    expect(
      captureModelCacheObservationFromRuntimeEvent({
        agentId: 'manager-1',
        descriptor: baseDescriptor,
        effectiveEvent,
        runtime: undefined,
        timestamp: '2026-06-02T12:00:00.000Z',
        enabled: true,
      }),
    ).toBeNull()
  })

  it.each(['toolUse', 'tool_use', 'ToolUse'])('treats %s assistant ends as intermediate tool-use', (stopReason) => {
    expect(
      isIntermediateToolUseModelCacheMessageEnd({
        role: 'assistant',
        stopReason,
      }),
    ).toBe(true)
  })

  it('captureModelCacheObservationFromRuntimeEvent skips intermediate tool-use assistant ends', () => {
    expect(
      captureModelCacheObservationFromRuntimeEvent({
        agentId: 'manager-1',
        descriptor: baseDescriptor,
        effectiveEvent: {
          type: 'message_end',
          message: {
            role: 'assistant',
            provider: 'openai',
            modelId: 'gpt-5',
            stopReason: 'toolUse',
            usage: { input_tokens: 3000, cache_read_input_tokens: 2500, output_tokens: 120 },
          },
        },
        runtime: { runtimeType: 'pi' } as never,
        timestamp: '2026-06-02T12:00:00.000Z',
        enabled: true,
      }),
    ).toBeNull()
  })

  it('captureModelCacheObservationFromRuntimeEvent uses message turnId for observation id', () => {
    const observation = captureModelCacheObservationFromRuntimeEvent({
      agentId: 'manager-1',
      descriptor: baseDescriptor,
      effectiveEvent: {
        type: 'message_end',
        message: {
          role: 'assistant',
          provider: 'openai',
          modelId: 'gpt-5',
          turnId: 'turn-abc',
          usage: { input_tokens: 3000, cache_read_input_tokens: 2500, output_tokens: 120 },
        },
      },
      runtime: { runtimeType: 'pi' } as never,
      timestamp: '2026-06-02T12:00:00.000Z',
      enabled: true,
    })

    expect(observation).toMatchObject({
      turnId: 'turn-abc',
      id: 'turn-abc',
    })
  })

  it('captureModelCacheObservationFromRuntimeEvent returns observation for eligible manager Pi assistant ends', () => {
    const observation = captureModelCacheObservationFromRuntimeEvent({
      agentId: 'manager-1',
      descriptor: baseDescriptor,
      effectiveEvent: {
        type: 'message_end',
        message: {
          role: 'assistant',
          provider: 'openai',
          modelId: 'gpt-5',
          usage: { input_tokens: 3000, cache_read_input_tokens: 2500, output_tokens: 120 },
        },
      },
      runtime: { runtimeType: 'pi' } as never,
      timestamp: '2026-06-02T12:00:00.000Z',
      enabled: true,
    })

    expect(observation).toMatchObject({
      type: 'model_cache_observation',
      agentId: 'manager-1',
      runtimeType: 'pi',
      provider: 'openai',
    })
  })
})
