import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CountingBatchSpanProcessor } from '../counting-batch-span-processor.js'
import { ObservabilityRedactor } from '../observability-redaction.js'
import { createDefaultPhoenixObservabilitySettings } from '../observability-settings.js'
import { PhoenixOtlpExporter } from '../phoenix-otlp-exporter.js'
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

  it('sanitizes path-bearing metadata centrally according to pathMode', () => {
    const settings = createDefaultPhoenixObservabilitySettings()
    const redactor = new ObservabilityRedactor(settings.privacy)
    const value = redactor.sanitizeAttributeValue({
      cwd: '/Users/adam/repos/middleman-phoenix-observability',
      memoryFile: '/Users/adam/.forge/profiles/profile-1/memory.md',
      stateRoot: 'C:\\Users\\Adam\\.forge\\cursor-state',
      ordinary: 'not-a-path-value',
    })

    expect(value).not.toContain('/Users/adam')
    expect(value).not.toContain('C:\\Users\\Adam')
    expect(value).toContain('middleman-phoenix-observability#')
    expect(value).toContain('memory.md#')
    expect(value).toContain('cursor-state#')
    expect(value).toContain('not-a-path-value')
    expect(redactor.getStats().redactionMatches).toBeGreaterThanOrEqual(3)
  })

  it('fully redacts path-bearing metadata when pathMode is redacted', () => {
    const settings = createDefaultPhoenixObservabilitySettings()
    const redactor = new ObservabilityRedactor({ ...settings.privacy, pathMode: 'redacted' })
    const value = redactor.sanitizeAttributeValue({
      cwd: '/Users/adam/repos/middleman-phoenix-observability',
      memoryFile: '/Users/adam/.forge/profiles/profile-1/memory.md',
      stateRoot: 'C:\\Users\\Adam\\.forge\\cursor-state',
    })

    expect(value).not.toContain('/Users/adam')
    expect(value).not.toContain('C:\\Users\\Adam')
    expect(value.match(/\[REDACTED_PATH\]/g)).toHaveLength(3)
  })
})

