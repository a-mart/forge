import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CountingBatchSpanProcessor } from '../counting-batch-span-processor.js'
import { ObservabilityRedactor } from '../observability-redaction.js'
import { createDefaultPhoenixObservabilitySettings } from '../observability-settings.js'
import {
  assertOtelPrimitiveAttributes,
  buildCommonOpenInferenceAttributes,
  buildModelCallAttributes,
  buildToolAttributes,
} from '../openinference-attributes.js'

afterEach(() => {
  vi.unstubAllEnvs()
})

class MockExporter implements SpanExporter {
  readonly batches: ReadableSpan[][] = []
  exportImpl: (spans: ReadableSpan[], callback: (result: { code: number; error?: Error }) => void) => void = (spans, callback) => {
    this.batches.push(spans)
    callback({ code: 0 })
  }
  shutdown = vi.fn(async () => undefined)
  forceFlush = vi.fn(async () => undefined)

  export(spans: ReadableSpan[], callback: (result: { code: number; error?: Error }) => void): void {
    this.exportImpl(spans, callback)
  }
}

describe('CountingBatchSpanProcessor', () => {
  it('exports accepted spans and records success counters', async () => {
    const exporter = new MockExporter()
    const processor = new CountingBatchSpanProcessor(exporter, {
      maxQueueSize: 4,
      maxExportBatchSize: 2,
      scheduledDelayMs: 10_000,
      exportTimeoutMs: 1000,
    })

    processor.onEnd({ name: 'one' } as ReadableSpan)
    processor.onEnd({ name: 'two' } as ReadableSpan)
    await processor.forceFlush()

    expect(exporter.batches).toHaveLength(1)
    expect(processor.getCounters()).toMatchObject({ accepted: 2, exportSucceeded: 1, exportFailed: 0 })
  })

  it('drops queue-full spans and records export failures without throwing', async () => {
    const exporter = new MockExporter()
    exporter.exportImpl = (_spans, callback) => callback({ code: 1, error: new Error('boom') })
    const processor = new CountingBatchSpanProcessor(exporter, {
      maxQueueSize: 1,
      maxExportBatchSize: 1,
      scheduledDelayMs: 10_000,
      exportTimeoutMs: 1000,
    })

    processor.onEnd({ name: 'one' } as ReadableSpan)
    processor.onEnd({ name: 'two' } as ReadableSpan)
    await expect(processor.forceFlush()).resolves.toBeUndefined()

    expect(processor.getCounters()).toMatchObject({ accepted: 1, droppedQueueFull: 1, exportFailed: 1 })
    expect(processor.getCounters().lastErrorMessage).toBe('boom')
  })

  it('does not accept spans after shutdown', async () => {
    const processor = new CountingBatchSpanProcessor(new MockExporter(), {
      maxQueueSize: 1,
      maxExportBatchSize: 1,
      scheduledDelayMs: 10_000,
      exportTimeoutMs: 1000,
    })

    await processor.shutdown()
    processor.onEnd({ name: 'late' } as ReadableSpan)

    expect(processor.getCounters()).toMatchObject({ accepted: 0, droppedQueueFull: 1 })
  })
})

