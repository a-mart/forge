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

  it('exports runtime tool spans once and isolates reused tool ids by runtime token', async () => {
    const spanExporter = new MockExporter()
    const settings = { ...createDefaultPhoenixObservabilitySettings(), enabled: true }
    const exporter = new PhoenixOtlpExporter({ settings, spanExporter })

    for (const runtimeToken of [21, 22]) {
      exporter.recordRuntimeCreated({
        agentId: 'manager-1',
        managerId: 'manager-1',
        runtimeType: 'pi',
        runtimeToken,
        status: 'ready',
        activeTools: [{ name: 'speak_to_user', description: 'Publish response', jsonSchema: { type: 'object' } }],
      })
      exporter.recordRuntimeInput({
        targetAgentId: 'manager-1',
        managerId: 'manager-1',
        runtimeType: 'pi',
        runtimeToken,
        rootSource: 'user_input',
        runtimeInput: `turn ${runtimeToken}`,
      })
      exporter.recordRuntimeSessionEvent({
        agentId: 'manager-1',
        managerId: 'manager-1',
        runtimeType: 'pi',
        runtimeToken,
        event: { type: 'message_start', message: { role: 'user', content: `turn ${runtimeToken}` } },
      })
      exporter.recordRuntimeSessionEvent({
        agentId: 'manager-1',
        managerId: 'manager-1',
        runtimeType: 'pi',
        runtimeToken,
        event: { type: 'tool_execution_start', toolName: 'speak_to_user', toolCallId: 'tool-1', args: { text: `hello ${runtimeToken}` } },
      })
      exporter.recordRuntimeSessionEvent({
        agentId: 'manager-1',
        managerId: 'manager-1',
        runtimeType: 'pi',
        runtimeToken,
        event: { type: 'tool_execution_start', toolName: 'speak_to_user', toolCallId: 'tool-1', args: { text: 'duplicate ignored' } },
      })
      exporter.recordRuntimeSessionEvent({
        agentId: 'manager-1',
        managerId: 'manager-1',
        runtimeType: 'pi',
        runtimeToken,
        event: { type: 'tool_execution_update', toolName: 'speak_to_user', toolCallId: 'tool-1', partialResult: { queued: true } },
      })
      exporter.recordToolSideEffect({
        agentId: 'manager-1',
        managerId: 'manager-1',
        runtimeType: 'pi',
        runtimeToken,
        toolName: 'speak_to_user',
        toolCallId: 'tool-1',
        phase: 'before',
        input: { text: `hello ${runtimeToken}` },
        output: { input: { text: `hello ${runtimeToken}` } },
        metadata: { source: 'forge_extension_hook' },
      })
      exporter.recordToolSideEffect({
        agentId: 'manager-1',
        managerId: 'manager-1',
        runtimeType: 'pi',
        runtimeToken,
        toolName: 'speak_to_user',
        toolCallId: 'tool-1',
        phase: 'before',
        input: { text: 'DUPLICATE_HOOK_INPUT' },
        output: { input: { text: 'DUPLICATE_HOOK_OUTPUT' } },
        metadata: { source: 'forge_pi_tool_bridge' },
      })
      exporter.recordToolSideEffect({
        agentId: 'manager-1',
        managerId: 'manager-1',
        runtimeType: 'pi',
        runtimeToken,
        toolName: 'speak_to_user',
        toolCallId: 'tool-1',
        phase: 'side_effect',
        input: { text: `hello ${runtimeToken}` },
        output: { targetContext: { channel: 'web' } },
        userVisible: true,
        metadata: { targetChannel: 'web' },
      })
      exporter.recordRuntimeSessionEvent({
        agentId: 'manager-1',
        managerId: 'manager-1',
        runtimeType: 'pi',
        runtimeToken,
        event: { type: 'tool_execution_end', toolName: 'speak_to_user', toolCallId: 'tool-1', result: { published: true }, isError: false },
      })
      exporter.recordRuntimeSessionEvent({
        agentId: 'manager-1',
        managerId: 'manager-1',
        runtimeType: 'pi',
        runtimeToken,
        event: { type: 'turn_end', toolResults: [] },
      })
    }

    await exporter.forceFlush()
    await exporter.shutdown()

    const spans = spanExporter.batches.flat()
    const tools = spans.filter((entry) => entry.name === 'forge.tool.speak_to_user')
    expect(tools).toHaveLength(2)
    expect(tools.every((entry) => entry.parentSpanContext?.spanId)).toBe(true)
    expect(tools.every((entry) => entry.attributes['openinference.span.kind'] === 'TOOL')).toBe(true)
    expect(tools.every((entry) => entry.attributes['tool.name'] === 'speak_to_user')).toBe(true)
    expect(tools.every((entry) => entry.attributes['tool.json_schema'] === '{"type":"object"}')).toBe(true)
    expect(tools.every((entry) => entry.attributes['forge.user_visible'] === true)).toBe(true)
    expect(tools.every((entry) => entry.events.some((event) => event.name === 'forge.tool.before'))).toBe(true)
    expect(tools.every((entry) => entry.events.some((event) => event.name === 'forge.tool.duplicate_enrichment'))).toBe(true)
    expect(tools.every((entry) => entry.events.some((event) => event.name === 'forge.tool.side_effect'))).toBe(true)
    const userOutputs = spans.filter((entry) => entry.name === 'forge.user.output')
    expect(userOutputs).toHaveLength(2)
    expect(userOutputs.every((entry) => tools.some((tool) => tool.spanContext().spanId === entry.parentSpanContext?.spanId))).toBe(true)
    const serializedTools = JSON.stringify(tools.map((entry) => ({ attributes: entry.attributes, events: entry.events })))
    expect(serializedTools).not.toContain('duplicate ignored')
    expect(serializedTools).not.toContain('DUPLICATE_HOOK')
  })

  it('correlates manager turns when runtime callback tokens drift from the pending input token', async () => {
    const spanExporter = new MockExporter()
    const settings = { ...createDefaultPhoenixObservabilitySettings(), enabled: true }
    const exporter = new PhoenixOtlpExporter({ settings, spanExporter })

    exporter.recordRuntimeCreated({
      agentId: 'manager-1',
      managerId: 'manager-1',
      runtimeType: 'pi',
      runtimeToken: 3,
      status: 'ready',
      activeTools: [{ name: 'speak_to_user', description: 'Publish response', jsonSchema: { type: 'object' } }],
    })
    exporter.recordRuntimeInput({
      targetAgentId: 'manager-1',
      managerId: 'manager-1',
      runtimeType: 'pi',
      runtimeToken: 3,
      rootSource: 'user_input',
      runtimeInput: 'runtime user text',
    })

    const startResult = exporter.recordRuntimeSessionEvent({
      agentId: 'manager-1',
      managerId: 'manager-1',
      runtimeType: 'pi',
      runtimeToken: 4,
      event: { type: 'message_start', message: { role: 'assistant', content: '' } },
    })
    expect(startResult.correlationMisses).toBe(0)
    expect(startResult.started).toBe(2)

    exporter.recordRuntimeSessionEvent({
      agentId: 'manager-1',
      managerId: 'manager-1',
      runtimeType: 'pi',
      runtimeToken: 4,
      event: {
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }] },
        meta: { provider: 'openai-codex', modelId: 'gpt-5.4', usage: { input: 5, output: 2, total: 7 } },
      },
    })
    exporter.recordRuntimeSessionEvent({
      agentId: 'manager-1',
      managerId: 'manager-1',
      runtimeType: 'pi',
      runtimeToken: 4,
      event: { type: 'tool_execution_start', toolName: 'speak_to_user', toolCallId: 'tool-1', args: { text: 'Done' } },
    })

    const sideEffectResult = exporter.recordToolSideEffect({
      agentId: 'manager-1',
      managerId: 'manager-1',
      runtimeType: 'pi',
      runtimeToken: 3,
      toolName: 'speak_to_user',
      toolCallId: 'tool-1',
      phase: 'side_effect',
      input: { text: 'Done' },
      output: { targetContext: { channel: 'web' } },
      userVisible: true,
    })
    expect(sideEffectResult.correlationMisses).toBe(0)

    exporter.recordRuntimeSessionEvent({
      agentId: 'manager-1',
      managerId: 'manager-1',
      runtimeType: 'pi',
      runtimeToken: 4,
      event: { type: 'tool_execution_end', toolName: 'speak_to_user', toolCallId: 'tool-1', result: { published: true }, isError: false },
    })
    const endResult = exporter.recordRuntimeSessionEvent({
      agentId: 'manager-1',
      managerId: 'manager-1',
      runtimeType: 'pi',
      runtimeToken: 4,
      event: { type: 'turn_end', toolResults: [] },
    })
    expect(endResult.correlationMisses).toBe(0)

    await exporter.forceFlush()
    await exporter.shutdown()

    const spans = spanExporter.batches.flat()
    expect(spans.some((entry) => entry.name === 'forge.session.turn')).toBe(true)
    expect(spans.some((entry) => entry.name === 'forge.runtime.turn')).toBe(true)
    expect(spans.some((entry) => entry.name === 'forge.llm.call')).toBe(true)
    expect(spans.some((entry) => entry.name === 'forge.tool.speak_to_user')).toBe(true)
    expect(spans.some((entry) => entry.name === 'forge.user.output')).toBe(true)
  })

  it('closes active Pi turns on agent_end when turn_end is missing', async () => {
    const spanExporter = new MockExporter()
    const settings = { ...createDefaultPhoenixObservabilitySettings(), enabled: true }
    const exporter = new PhoenixOtlpExporter({ settings, spanExporter })

    exporter.recordRuntimeInput({
      targetAgentId: 'manager-1',
      managerId: 'manager-1',
      runtimeType: 'pi',
      runtimeToken: 8,
      rootSource: 'user_input',
      runtimeInput: 'live manager turn',
    })
    exporter.recordRuntimeSessionEvent({
      agentId: 'manager-1',
      managerId: 'manager-1',
      runtimeType: 'pi',
      runtimeToken: 8,
      event: { type: 'message_start', message: { role: 'assistant', content: '' } },
    })
    exporter.recordRuntimeSessionEvent({
      agentId: 'manager-1',
      managerId: 'manager-1',
      runtimeType: 'pi',
      runtimeToken: 8,
      event: {
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'fallback close' }] },
        meta: { provider: 'openai-codex', modelId: 'gpt-5.4' },
      },
    })
    exporter.recordRuntimeSessionEvent({
      agentId: 'manager-1',
      managerId: 'manager-1',
      runtimeType: 'pi',
      runtimeToken: 8,
      event: { type: 'tool_execution_start', toolName: 'speak_to_user', toolCallId: 'tool-fallback', args: { text: 'fallback close' } },
    })

    const endResult = exporter.recordRuntimeSessionEvent({
      agentId: 'manager-1',
      managerId: 'manager-1',
      runtimeType: 'pi',
      runtimeToken: 8,
      event: { type: 'agent_end' },
    })
    expect(endResult.ended).toBe(4)
    expect(endResult.correlationMisses).toBe(0)

    await exporter.forceFlush()
    await exporter.shutdown()

    const spans = spanExporter.batches.flat()
    expect(spans.some((entry) => entry.name === 'forge.session.turn')).toBe(true)
    expect(spans.some((entry) => entry.name === 'forge.runtime.turn')).toBe(true)
    expect(spans.some((entry) => entry.name === 'forge.llm.call')).toBe(true)
    const tool = spans.find((entry) => entry.name === 'forge.tool.speak_to_user')
    expect(tool?.attributes['forge.correlation_status']).toBe('runtime_agent_ended_without_turn_end')
  })

  it('exports dedicated agent delivery spans under the top-level parent root and marks unresolved fallback', async () => {
    const spanExporter = new MockExporter()
    const settings = { ...createDefaultPhoenixObservabilitySettings(), enabled: true }
    const exporter = new PhoenixOtlpExporter({ settings, spanExporter })

    const managerRoot = exporter.beginRuntimeInput({
      targetAgentId: 'manager-1',
      managerId: 'manager-1',
      runtimeType: 'pi',
      runtimeToken: 51,
      rootSource: 'user_input',
      runtimeInput: 'top-level user request',
    })
    exporter.recordRuntimeSessionEvent({
      agentId: 'manager-1',
      managerId: 'manager-1',
      runtimeType: 'pi',
      runtimeToken: 51,
      event: { type: 'message_start', message: { role: 'user', content: 'top-level user request' } },
    })
    const workerRoot = exporter.beginRuntimeInput({
      targetAgentId: 'worker-1',
      managerId: 'manager-1',
      role: 'worker',
      runtimeType: 'pi',
      runtimeToken: 52,
      rootSource: 'internal_agent_message',
      rootTurnId: 'worker-child-root',
      parentRootTurnId: managerRoot.rootTurnId,
      runtimeInput: 'worker task',
    })
    exporter.recordAgentDelivery({
      fromAgentId: 'manager-1',
      targetAgentId: 'worker-1',
      managerId: 'manager-1',
      rootTurnId: workerRoot.rootTurnId,
      parentRootTurnId: managerRoot.rootTurnId,
      message: 'visible worker task',
      runtimeInput: 'worker task',
      requestedDelivery: 'auto',
      acceptedMode: 'prompt',
      deliveryId: 'delivery-worker',
      source: 'internal',
      metadata: { parentRootSemantics: 'top_level_root_turn' },
    })
    exporter.recordRuntimeSessionEvent({
      agentId: 'worker-1',
      managerId: 'manager-1',
      role: 'worker',
      runtimeType: 'pi',
      runtimeToken: 52,
      event: { type: 'message_start', message: { role: 'user', content: 'worker task' } },
    })
    exporter.recordRuntimeSessionEvent({
      agentId: 'manager-1',
      managerId: 'manager-1',
      runtimeType: 'pi',
      runtimeToken: 51,
      event: { type: 'turn_end', toolResults: [] },
    })
    exporter.recordAgentDelivery({
      fromAgentId: 'worker-1',
      targetAgentId: 'manager-1',
      managerId: 'manager-1',
      rootTurnId: 'worker-report-root',
      parentRootTurnId: managerRoot.rootTurnId,
      message: 'worker report after manager turn ended',
      runtimeInput: 'worker report runtime input',
      requestedDelivery: 'auto',
      acceptedMode: 'prompt',
      deliveryId: 'delivery-worker-report',
      source: 'internal',
      metadata: { parentRootSemantics: 'top_level_root_turn', report: true },
    })
    const projectRoot = exporter.beginRuntimeInput({
      targetAgentId: 'project-agent-1',
      managerId: 'project-agent-1',
      runtimeType: 'pi',
      runtimeToken: 53,
      rootSource: 'project_agent',
      rootTurnId: 'project-agent-child-root',
      parentRootTurnId: managerRoot.rootTurnId,
      runtimeInput: 'project runtime message after parent turn ended',
    })
    exporter.recordAgentDelivery({
      fromAgentId: 'manager-1',
      targetAgentId: 'project-agent-1',
      managerId: 'project-agent-1',
      rootTurnId: projectRoot.rootTurnId,
      parentRootTurnId: managerRoot.rootTurnId,
      message: 'project visible message after parent turn ended',
      runtimeInput: 'project runtime message after parent turn ended',
      requestedDelivery: 'auto',
      acceptedMode: 'prompt',
      deliveryId: 'delivery-project-after-end',
      source: 'project_agent',
      metadata: { projectAgentExternal: false, parentRootSemantics: 'top_level_root_turn' },
    })
    exporter.recordAgentDelivery({
      fromAgentId: 'orphan-1',
      targetAgentId: 'worker-2',
      message: 'orphan task',
      requestedDelivery: 'auto',
      deliveryId: 'delivery-orphan',
      source: 'internal',
    })
    exporter.cancelRuntimeInput(workerRoot, 'test_done')
    exporter.cancelRuntimeInput(projectRoot, 'test_done')
    await exporter.forceFlush()
    await exporter.shutdown()

    const spans = spanExporter.batches.flat()
    const managerRootSpan = spans.find((entry) => entry.name === 'forge.session.turn' && String(entry.attributes['input.value']).includes('top-level user request'))
    const deliverySpans = spans.filter((entry) => entry.name === 'forge.agent.delivery')
    expect(deliverySpans).toHaveLength(4)
    const resolved = deliverySpans.filter((entry) => String(entry.attributes.metadata).includes('top_level_root_turn'))
    expect(resolved).toHaveLength(3)
    expect(resolved.every((entry) => entry.parentSpanContext?.spanId === managerRootSpan?.spanContext().spanId)).toBe(true)
    expect(resolved.some((entry) => String(entry.attributes.metadata).includes('resolved_retained_root'))).toBe(true)
    expect(resolved.some((entry) => String(entry.attributes.metadata).includes('delivery-worker-report'))).toBe(true)
    expect(resolved.some((entry) => String(entry.attributes.metadata).includes('delivery-project-after-end'))).toBe(true)
    const unresolved = deliverySpans.find((entry) => String(entry.attributes.metadata).includes('unresolved'))
    expect(unresolved?.parentSpanContext).toBeUndefined()
    expect(String(unresolved?.attributes.metadata)).toContain('delivery-orphan')
  })

  it('exports one send-message delivery span parented under the active tool correlation context', async () => {
    const spanExporter = new MockExporter()
    const settings = { ...createDefaultPhoenixObservabilitySettings(), enabled: true }
    const exporter = new PhoenixOtlpExporter({ settings, spanExporter })

    exporter.recordRuntimeInput({
      targetAgentId: 'manager-1',
      managerId: 'manager-1',
      runtimeType: 'pi',
      runtimeToken: 41,
      rootSource: 'user_input',
      runtimeInput: 'delegate',
    })
    exporter.recordRuntimeSessionEvent({
      agentId: 'manager-1',
      managerId: 'manager-1',
      runtimeType: 'pi',
      runtimeToken: 41,
      event: { type: 'message_start', message: { role: 'user', content: 'delegate' } },
    })
    exporter.recordRuntimeSessionEvent({
      agentId: 'manager-1',
      managerId: 'manager-1',
      runtimeType: 'pi',
      runtimeToken: 41,
      event: { type: 'tool_execution_start', toolName: 'send_message_to_agent', toolCallId: 'deliver-1', args: { targetAgentId: 'worker-1', message: 'do work' } },
    })
    exporter.recordToolSideEffect({
      agentId: 'manager-1',
      managerId: 'manager-1',
      runtimeType: 'pi',
      runtimeToken: 41,
      toolName: 'send_message_to_agent',
      toolCallId: 'deliver-1',
      phase: 'side_effect',
      input: { targetAgentId: 'worker-1', message: 'do work' },
      output: { targetAgentId: 'worker-1', deliveryId: 'delivery-1', acceptedMode: 'prompt' },
      metadata: { targetAgentId: 'worker-1', deliveryId: 'delivery-1', acceptedMode: 'prompt' },
    })
    exporter.recordAgentDelivery({
      fromAgentId: 'manager-1',
      targetAgentId: 'worker-1',
      managerId: 'manager-1',
      rootTurnId: 'worker-delivery-root',
      message: 'do work',
      runtimeInput: 'do work',
      requestedDelivery: 'auto',
      acceptedMode: 'prompt',
      deliveryId: 'delivery-1',
      source: 'internal',
      parentTool: { agentId: 'manager-1', runtimeToken: 41, toolCallId: 'deliver-1', toolName: 'send_message_to_agent' },
    })
    exporter.recordRuntimeSessionEvent({
      agentId: 'manager-1',
      managerId: 'manager-1',
      runtimeType: 'pi',
      runtimeToken: 41,
      event: { type: 'tool_execution_end', toolName: 'send_message_to_agent', toolCallId: 'deliver-1', result: { targetAgentId: 'worker-1' }, isError: false },
    })
    exporter.recordRuntimeSessionEvent({
      agentId: 'manager-1',
      managerId: 'manager-1',
      runtimeType: 'pi',
      runtimeToken: 41,
      event: { type: 'turn_end', toolResults: [] },
    })
    await exporter.forceFlush()
    await exporter.shutdown()

    const spans = spanExporter.batches.flat()
    const tool = spans.find((entry) => entry.name === 'forge.tool.send_message_to_agent')
    const deliveries = spans.filter((entry) => entry.name === 'forge.agent.delivery')
    expect(deliveries).toHaveLength(1)
    const delivery = deliveries[0]
    expect(delivery?.parentSpanContext?.spanId).toBe(tool?.spanContext().spanId)
    expect(String(delivery?.attributes.metadata)).toContain('agent_delivery')
    expect(String(delivery?.attributes.metadata)).toContain('acceptedMode')
    expect(String(delivery?.attributes.metadata)).toContain('resolved_tool')
  })

  it('honors tool input/result capture toggles', async () => {
    const spanExporter = new MockExporter()
    const base = createDefaultPhoenixObservabilitySettings()
    const settings = { ...base, enabled: true, capture: { ...base.capture, toolInputs: false, toolResults: false } }
    const exporter = new PhoenixOtlpExporter({ settings, spanExporter })

    exporter.recordRuntimeInput({
      targetAgentId: 'worker-1',
      managerId: 'manager-1',
      role: 'worker',
      runtimeType: 'pi',
      runtimeToken: 31,
      rootSource: 'internal_agent_message',
      runtimeInput: 'run tool',
    })
    exporter.recordRuntimeSessionEvent({
      agentId: 'worker-1',
      managerId: 'manager-1',
      role: 'worker',
      runtimeType: 'pi',
      runtimeToken: 31,
      event: { type: 'message_start', message: { role: 'user', content: 'run tool' } },
    })
    exporter.recordRuntimeSessionEvent({
      agentId: 'worker-1',
      managerId: 'manager-1',
      role: 'worker',
      runtimeType: 'pi',
      runtimeToken: 31,
      event: { type: 'tool_execution_start', toolName: 'bash', toolCallId: 'tool-secret', args: { command: 'SECRET_COMMAND' } },
    })
    exporter.recordRuntimeSessionEvent({
      agentId: 'worker-1',
      managerId: 'manager-1',
      role: 'worker',
      runtimeType: 'pi',
      runtimeToken: 31,
      event: { type: 'tool_execution_end', toolName: 'bash', toolCallId: 'tool-secret', result: { stdout: 'SECRET_RESULT' }, isError: false },
    })
    exporter.recordRuntimeSessionEvent({
      agentId: 'worker-1',
      managerId: 'manager-1',
      role: 'worker',
      runtimeType: 'pi',
      runtimeToken: 31,
      event: { type: 'turn_end', toolResults: [] },
    })
    await exporter.forceFlush()
    await exporter.shutdown()

    const tool = spanExporter.batches.flat().find((entry) => entry.name === 'forge.tool.bash')
    expect(tool).toBeDefined()
    expect(JSON.stringify(tool?.attributes)).not.toContain('SECRET_COMMAND')
    expect(JSON.stringify(tool?.attributes)).not.toContain('SECRET_RESULT')
    expect(tool?.attributes['input.value']).toBeUndefined()
    expect(tool?.attributes['output.value']).toBeUndefined()
    expect(tool?.attributes['tool.parameters']).toBeUndefined()
  })

  it('omits image bytes by default while preserving image summaries', async () => {
    const spanExporter = new MockExporter()
    const settings = { ...createDefaultPhoenixObservabilitySettings(), enabled: true }
    const exporter = new PhoenixOtlpExporter({ settings, spanExporter })

    exporter.recordRuntimeInput({
      targetAgentId: 'manager-1',
      managerId: 'manager-1',
      runtimeType: 'pi',
      runtimeToken: 9,
      rootSource: 'user_input',
      runtimeInput: { text: 'inspect image', images: [{ data: 'BASE64_SECRET_IMAGE_BYTES', mimeType: 'image/png' }] },
    })
    exporter.recordRuntimeSessionEvent({
      agentId: 'manager-1',
      managerId: 'manager-1',
      runtimeType: 'pi',
      runtimeToken: 9,
      event: { type: 'message_start', message: { role: 'user', content: 'inspect image' } },
    })
    exporter.recordRuntimeSessionEvent({
      agentId: 'manager-1',
      managerId: 'manager-1',
      runtimeType: 'pi',
      runtimeToken: 9,
      event: { type: 'message_start', message: { role: 'assistant', content: '' } },
    })
    exporter.recordRuntimeSessionEvent({
      agentId: 'manager-1',
      managerId: 'manager-1',
      runtimeType: 'pi',
      runtimeToken: 9,
      event: {
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'BASE64_SECRET_OUTPUT' } }] },
        meta: {
          provider: 'openai-codex',
          modelId: 'gpt-5.4',
          requestMessages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'BASE64_SECRET_REQUEST' } }] }],
        },
      },
    })
    exporter.recordRuntimeSessionEvent({
      agentId: 'manager-1',
      managerId: 'manager-1',
      runtimeType: 'pi',
      runtimeToken: 9,
      event: { type: 'turn_end', toolResults: [] },
    })
    await exporter.forceFlush()
    await exporter.shutdown()

    const serialized = JSON.stringify(spanExporter.batches.flat().map((span) => span.attributes))
    expect(serialized).not.toContain('BASE64_SECRET')
    expect(serialized).toContain('image/png data omitted')
  })

  it('omits runtime input and LLM request messages when model input capture is disabled', async () => {
    const spanExporter = new MockExporter()
    const base = createDefaultPhoenixObservabilitySettings()
    const settings = { ...base, enabled: true, capture: { ...base.capture, modelInputs: false } }
    const exporter = new PhoenixOtlpExporter({ settings, spanExporter })

    exporter.recordRuntimeInput({
      targetAgentId: 'manager-1',
      managerId: 'manager-1',
      runtimeType: 'pi',
      runtimeToken: 12,
      rootSource: 'user_input',
      originalInput: 'SECRET_VISIBLE_INPUT',
      runtimeInput: 'SECRET_RUNTIME_INPUT',
    })
    exporter.recordRuntimeSessionEvent({
      agentId: 'manager-1',
      managerId: 'manager-1',
      runtimeType: 'pi',
      runtimeToken: 12,
      event: { type: 'message_start', message: { role: 'user', content: 'SECRET_RUNTIME_INPUT' } },
    })
    exporter.recordRuntimeSessionEvent({
      agentId: 'manager-1',
      managerId: 'manager-1',
      runtimeType: 'pi',
      runtimeToken: 12,
      event: {
        type: 'message_end',
        message: { role: 'assistant', content: 'ok' },
        meta: { provider: 'openai-codex', modelId: 'gpt-5.4', requestMessages: [{ role: 'user', content: 'SECRET_REQUEST_MESSAGES' }] },
      },
    })
    exporter.recordRuntimeSessionEvent({
      agentId: 'manager-1',
      managerId: 'manager-1',
      runtimeType: 'pi',
      runtimeToken: 12,
      event: {
        type: 'turn_end',
        toolResults: [],
        meta: { provider: 'openai-codex', modelId: 'gpt-5.4', requestMessages: [{ role: 'user', content: 'SECRET_TURN_REQUEST_MESSAGES' }] },
      },
    })
    await exporter.forceFlush()
    await exporter.shutdown()

    const serialized = JSON.stringify(spanExporter.batches.flat().map((span) => span.attributes))
    expect(serialized).not.toContain('SECRET_VISIBLE_INPUT')
    expect(serialized).not.toContain('SECRET_RUNTIME_INPUT')
    expect(serialized).not.toContain('SECRET_REQUEST_MESSAGES')
    expect(serialized).not.toContain('SECRET_TURN_REQUEST_MESSAGES')
    const llm = spanExporter.batches.flat().find((entry) => entry.name === 'forge.llm.call')
    expect(llm?.attributes['llm.input_messages']).toBeUndefined()
  })

  it('omits assistant output content when model output capture is disabled', async () => {
    const spanExporter = new MockExporter()
    const base = createDefaultPhoenixObservabilitySettings()
    const settings = { ...base, enabled: true, capture: { ...base.capture, modelOutputs: false } }
    const exporter = new PhoenixOtlpExporter({ settings, spanExporter })

    exporter.recordRuntimeInput({
      targetAgentId: 'manager-1',
      managerId: 'manager-1',
      runtimeType: 'pi',
      runtimeToken: 10,
      rootSource: 'user_input',
      runtimeInput: 'hello',
    })
    exporter.recordRuntimeSessionEvent({
      agentId: 'manager-1',
      managerId: 'manager-1',
      runtimeType: 'pi',
      runtimeToken: 10,
      event: { type: 'message_start', message: { role: 'user', content: 'hello' } },
    })
    exporter.recordRuntimeSessionEvent({
      agentId: 'manager-1',
      managerId: 'manager-1',
      runtimeType: 'pi',
      runtimeToken: 10,
      event: { type: 'message_end', message: { role: 'assistant', content: 'SECRET_ASSISTANT_OUTPUT' }, meta: { provider: 'openai-codex', modelId: 'gpt-5.4' } },
    })
    exporter.recordRuntimeSessionEvent({
      agentId: 'manager-1',
      managerId: 'manager-1',
      runtimeType: 'pi',
      runtimeToken: 10,
      event: { type: 'turn_end', toolResults: [] },
    })
    await exporter.forceFlush()
    await exporter.shutdown()

    const llm = spanExporter.batches.flat().find((entry) => entry.name === 'forge.llm.call')
    expect(llm).toBeDefined()
    expect(llm?.attributes['output.value']).toBeUndefined()
    expect(JSON.stringify(llm?.attributes)).not.toContain('SECRET_ASSISTANT_OUTPUT')
  })

  it('merges provider metadata from turn_end into the final LLM span', async () => {
    const spanExporter = new MockExporter()
    const settings = { ...createDefaultPhoenixObservabilitySettings(), enabled: true }
    const exporter = new PhoenixOtlpExporter({ settings, spanExporter })

    exporter.recordRuntimeInput({
      targetAgentId: 'worker-1',
      managerId: 'manager-1',
      role: 'worker',
      runtimeType: 'cursor-sdk',
      runtimeToken: 11,
      rootSource: 'internal_agent_message',
      runtimeInput: 'run cursor task',
    })
    exporter.recordRuntimeSessionEvent({
      agentId: 'worker-1',
      managerId: 'manager-1',
      role: 'worker',
      runtimeType: 'cursor-sdk',
      runtimeToken: 11,
      event: { type: 'message_start', message: { role: 'user', content: 'run cursor task' } },
    })
    exporter.recordRuntimeSessionEvent({
      agentId: 'worker-1',
      managerId: 'manager-1',
      role: 'worker',
      runtimeType: 'cursor-sdk',
      runtimeToken: 11,
      event: { type: 'message_end', message: { role: 'assistant', content: 'done' } },
    })
    exporter.recordRuntimeSessionEvent({
      agentId: 'worker-1',
      managerId: 'manager-1',
      role: 'worker',
      runtimeType: 'cursor-sdk',
      runtimeToken: 11,
      event: {
        type: 'turn_end',
        toolResults: [],
        meta: {
          provider: 'cursor-sdk',
          modelId: 'composer-2.5',
          providerRequestId: 'run-123',
          stopReason: 'FINISHED',
          usage: { input: 20, output: 5, total: 25 },
          requestPayloadFidelity: 'delta_only',
        },
      },
    })
    await exporter.forceFlush()
    await exporter.shutdown()

    const llm = spanExporter.batches.flat().find((entry) => entry.name === 'forge.llm.call')
    expect(llm?.attributes['llm.provider']).toBe('cursor-sdk')
    expect(llm?.attributes['llm.model_name']).toBe('composer-2.5')
    expect(llm?.attributes['llm.token_count.prompt']).toBe(20)
    expect(llm?.attributes['llm.token_count.completion']).toBe(5)
    expect(llm?.attributes['llm.finish_reason']).toBe('FINISHED')
    expect(llm?.attributes['forge.provider_request_id']).toBeDefined()
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

  it('exports runtime lifecycle, runtime error, and feedback annotation spans', async () => {
    const spanExporter = new MockExporter()
    const settings = { ...createDefaultPhoenixObservabilitySettings(), enabled: true }
    const exporter = new PhoenixOtlpExporter({ settings, spanExporter })

    exporter.recordRuntimeInput({
      targetAgentId: 'manager-1',
      managerId: 'manager-1',
      profileId: 'profile-1',
      runtimeType: 'pi',
      runtimeToken: 4,
      rootSource: 'user_input',
      runtimeInput: 'please retry if needed',
    })
    exporter.recordRuntimeSessionEvent({
      agentId: 'manager-1',
      managerId: 'manager-1',
      profileId: 'profile-1',
      runtimeType: 'pi',
      runtimeToken: 4,
      event: { type: 'turn_start' },
    })
    exporter.recordRuntimeSessionEvent({
      agentId: 'manager-1',
      managerId: 'manager-1',
      profileId: 'profile-1',
      runtimeType: 'pi',
      runtimeToken: 4,
      event: { type: 'auto_retry_start', attempt: 1, maxAttempts: 2, delayMs: 10, errorMessage: 'rate limited' },
    })
    exporter.recordRuntimeError({
      agentId: 'manager-1',
      managerId: 'manager-1',
      profileId: 'profile-1',
      runtimeType: 'pi',
      runtimeToken: 4,
      phase: 'prompt_start',
      message: 'runtime failed',
      details: { reason: 'test' },
    })
    exporter.recordFeedback({
      id: 'feedback-1',
      createdAt: '2026-06-10T00:00:00.000Z',
      profileId: 'profile-1',
      sessionId: 'manager-1',
      scope: 'message',
      targetId: 'message-1',
      value: 'down',
      reasonCodes: ['accuracy'],
      comment: 'wrong answer',
      channel: 'web',
      actor: 'user',
    })
    await exporter.forceFlush()
    await exporter.shutdown()

    const spans = spanExporter.batches.flat()
    expect(spans.some((entry) => entry.name === 'forge.runtime.lifecycle')).toBe(true)
    expect(spans.some((entry) => entry.name === 'forge.runtime.error')).toBe(true)
    expect(spans.some((entry) => entry.name === 'forge.feedback.annotation')).toBe(true)
    expect(String(spans.find((entry) => entry.name === 'forge.feedback.annotation')?.attributes['input.value'])).toContain('wrong answer')
  })

  it('omits feedback comments when feedback comment capture is disabled', async () => {
    const spanExporter = new MockExporter()
    const defaults = createDefaultPhoenixObservabilitySettings()
    const settings = {
      ...defaults,
      enabled: true,
      capture: { ...defaults.capture, feedbackComments: false },
    }
    const exporter = new PhoenixOtlpExporter({ settings, spanExporter })

    exporter.recordFeedback({
      id: 'feedback-1',
      createdAt: '2026-06-10T00:00:00.000Z',
      profileId: 'profile-1',
      sessionId: 'manager-1',
      scope: 'message',
      targetId: 'message-1',
      value: 'comment',
      reasonCodes: [],
      comment: 'private feedback comment',
      channel: 'web',
      actor: 'user',
    })
    await exporter.forceFlush()
    await exporter.shutdown()

    const serialized = JSON.stringify(spanExporter.batches.flat().map((span) => span.attributes))
    expect(serialized).not.toContain('private feedback comment')
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