describe('PhoenixOtlpExporter', () => {
  it('does not export raw runtime-created path metadata under default path mode', async () => {
    const spanExporter = new MockExporter()
    const settings = { ...createDefaultPhoenixObservabilitySettings(), enabled: true }
    const exporter = new PhoenixOtlpExporter({ settings, spanExporter })

    exporter.recordPromptResolved({
      agentId: 'worker-1',
      managerId: 'manager-1',
      profileId: 'profile-1',
      role: 'worker',
      runtimeType: 'cursor-sdk',
      runtimeToken: 7,
      source: 'runtime_final',
      prompt: 'runtime prompt',
      cwd: '/Users/adam/repos/middleman-phoenix-observability',
      metadata: { memoryFile: '/Users/adam/.forge/profiles/profile-1/memory.md' },
    })
    exporter.recordRuntimeCreated({
      agentId: 'worker-1',
      managerId: 'manager-1',
      profileId: 'profile-1',
      role: 'worker',
      runtimeType: 'cursor-sdk',
      runtimeToken: 7,
      status: 'ready',
      cwd: '/Users/adam/repos/middleman-phoenix-observability',
      modelProvider: 'cursor-sdk',
      modelId: 'composer-2.5',
      finalSystemPrompt: 'runtime prompt',
      metadata: {
        memoryFile: '/Users/adam/.forge/profiles/profile-1/memory.md',
        stateRoot: 'C:\\Users\\Adam\\.forge\\cursor-state',
      },
    })
    await exporter.forceFlush()
    await exporter.shutdown()

    const span = spanExporter.batches.flat().find((entry) => entry.name === 'forge.runtime.create')
    expect(span).toBeDefined()
    const metadata = String(span?.attributes.metadata)
    expect(metadata).not.toContain('/Users/adam')
    expect(metadata).not.toContain('C:\\Users\\Adam')
    expect(metadata).toContain('middleman-phoenix-observability#')
    expect(metadata).toContain('memory.md#')
    expect(metadata).toContain('cursor-state#')
    const promptSpan = spanExporter.batches.flat().find((entry) => entry.name === 'forge.prompt.resolve')
    const promptMetadata = String(promptSpan?.attributes.metadata)
    expect(promptMetadata).not.toContain('/Users/adam')
    expect(promptMetadata).toContain('middleman-phoenix-observability#')
    expect(promptMetadata).toContain('memory.md#')
  })

  it('exports root runtime turn and child LLM spans with provider metadata', async () => {
    const spanExporter = new MockExporter()
    const settings = { ...createDefaultPhoenixObservabilitySettings(), enabled: true }
    const exporter = new PhoenixOtlpExporter({ settings, spanExporter })

    exporter.recordRuntimeCreated({
      agentId: 'manager-1',
      managerId: 'manager-1',
      profileId: 'profile-1',
      role: 'manager',
      runtimeType: 'pi',
      runtimeToken: 3,
      status: 'ready',
      activeTools: [{ name: 'speak_to_user', description: 'Reply to user', jsonSchema: { type: 'object' } }],
    })
    exporter.recordRuntimeInput({
      targetAgentId: 'manager-1',
      managerId: 'manager-1',
      profileId: 'profile-1',
      role: 'manager',
      runtimeType: 'pi',
      runtimeToken: 3,
      rootSource: 'user_input',
      originalInput: 'visible user text',
      runtimeInput: 'runtime user text with guidance',
      visibleMessageId: 'message-1',
      requestedDelivery: 'steer',
      acceptedMode: 'prompt',
      sourceChannel: 'web',
    })
    exporter.recordRuntimeSessionEvent({
      agentId: 'manager-1',
      managerId: 'manager-1',
      profileId: 'profile-1',
      role: 'manager',
      runtimeType: 'pi',
      runtimeToken: 3,
      event: { type: 'message_start', message: { role: 'user', content: 'runtime user text with guidance' } },
    })
    exporter.recordRuntimeSessionEvent({
      agentId: 'manager-1',
      managerId: 'manager-1',
      profileId: 'profile-1',
      role: 'manager',
      runtimeType: 'pi',
      runtimeToken: 3,
      event: { type: 'message_start', message: { role: 'assistant', content: '' } },
    })
    exporter.recordRuntimeSessionEvent({
      agentId: 'manager-1',
      managerId: 'manager-1',
      profileId: 'profile-1',
      role: 'manager',
      runtimeType: 'pi',
      runtimeToken: 3,
      event: { type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } },
    })
    exporter.recordRuntimeSessionEvent({
      agentId: 'manager-1',
      managerId: 'manager-1',
      profileId: 'profile-1',
      role: 'manager',
      runtimeType: 'pi',
      runtimeToken: 3,
      event: {
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] },
        meta: {
          provider: 'openai-codex',
          modelId: 'gpt-5.4',
          responseModelId: 'gpt-5.4-actual',
          stopReason: 'stop',
          providerRequestId: 'resp-123',
          usage: { input: 10, output: 4, cacheRead: 2, total: 16 },
          costUsd: { total: 0.01 },
          requestPayloadFidelity: 'partial',
          requestMessages: [{ role: 'user', content: 'runtime user text with guidance' }],
        },
      },
    })
    exporter.recordRuntimeSessionEvent({
      agentId: 'manager-1',
      managerId: 'manager-1',
      profileId: 'profile-1',
      role: 'manager',
      runtimeType: 'pi',
      runtimeToken: 3,
      event: { type: 'turn_end', toolResults: [] },
    })
    await exporter.forceFlush()
    await exporter.shutdown()

    const spans = spanExporter.batches.flat()
    const root = spans.find((entry) => entry.name === 'forge.session.turn')
    const turn = spans.find((entry) => entry.name === 'forge.runtime.turn')
    const llm = spans.find((entry) => entry.name === 'forge.llm.call')
    expect(root).toBeDefined()
    expect(turn?.parentSpanContext?.spanId).toBe(root?.spanContext().spanId)
    expect(llm?.parentSpanContext?.spanId).toBe(turn?.spanContext().spanId)
    expect(root?.attributes['session.id']).toBeDefined()
    expect(llm?.attributes['llm.model_name']).toBe('gpt-5.4-actual')
    expect(llm?.attributes['llm.provider']).toBe('openai-codex')
    expect(llm?.attributes['llm.token_count.prompt']).toBe(10)
    expect(llm?.attributes['llm.token_count.completion']).toBe(4)
    expect(llm?.attributes['llm.token_count.prompt_details.cache_read']).toBe(2)
    expect(llm?.attributes['llm.token_count.total']).toBe(16)
    expect(llm?.attributes['llm.cost.total']).toBe(0.01)
    expect(llm?.attributes['llm.finish_reason']).toBe('stop')
    expect(llm?.attributes['llm.tools']).toContain('speak_to_user')
    expect(llm?.attributes['forge.ttft_ms']).toEqual(expect.any(Number))
    expect(String(llm?.attributes['llm.input_messages'])).toContain('runtime user text with guidance')
  })

  it('evicts pending runtime-input correlations when per-agent caps are exceeded', async () => {
    const spanExporter = new MockExporter()
    const settings = { ...createDefaultPhoenixObservabilitySettings(), enabled: true }
    const exporter = new PhoenixOtlpExporter({ settings, spanExporter })

    for (let index = 0; index < 17; index += 1) {
      exporter.beginRuntimeInput({
        targetAgentId: 'manager-1',
        managerId: 'manager-1',
        runtimeType: 'pi',
        runtimeToken: 1,
        rootSource: 'user_input',
        runtimeInput: `pending ${index}`,
      })
    }

    expect(exporter.getStatus().correlationEvictions).toBe(1)
    exporter.recordRuntimeSessionEvent({
      agentId: 'manager-1',
      managerId: 'manager-1',
      runtimeType: 'pi',
      runtimeToken: 1,
      event: { type: 'message_start', message: { role: 'user', content: 'pending 0' } },
    })
    exporter.recordRuntimeSessionEvent({
      agentId: 'manager-1',
      managerId: 'manager-1',
      runtimeType: 'pi',
      runtimeToken: 1,
      event: { type: 'message_start', message: { role: 'user', content: 'pending 16' } },
    })
    exporter.recordRuntimeSessionEvent({
      agentId: 'manager-1',
      managerId: 'manager-1',
      runtimeType: 'pi',
      runtimeToken: 1,
      event: { type: 'turn_end', toolResults: [] },
    })
    await exporter.forceFlush()
    await exporter.shutdown()

    const spans = spanExporter.batches.flat()
    expect(spans.some((entry) => entry.attributes['forge.correlation_status'] === 'pending_runtime_input_agent_cap_evicted')).toBe(true)
  })

  it('does not let a stale runtime token consume a pending runtime input', async () => {
    const spanExporter = new MockExporter()
    const settings = { ...createDefaultPhoenixObservabilitySettings(), enabled: true }
    const exporter = new PhoenixOtlpExporter({ settings, spanExporter })

    exporter.recordRuntimeInput({
      targetAgentId: 'manager-1',
      managerId: 'manager-1',
      runtimeType: 'pi',
      runtimeToken: 2,
      rootSource: 'user_input',
      runtimeInput: 'fresh turn',
    })
    expect(exporter.recordRuntimeSessionEvent({
      agentId: 'manager-1',
      managerId: 'manager-1',
      runtimeType: 'pi',
      runtimeToken: 1,
      event: { type: 'message_start', message: { role: 'user', content: 'fresh turn' } },
    }).correlationMisses).toBe(0)
    exporter.recordRuntimeSessionEvent({
      agentId: 'manager-1',
      managerId: 'manager-1',
      runtimeType: 'pi',
      runtimeToken: 2,
      event: { type: 'message_start', message: { role: 'user', content: 'fresh turn' } },
    })
    exporter.recordRuntimeSessionEvent({
      agentId: 'manager-1',
      managerId: 'manager-1',
      runtimeType: 'pi',
      runtimeToken: 2,
      event: { type: 'message_start', message: { role: 'assistant', content: '' } },
    })
    exporter.recordRuntimeSessionEvent({
      agentId: 'manager-1',
      managerId: 'manager-1',
      runtimeType: 'pi',
      runtimeToken: 2,
      event: { type: 'message_end', message: { role: 'assistant', content: 'ok' } },
    })
    exporter.recordRuntimeSessionEvent({
      agentId: 'manager-1',
      managerId: 'manager-1',
      runtimeType: 'pi',
      runtimeToken: 2,
      event: { type: 'turn_end', toolResults: [] },
    })
    await exporter.forceFlush()
    await exporter.shutdown()

    const spans = spanExporter.batches.flat()
    expect(spans.filter((entry) => entry.name === 'forge.session.turn')).toHaveLength(1)
    expect(spans.filter((entry) => entry.name === 'forge.runtime.turn')).toHaveLength(1)
    expect(spans.filter((entry) => entry.name === 'forge.llm.call')).toHaveLength(1)
  })

  it('fully redacts runtime-created path metadata when pathMode is redacted', async () => {
    const spanExporter = new MockExporter()
    const settings = {
      ...createDefaultPhoenixObservabilitySettings(),
      enabled: true,
      privacy: { ...createDefaultPhoenixObservabilitySettings().privacy, pathMode: 'redacted' as const },
    }
    const exporter = new PhoenixOtlpExporter({ settings, spanExporter })

    exporter.recordPromptResolved({
      agentId: 'worker-1',
      managerId: 'manager-1',
      profileId: 'profile-1',
      role: 'worker',
      runtimeType: 'cursor-sdk',
      runtimeToken: 7,
      source: 'runtime_final',
      prompt: 'runtime prompt',
      cwd: '/Users/adam/repos/middleman-phoenix-observability',
      metadata: { memoryFile: '/Users/adam/.forge/profiles/profile-1/memory.md' },
    })
    exporter.recordRuntimeCreated({
      agentId: 'worker-1',
      managerId: 'manager-1',
      profileId: 'profile-1',
      role: 'worker',
      runtimeType: 'cursor-sdk',
      runtimeToken: 7,
      status: 'ready',
      cwd: '/Users/adam/repos/middleman-phoenix-observability',
      metadata: {
        memoryFile: '/Users/adam/.forge/profiles/profile-1/memory.md',
        stateRoot: 'C:\\Users\\Adam\\.forge\\cursor-state',
      },
    })
    await exporter.forceFlush()
    await exporter.shutdown()

    const span = spanExporter.batches.flat().find((entry) => entry.name === 'forge.runtime.create')
    const metadata = String(span?.attributes.metadata)
    expect(metadata).not.toContain('/Users/adam')
    expect(metadata).not.toContain('C:\\Users\\Adam')
    expect(metadata.match(/\[REDACTED_PATH\]/g)).toHaveLength(3)
    const promptSpan = spanExporter.batches.flat().find((entry) => entry.name === 'forge.prompt.resolve')
    const promptMetadata = String(promptSpan?.attributes.metadata)
    expect(promptMetadata).not.toContain('/Users/adam')
    expect(promptMetadata.match(/\[REDACTED_PATH\]/g)).toHaveLength(2)
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