describe('ObservabilityRedactor', () => {
  it('redacts secret-looking fields and caps long content', () => {
    const settings = createDefaultPhoenixObservabilitySettings()
    const redactor = new ObservabilityRedactor({ ...settings.privacy, maxContentChars: 80 })

    const result = redactor.redactAndCap({
      apiKey: 'sk-1234567890abcdef',
      nested: { password: 'secret' },
      text: Array.from({ length: 40 }, (_, index) => `long segment ${index}`).join(' '),
    })

    expect(result.value).toContain('[REDACTED]')
    expect(result.value).toContain('[TRUNCATED')
    expect(result.stats.redactionMatches).toBeGreaterThanOrEqual(2)
    expect(redactor.getStats().redactionMatches).toBeGreaterThanOrEqual(2)
    expect(result.stats.contentTruncations).toBe(1)
  })

  it('redacts POSIX and Windows paths according to basename-and-hash mode', () => {
    const redactor = new ObservabilityRedactor()
    expect(redactor.redactPath('/Users/adam/.forge/auth.json')).toMatch(/^auth\.json#[a-f0-9]{16}$/)
    expect(redactor.redactPath('C:\\Users\\Adam\\.forge\\auth.json')).toMatch(/^auth\.json#[a-f0-9]{16}$/)
  })

  it('redacts Windows USERPROFILE paths case-insensitively in raw path mode', () => {
    vi.stubEnv('USERPROFILE', 'C:\\Users\\Adam')
    const settings = createDefaultPhoenixObservabilitySettings()
    const redactor = new ObservabilityRedactor({ ...settings.privacy, pathMode: 'raw' })

    expect(redactor.redactPath('c:\\users\\adam\\.forge\\auth.json')).toBe('~\\.forge\\auth.json')
    expect(redactor.redactPath('C:/USERS/ADAM/.forge/auth.json')).toBe('~/.forge/auth.json')
    expect(redactor.redactPath('C:\\Users\\Adam\\.forge\\auth.json')).toBe('~\\.forge\\auth.json')
  })
})

describe('OpenInference attributes', () => {
  it('flattens useful attributes to OpenTelemetry primitive values only', () => {
    const redactor = new ObservabilityRedactor()
    const attrs = {
      ...buildCommonOpenInferenceAttributes({
        spanKind: 'LLM',
        input: { role: 'user', content: 'hello' },
        output: 'world',
        sessionId: 'session-1',
        userId: 'profile-1',
        metadata: { runtime: 'pi' },
        tags: ['forge', 'test'],
        agentName: 'Manager',
        graphNodeId: 'manager-1',
      }, redactor),
      ...buildModelCallAttributes({
        modelId: 'gpt-5.4',
        provider: 'openai',
        finishReason: 'stop',
        invocationParameters: { temperature: 0 },
        usage: { input: 10, output: 4, total: 14 },
        costUsd: { total: 0.01 },
      }, redactor),
      ...buildToolAttributes({ name: 'read', description: 'Read file', jsonSchema: { type: 'object' } }, redactor),
    }

    expect(() => assertOtelPrimitiveAttributes(attrs)).not.toThrow()
    expect(attrs['session.id']).toMatch(/^[a-f0-9]{16}$/)
    expect(attrs['session.id']).not.toBe('session-1')
    expect(attrs['user.id']).not.toBe('profile-1')
    expect(attrs['agent.name']).toMatch(/^display#[a-f0-9]{16}$/)
    expect(attrs['agent.name']).not.toBe('Manager')
    expect(attrs['graph.node.id']).not.toBe('manager-1')
    expect(attrs['llm.token_count.total']).toBe(14)
    expect(attrs['tool.json_schema']).toBe('{"type":"object"}')
  })

  it('sanitizes and caps model and tool strings while tracking redaction stats', () => {
    const settings = createDefaultPhoenixObservabilitySettings()
    const redactor = new ObservabilityRedactor({ ...settings.privacy, maxAttributeChars: 120 })
    const attrs = {
      ...buildModelCallAttributes({
        modelId: `sk-1234567890abcdef ${Array.from({ length: 20 }, (_, index) => `model segment ${index}`).join(' ')}`,
        provider: 'openai',
      }, redactor),
      ...buildToolAttributes({ name: `tool ${Array.from({ length: 20 }, (_, index) => `segment ${index}`).join(' ')}` }, redactor),
    }

    expect(attrs['llm.model_name']).toContain('[REDACTED]')
    expect(attrs['llm.model_name']).toContain('[TRUNCATED')
    expect(String(attrs['tool.name'])).toContain('[TRUNCATED')
    expect(redactor.getStats().redactionMatches).toBeGreaterThan(0)
    expect(redactor.getStats().contentTruncations).toBeGreaterThan(0)
  })
})
