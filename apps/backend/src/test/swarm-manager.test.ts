import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SessionManager } from '@mariozechner/pi-coding-agent'
import { getConversationHistoryCacheFilePath } from '../swarm/conversation-history-cache.js'
import {
  getCommonKnowledgePath,
  getCortexReviewRunsPath,
  getSessionDir,
} from '../swarm/data-paths.js'
import { makeTempConfig as buildTempConfig } from '../test-support/index.js'
const memoryMergeMockState = vi.hoisted(() => ({
  executeLLMMerge: vi.fn(async (..._args: any[]) => '# Swarm Memory\n\n## Decisions\n- merged by mock\n'),
}))
const projectAgentAnalysisMockState = vi.hoisted(() => ({
  analyzeSessionForPromotion: vi.fn(async (..._args: any[]) => ({
    whenToUse: 'Use for release coordination.',
    systemPrompt: 'You are the release coordination manager.',
  })),
}))

vi.mock('../swarm/memory-merge.js', async () => {
  const actual = await vi.importActual<typeof import('../swarm/memory-merge.js')>('../swarm/memory-merge.js')
  return {
    ...actual,
    executeLLMMerge: (...args: Parameters<typeof actual.executeLLMMerge>) =>
      memoryMergeMockState.executeLLMMerge(...args),
  }
})

vi.mock('../swarm/project-agent-analysis.js', async () => {
  const actual = await vi.importActual<typeof import('../swarm/project-agent-analysis.js')>('../swarm/project-agent-analysis.js')
  return {
    ...actual,
    analyzeSessionForPromotion: (...args: Parameters<typeof actual.analyzeSessionForPromotion>) =>
      projectAgentAnalysisMockState.analyzeSessionForPromotion(...args),
  }
})

import { readSessionMeta, writeSessionMeta } from '../swarm/session-manifest.js'
import { AgentRuntime } from '../swarm/agent-runtime.js'
import type {
  AgentContextUsage,
  AgentDescriptor,
  AgentStatus,
  RequestedDeliveryMode,
  SendMessageReceipt,
  SwarmConfig,
} from '../swarm/types.js'
import type {
  RuntimeCreationOptions,
  RuntimeErrorEvent,
  RuntimeSessionEvent,
  RuntimeUserMessage,
  SwarmAgentRuntime,
} from '../swarm/runtime-contracts.js'
import { FakeRuntime, TestSwarmManager as TestSwarmManagerBase, bootWithDefaultManager } from '../test-support/index.js'

class TestSwarmManager extends TestSwarmManagerBase {
  protected override async createRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    systemPrompt: string,
    runtimeToken?: number,
    options?: RuntimeCreationOptions,
  ): Promise<SwarmAgentRuntime> {
    const runtime = await super.createRuntimeForDescriptor(descriptor, systemPrompt, runtimeToken, options)
    ;(runtime as FakeRuntime).terminateMutatesDescriptorStatus = false
    return runtime
  }
}

class FallbackReplaySession {
  isStreaming = false
  promptCalls: string[] = []
  steerCalls: string[] = []
  listener: ((event: any) => void) | undefined
  promptImpl: ((message: string) => Promise<void>) | undefined
  steerImpl: ((message: string) => Promise<void>) | undefined
  private sessionMessages: unknown[] = []

  readonly sessionManager = {
    getEntries: () => [],
    buildSessionContext: () => ({ messages: structuredClone(this.sessionMessages) as unknown[] }),
    resetLeaf: () => {
      this.sessionMessages = []
    },
    appendModelChange: () => {},
    appendThinkingLevelChange: () => {},
    appendMessage: (message: unknown) => {
      this.sessionMessages.push(structuredClone(message))
    },
    appendCustomEntry: () => 'custom-id',
  }

  readonly model = { provider: 'openai-codex', id: 'gpt-5.3-codex' }
  readonly thinkingLevel = 'medium'
  readonly state = { messages: [] as Array<{ role?: string; stopReason?: string }> }
  readonly agent = {
    state: this.state,
  }

  async prompt(message: string): Promise<void> {
    this.promptCalls.push(message)
    if (this.promptImpl) {
      await this.promptImpl(message)
    }
  }

  async steer(message: string): Promise<void> {
    this.steerCalls.push(message)
    if (this.steerImpl) {
      await this.steerImpl(message)
    }
  }

  async sendUserMessage(): Promise<void> {}
  async abort(): Promise<void> {}
  async compact(): Promise<unknown> { return { ok: true } }
  getContextUsage(): AgentContextUsage | undefined { return undefined }
  dispose(): void {}

  subscribe(listener: (event: any) => void): () => void {
    this.listener = listener
    return () => {
      this.listener = undefined
    }
  }

  emit(event: any): void {
    this.listener?.(event)
  }
}

class ForgeRuntimeHookTestManager extends TestSwarmManager {
  protected override async createRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    systemPrompt: string,
    runtimeToken?: number,
    options?: RuntimeCreationOptions,
  ): Promise<SwarmAgentRuntime> {
    const runtime = await super.createRuntimeForDescriptor(descriptor, systemPrompt, runtimeToken, options)

    if (runtimeToken !== undefined) {
      const forgeExtensionHost = (this as any).forgeExtensionHost
      const bindings = await forgeExtensionHost.prepareRuntimeBindings({
        descriptor,
        runtimeType: 'pi',
        runtimeToken,
      })
      if (bindings) {
        forgeExtensionHost.activateRuntimeBindings(bindings)
      }
    }

    return runtime
  }
}

class RuntimeFallbackReplayTestManager extends TestSwarmManager {
  fallbackReplaySessionByAgentId = new Map<string, FallbackReplaySession>()
  fallbackReplayRuntimeByAgentId = new Map<string, AgentRuntime>()
  fallbackReplayWorkerId: string | undefined

  protected override async createRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    systemPrompt: string,
    runtimeToken?: number,
    options?: RuntimeCreationOptions,
  ): Promise<SwarmAgentRuntime> {
    const workerId = this.fallbackReplayWorkerId
    const creationCount = (this.runtimeCreationCountByAgentId.get(descriptor.agentId) ?? 0) + 1

    if (workerId && descriptor.agentId === workerId && creationCount === 1) {
      const session = new FallbackReplaySession()
      const runtime = new AgentRuntime({
        descriptor: structuredClone(descriptor),
        session: session as any,
        systemPrompt,
        callbacks: {
          onStatusChange: async () => {},
          onSessionEvent: async () => {},
          onAgentEnd: async () => {},
          onRuntimeError: async () => {},
        },
      })
      this.runtimeCreationCountByAgentId.set(descriptor.agentId, creationCount)
      this.createdRuntimeIds.push(descriptor.agentId)
      this.fallbackReplaySessionByAgentId.set(descriptor.agentId, session)
      this.fallbackReplayRuntimeByAgentId.set(descriptor.agentId, runtime)
      this.systemPromptByAgentId.set(descriptor.agentId, systemPrompt)
      return runtime as unknown as SwarmAgentRuntime
    }

    return super.createRuntimeForDescriptor(descriptor, systemPrompt, runtimeToken, options)
  }
}

function appendSessionConversationMessage(sessionFile: string, agentId: string, text: string): void {
  const sessionManager = SessionManager.open(sessionFile)
  sessionManager.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text: 'seed' }],
  } as any)
  sessionManager.appendCustomEntry('swarm_conversation_entry', {
    type: 'conversation_message',
    agentId,
    role: 'assistant',
    text,
    timestamp: '2026-01-01T00:00:00.000Z',
    source: 'speak_to_user',
  })
}

async function waitForFileText(path: string): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      if (!isEnoentError(error)) {
        throw error
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 20))
  }

  throw new Error(`Timed out waiting for ${path}`)
}

async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (await condition()) {
      return
    }

    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  throw new Error('Timed out waiting for async condition')
}

function createDeferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve = (_value: T) => {}
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })

  return { promise, resolve }
}

function expectStartedReviewRun<T>(run: T | null): T {
  expect(run).not.toBeNull()
  if (!run) {
    throw new Error('Expected Cortex review run to be created')
  }
  return run
}

async function seedNeedsReviewSession(
  config: SwarmConfig,
  profileId = 'alpha',
  sessionId = 'alpha--s1',
): Promise<void> {
  const sessionDir = getSessionDir(config.paths.dataDir, profileId, sessionId)
  const sessionFileContent = '{"type":"message","role":"user","content":[{"type":"text","text":"needs review"}]}\n'

  await mkdir(sessionDir, { recursive: true })
  await writeFile(join(sessionDir, 'session.jsonl'), sessionFileContent, 'utf8')
  await writeFile(
    join(sessionDir, 'meta.json'),
    `${JSON.stringify(
      {
        profileId,
        sessionId,
        stats: {
          sessionFileSize: Buffer.byteLength(sessionFileContent, 'utf8'),
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
}

function isEnoentError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  )
}

function seedManagerDescriptorForRuntimeEventTests(manager: TestSwarmManager, config: SwarmConfig): void {
  const createdAt = '2026-01-01T00:00:00.000Z'
  const state = manager as unknown as {
    descriptors: Map<string, AgentDescriptor>
    conversationEntriesByAgentId: Map<string, unknown[]>
  }

  state.descriptors.set('manager', {
    agentId: 'manager',
    displayName: 'Manager',
    role: 'manager',
    managerId: 'manager',
    status: 'idle',
    createdAt,
    updatedAt: createdAt,
    cwd: config.defaultCwd,
    model: config.defaultModel,
    sessionFile: join(config.paths.sessionsDir, 'manager.jsonl'),
  })
  state.conversationEntriesByAgentId.set('manager', [])
}

async function makeTempConfig(port = 8790): Promise<SwarmConfig> {
  return buildTempConfig({
    prefix: 'swarm-manager-test-',
    port,
    omitSharedAuthFile: true,
    omitSharedSecretsFile: true,
    skipRepoMemorySkillPlaceholder: true,
  })
}

async function installForgeRuntimeErrorLogger(config: SwarmConfig, logPath: string): Promise<void> {
  const extensionsDir = join(config.paths.dataDir, 'extensions')
  await mkdir(extensionsDir, { recursive: true })
  await writeFile(
    join(extensionsDir, 'runtime-error.ts'),
    `
      import { appendFileSync } from "node:fs"
      export default (forge) => {
        forge.on("runtime:error", (event) => {
          appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(event) + "\\n", "utf8")
        })
      }
    `,
    'utf8',
  )
}

describe('SwarmManager', () => {


  it('spawns unique normalized agent ids on collisions', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const first = await manager.spawnAgent('manager', { agentId: 'Code Scout' })
    const second = await manager.spawnAgent('manager', { agentId: 'Code Scout' })

    expect(first.agentId).toBe('code-scout')
    expect(first.displayName).toBe('code-scout')
    expect(second.agentId).toBe('code-scout-2')
    expect(second.displayName).toBe('code-scout-2')
  })

  it('does not force a worker suffix for normalized ids', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const spawned = await manager.spawnAgent('manager', { agentId: 'Task Owner' })

    expect(spawned.agentId).toBe('task-owner')
    expect(spawned.displayName).toBe('task-owner')
  })

  it('rejects explicit agent ids that would use the reserved manager id', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await expect(manager.spawnAgent('manager', { agentId: 'manager' })).rejects.toThrow(
      'spawn_agent agentId "manager" is reserved',
    )
  })

  it('SYSTEM-prefixes worker initial messages (internal manager->worker input)', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', {
      agentId: 'Kickoff Worker',
      initialMessage: 'start implementation',
    })

    const workerRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(workerRuntime).toBeDefined()
    expect(workerRuntime?.sendCalls[0]?.message).toBe('SYSTEM: start implementation')
  })

  it('enforces manager-only spawn and kill permissions', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Worker' })

    await expect(manager.spawnAgent(worker.agentId, { agentId: 'Nope' })).rejects.toThrow('Only manager can spawn agents')
    await expect(manager.killAgent(worker.agentId, worker.agentId)).rejects.toThrow('Only manager can kill agents')
  })

  it('returns fire-and-forget receipt and prefixes internal inter-agent deliveries', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Messenger' })

    const receipt = await manager.sendMessage('manager', worker.agentId, 'hi worker', 'auto')

    expect(receipt.targetAgentId).toBe(worker.agentId)
    expect(receipt.deliveryId).toBe('delivery-1')
    expect(receipt.acceptedMode).toBe('prompt')

    const workerRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(workerRuntime?.sendCalls.at(-1)?.message).toBe('SYSTEM: hi worker')
  })


  it('keeps worker-to-manager completion reporting on the generic send path', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Reporter Worker' })
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    expect(managerRuntime).toBeDefined()

    managerRuntime!.sendCalls = []

    await manager.sendMessage(worker.agentId, 'manager', 'status: done', 'auto')

    expect(managerRuntime?.sendCalls.at(-1)?.message).toBe('SYSTEM: status: done')

    const managerHistory = manager.getConversationHistory('manager')
    expect(
      managerHistory.some(
        (entry) =>
          entry.type === 'agent_message' &&
          entry.agentId === 'manager' &&
          entry.fromAgentId === worker.agentId &&
          entry.toAgentId === 'manager' &&
          entry.text === 'status: done',
      ),
    ).toBe(true)
    expect(
      managerHistory.some(
        (entry) =>
          entry.type === 'conversation_message' &&
          entry.source === 'project_agent_input' &&
          entry.text === 'status: done',
      ),
    ).toBe(false)
  })

  it('sends manager user input as steer delivery, without SYSTEM prefixing, and with source metadata annotation', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.handleUserMessage('interrupt current plan')

    const managerRuntime = manager.runtimeByAgentId.get('manager')
    expect(managerRuntime).toBeDefined()
    expect(managerRuntime?.sendCalls.at(-1)?.delivery).toBe('steer')
    expect(managerRuntime?.sendCalls.at(-1)?.message).toBe('[sourceContext] {"channel":"web"}\n\ninterrupt current plan')
  })

  it('streams tool_execution_update events live but only persists terminal tool call events', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    seedManagerDescriptorForRuntimeEventTests(manager, config)

    const streamedKinds: string[] = []
    manager.on('agent_tool_call', (event: any) => {
      if (event.type === 'agent_tool_call') {
        streamedKinds.push(event.kind)
      }
    })

    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'tool_execution_update',
      toolName: 'bash',
      toolCallId: 'tool-call-1',
      partialResult: {
        chunk: 'progress',
      },
    })

    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'tool_execution_end',
      toolName: 'bash',
      toolCallId: 'tool-call-1',
      result: {
        ok: true,
      },
      isError: false,
    })

    expect(streamedKinds).toContain('tool_execution_update')
    expect(streamedKinds).toContain('tool_execution_end')

    const inMemoryHistory = manager.getConversationHistory('manager')
    expect(
      inMemoryHistory.some(
        (entry) => entry.type === 'agent_tool_call' && entry.kind === 'tool_execution_update',
      ),
    ).toBe(true)

    const sessionManager = SessionManager.open(join(config.paths.sessionsDir, 'manager.jsonl'))
    const persistedConversationEntries = sessionManager
      .getEntries()
      .filter((entry: any) => entry.type === 'custom' && entry.customType === 'swarm_conversation_entry')
      .map((entry: any) => entry.data)

    expect(
      persistedConversationEntries.some(
        (entry: any) => entry?.type === 'agent_tool_call' && entry.kind === 'tool_execution_update',
      ),
    ).toBe(false)
    expect(
      persistedConversationEntries.some(
        (entry: any) => entry?.type === 'agent_tool_call' && entry.kind === 'tool_execution_end',
      ),
    ).toBe(true)
  })

  it('does not recreate worker activity state when workers are no longer streaming', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Late Event Worker' })

    const state = manager as unknown as {
      workerStallState: Map<string, unknown>
      workerActivityState: Map<string, unknown>
      updateWorkerActivity: (agentId: string, event: any) => void
    }

    expect(state.workerStallState.has(worker.agentId)).toBe(false)
    expect(state.workerActivityState.has(worker.agentId)).toBe(false)

    state.updateWorkerActivity(worker.agentId, {
      type: 'turn_end',
      toolResults: [],
    })

    expect(state.workerActivityState.has(worker.agentId)).toBe(false)
    expect(manager.getWorkerActivity(worker.agentId)).toBeUndefined()
  })

  it('records versioning mutations for successful agent write/edit tool events on tracked data-dir files', async () => {
    const config = await makeTempConfig()
    const recordMutation = vi.fn(async () => true)
    const manager = new TestSwarmManager(config, {
      versioningService: {
        isTrackedPath: () => true,
        recordMutation,
        flushPending: async () => {},
        reconcileNow: async () => {},
      },
    })
    await bootWithDefaultManager(manager, config)
    recordMutation.mockClear()

    const commonKnowledgePath = getCommonKnowledgePath(config.paths.dataDir)

    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'tool_execution_start',
      toolName: 'write',
      toolCallId: 'tool-write-1',
      args: {
        path: commonKnowledgePath,
        content: '# Common Knowledge\n\n- updated\n',
      },
    })
    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'tool_execution_end',
      toolName: 'write',
      toolCallId: 'tool-write-1',
      result: { ok: true },
      isError: false,
    })

    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'tool_execution_start',
      toolName: 'edit',
      toolCallId: 'tool-edit-1',
      args: {
        path: commonKnowledgePath,
        oldText: 'updated',
        newText: 'edited',
      },
    })
    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'tool_execution_end',
      toolName: 'edit',
      toolCallId: 'tool-edit-1',
      result: { ok: true },
      isError: false,
    })

    await waitForCondition(() => recordMutation.mock.calls.length >= 2, 1_000)

    const recordedMutations = (recordMutation.mock.calls as unknown as Array<Array<Record<string, unknown>>>).map(
      (call) => call[0],
    )
    expect(recordedMutations).toHaveLength(2)
    expect(recordedMutations).toEqual(expect.arrayContaining([
      {
        path: commonKnowledgePath,
        action: 'write',
        source: 'agent-write-tool',
        profileId: 'manager',
        sessionId: 'manager',
        agentId: 'manager',
        reviewRunId: undefined,
      },
      {
        path: commonKnowledgePath,
        action: 'write',
        source: 'agent-edit-tool',
        profileId: 'manager',
        sessionId: 'manager',
        agentId: 'manager',
        reviewRunId: undefined,
      },
    ]))
  })


  it('does not bump session updatedAt for worker runtime assistant message_start events', async () => {
    const config = await makeTempConfig()
    let tick = 0
    const now = () => new Date(Date.parse('2026-01-01T00:00:00.000Z') + tick++).toISOString()
    const manager = new TestSwarmManager(config, { now })
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Runtime Activity Worker' })
    const previousUpdatedAt = manager.getAgent('manager')?.updatedAt

    const snapshots: Array<{ type: string; agents: AgentDescriptor[] }> = []
    manager.on('agents_snapshot', (event) => {
      if (event.type === 'agents_snapshot') {
        snapshots.push(event)
      }
    })

    await (manager as any).handleRuntimeSessionEvent(worker.agentId, {
      type: 'message_start',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'working on it' }],
      },
    })

    const nextUpdatedAt = manager.getAgent('manager')?.updatedAt
    expect(previousUpdatedAt).toBeDefined()
    expect(nextUpdatedAt).toBe(previousUpdatedAt)
    expect(snapshots).toHaveLength(0)
  })

  it('surfaces manager assistant overflow turns as system conversation messages', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    seedManagerDescriptorForRuntimeEventTests(manager, config)

    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage:
          '400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 180186 tokens > 180000 maximum"},"request_id":"req_test"}',
      },
    })

    const history = manager.getConversationHistory('manager')
    const systemEvent = [...history]
      .reverse()
      .find(
        (entry) =>
          entry.type === 'conversation_message' &&
          entry.role === 'system' &&
          entry.source === 'system' &&
          entry.text.includes('Manager reply failed'),
      )

    expect(systemEvent).toBeDefined()
    if (systemEvent?.type === 'conversation_message') {
      expect(systemEvent.text).toContain('prompt is too long: 180186 tokens > 180000 maximum')
      expect(systemEvent.text).toContain('Try compacting the conversation to free up context space.')
    }
  })

  it('surfaces non-overflow manager runtime errors without overflow wording', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    seedManagerDescriptorForRuntimeEventTests(manager, config)

    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: 'Rate limit exceeded for requests per minute.',
      },
    })

    const history = manager.getConversationHistory('manager')
    const systemEvent = [...history]
      .reverse()
      .find(
        (entry) =>
          entry.type === 'conversation_message' &&
          entry.role === 'system' &&
          entry.source === 'system' &&
          entry.text.includes('Manager reply failed'),
      )

    expect(systemEvent).toBeDefined()
    if (systemEvent?.type === 'conversation_message') {
      expect(systemEvent.text).toContain('Rate limit exceeded for requests per minute.')
      expect(systemEvent.text).not.toContain('Rate limit exceeded for requests per minute..')
      expect(systemEvent.text).not.toContain('prompt exceeded the model context window')
      expect(systemEvent.text).not.toContain('Try compacting the conversation to free up context space.')
    }
  })

  it('keeps the pending manual stop notice until the abort error arrives', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    seedManagerDescriptorForRuntimeEventTests(manager, config)

    ;(manager as any).markPendingManualManagerStopNotice('manager')

    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'partial response before abort' }],
        stopReason: 'stop',
      },
    })

    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: 'Request was aborted.',
      },
    })

    const history = manager.getConversationHistory('manager')
    expect(
      history.some(
        (entry) =>
          entry.type === 'conversation_message' &&
          entry.role === 'system' &&
          entry.text === 'Session stopped.',
      ),
    ).toBe(true)
    expect(
      history.some(
        (entry) =>
          entry.type === 'conversation_message' &&
          entry.role === 'system' &&
          entry.text.includes('Manager reply failed'),
      ),
    ).toBe(false)
  })

  it('handles undefined/null/empty/malformed errorMessage payloads without crashing', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    seedManagerDescriptorForRuntimeEventTests(manager, config)

    const malformedErrorMessages: unknown[] = [undefined, null, '', { code: 'invalid_request_error' }]

    for (const errorMessage of malformedErrorMessages) {
      await expect(
        (manager as any).handleRuntimeSessionEvent('manager', {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [],
            stopReason: 'error',
            errorMessage,
          },
        }),
      ).resolves.toBeUndefined()
    }

    const history = manager.getConversationHistory('manager')
    const systemErrorEvents = history.filter(
      (entry) =>
        entry.type === 'conversation_message' &&
        entry.role === 'system' &&
        entry.source === 'system' &&
        entry.text.includes('Manager reply failed'),
    )
    expect(systemErrorEvents).toHaveLength(malformedErrorMessages.length)
  })

  it('does not surface normal manager assistant turns as conversation messages', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    seedManagerDescriptorForRuntimeEventTests(manager, config)

    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'normal hidden manager assistant turn' }],
        stopReason: 'stop',
      },
    })

    const history = manager.getConversationHistory('manager')
    expect(history).toHaveLength(0)
  })

  it('does not surface non-error manager turns that mention token limits', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    seedManagerDescriptorForRuntimeEventTests(manager, config)

    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'We should keep the summary short to avoid token limit issues.' }],
        stopReason: 'stop',
      },
    })

    const history = manager.getConversationHistory('manager')
    expect(history).toHaveLength(0)
  })

  it('handles /compact as a manager slash command without forwarding it as a user prompt', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.handleUserMessage('/compact')

    const managerRuntime = manager.runtimeByAgentId.get('manager')
    expect(managerRuntime).toBeDefined()
    expect(managerRuntime?.compactCalls).toEqual([undefined])
    expect(managerRuntime?.sendCalls).toEqual([])

    const history = manager.getConversationHistory('manager')
    expect(
      history.some(
        (entry) =>
          entry.type === 'conversation_message' &&
          entry.role === 'system' &&
          entry.text === 'Compacting manager context...',
      ),
    ).toBe(true)
    expect(
      history.some(
        (entry) =>
          entry.type === 'conversation_message' &&
          entry.role === 'system' &&
          entry.text === 'Compaction complete.',
      ),
    ).toBe(true)
    expect(
      history.some(
        (entry) =>
          entry.type === 'conversation_message' && entry.role === 'user' && entry.text === '/compact',
      ),
    ).toBe(false)
  })

  it('passes optional custom instructions for /compact slash commands', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.handleUserMessage('/compact focus the summary on open implementation tasks')

    const managerRuntime = manager.runtimeByAgentId.get('manager')
    expect(managerRuntime?.compactCalls).toEqual(['focus the summary on open implementation tasks'])
  })

  it('starts fresh Cortex review runs in dedicated review sessions and records them for the Review tab', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await manager.boot()

    const run = expectStartedReviewRun(await manager.startCortexReviewRun({
      scope: { mode: 'session', profileId: 'alpha', sessionId: 'alpha--s1', axes: ['memory', 'feedback'] },
      trigger: 'manual',
      sourceContext: { channel: 'web' },
    }))

    expect(run.status).toBe('completed')
    expect(run.scopeLabel).toBe('alpha/alpha--s1 (memory, feedback)')
    expect(run.sessionAgentId).toMatch(/^cortex--s\d+$/)

    const reviewSession = manager.listAgents().find((descriptor) => descriptor.agentId === run.sessionAgentId)
    expect(reviewSession).toMatchObject({
      profileId: 'cortex',
      sessionPurpose: 'cortex_review',
    })

    const reviewRuntime = manager.runtimeByAgentId.get(run.sessionAgentId!)
    expect(reviewRuntime?.sendCalls.at(-1)?.delivery).toBe('steer')
    expect(reviewRuntime?.sendCalls.at(-1)?.message).toBe(
      '[sourceContext] {"channel":"web"}\n\nReview session alpha/alpha--s1 (memory, feedback freshness)',
    )

    const storedRuns = JSON.parse(await readFile(getCortexReviewRunsPath(config.paths.dataDir), 'utf8')) as {
      runs: Array<{ sessionAgentId: string | null; trigger: string }>
    }
    expect(storedRuns.runs[0]).toMatchObject({
      sessionAgentId: run.sessionAgentId,
      trigger: 'manual',
    })
  })

  it('routes root Cortex review messages into fresh review-run sessions instead of the interactive root session', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await manager.boot()

    expect(manager.runtimeByAgentId.get('cortex')).toBeUndefined()

    await manager.handleUserMessage('Review all sessions that need attention', {
      targetAgentId: 'cortex',
      sourceContext: { channel: 'web' },
    })

    expect(manager.runtimeByAgentId.get('cortex')).toBeUndefined()

    const runs = await manager.listCortexReviewRuns()
    expect(runs[0]).toMatchObject({
      trigger: 'manual',
      scope: { mode: 'all' },
    })
    expect(runs[0]?.sessionAgentId).toMatch(/^cortex--s\d+$/)
  })


  it('skips scheduled all-scope review envelopes when deterministic scan finds nothing to review', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await manager.boot()

    await manager.handleUserMessage(
      '[Scheduled Task: Nightly Review]\n[scheduleContext] {"scheduleId":"sched-1"}\n\nReview all sessions that need attention',
      {
        targetAgentId: 'cortex',
        sourceContext: { channel: 'web' },
      },
    )

    const runs = await manager.listCortexReviewRuns()
    expect(runs).toEqual([])
    expect(manager.listAgents().some((descriptor) => descriptor.sessionPurpose === 'cortex_review')).toBe(false)
  })

  it('routes scheduled review envelopes into the same review-run path with schedule metadata when review is needed', async () => {
    const config = await makeTempConfig()
    await seedNeedsReviewSession(config)

    const manager = new TestSwarmManager(config)
    await manager.boot()

    await manager.handleUserMessage(
      '[Scheduled Task: Nightly Review]\n[scheduleContext] {"scheduleId":"sched-1"}\n\nReview all sessions that need attention',
      {
        targetAgentId: 'cortex',
        sourceContext: { channel: 'web' },
      },
    )

    const runs = await manager.listCortexReviewRuns()
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      trigger: 'scheduled',
      scope: { mode: 'all' },
      scheduleName: 'Nightly Review',
      requestText:
        '[Scheduled Task: Nightly Review]\n[scheduleContext] {"scheduleId":"sched-1"}\n\nReview all sessions that need attention',
    })
  })

  it('bypasses precheck and coalescing for scheduled session-scoped review envelopes', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await manager.boot()

    const scheduledMessage =
      '[Scheduled Task: Session Review]\n[scheduleContext] {"scheduleId":"sched-session"}\n\nReview session alpha/alpha--s1 (memory freshness)'

    await manager.handleUserMessage(scheduledMessage, {
      targetAgentId: 'cortex',
      sourceContext: { channel: 'web' },
    })

    await manager.handleUserMessage(scheduledMessage, {
      targetAgentId: 'cortex',
      sourceContext: { channel: 'web' },
    })

    const runs = await manager.listCortexReviewRuns()
    expect(runs.filter((entry) => entry.trigger === 'scheduled' && entry.scope.mode === 'session')).toHaveLength(2)
    expect(runs[0]).toMatchObject({
      trigger: 'scheduled',
      scope: { mode: 'session', profileId: 'alpha', sessionId: 'alpha--s1', axes: ['memory'] },
      scheduleName: 'Session Review',
    })
  })

  it('coalesces scheduled all-scope review envelopes when an all-scope review is already active', async () => {
    const config = await makeTempConfig()
    await seedNeedsReviewSession(config)

    class BlockingReviewRuntime extends FakeRuntime {
      constructor(
        descriptor: AgentDescriptor,
        private readonly release: Promise<void>,
      ) {
        super(descriptor)
      }

      override async sendMessage(message: string | RuntimeUserMessage, delivery: RequestedDeliveryMode = 'auto'): Promise<SendMessageReceipt> {
        if (this.descriptor.sessionPurpose === 'cortex_review') {
          this.descriptor.status = 'streaming'
          void this.release.then(() => {
            this.descriptor.status = 'idle'
          })
        }
        return super.sendMessage(message, delivery)
      }
    }

    let releaseReview!: () => void
    const releaseReviewPromise = new Promise<void>((resolve) => {
      releaseReview = resolve
    })

    class BlockingReviewManager extends TestSwarmManager {
      protected override async createRuntimeForDescriptor(
        descriptor: AgentDescriptor,
        systemPrompt: string,
        _runtimeToken?: number,
      ): Promise<SwarmAgentRuntime> {
        const runtime = new BlockingReviewRuntime(descriptor, releaseReviewPromise)
        this.createdRuntimeIds.push(descriptor.agentId)
        this.runtimeByAgentId.set(descriptor.agentId, runtime)
        this.systemPromptByAgentId.set(descriptor.agentId, systemPrompt)
        return runtime as unknown as SwarmAgentRuntime
      }
    }

    const manager = new BlockingReviewManager(config)
    await manager.boot()

    const scheduledMessage =
      '[Scheduled Task: Nightly Review]\n[scheduleContext] {"scheduleId":"sched-1"}\n\nReview all sessions that need attention'

    await manager.handleUserMessage(scheduledMessage, {
      targetAgentId: 'cortex',
      sourceContext: { channel: 'web' },
    })

    await waitForCondition(() => {
      const activeReviewSession = manager
        .listAgents()
        .find((descriptor) => descriptor.sessionPurpose === 'cortex_review' && descriptor.status === 'streaming')
      return Boolean(activeReviewSession)
    })

    await manager.handleUserMessage(scheduledMessage, {
      targetAgentId: 'cortex',
      sourceContext: { channel: 'web' },
    })

    const runs = await manager.listCortexReviewRuns()
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      trigger: 'scheduled',
      scope: { mode: 'all' },
    })

    releaseReview()
  })

  it('coalesces scheduled all-scope review envelopes when an all-scope run is already queued', async () => {
    const config = await makeTempConfig()
    await seedNeedsReviewSession(config)

    class BlockingReviewRuntime extends FakeRuntime {
      constructor(
        descriptor: AgentDescriptor,
        private readonly release: Promise<void>,
      ) {
        super(descriptor)
      }

      override async sendMessage(message: string | RuntimeUserMessage, delivery: RequestedDeliveryMode = 'auto'): Promise<SendMessageReceipt> {
        if (this.descriptor.sessionPurpose === 'cortex_review') {
          this.descriptor.status = 'streaming'
          void this.release.then(() => {
            this.descriptor.status = 'idle'
          })
        }
        return super.sendMessage(message, delivery)
      }
    }

    let releaseReview!: () => void
    const releaseReviewPromise = new Promise<void>((resolve) => {
      releaseReview = resolve
    })

    class BlockingReviewManager extends TestSwarmManager {
      protected override async createRuntimeForDescriptor(
        descriptor: AgentDescriptor,
        systemPrompt: string,
        _runtimeToken?: number,
      ): Promise<SwarmAgentRuntime> {
        const runtime = new BlockingReviewRuntime(descriptor, releaseReviewPromise)
        this.createdRuntimeIds.push(descriptor.agentId)
        this.runtimeByAgentId.set(descriptor.agentId, runtime)
        this.systemPromptByAgentId.set(descriptor.agentId, systemPrompt)
        return runtime as unknown as SwarmAgentRuntime
      }
    }

    const manager = new BlockingReviewManager(config)
    await manager.boot()

    const activeRun = expectStartedReviewRun(await manager.startCortexReviewRun({
      scope: { mode: 'session', profileId: 'alpha', sessionId: 'alpha--s1', axes: ['memory'] },
      trigger: 'manual',
      sourceContext: { channel: 'web' },
    }))

    await waitForCondition(() => {
      const activeReviewSession = manager.getAgent(activeRun.sessionAgentId ?? '')
      return activeReviewSession?.status === 'streaming'
    })

    const scheduledMessage =
      '[Scheduled Task: Nightly Review]\n[scheduleContext] {"scheduleId":"sched-1"}\n\nReview all sessions that need attention'

    await manager.handleUserMessage(scheduledMessage, {
      targetAgentId: 'cortex',
      sourceContext: { channel: 'web' },
    })

    let runs = await manager.listCortexReviewRuns()
    const queuedAllScopeRun = runs.find((entry) => entry.trigger === 'scheduled' && entry.scope.mode === 'all')
    expect(queuedAllScopeRun).toMatchObject({
      status: 'queued',
      sessionAgentId: null,
    })

    await manager.handleUserMessage(scheduledMessage, {
      targetAgentId: 'cortex',
      sourceContext: { channel: 'web' },
    })

    runs = await manager.listCortexReviewRuns()
    expect(runs.filter((entry) => entry.trigger === 'scheduled' && entry.scope.mode === 'all')).toHaveLength(1)

    releaseReview()
  })

  it('queues concurrent review starts FIFO and automatically launches the next run after the active one finishes', async () => {
    const config = await makeTempConfig()

    class BlockingReviewRuntime extends FakeRuntime {
      constructor(
        descriptor: AgentDescriptor,
        private readonly release: Promise<void>,
      ) {
        super(descriptor)
      }

      override async sendMessage(message: string | RuntimeUserMessage, delivery: RequestedDeliveryMode = 'auto'): Promise<SendMessageReceipt> {
        if (this.descriptor.sessionPurpose === 'cortex_review') {
          this.descriptor.status = 'streaming'
          void this.release.then(() => {
            this.descriptor.status = 'idle'
          })
        }
        return super.sendMessage(message, delivery)
      }
    }

    let releaseFirstRun!: () => void
    const releaseFirstRunPromise = new Promise<void>((resolve) => {
      releaseFirstRun = resolve
    })

    class ConcurrentReviewTestSwarmManager extends TestSwarmManager {
      protected override async createRuntimeForDescriptor(
        descriptor: AgentDescriptor,
        systemPrompt: string,
        _runtimeToken?: number,
      ): Promise<SwarmAgentRuntime> {
        const runtime = new BlockingReviewRuntime(descriptor, releaseFirstRunPromise)
        this.createdRuntimeIds.push(descriptor.agentId)
        this.runtimeByAgentId.set(descriptor.agentId, runtime)
        this.systemPromptByAgentId.set(descriptor.agentId, systemPrompt)
        return runtime as unknown as SwarmAgentRuntime
      }
    }

    const manager = new ConcurrentReviewTestSwarmManager(config)
    await manager.boot()

    const firstRunPromise = manager.startCortexReviewRun({
      scope: { mode: 'all' },
      trigger: 'manual',
      sourceContext: { channel: 'web' },
    })

    await waitForCondition(() => {
      const streamingReviewSession = manager
        .listAgents()
        .find((descriptor) => descriptor.sessionPurpose === 'cortex_review' && descriptor.status === 'streaming')
      return Boolean(streamingReviewSession)
    })

    const secondRun = expectStartedReviewRun(await manager.startCortexReviewRun({
      scope: { mode: 'session', profileId: 'alpha', sessionId: 'alpha--s1', axes: ['memory'] },
      trigger: 'manual',
      sourceContext: { channel: 'web' },
    }))

    expect(secondRun.status).toBe('queued')
    expect(secondRun.sessionAgentId).toBeNull()
    expect(secondRun.queuePosition).toBe(1)

    releaseFirstRun()
    const firstRun = expectStartedReviewRun(await firstRunPromise)

    let refreshedRuns = await manager.listCortexReviewRuns()
    let refreshedSecondRun = refreshedRuns.find((entry) => entry.runId === secondRun.runId)
    for (let attempt = 0; attempt < 50 && !refreshedSecondRun?.sessionAgentId; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      refreshedRuns = await manager.listCortexReviewRuns()
      refreshedSecondRun = refreshedRuns.find((entry) => entry.runId === secondRun.runId)
    }

    const refreshedFirstRun = refreshedRuns.find((entry) => entry.runId === firstRun.runId)

    expect(refreshedFirstRun?.status).toBe('completed')
    expect(refreshedSecondRun?.queuePosition ?? null).toBeNull()
    expect(refreshedSecondRun?.sessionAgentId).toMatch(/^cortex--s\d+$/)
    expect(refreshedSecondRun?.sessionAgentId).not.toBe(firstRun.sessionAgentId)

    const storedRuns = JSON.parse(await readFile(getCortexReviewRunsPath(config.paths.dataDir), 'utf8')) as {
      runs: Array<{ runId: string; blockedReason?: string | null; sessionAgentId: string | null }>
    }
    const storedSecondRun = storedRuns.runs.find((entry) => entry.runId === secondRun.runId)
    expect(storedSecondRun?.blockedReason ?? null).toBeNull()
    expect(storedSecondRun?.sessionAgentId).toBe(refreshedSecondRun?.sessionAgentId ?? null)
  })

  it('tags web user messages with default source metadata', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.handleUserMessage('interrupt current plan')

    const history = manager.getConversationHistory('manager')
    const userEvent = history.find(
      (entry) => entry.type === 'conversation_message' && entry.role === 'user' && entry.text === 'interrupt current plan',
    )

    expect(userEvent).toBeDefined()
    if (userEvent?.type === 'conversation_message') {
      expect(userEvent.sourceContext).toEqual({ channel: 'web' })
    }
  })

  it('includes full sourceContext annotation when forwarding telegram user messages to manager runtime', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.handleUserMessage('reply in telegram thread', {
      sourceContext: {
        channel: 'telegram',
        channelId: '123456',
        userId: '456789',
        threadTs: '173.456',
        channelType: 'group',
        teamId: 'T789',
      },
    })

    const managerRuntime = manager.runtimeByAgentId.get('manager')
    expect(managerRuntime?.sendCalls.at(-1)?.message).toBe(
      '[sourceContext] {"channel":"telegram","channelId":"123456","userId":"456789","threadTs":"173.456","channelType":"group","teamId":"T789"}\n\nreply in telegram thread',
    )
  })

  it('defaults speak_to_user routing to web when target is omitted, even after telegram input', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.handleUserMessage('reply in telegram thread', {
      sourceContext: {
        channel: 'telegram',
        channelId: '123456',
        userId: '456789',
        threadTs: '173.456',
      },
    })

    await manager.publishToUser('manager', 'ack from manager', 'speak_to_user')

    const history = manager.getConversationHistory('manager')
    const assistantEvent = [...history]
      .reverse()
      .find((entry) => entry.type === 'conversation_message' && entry.source === 'speak_to_user')

    expect(assistantEvent).toBeDefined()
    if (assistantEvent?.type === 'conversation_message') {
      expect(assistantEvent.sourceContext).toEqual({ channel: 'web' })
    }
  })

  it('uses explicit speak_to_user targets without inferred fallback behavior', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.handleUserMessage('reply in telegram thread', {
      sourceContext: {
        channel: 'telegram',
        channelId: '123456',
        userId: '456789',
        threadTs: '173.456',
      },
    })

    await manager.publishToUser('manager', 'ack from manager', 'speak_to_user', {
      channel: 'telegram',
      channelId: '999000',
      userId: '000111',
      threadTs: '999.000',
    })

    const history = manager.getConversationHistory('manager')
    const assistantEvent = [...history]
      .reverse()
      .find((entry) => entry.type === 'conversation_message' && entry.source === 'speak_to_user')

    expect(assistantEvent).toBeDefined()
    if (assistantEvent?.type === 'conversation_message') {
      expect(assistantEvent.sourceContext).toEqual({
        channel: 'telegram',
        channelId: '999000',
        userId: '000111',
        threadTs: '999.000',
      })
    }
  })

  it('requires channelId for explicit telegram speak_to_user targets', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await expect(
      manager.publishToUser('manager', 'ack from manager', 'speak_to_user', {
        channel: 'telegram',
      }),
    ).rejects.toThrow(
      'speak_to_user target.channelId is required when target.channel is "telegram"',
    )
  })

  it('falls back to web routing when no explicit target context exists', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.publishToUser('manager', 'ack from manager', 'speak_to_user')

    const history = manager.getConversationHistory('manager')
    const assistantEvent = [...history]
      .reverse()
      .find((entry) => entry.type === 'conversation_message' && entry.source === 'speak_to_user')

    expect(assistantEvent).toBeDefined()
    if (assistantEvent?.type === 'conversation_message') {
      expect(assistantEvent.sourceContext).toEqual({ channel: 'web' })
    }
  })

  it('bumps session updatedAt and emits agents_snapshot for speak_to_user messages', async () => {
    const config = await makeTempConfig()
    let tick = 0
    const now = () => new Date(Date.parse('2026-01-01T00:00:00.000Z') + tick++).toISOString()
    const manager = new TestSwarmManager(config, { now })
    await bootWithDefaultManager(manager, config)

    const previousUpdatedAt = manager.getAgent('manager')?.updatedAt

    const snapshots: Array<{ type: string; agents: AgentDescriptor[] }> = []
    manager.on('agents_snapshot', (event) => {
      if (event.type === 'agents_snapshot') {
        snapshots.push(event)
      }
    })

    await manager.publishToUser('manager', 'ack from manager', 'speak_to_user')

    const nextUpdatedAt = manager.getAgent('manager')?.updatedAt
    expect(previousUpdatedAt).toBeDefined()
    expect(nextUpdatedAt).toBeDefined()
    expect(nextUpdatedAt!.localeCompare(previousUpdatedAt!)).toBeGreaterThan(0)
    expect(
      snapshots.some((snapshot) =>
        snapshot.agents.some((agent) => agent.agentId === 'manager' && agent.updatedAt === nextUpdatedAt),
      ),
    ).toBe(true)
  })

  it('does not bump session updatedAt for system publish_to_user messages', async () => {
    const config = await makeTempConfig()
    let tick = 0
    const now = () => new Date(Date.parse('2026-01-01T00:00:00.000Z') + tick++).toISOString()
    const manager = new TestSwarmManager(config, { now })
    await bootWithDefaultManager(manager, config)

    const previousUpdatedAt = manager.getAgent('manager')?.updatedAt

    const snapshots: Array<{ type: string; agents: AgentDescriptor[] }> = []
    manager.on('agents_snapshot', (event) => {
      if (event.type === 'agents_snapshot') {
        snapshots.push(event)
      }
    })

    await manager.publishToUser('manager', 'system-only note', 'system')

    const nextUpdatedAt = manager.getAgent('manager')?.updatedAt
    expect(previousUpdatedAt).toBeDefined()
    expect(nextUpdatedAt).toBe(previousUpdatedAt)
    expect(snapshots).toHaveLength(0)
  })

  it('does not SYSTEM-prefix direct user messages routed to a worker', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'User Routed Worker' })

    await manager.handleUserMessage('hello worker', { targetAgentId: worker.agentId })

    const workerRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(workerRuntime).toBeDefined()
    expect(workerRuntime?.sendCalls.at(-1)?.message).toBe('hello worker')
  })

  it('bumps the owning session updatedAt and emits agents_snapshot on worker-targeted user messages', async () => {
    const config = await makeTempConfig()
    let tick = 0
    const now = () => new Date(Date.parse('2026-01-01T00:00:00.000Z') + tick++).toISOString()
    const manager = new TestSwarmManager(config, { now })
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Activity Worker' })
    const previousUpdatedAt = manager.getAgent('manager')?.updatedAt

    const snapshots: Array<{ type: string; agents: AgentDescriptor[] }> = []
    manager.on('agents_snapshot', (event) => {
      if (event.type === 'agents_snapshot') {
        snapshots.push(event)
      }
    })

    await manager.handleUserMessage('hello worker', { targetAgentId: worker.agentId })

    const nextUpdatedAt = manager.getAgent('manager')?.updatedAt
    expect(previousUpdatedAt).toBeDefined()
    expect(nextUpdatedAt).toBeDefined()
    expect(nextUpdatedAt!.localeCompare(previousUpdatedAt!)).toBeGreaterThan(0)
    expect(
      snapshots.some((snapshot) =>
        snapshot.agents.some((agent) => agent.agentId === 'manager' && agent.updatedAt === nextUpdatedAt),
      ),
    ).toBe(true)
  })

  it('routes user image attachments to worker runtimes and conversation events', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Image Worker' })

    await manager.handleUserMessage('', {
      targetAgentId: worker.agentId,
      attachments: [
        {
          mimeType: 'image/png',
          data: 'aGVsbG8=',
          fileName: 'diagram.png',
        },
      ],
    })

    const workerRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(workerRuntime).toBeDefined()

    const sentMessage = workerRuntime?.sendCalls.at(-1)?.message
    expect(typeof sentMessage).toBe('object')
    if (sentMessage && typeof sentMessage !== 'string') {
      expect(sentMessage.text).toBe('')
      expect(sentMessage.images).toEqual([
        {
          mimeType: 'image/png',
          data: 'aGVsbG8=',
        },
      ])
    }

    const history = manager.getConversationHistory(worker.agentId)
    const userEvent = history.find(
      (entry) => entry.type === 'conversation_message' && entry.role === 'user' && entry.source === 'user_input',
    )

    expect(userEvent).toBeDefined()
    if (userEvent && userEvent.type === 'conversation_message') {
      expect(userEvent.text).toBe('')
      expect(userEvent.attachments).toHaveLength(1)
      expect(userEvent.attachments?.[0]).toMatchObject({
        type: 'image',
        mimeType: 'image/png',
        fileName: 'diagram.png',
        sizeBytes: 5,
      })
      expect('data' in (userEvent.attachments?.[0] ?? {})).toBe(false)
    }
  })

  it('injects text attachments into the runtime prompt', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Text Attachment Worker' })

    await manager.handleUserMessage('Please review this file.', {
      targetAgentId: worker.agentId,
      attachments: [
        {
          type: 'text',
          mimeType: 'text/markdown',
          fileName: 'notes.md',
          text: '# Notes\n\n- item',
        },
      ],
    })

    const workerRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(workerRuntime).toBeDefined()

    const sentMessage = workerRuntime?.sendCalls.at(-1)?.message
    expect(typeof sentMessage).toBe('string')
    if (typeof sentMessage === 'string') {
      expect(sentMessage).toContain('Please review this file.')
      expect(sentMessage).toContain('Name: notes.md')
      expect(sentMessage).toContain('# Notes')
    }
  })

  it('ignores inbound attachment file paths and appends server-persisted paths to runtime text', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Persisted Path Worker' })
    const spoofedImagePath = join(config.paths.dataDir, 'spoofed-image.png')
    const spoofedTextPath = join(config.paths.dataDir, 'spoofed-notes.txt')

    await manager.handleUserMessage('Review these files', {
      targetAgentId: worker.agentId,
      attachments: [
        {
          mimeType: 'image/png',
          data: 'aGVsbG8=',
          fileName: 'diagram.png',
          filePath: spoofedImagePath,
        },
        {
          type: 'text',
          mimeType: 'text/plain',
          fileName: 'notes.txt',
          filePath: spoofedTextPath,
          text: 'hello from text attachment',
        },
      ],
    })

    const workerRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(workerRuntime).toBeDefined()

    const sentMessage = workerRuntime?.sendCalls.at(-1)?.message
    expect(typeof sentMessage).toBe('object')

    if (sentMessage && typeof sentMessage !== 'string') {
      expect(sentMessage.images).toEqual([
        {
          mimeType: 'image/png',
          data: 'aGVsbG8=',
        },
      ])
      expect(sentMessage.text).toContain('Review these files')
      expect(sentMessage.text).not.toContain(spoofedImagePath)
      expect(sentMessage.text).not.toContain(spoofedTextPath)
      expect(sentMessage.text).toContain('hello from text attachment')

      const persistedUploads = await readdir(config.paths.uploadsDir)
      expect(persistedUploads).toHaveLength(2)
    }
  })

  it('writes binary attachments to disk and passes their path to the runtime', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Binary Attachment Worker' })

    await manager.handleUserMessage('', {
      targetAgentId: worker.agentId,
      attachments: [
        {
          type: 'binary',
          mimeType: 'application/pdf',
          fileName: 'spec.pdf',
          data: 'aGVsbG8=',
        },
      ],
    })

    const workerRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(workerRuntime).toBeDefined()

    const sentMessage = workerRuntime?.sendCalls.at(-1)?.message
    expect(typeof sentMessage).toBe('string')

    if (typeof sentMessage === 'string') {
      const savedPathMatch = sentMessage.match(/Saved to: (.+)/)
      expect(savedPathMatch).toBeTruthy()

      const savedPath = savedPathMatch?.[1]?.trim()
      expect(savedPath).toBeTruthy()

      if (savedPath) {
        const binaryContents = await readFile(savedPath)
        expect(binaryContents.toString('utf8')).toBe('hello')
      }
    }
  })

  it('does not double-prefix internal messages that already start with SYSTEM:', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Already Tagged Worker' })

    await manager.sendMessage('manager', worker.agentId, 'SYSTEM: pre-tagged', 'auto')

    const workerRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(workerRuntime).toBeDefined()
    expect(workerRuntime?.sendCalls.at(-1)?.message).toBe('SYSTEM: pre-tagged')
  })

  it('accepts busy-runtime messages as steer regardless of requested delivery', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Busy Worker' })
    const runtime = manager.runtimeByAgentId.get(worker.agentId)
    expect(runtime).toBeDefined()
    runtime!.busy = true

    const autoReceipt = await manager.sendMessage('manager', worker.agentId, 'queued auto', 'auto')
    const followUpReceipt = await manager.sendMessage('manager', worker.agentId, 'queued followup', 'followUp')
    const steerReceipt = await manager.sendMessage('manager', worker.agentId, 'queued steer', 'steer')

    expect(autoReceipt.acceptedMode).toBe('steer')
    expect(followUpReceipt.acceptedMode).toBe('steer')
    expect(steerReceipt.acceptedMode).toBe('steer')
  })

  it('automatically reports worker completion summaries to the owning manager', async () => {
    const config = await makeTempConfig()
    let tick = 0
    const now = () => new Date(Date.parse('2026-01-01T00:00:00.000Z') + tick++).toISOString()
    const manager = new TestSwarmManager(config, { now })
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Summary Worker' })
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    expect(managerRuntime).toBeDefined()

    await (manager as any).handleRuntimeSessionEvent(worker.agentId, {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Implemented the completion hook and verified the flow.' }],
      },
    })

    await waitForCondition(() =>
      manager
        .getConversationHistory(worker.agentId)
        .some(
          (entry) =>
            entry.type === 'conversation_message' &&
            entry.role === 'assistant' &&
            entry.text === 'Implemented the completion hook and verified the flow.',
        ),
    )

    managerRuntime!.sendCalls = []

    await (manager as any).handleRuntimeAgentEnd(worker.agentId)

    expect(managerRuntime?.sendCalls).toHaveLength(1)
    expect(managerRuntime?.sendCalls[0]).toMatchObject({
      delivery: 'auto',
      message:
        'SYSTEM: Worker summary-worker completed its turn.\n\nLast assistant message:\nImplemented the completion hook and verified the flow.',
    })
  })

  it('auto-reports worker turn errors with the error context instead of a generic completion signal', async () => {
    const config = await makeTempConfig()
    let tick = 0
    const now = () => new Date(Date.parse('2026-01-01T00:00:00.000Z') + tick++).toISOString()
    const manager = new TestSwarmManager(config, { now })
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Errored Worker' })
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    expect(managerRuntime).toBeDefined()

    await (manager as any).handleRuntimeSessionEvent(worker.agentId, {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage:
          '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
      },
    })

    await waitForCondition(() =>
      manager
        .getConversationHistory(worker.agentId)
        .some(
          (entry) =>
            entry.type === 'conversation_message' &&
            entry.role === 'system' &&
            entry.text.includes('⚠️ Worker reply failed:'),
        ),
    )

    managerRuntime!.sendCalls = []

    await (manager as any).handleRuntimeAgentEnd(worker.agentId)

    expect(managerRuntime?.sendCalls).toHaveLength(1)
    expect(managerRuntime?.sendCalls[0]).toMatchObject({
      delivery: 'auto',
      message:
        'SYSTEM: Worker errored-worker ended its turn with an error.\n\nLast system message:\n⚠️ Worker reply failed: This request would exceed your account\'s rate limit. Please try again later. The manager may need to retry after checking provider auth, quotas, or rate limits.',
    })
  })

  it('dispatches Forge runtime:error before specialist fallback recovery short-circuits the user-facing error path', async () => {
    const config = await makeTempConfig()
    const logPath = join(config.paths.dataDir, 'runtime-error-hook.jsonl')
    await installForgeRuntimeErrorLogger(config, logPath)

    const manager = new ForgeRuntimeHookTestManager(config)

    await mkdir(join(config.paths.sharedDir, 'specialists'), { recursive: true })
    await writeFile(
      join(config.paths.sharedDir, 'specialists', 'planner.md'),
      [
        '---',
        'displayName: Planner',
        'color: "#7c3aed"',
        'enabled: true',
        'whenToUse: Planning work.',
        'modelId: claude-opus-4-6',
        'reasoningLevel: high',
        'fallbackModelId: gpt-5.4',
        'fallbackReasoningLevel: high',
        '---',
        'You are the planner specialist.'
      ].join('\n'),
      'utf8',
    )

    await bootWithDefaultManager(manager, config)
    await writeFile(logPath, '', 'utf8')

    const worker = await manager.spawnAgent('manager', {
      agentId: 'Planner Hook Worker',
      specialist: 'planner',
    })
    const originalRuntime = manager.runtimeByAgentId.get(worker.agentId)
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    const managerState = manager as unknown as {
      runtimeTokensByAgentId: Map<string, number>
      handleRuntimeError: (runtimeToken: number, agentId: string, error: RuntimeErrorEvent) => Promise<void>
    }
    const workerDescriptor = manager.getAgent(worker.agentId)
    const workerRuntimeToken = managerState.runtimeTokensByAgentId.get(worker.agentId) ?? 101
    managerState.runtimeTokensByAgentId.set(worker.agentId, workerRuntimeToken)
    const forgeExtensionHost = (manager as any).forgeExtensionHost
    if (workerDescriptor && workerRuntimeToken !== undefined) {
      const bindings = await forgeExtensionHost.prepareRuntimeBindings({
        descriptor: workerDescriptor,
        runtimeType: 'pi',
        runtimeToken: workerRuntimeToken,
      })
      if (bindings) {
        forgeExtensionHost.activateRuntimeBindings(bindings)
      }
    }

    originalRuntime!.specialistFallbackReplayMessage = {
      text: 'Draft the implementation plan.',
      images: [],
    }
    managerRuntime!.sendCalls = []
    const dispatchRuntimeErrorSpy = vi.spyOn(forgeExtensionHost, 'dispatchRuntimeError')
    const fallbackSpy = vi
      .spyOn(manager as any, 'maybeRecoverWorkerWithSpecialistFallback')
      .mockImplementation(async () => {
        expect(dispatchRuntimeErrorSpy).toHaveBeenCalledTimes(1)
        return true
      })

    await managerState.handleRuntimeError(workerRuntimeToken, worker.agentId, {
      phase: 'prompt_dispatch',
      message: '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
    })

    expect(dispatchRuntimeErrorSpy).toHaveBeenCalledTimes(1)
    expect(dispatchRuntimeErrorSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        phase: 'prompt_dispatch',
        message: expect.stringContaining('rate limit'),
      }),
    )
    expect(fallbackSpy).toHaveBeenCalledTimes(1)
    expect(managerRuntime?.sendCalls).toHaveLength(0)
    expect(
      manager
        .getConversationHistory(worker.agentId)
        .some(
          (entry) =>
            entry.type === 'conversation_message' &&
            entry.role === 'system' &&
            entry.text.includes('Worker reply failed:'),
        ),
    ).toBe(false)
  })

  it('reroutes recoverable specialist prompt_dispatch failures to the fallback model without surfacing an error', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)

    await mkdir(join(config.paths.sharedDir, 'specialists'), { recursive: true })
    await writeFile(
      join(config.paths.sharedDir, 'specialists', 'planner.md'),
      [
        '---',
        'displayName: Planner',
        'color: "#7c3aed"',
        'enabled: true',
        'whenToUse: Planning work.',
        'modelId: claude-opus-4-6',
        'reasoningLevel: high',
        'fallbackModelId: gpt-5.4',
        'fallbackReasoningLevel: high',
        '---',
        'You are the planner specialist.'
      ].join('\n'),
      'utf8',
    )

    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', {
      agentId: 'Planner Worker',
      specialist: 'planner',
    })
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    const originalRuntime = manager.runtimeByAgentId.get(worker.agentId)

    expect(worker.model).toEqual({
      provider: 'anthropic',
      modelId: 'claude-opus-4-6',
      thinkingLevel: 'high',
    })
    const spawnedSessionMeta = await readSessionMeta(config.paths.dataDir, 'manager', 'manager')
    const spawnedWorkerMeta = spawnedSessionMeta?.workers.find((entry) => entry.id === worker.agentId)
    expect(spawnedWorkerMeta?.specialistId).toBe('planner')
    expect(spawnedWorkerMeta?.specialistAttributionKnown).toBe(true)
    expect(managerRuntime).toBeDefined()
    expect(originalRuntime).toBeDefined()

    originalRuntime!.specialistFallbackReplayMessage = {
      text: 'Draft the implementation plan.',
      images: [],
    }
    managerRuntime!.sendCalls = []

    await (manager as any).handleRuntimeError(worker.agentId, {
      phase: 'prompt_dispatch',
      message: '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
    })

    const replacementRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(replacementRuntime).toBeDefined()
    expect(replacementRuntime).not.toBe(originalRuntime)
    expect(originalRuntime?.terminateCalls).toHaveLength(1)
    expect(managerRuntime?.sendCalls).toHaveLength(0)
    expect(manager.getAgent(worker.agentId)?.model).toEqual({
      provider: 'openai-codex',
      modelId: 'gpt-5.4',
      thinkingLevel: 'high',
    })
    expect(replacementRuntime?.sendCalls).toEqual([
      {
        message: {
          text: 'Draft the implementation plan.',
          images: [],
        },
        delivery: 'auto',
      },
    ])
    expect(
      manager
        .getConversationHistory(worker.agentId)
        .some(
          (entry) =>
            entry.type === 'conversation_message' &&
            entry.role === 'system' &&
            entry.text.includes('Worker reply failed:'),
        ),
    ).toBe(false)
  })

  it('preserves missing attribution provenance on descriptor-backed worker meta updates', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)

    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', {
      agentId: 'Legacy Attribution Worker',
    })

    const sessionMeta = await readSessionMeta(config.paths.dataDir, 'manager', 'manager')
    expect(sessionMeta).toBeDefined()
    if (!sessionMeta) {
      throw new Error('Expected session meta')
    }

    await writeSessionMeta(config.paths.dataDir, {
      ...sessionMeta,
      workers: sessionMeta.workers.map((entry) => {
        if (entry.id !== worker.agentId) {
          return entry
        }

        const { specialistAttributionKnown: _ignored, ...legacyEntry } = entry
        return legacyEntry
      }),
    })

    const workerDescriptor = manager.getAgent(worker.agentId)
    expect(workerDescriptor?.role).toBe('worker')
    if (!workerDescriptor || workerDescriptor.role !== 'worker') {
      throw new Error('Expected worker descriptor')
    }

    workerDescriptor.status = 'streaming'
    workerDescriptor.contextUsage = {
      tokens: 321,
      contextWindow: 1000,
      percent: 32.1,
    }

    await (manager as any).updateSessionMetaForWorkerDescriptor(workerDescriptor)

    const updatedMeta = await readSessionMeta(config.paths.dataDir, 'manager', 'manager')
    const updatedWorkerMeta = updatedMeta?.workers.find((entry) => entry.id === worker.agentId)
    expect(updatedWorkerMeta?.status).toBe('streaming')
    expect(updatedWorkerMeta?.tokens.input).toBe(321)
    expect(updatedWorkerMeta?.specialistAttributionKnown).toBeUndefined()
  })

  it('keeps the live worker descriptor healthy after old-runtime terminate mutates its own descriptor during fallback', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)

    await mkdir(join(config.paths.sharedDir, 'specialists'), { recursive: true })
    await writeFile(
      join(config.paths.sharedDir, 'specialists', 'planner.md'),
      [
        '---',
        'displayName: Planner',
        'color: "#7c3aed"',
        'enabled: true',
        'whenToUse: Planning work.',
        'modelId: claude-opus-4-6',
        'reasoningLevel: high',
        'fallbackModelId: gpt-5.4',
        'fallbackReasoningLevel: high',
        '---',
        'You are the planner specialist.'
      ].join('\n'),
      'utf8',
    )

    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', {
      agentId: 'Planner Descriptor Isolation Worker',
      specialist: 'planner',
    })
    const originalRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(originalRuntime).toBeDefined()

    originalRuntime!.specialistFallbackReplayMessage = {
      text: 'Retry after rate limit.',
      images: [],
    }
    originalRuntime!.terminateMutatesDescriptorStatus = true

    await (manager as any).handleRuntimeError(worker.agentId, {
      phase: 'prompt_dispatch',
      message: '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
    })

    expect(originalRuntime?.descriptor.status).toBe('terminated')
    expect(manager.getAgent(worker.agentId)?.status).toBe('idle')
    expect(manager.getAgent(worker.agentId)?.model).toEqual({
      provider: 'openai-codex',
      modelId: 'gpt-5.4',
      thinkingLevel: 'high',
    })
  })

  it('reroutes recoverable specialist message_end provider failures before they reach the manager', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)

    await mkdir(join(config.paths.sharedDir, 'specialists'), { recursive: true })
    await writeFile(
      join(config.paths.sharedDir, 'specialists', 'planner.md'),
      [
        '---',
        'displayName: Planner',
        'color: "#7c3aed"',
        'enabled: true',
        'whenToUse: Planning work.',
        'modelId: claude-opus-4-6',
        'reasoningLevel: high',
        'fallbackModelId: gpt-5.4',
        'fallbackReasoningLevel: high',
        '---',
        'You are the planner specialist.'
      ].join('\n'),
      'utf8',
    )

    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', {
      agentId: 'Planner Error Worker',
      specialist: 'planner',
    })
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    const originalRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(managerRuntime).toBeDefined()
    expect(originalRuntime).toBeDefined()

    originalRuntime!.specialistFallbackReplayMessage = {
      text: 'Revise the rollout plan.',
      images: [],
    }
    managerRuntime!.sendCalls = []

    await (manager as any).handleRuntimeSessionEvent(worker.agentId, {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage:
          '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
      },
    })

    const replacementRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(replacementRuntime).toBeDefined()
    expect(replacementRuntime).not.toBe(originalRuntime)
    expect(originalRuntime?.terminateCalls).toHaveLength(1)
    expect(managerRuntime?.sendCalls).toHaveLength(0)
    expect(manager.getAgent(worker.agentId)?.model).toEqual({
      provider: 'openai-codex',
      modelId: 'gpt-5.4',
      thinkingLevel: 'high',
    })
    expect(replacementRuntime?.sendCalls).toEqual([
      {
        message: {
          text: 'Revise the rollout plan.',
          images: [],
        },
        delivery: 'auto',
      },
    ])
    expect(
      manager
        .getConversationHistory(worker.agentId)
        .some(
          (entry) =>
            entry.type === 'conversation_message' &&
            entry.role === 'system' &&
            entry.text.includes('Worker reply failed:'),
        ),
    ).toBe(false)
  })

  it('replays the full accepted turn set when a queued follow-up was already consumed', async () => {
    const config = await makeTempConfig()
    const manager = new RuntimeFallbackReplayTestManager(config)

    await mkdir(join(config.paths.sharedDir, 'specialists'), { recursive: true })
    await writeFile(
      join(config.paths.sharedDir, 'specialists', 'planner.md'),
      [
        '---',
        'displayName: Planner',
        'color: "#7c3aed"',
        'enabled: true',
        'whenToUse: Planning work.',
        'modelId: claude-opus-4-6',
        'reasoningLevel: high',
        'fallbackModelId: gpt-5.4',
        'fallbackReasoningLevel: high',
        '---',
        'You are the planner specialist.'
      ].join('\n'),
      'utf8',
    )

    manager.fallbackReplayWorkerId = 'planner-active-follow-up-worker'
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', {
      agentId: 'Planner Active Follow Up Worker',
      specialist: 'planner',
    })
    const activeRuntime = manager.fallbackReplayRuntimeByAgentId.get(worker.agentId)
    const activeSession = manager.fallbackReplaySessionByAgentId.get(worker.agentId)
    expect(activeRuntime).toBeDefined()
    expect(activeSession).toBeDefined()

    const firstPromptStarted = createDeferred<void>()
    const releaseFirstPrompt = createDeferred<void>()
    activeSession!.promptImpl = async (message: string) => {
      if (message === 'first prompt') {
        firstPromptStarted.resolve(undefined)
        await releaseFirstPrompt.promise
      }
    }

    await activeRuntime!.sendMessage('first prompt', 'auto')
    await firstPromptStarted.promise
    await activeRuntime!.sendMessage('second prompt', 'auto')
    releaseFirstPrompt.resolve(undefined)

    activeSession!.emit({
      type: 'message_start',
      message: {
        role: 'user',
        content: 'second prompt',
      },
    })
    await Promise.resolve()

    await (manager as any).handleRuntimeSessionEvent(worker.agentId, {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage:
          '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
      },
    })

    const replacementRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(replacementRuntime).toBeDefined()
    expect(replacementRuntime?.sendCalls).toEqual([
      {
        message: {
          text: 'first prompt',
          images: [],
        },
        delivery: 'auto',
      },
      {
        message: {
          text: 'second prompt',
          images: [],
        },
        delivery: 'steer',
      },
    ])
  })

  it('replays queued specialist follow-up turns after the fallback prompt', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)

    await mkdir(join(config.paths.sharedDir, 'specialists'), { recursive: true })
    await writeFile(
      join(config.paths.sharedDir, 'specialists', 'planner.md'),
      [
        '---',
        'displayName: Planner',
        'color: "#7c3aed"',
        'enabled: true',
        'whenToUse: Planning work.',
        'modelId: claude-opus-4-6',
        'reasoningLevel: high',
        'fallbackModelId: gpt-5.4',
        'fallbackReasoningLevel: high',
        '---',
        'You are the planner specialist.'
      ].join('\n'),
      'utf8',
    )

    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', {
      agentId: 'Planner Queue Worker',
      specialist: 'planner',
    })
    const originalRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(originalRuntime).toBeDefined()

    originalRuntime!.specialistFallbackReplaySnapshot = {
      messages: [
        {
          text: 'Draft the implementation plan.',
          images: [],
        },
        {
          text: 'Also capture rollout risks.',
          images: [],
        },
        {
          text: 'Summarize open blockers.',
          images: [],
        },
      ],
    }

    await (manager as any).handleRuntimeError(worker.agentId, {
      phase: 'prompt_dispatch',
      message: '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
    })

    const replacementRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(replacementRuntime).toBeDefined()
    expect(replacementRuntime).not.toBe(originalRuntime)
    expect(replacementRuntime?.sendCalls).toEqual([
      {
        message: {
          text: 'Draft the implementation plan.',
          images: [],
        },
        delivery: 'auto',
      },
      {
        message: {
          text: 'Also capture rollout risks.',
          images: [],
        },
        delivery: 'steer',
      },
      {
        message: {
          text: 'Summarize open blockers.',
          images: [],
        },
        delivery: 'steer',
      },
    ])
  })

  it('surfaces the original worker error when specialist fallback replay fails internally', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)

    await mkdir(join(config.paths.sharedDir, 'specialists'), { recursive: true })
    await writeFile(
      join(config.paths.sharedDir, 'specialists', 'planner.md'),
      [
        '---',
        'displayName: Planner',
        'color: "#7c3aed"',
        'enabled: true',
        'whenToUse: Planning work.',
        'modelId: claude-opus-4-6',
        'reasoningLevel: high',
        'fallbackModelId: gpt-5.4',
        'fallbackReasoningLevel: high',
        '---',
        'You are the planner specialist.'
      ].join('\n'),
      'utf8',
    )

    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', {
      agentId: 'Planner Replay Failure Worker',
      specialist: 'planner',
    })
    const originalRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(originalRuntime).toBeDefined()

    manager.onCreateRuntime = ({ descriptor, runtime, creationCount }) => {
      if (descriptor.agentId === worker.agentId && creationCount === 2) {
        runtime.sendMessageError = new Error('fallback replay boom')
      }
    }

    originalRuntime!.specialistFallbackReplayMessage = {
      text: 'Retry the implementation plan.',
      images: [],
    }

    await (manager as any).handleRuntimeError(worker.agentId, {
      phase: 'prompt_dispatch',
      message: '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
    })

    const managerState = manager as unknown as {
      runtimes: Map<string, SwarmAgentRuntime>
    }
    expect(managerState.runtimes.get(worker.agentId)).toBe(originalRuntime as unknown as SwarmAgentRuntime)
    expect(manager.getAgent(worker.agentId)?.model).toEqual({
      provider: 'anthropic',
      modelId: 'claude-opus-4-6',
      thinkingLevel: 'high',
    })
    const rolledBackSessionMeta = await readSessionMeta(config.paths.dataDir, 'manager', 'manager')
    expect(rolledBackSessionMeta?.workers.find((entry) => entry.id === worker.agentId)?.model).toBe(
      'anthropic/claude-opus-4-6',
    )
    expect(
      manager
        .getConversationHistory(worker.agentId)
        .some(
          (entry) =>
            entry.type === 'conversation_message' &&
            entry.role === 'system' &&
            entry.text ===
              '⚠️ Agent error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}. Message may need to be resent.',
        ),
    ).toBe(true)
  })

  it('reconciles buffered old-runtime idle/end callbacks when fallback is unavailable after early handoff suppression', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)

    await mkdir(join(config.paths.sharedDir, 'specialists'), { recursive: true })
    await writeFile(
      join(config.paths.sharedDir, 'specialists', 'planner.md'),
      [
        '---',
        'displayName: Planner',
        'color: "#7c3aed"',
        'enabled: true',
        'whenToUse: Planning work.',
        'modelId: claude-opus-4-6',
        'reasoningLevel: high',
        'fallbackModelId: gpt-5.4',
        'fallbackReasoningLevel: high',
        '---',
        'You are the planner specialist.'
      ].join('\n'),
      'utf8',
    )

    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', {
      agentId: 'Planner No Fallback Worker',
      specialist: 'planner',
    })
    const originalRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(originalRuntime).toBeDefined()

    const managerState = manager as unknown as {
      runtimeTokensByAgentId: Map<string, number>
      handleRuntimeStatus: (runtimeToken: number, agentId: string, status: AgentStatus, pendingCount: number) => Promise<void>
      handleRuntimeAgentEnd: (runtimeToken: number, agentId: string) => Promise<void>
      handleRuntimeError: (runtimeToken: number, agentId: string, error: RuntimeErrorEvent) => Promise<void>
      runtimes: Map<string, SwarmAgentRuntime>
    }
    const originalRuntimeToken = managerState.runtimeTokensByAgentId.get(worker.agentId) ?? 101
    managerState.runtimeTokensByAgentId.set(worker.agentId, originalRuntimeToken)

    originalRuntime!.descriptor.status = 'streaming'
    await managerState.handleRuntimeStatus(originalRuntimeToken, worker.agentId, 'streaming', 0)

    const releaseFallbackModel = createDeferred<void>()
    const originalResolveFallbackModel = (manager as any).resolveSpecialistFallbackModelForDescriptor.bind(manager)
    ;(manager as any).resolveSpecialistFallbackModelForDescriptor = async () => {
      await releaseFallbackModel.promise
      return undefined
    }

    const fallbackPromise = managerState.handleRuntimeError(originalRuntimeToken, worker.agentId, {
      phase: 'prompt_dispatch',
      message: '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
    })

    await Promise.resolve()
    originalRuntime!.descriptor.status = 'idle'
    await managerState.handleRuntimeStatus(originalRuntimeToken, worker.agentId, 'idle', 0)
    await managerState.handleRuntimeAgentEnd(originalRuntimeToken, worker.agentId)

    releaseFallbackModel.resolve(undefined)
    await fallbackPromise
    ;(manager as any).resolveSpecialistFallbackModelForDescriptor = originalResolveFallbackModel

    expect(managerState.runtimes.get(worker.agentId)).toBe(originalRuntime as unknown as SwarmAgentRuntime)
    expect(manager.getAgent(worker.agentId)?.status).toBe('idle')
    const sessionMeta = await readSessionMeta(config.paths.dataDir, 'manager', 'manager')
    expect(sessionMeta?.workers.find((entry) => entry.id === worker.agentId)?.status).toBe('idle')
  })

  it('suppresses old-runtime status and end callbacks even before fallback model resolution completes', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)

    await mkdir(join(config.paths.sharedDir, 'specialists'), { recursive: true })
    await writeFile(
      join(config.paths.sharedDir, 'specialists', 'planner.md'),
      [
        '---',
        'displayName: Planner',
        'color: "#7c3aed"',
        'enabled: true',
        'whenToUse: Planning work.',
        'modelId: claude-opus-4-6',
        'reasoningLevel: high',
        'fallbackModelId: gpt-5.4',
        'fallbackReasoningLevel: high',
        '---',
        'You are the planner specialist.'
      ].join('\n'),
      'utf8',
    )

    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', {
      agentId: 'Planner Early Suppression Worker',
      specialist: 'planner',
    })
    const originalRuntime = manager.runtimeByAgentId.get(worker.agentId)
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    expect(originalRuntime).toBeDefined()
    expect(managerRuntime).toBeDefined()

    const managerState = manager as unknown as {
      runtimeTokensByAgentId: Map<string, number>
      handleRuntimeStatus: (runtimeToken: number, agentId: string, status: AgentStatus, pendingCount: number) => Promise<void>
      handleRuntimeAgentEnd: (runtimeToken: number, agentId: string) => Promise<void>
      handleRuntimeError: (runtimeToken: number, agentId: string, error: RuntimeErrorEvent) => Promise<void>
    }
    const originalRuntimeToken = managerState.runtimeTokensByAgentId.get(worker.agentId) ?? 101
    managerState.runtimeTokensByAgentId.set(worker.agentId, originalRuntimeToken)

    originalRuntime!.descriptor.status = 'streaming'
    originalRuntime!.specialistFallbackReplayMessage = {
      text: 'Retry original request.',
      images: [],
    }
    await managerState.handleRuntimeStatus(originalRuntimeToken, worker.agentId, 'streaming', 0)
    managerRuntime!.sendCalls = []

    const originalResolveFallbackModel = (manager as any).resolveSpecialistFallbackModelForDescriptor.bind(manager)
    const releaseFallbackModel = createDeferred<void>()
    ;(manager as any).resolveSpecialistFallbackModelForDescriptor = async (...args: unknown[]) => {
      await releaseFallbackModel.promise
      return await originalResolveFallbackModel(...args)
    }

    const fallbackPromise = managerState.handleRuntimeError(originalRuntimeToken, worker.agentId, {
      phase: 'prompt_dispatch',
      message: '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
    })

    await Promise.resolve()
    await managerState.handleRuntimeStatus(originalRuntimeToken, worker.agentId, 'idle', 0)
    await managerState.handleRuntimeAgentEnd(originalRuntimeToken, worker.agentId)

    expect(manager.getAgent(worker.agentId)?.status).toBe('streaming')
    expect(managerRuntime?.sendCalls).toHaveLength(0)

    releaseFallbackModel.resolve(undefined)
    await fallbackPromise
    ;(manager as any).resolveSpecialistFallbackModelForDescriptor = originalResolveFallbackModel

    expect(managerRuntime?.sendCalls).toHaveLength(0)
  })

  it('restores idle worker status and session meta when old-runtime idle/end callbacks were suppressed during a failed handoff', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)

    await mkdir(join(config.paths.sharedDir, 'specialists'), { recursive: true })
    await writeFile(
      join(config.paths.sharedDir, 'specialists', 'planner.md'),
      [
        '---',
        'displayName: Planner',
        'color: "#7c3aed"',
        'enabled: true',
        'whenToUse: Planning work.',
        'modelId: claude-opus-4-6',
        'reasoningLevel: high',
        'fallbackModelId: gpt-5.4',
        'fallbackReasoningLevel: high',
        '---',
        'You are the planner specialist.'
      ].join('\n'),
      'utf8',
    )

    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', {
      agentId: 'Planner Rollback Idle Worker',
      specialist: 'planner',
    })
    const originalRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(originalRuntime).toBeDefined()

    const managerState = manager as unknown as {
      runtimeTokensByAgentId: Map<string, number>
      handleRuntimeStatus: (runtimeToken: number, agentId: string, status: AgentStatus, pendingCount: number) => Promise<void>
      handleRuntimeAgentEnd: (runtimeToken: number, agentId: string) => Promise<void>
      handleRuntimeError: (runtimeToken: number, agentId: string, error: RuntimeErrorEvent) => Promise<void>
      runtimes: Map<string, SwarmAgentRuntime>
    }
    const originalRuntimeToken = managerState.runtimeTokensByAgentId.get(worker.agentId) ?? 101
    managerState.runtimeTokensByAgentId.set(worker.agentId, originalRuntimeToken)

    originalRuntime!.descriptor.status = 'streaming'
    originalRuntime!.specialistFallbackReplayMessage = {
      text: 'Retry original request.',
      images: [],
    }
    await managerState.handleRuntimeStatus(originalRuntimeToken, worker.agentId, 'streaming', 0)

    manager.onCreateRuntime = async ({ descriptor, runtime, creationCount }) => {
      if (descriptor.agentId !== worker.agentId || creationCount !== 2) {
        return
      }

      await managerState.handleRuntimeStatus(originalRuntimeToken, worker.agentId, 'idle', 0)
      await managerState.handleRuntimeAgentEnd(originalRuntimeToken, worker.agentId)
      runtime.sendMessageError = new Error('fallback replay boom')
    }

    await managerState.handleRuntimeError(originalRuntimeToken, worker.agentId, {
      phase: 'prompt_dispatch',
      message: '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
    })

    expect(managerState.runtimes.get(worker.agentId)).toBe(originalRuntime as unknown as SwarmAgentRuntime)
    expect(manager.getAgent(worker.agentId)?.status).toBe('idle')
    const rolledBackSessionMeta = await readSessionMeta(config.paths.dataDir, 'manager', 'manager')
    expect(rolledBackSessionMeta?.workers.find((entry) => entry.id === worker.agentId)?.status).toBe('idle')
  })

  it('does not resurrect a worker with a replacement runtime after stopWorker during delayed fallback handoff', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)

    await mkdir(join(config.paths.sharedDir, 'specialists'), { recursive: true })
    await writeFile(
      join(config.paths.sharedDir, 'specialists', 'planner.md'),
      [
        '---',
        'displayName: Planner',
        'color: "#7c3aed"',
        'enabled: true',
        'whenToUse: Planning work.',
        'modelId: claude-opus-4-6',
        'reasoningLevel: high',
        'fallbackModelId: gpt-5.4',
        'fallbackReasoningLevel: high',
        '---',
        'You are the planner specialist.'
      ].join('\n'),
      'utf8',
    )

    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', {
      agentId: 'Planner Stop During Handoff Worker',
      specialist: 'planner',
    })
    const originalRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(originalRuntime).toBeDefined()
    originalRuntime!.specialistFallbackReplayMessage = {
      text: 'Retry original request.',
      images: [],
    }

    const replacementCreationStarted = createDeferred<void>()
    const releaseReplacementCreation = createDeferred<void>()
    manager.onCreateRuntime = async ({ descriptor, creationCount }) => {
      if (descriptor.agentId !== worker.agentId || creationCount !== 2) {
        return
      }

      replacementCreationStarted.resolve(undefined)
      await releaseReplacementCreation.promise
    }

    const fallbackPromise = (manager as any).handleRuntimeError(worker.agentId, {
      phase: 'prompt_dispatch',
      message: '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
    })

    await replacementCreationStarted.promise
    await manager.stopWorker(worker.agentId)
    releaseReplacementCreation.resolve(undefined)
    await fallbackPromise

    const managerState = manager as unknown as {
      runtimes: Map<string, SwarmAgentRuntime>
    }
    expect(managerState.runtimes.has(worker.agentId)).toBe(false)
    expect(manager.getAgent(worker.agentId)?.status).toBe('idle')
    expect(manager.getAgent(worker.agentId)?.model).toEqual({
      provider: 'anthropic',
      modelId: 'claude-opus-4-6',
      thinkingLevel: 'high',
    })
  })

  it('does not resurrect a worker with a replacement runtime after killAgent during delayed fallback handoff', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)

    await mkdir(join(config.paths.sharedDir, 'specialists'), { recursive: true })
    await writeFile(
      join(config.paths.sharedDir, 'specialists', 'planner.md'),
      [
        '---',
        'displayName: Planner',
        'color: "#7c3aed"',
        'enabled: true',
        'whenToUse: Planning work.',
        'modelId: claude-opus-4-6',
        'reasoningLevel: high',
        'fallbackModelId: gpt-5.4',
        'fallbackReasoningLevel: high',
        '---',
        'You are the planner specialist.'
      ].join('\n'),
      'utf8',
    )

    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', {
      agentId: 'Planner Kill During Handoff Worker',
      specialist: 'planner',
    })
    const originalRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(originalRuntime).toBeDefined()
    originalRuntime!.specialistFallbackReplayMessage = {
      text: 'Retry original request.',
      images: [],
    }

    const replacementCreationStarted = createDeferred<void>()
    const releaseReplacementCreation = createDeferred<void>()
    manager.onCreateRuntime = async ({ descriptor, creationCount }) => {
      if (descriptor.agentId !== worker.agentId || creationCount !== 2) {
        return
      }

      replacementCreationStarted.resolve(undefined)
      await releaseReplacementCreation.promise
    }

    const fallbackPromise = (manager as any).handleRuntimeError(worker.agentId, {
      phase: 'prompt_dispatch',
      message: '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
    })

    await replacementCreationStarted.promise
    await manager.killAgent('manager', worker.agentId)
    releaseReplacementCreation.resolve(undefined)
    await fallbackPromise

    const managerState = manager as unknown as {
      runtimes: Map<string, SwarmAgentRuntime>
    }
    expect(managerState.runtimes.has(worker.agentId)).toBe(false)
    expect(manager.getAgent(worker.agentId)?.status).toBe('terminated')
  })

  it('does not restore a dead original runtime after fallback replay failure during handoff', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)

    await mkdir(join(config.paths.sharedDir, 'specialists'), { recursive: true })
    await writeFile(
      join(config.paths.sharedDir, 'specialists', 'planner.md'),
      [
        '---',
        'displayName: Planner',
        'color: "#7c3aed"',
        'enabled: true',
        'whenToUse: Planning work.',
        'modelId: claude-opus-4-6',
        'reasoningLevel: high',
        'fallbackModelId: gpt-5.4',
        'fallbackReasoningLevel: high',
        '---',
        'You are the planner specialist.'
      ].join('\n'),
      'utf8',
    )

    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', {
      agentId: 'Planner Dead Original Runtime Worker',
      specialist: 'planner',
    })
    const originalRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(originalRuntime).toBeDefined()
    originalRuntime!.specialistFallbackReplayMessage = {
      text: 'Retry original request.',
      images: [],
    }

    const managerState = manager as unknown as {
      runtimeTokensByAgentId: Map<string, number>
      handleRuntimeStatus: (runtimeToken: number, agentId: string, status: AgentStatus, pendingCount: number) => Promise<void>
      handleRuntimeError: (runtimeToken: number, agentId: string, error: RuntimeErrorEvent) => Promise<void>
      runtimes: Map<string, SwarmAgentRuntime>
    }
    const originalRuntimeToken = managerState.runtimeTokensByAgentId.get(worker.agentId) ?? 101
    managerState.runtimeTokensByAgentId.set(worker.agentId, originalRuntimeToken)

    originalRuntime!.descriptor.status = 'streaming'
    await managerState.handleRuntimeStatus(originalRuntimeToken, worker.agentId, 'streaming', 0)

    manager.onCreateRuntime = async ({ descriptor, runtime, creationCount }) => {
      if (descriptor.agentId !== worker.agentId || creationCount !== 2) {
        return
      }

      originalRuntime!.descriptor.status = 'terminated'
      await managerState.handleRuntimeStatus(originalRuntimeToken, worker.agentId, 'terminated', 0)
      runtime.sendMessageError = new Error('fallback replay boom')
    }

    await managerState.handleRuntimeError(originalRuntimeToken, worker.agentId, {
      phase: 'prompt_dispatch',
      message: '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
    })

    expect(managerState.runtimes.has(worker.agentId)).toBe(false)
    expect(originalRuntime?.terminateCalls).toHaveLength(1)
    expect(
      manager
        .getConversationHistory(worker.agentId)
        .some(
          (entry) =>
            entry.type === 'conversation_message' &&
            entry.role === 'system' &&
            entry.text.includes('Message may need to be resent.'),
        ),
    ).toBe(true)
  })

  it('does not restore the old runtime after stopWorker interrupts replacement replay', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)

    await mkdir(join(config.paths.sharedDir, 'specialists'), { recursive: true })
    await writeFile(
      join(config.paths.sharedDir, 'specialists', 'planner.md'),
      [
        '---',
        'displayName: Planner',
        'color: "#7c3aed"',
        'enabled: true',
        'whenToUse: Planning work.',
        'modelId: claude-opus-4-6',
        'reasoningLevel: high',
        'fallbackModelId: gpt-5.4',
        'fallbackReasoningLevel: high',
        '---',
        'You are the planner specialist.'
      ].join('\n'),
      'utf8',
    )

    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', {
      agentId: 'Planner Stop During Replay Worker',
      specialist: 'planner',
    })
    const originalRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(originalRuntime).toBeDefined()
    originalRuntime!.specialistFallbackReplaySnapshot = {
      messages: [
        { text: 'Replay one', images: [] },
        { text: 'Replay two', images: [] },
      ],
    }

    const secondReplayStarted = createDeferred<void>()
    const releaseSecondReplay = createDeferred<void>()
    let replacementRuntime: FakeRuntime | undefined
    manager.onCreateRuntime = ({ descriptor, runtime, creationCount }) => {
      if (descriptor.agentId !== worker.agentId || creationCount !== 2) {
        return
      }

      replacementRuntime = runtime
      runtime.onSendMessage = async () => {
        if (runtime.sendCalls.length !== 2) {
          return
        }

        secondReplayStarted.resolve(undefined)
        await releaseSecondReplay.promise
      }
    }

    const fallbackPromise = (manager as any).handleRuntimeError(worker.agentId, {
      phase: 'prompt_dispatch',
      message: '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
    })

    await secondReplayStarted.promise
    replacementRuntime!.sendMessageError = new Error('replacement replay interrupted')
    await manager.stopWorker(worker.agentId)
    releaseSecondReplay.resolve(undefined)
    await fallbackPromise

    const managerState = manager as unknown as {
      runtimes: Map<string, SwarmAgentRuntime>
    }
    expect(managerState.runtimes.has(worker.agentId)).toBe(false)
    expect(originalRuntime?.terminateCalls).toHaveLength(1)
    expect(manager.getAgent(worker.agentId)?.status).toBe('idle')
    expect(manager.getAgent(worker.agentId)?.model).toEqual({
      provider: 'openai-codex',
      modelId: 'gpt-5.4',
      thinkingLevel: 'high',
    })
  })

  it('does not restore the old runtime after killAgent interrupts replacement replay', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)

    await mkdir(join(config.paths.sharedDir, 'specialists'), { recursive: true })
    await writeFile(
      join(config.paths.sharedDir, 'specialists', 'planner.md'),
      [
        '---',
        'displayName: Planner',
        'color: "#7c3aed"',
        'enabled: true',
        'whenToUse: Planning work.',
        'modelId: claude-opus-4-6',
        'reasoningLevel: high',
        'fallbackModelId: gpt-5.4',
        'fallbackReasoningLevel: high',
        '---',
        'You are the planner specialist.'
      ].join('\n'),
      'utf8',
    )

    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', {
      agentId: 'Planner Kill During Replay Worker',
      specialist: 'planner',
    })
    const originalRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(originalRuntime).toBeDefined()
    originalRuntime!.specialistFallbackReplaySnapshot = {
      messages: [
        { text: 'Replay one', images: [] },
        { text: 'Replay two', images: [] },
      ],
    }

    const secondReplayStarted = createDeferred<void>()
    const releaseSecondReplay = createDeferred<void>()
    let replacementRuntime: FakeRuntime | undefined
    manager.onCreateRuntime = ({ descriptor, runtime, creationCount }) => {
      if (descriptor.agentId !== worker.agentId || creationCount !== 2) {
        return
      }

      replacementRuntime = runtime
      runtime.onSendMessage = async () => {
        if (runtime.sendCalls.length !== 2) {
          return
        }

        secondReplayStarted.resolve(undefined)
        await releaseSecondReplay.promise
      }
    }

    const fallbackPromise = (manager as any).handleRuntimeError(worker.agentId, {
      phase: 'prompt_dispatch',
      message: '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
    })

    await secondReplayStarted.promise
    replacementRuntime!.sendMessageError = new Error('replacement replay interrupted')
    await manager.killAgent('manager', worker.agentId)
    releaseSecondReplay.resolve(undefined)
    await fallbackPromise

    const managerState = manager as unknown as {
      runtimes: Map<string, SwarmAgentRuntime>
    }
    expect(managerState.runtimes.has(worker.agentId)).toBe(false)
    expect(originalRuntime?.terminateCalls).toHaveLength(1)
    expect(manager.getAgent(worker.agentId)?.status).toBe('terminated')
    expect(manager.getAgent(worker.agentId)?.model).toEqual({
      provider: 'openai-codex',
      modelId: 'gpt-5.4',
      thinkingLevel: 'high',
    })
  })

  it('does not restore the old runtime after delete interrupts replacement replay', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)

    await mkdir(join(config.paths.sharedDir, 'specialists'), { recursive: true })
    await writeFile(
      join(config.paths.sharedDir, 'specialists', 'planner.md'),
      [
        '---',
        'displayName: Planner',
        'color: "#7c3aed"',
        'enabled: true',
        'whenToUse: Planning work.',
        'modelId: claude-opus-4-6',
        'reasoningLevel: high',
        'fallbackModelId: gpt-5.4',
        'fallbackReasoningLevel: high',
        '---',
        'You are the planner specialist.'
      ].join('\n'),
      'utf8',
    )

    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', {
      agentId: 'Planner Delete During Replay Worker',
      specialist: 'planner',
    })
    const originalRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(originalRuntime).toBeDefined()
    originalRuntime!.specialistFallbackReplaySnapshot = {
      messages: [
        { text: 'Replay one', images: [] },
        { text: 'Replay two', images: [] },
      ],
    }

    const secondReplayStarted = createDeferred<void>()
    const releaseSecondReplay = createDeferred<void>()
    let replacementRuntime: FakeRuntime | undefined
    manager.onCreateRuntime = ({ descriptor, runtime, creationCount }) => {
      if (descriptor.agentId !== worker.agentId || creationCount !== 2) {
        return
      }

      replacementRuntime = runtime
      runtime.onSendMessage = async () => {
        if (runtime.sendCalls.length !== 2) {
          return
        }

        secondReplayStarted.resolve(undefined)
        await releaseSecondReplay.promise
      }
    }

    const fallbackPromise = (manager as any).handleRuntimeError(worker.agentId, {
      phase: 'prompt_dispatch',
      message: '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
    })

    await secondReplayStarted.promise
    replacementRuntime!.sendMessageError = new Error('replacement replay interrupted')
    const managerState = manager as unknown as {
      descriptors: Map<string, AgentDescriptor>
      runtimes: Map<string, SwarmAgentRuntime>
    }
    managerState.runtimes.delete(worker.agentId)
    managerState.descriptors.delete(worker.agentId)
    releaseSecondReplay.resolve(undefined)
    await fallbackPromise

    expect(managerState.runtimes.has(worker.agentId)).toBe(false)
    expect(originalRuntime?.terminateCalls).toHaveLength(1)
    expect(manager.getAgent(worker.agentId)).toBeUndefined()
  })

  it('does not resurrect a deleted worker session with a replacement runtime after delayed fallback handoff', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)

    await bootWithDefaultManager(manager, config)

    await mkdir(join(config.paths.sharedDir, 'specialists'), { recursive: true })
    await writeFile(
      join(config.paths.sharedDir, 'specialists', 'planner.md'),
      [
        '---',
        'displayName: Planner',
        'color: "#7c3aed"',
        'enabled: true',
        'whenToUse: Planning work.',
        'modelId: claude-opus-4-6',
        'reasoningLevel: high',
        'fallbackModelId: gpt-5.4',
        'fallbackReasoningLevel: high',
        '---',
        'You are the planner specialist.'
      ].join('\n'),
      'utf8',
    )

    const worker = await manager.spawnAgent('manager', {
      agentId: 'Planner Delete During Handoff Worker',
    })
    const workerDescriptor = manager.getAgent(worker.agentId)
    expect(workerDescriptor).toBeDefined()
    if (!workerDescriptor || workerDescriptor.role !== 'worker') {
      throw new Error('Expected worker descriptor')
    }
    workerDescriptor.specialistId = 'planner'
    workerDescriptor.model = {
      provider: 'anthropic',
      modelId: 'claude-opus-4-6',
      thinkingLevel: 'high',
    }

    const originalRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(originalRuntime).toBeDefined()
    originalRuntime!.specialistFallbackReplayMessage = {
      text: 'Retry original request.',
      images: [],
    }

    const releaseFallbackModel = createDeferred<void>()
    const originalResolveFallbackModel = (manager as any).resolveSpecialistFallbackModelForDescriptor.bind(manager)
    ;(manager as any).resolveSpecialistFallbackModelForDescriptor = async (...args: unknown[]) => {
      await releaseFallbackModel.promise
      return await originalResolveFallbackModel(...args)
    }

    const fallbackPromise = (manager as any).handleRuntimeError(worker.agentId, {
      phase: 'prompt_dispatch',
      message: '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
    })

    await Promise.resolve()
    const managerState = manager as unknown as {
      descriptors: Map<string, AgentDescriptor>
      runtimes: Map<string, SwarmAgentRuntime>
    }
    managerState.runtimes.delete(worker.agentId)
    managerState.descriptors.delete(worker.agentId)
    releaseFallbackModel.resolve(undefined)
    await fallbackPromise
    ;(manager as any).resolveSpecialistFallbackModelForDescriptor = originalResolveFallbackModel

    expect(managerState.runtimes.has(worker.agentId)).toBe(false)
    expect(manager.getAgent(worker.agentId)).toBeUndefined()
  })

  it('waits for the replacement runtime during fallback handoff so concurrent sends are not lost on the old runtime', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)

    await mkdir(join(config.paths.sharedDir, 'specialists'), { recursive: true })
    await writeFile(
      join(config.paths.sharedDir, 'specialists', 'planner.md'),
      [
        '---',
        'displayName: Planner',
        'color: "#7c3aed"',
        'enabled: true',
        'whenToUse: Planning work.',
        'modelId: claude-opus-4-6',
        'reasoningLevel: high',
        'fallbackModelId: gpt-5.4',
        'fallbackReasoningLevel: high',
        '---',
        'You are the planner specialist.'
      ].join('\n'),
      'utf8',
    )

    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', {
      agentId: 'Planner Handoff Wait Worker',
      specialist: 'planner',
    })
    const originalRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(originalRuntime).toBeDefined()

    originalRuntime!.specialistFallbackReplayMessage = {
      text: 'Retry original request.',
      images: [],
    }

    const replacementCreationStarted = createDeferred<void>()
    const releaseReplacementCreation = createDeferred<void>()
    manager.onCreateRuntime = async ({ descriptor, creationCount }) => {
      if (descriptor.agentId !== worker.agentId || creationCount !== 2) {
        return
      }

      replacementCreationStarted.resolve(undefined)
      await releaseReplacementCreation.promise
    }

    const fallbackPromise = (manager as any).handleRuntimeError(worker.agentId, {
      phase: 'prompt_dispatch',
      message: '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
    })

    await replacementCreationStarted.promise

    const concurrentSendPromise = manager.sendMessage('manager', worker.agentId, 'mid-handoff follow-up', 'auto', {
      origin: 'internal',
    })

    await Promise.resolve()
    expect(originalRuntime?.sendCalls).toEqual([])

    releaseReplacementCreation.resolve(undefined)
    await fallbackPromise
    await concurrentSendPromise

    const replacementRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(replacementRuntime).toBeDefined()
    expect(replacementRuntime).not.toBe(originalRuntime)
    expect(replacementRuntime?.sendCalls).toEqual([
      {
        message: {
          text: 'Retry original request.',
          images: [],
        },
        delivery: 'auto',
      },
      {
        message: 'SYSTEM: mid-handoff follow-up',
        delivery: 'auto',
      },
    ])
  })

  it('restores the original runtime session state after fallback rollback if replay later fails', async () => {
    const config = await makeTempConfig()
    const manager = new RuntimeFallbackReplayTestManager(config)

    await mkdir(join(config.paths.sharedDir, 'specialists'), { recursive: true })
    await writeFile(
      join(config.paths.sharedDir, 'specialists', 'planner.md'),
      [
        '---',
        'displayName: Planner',
        'color: "#7c3aed"',
        'enabled: true',
        'whenToUse: Planning work.',
        'modelId: claude-opus-4-6',
        'reasoningLevel: high',
        'fallbackModelId: gpt-5.4',
        'fallbackReasoningLevel: high',
        '---',
        'You are the planner specialist.'
      ].join('\n'),
      'utf8',
    )

    manager.fallbackReplayWorkerId = 'planner-rollback-state-worker'
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', {
      agentId: 'Planner Rollback State Worker',
      specialist: 'planner',
    })
    const activeRuntime = manager.fallbackReplayRuntimeByAgentId.get(worker.agentId)
    const activeSession = manager.fallbackReplaySessionByAgentId.get(worker.agentId)
    expect(activeRuntime).toBeDefined()
    expect(activeSession).toBeDefined()

    const firstPromptStarted = createDeferred<void>()
    const releaseFirstPrompt = createDeferred<void>()
    activeSession!.promptImpl = async (message: string) => {
      if (message === 'first prompt') {
        firstPromptStarted.resolve(undefined)
        await releaseFirstPrompt.promise
      }
    }

    await activeRuntime!.sendMessage('first prompt', 'auto')
    await firstPromptStarted.promise
    await activeRuntime!.sendMessage('second prompt', 'auto')
    releaseFirstPrompt.resolve(undefined)

    activeSession!.emit({
      type: 'message_start',
      message: {
        role: 'user',
        content: 'second prompt',
      },
    })
    await Promise.resolve()

    activeSession!.state.messages = [
      { role: 'user', content: 'first prompt' },
      { role: 'user', content: 'second prompt' },
      { role: 'assistant', stopReason: 'error', content: [] },
    ] as any
    ;(activeSession as any).sessionMessages = structuredClone(activeSession!.state.messages)
    const originalMessages = structuredClone(activeSession!.state.messages)

    manager.onCreateRuntime = ({ descriptor, runtime, creationCount }) => {
      if (descriptor.agentId === worker.agentId && creationCount === 2) {
        runtime.sendMessageError = new Error('fallback replay boom')
      }
    }

    await (manager as any).handleRuntimeSessionEvent(worker.agentId, {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage:
          '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
      },
    })

    expect(activeSession!.state.messages).toEqual(originalMessages)
  })

  it('suppresses stale old-runtime callbacks while specialist fallback handoff is in progress', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)

    await mkdir(join(config.paths.sharedDir, 'specialists'), { recursive: true })
    await writeFile(
      join(config.paths.sharedDir, 'specialists', 'planner.md'),
      [
        '---',
        'displayName: Planner',
        'color: "#7c3aed"',
        'enabled: true',
        'whenToUse: Planning work.',
        'modelId: claude-opus-4-6',
        'reasoningLevel: high',
        'fallbackModelId: gpt-5.4',
        'fallbackReasoningLevel: high',
        '---',
        'You are the planner specialist.'
      ].join('\n'),
      'utf8',
    )

    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', {
      agentId: 'Planner Race Worker',
      specialist: 'planner',
    })
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    const originalRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(managerRuntime).toBeDefined()
    expect(originalRuntime).toBeDefined()

    originalRuntime!.specialistFallbackReplayMessage = {
      text: 'Retry the implementation plan.',
      images: [],
    }

    let releaseReplacementCreation: (() => void) | undefined
    const replacementCreationStarted = new Promise<void>((resolve) => {
      manager.onCreateRuntime = async ({ descriptor, creationCount }) => {
        if (descriptor.agentId !== worker.agentId || creationCount !== 2) {
          return
        }

        resolve()
        await new Promise<void>((continueResolve) => {
          releaseReplacementCreation = continueResolve
        })
      }
    })

    const managerState = manager as unknown as {
      runtimeTokensByAgentId: Map<string, number>
      handleRuntimeError: (runtimeToken: number, agentId: string, error: RuntimeErrorEvent) => Promise<void>
      handleRuntimeSessionEvent: (runtimeToken: number, agentId: string, event: RuntimeSessionEvent) => Promise<void>
      handleRuntimeAgentEnd: (runtimeToken: number, agentId: string) => Promise<void>
    }
    const originalRuntimeToken = managerState.runtimeTokensByAgentId.get(worker.agentId) ?? 101
    managerState.runtimeTokensByAgentId.set(worker.agentId, originalRuntimeToken)
    expect(originalRuntimeToken).toBeTypeOf('number')

    const fallbackPromise = managerState.handleRuntimeError(originalRuntimeToken as number, worker.agentId, {
      phase: 'prompt_dispatch',
      message: '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
    })

    await replacementCreationStarted

    await managerState.handleRuntimeSessionEvent(originalRuntimeToken as number, worker.agentId, {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: 'late stale runtime error',
      },
    })
    await managerState.handleRuntimeAgentEnd(originalRuntimeToken as number, worker.agentId)

    releaseReplacementCreation?.()
    await fallbackPromise

    expect(managerRuntime?.sendCalls).toHaveLength(0)
    expect(
      manager
        .getConversationHistory(worker.agentId)
        .some(
          (entry) =>
            entry.type === 'conversation_message' &&
            entry.role === 'system' &&
            entry.text.includes('late stale runtime error'),
        ),
    ).toBe(false)
  })

  it('suppresses duplicate auto-reports when the latest summary was already reported', async () => {
    const config = await makeTempConfig()
    let tick = 0
    const now = () => new Date(Date.parse('2026-01-01T00:00:00.000Z') + tick++).toISOString()
    const manager = new TestSwarmManager(config, { now })
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Repeat Summary Worker' })
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    expect(managerRuntime).toBeDefined()

    await (manager as any).handleRuntimeSessionEvent(worker.agentId, {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Initial completion summary.' }],
      },
    })

    await (manager as any).handleRuntimeAgentEnd(worker.agentId)

    managerRuntime!.sendCalls = []

    await (manager as any).handleRuntimeAgentEnd(worker.agentId)

    expect(managerRuntime?.sendCalls).toHaveLength(0)
  })

  it('suppresses duplicate end callbacks after an errored worker turn instead of falling back to a generic completion signal', async () => {
    const config = await makeTempConfig()
    let tick = 0
    const now = () => new Date(Date.parse('2026-01-01T00:00:00.000Z') + tick++).toISOString()
    const manager = new TestSwarmManager(config, { now })
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Duplicate Error Worker' })
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    expect(managerRuntime).toBeDefined()

    await (manager as any).handleRuntimeSessionEvent(worker.agentId, {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage:
          '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
      },
    })

    await waitForCondition(() =>
      manager
        .getConversationHistory(worker.agentId)
        .some(
          (entry) =>
            entry.type === 'conversation_message' &&
            entry.role === 'system' &&
            entry.text.includes('⚠️ Worker reply failed:'),
        ),
    )

    managerRuntime!.sendCalls = []

    await (manager as any).handleRuntimeAgentEnd(worker.agentId)
    await (manager as any).handleRuntimeAgentEnd(worker.agentId)

    expect(managerRuntime?.sendCalls).toHaveLength(1)
    expect(managerRuntime?.sendCalls[0]).toMatchObject({
      delivery: 'auto',
      message:
        'SYSTEM: Worker duplicate-error-worker ended its turn with an error.\n\nLast system message:\n⚠️ Worker reply failed: This request would exceed your account\'s rate limit. Please try again later. The manager may need to retry after checking provider auth, quotas, or rate limits.',
    })
  })

  it.each([
    {
      label: 'worker reply failures projected from message_end errors',
      trigger: async (manager: TestSwarmManager, workerId: string) => {
        await (manager as any).handleRuntimeSessionEvent(workerId, {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [],
            stopReason: 'error',
            errorMessage: 'Prompt is too long for this model context window.',
          },
        })
      },
      expectedSummaryLine:
        '⚠️ Worker reply failed because the prompt exceeded the model context window (Prompt is too long for this model context window.). The manager may need to compact the task context before retrying.',
    },
    {
      label: 'agent runtime errors',
      trigger: async (manager: TestSwarmManager, workerId: string) => {
        await (manager as any).handleRuntimeError(workerId, {
          phase: 'prompt_dispatch',
          message: 'backend socket closed unexpectedly',
        })
      },
      expectedSummaryLine:
        '⚠️ Agent error: backend socket closed unexpectedly. Message may need to be resent.',
    },
    {
      label: 'extension runtime errors',
      trigger: async (manager: TestSwarmManager, workerId: string) => {
        await (manager as any).handleRuntimeError(workerId, {
          phase: 'extension',
          message: 'blocked write outside allowed roots',
          details: {
            extensionPath: '/tmp/protected-paths.ts',
            event: 'tool_call',
          },
        })
      },
      expectedSummaryLine:
        '⚠️ Extension error (protected-paths.ts · tool_call): blocked write outside allowed roots',
    },
    {
      label: 'context guard errors',
      trigger: async (manager: TestSwarmManager, workerId: string) => {
        await (manager as any).handleRuntimeError(workerId, {
          phase: 'context_guard',
          message: 'context guard rejected the pending prompt',
        })
      },
      expectedSummaryLine:
        '⚠️ Context guard error: context guard rejected the pending prompt.',
    },
    {
      label: 'context recovery failures',
      trigger: async (manager: TestSwarmManager, workerId: string) => {
        await (manager as any).handleRuntimeError(workerId, {
          phase: 'compaction',
          message: 'failed to rebuild compacted context',
          details: {
            recoveryStage: 'recovery_failed',
          },
        })
      },
      expectedSummaryLine:
        '🚨 Context recovery failed: failed to rebuild compacted context. Start a new session or manually trim history/compact before continuing.',
    },
  ])('classifies $label as worker turn errors in auto-reports', async ({ trigger, expectedSummaryLine }) => {
    const config = await makeTempConfig()
    let tick = 0
    const now = () => new Date(Date.parse('2026-01-01T00:00:00.000Z') + tick++).toISOString()
    const manager = new TestSwarmManager(config, { now })
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Worker Error Variant' })
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    expect(managerRuntime).toBeDefined()

    await trigger(manager, worker.agentId)

    await waitForCondition(() =>
      manager
        .getConversationHistory(worker.agentId)
        .some(
          (entry) =>
            entry.type === 'conversation_message' &&
            entry.role === 'system' &&
            entry.text === expectedSummaryLine,
        ),
    )

    managerRuntime!.sendCalls = []

    await (manager as any).handleRuntimeAgentEnd(worker.agentId)

    expect(managerRuntime?.sendCalls).toHaveLength(1)
    expect(managerRuntime?.sendCalls[0]).toMatchObject({
      delivery: 'auto',
      message:
        `SYSTEM: Worker worker-error-variant ended its turn with an error.\n\nLast system message:\n${expectedSummaryLine}`,
    })
  })

  it('does not replay stale worker summaries when recreating an idle worker runtime', async () => {
    const config = await makeTempConfig()

    appendSessionConversationMessage(join(config.paths.sessionsDir, 'worker-idle.jsonl'), 'worker-idle', 'stale summary')

    await writeFile(
      config.paths.agentsStoreFile,
      JSON.stringify(
        {
          agents: [
            {
              agentId: 'manager',
              displayName: 'Manager',
              role: 'manager',
              managerId: 'manager',
              status: 'idle',
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
              cwd: config.defaultCwd,
              model: config.defaultModel,
              sessionFile: join(config.paths.sessionsDir, 'manager.jsonl'),
            },
            {
              agentId: 'worker-idle',
              displayName: 'Worker Idle',
              role: 'worker',
              managerId: 'manager',
              status: 'idle',
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
              cwd: config.defaultCwd,
              model: config.defaultModel,
              sessionFile: join(config.paths.sessionsDir, 'worker-idle.jsonl'),
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    )

    const manager = new TestSwarmManager(config)
    await manager.boot()

    await manager.sendMessage('manager', 'manager', 'bootstrap manager runtime')
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    expect(managerRuntime).toBeDefined()
    managerRuntime!.sendCalls = []

    await manager.sendMessage('manager', 'worker-idle', 'start now')
    await (manager as any).handleRuntimeAgentEnd('worker-idle')

    expect(managerRuntime).toBeDefined()
    expect(managerRuntime?.sendCalls.at(-1)?.message).toBe('SYSTEM: Worker worker-idle completed its turn.')
  })

  it('falls back to watchdog notifications when auto completion reporting fails', async () => {
    vi.useFakeTimers()

    try {
      const config = await makeTempConfig()
      const manager = new TestSwarmManager(config)
      await bootWithDefaultManager(manager, config)

      const worker = await manager.spawnAgent('manager', { agentId: 'Watchdog Worker' })
      const managerRuntime = manager.runtimeByAgentId.get('manager')
      expect(managerRuntime).toBeDefined()

      const originalSendMessage = managerRuntime!.sendMessage.bind(managerRuntime)
      let shouldFailAutoReport = true
      ;(managerRuntime as any).sendMessage = async (
        message: string,
        delivery?: RequestedDeliveryMode,
      ) => {
        if (shouldFailAutoReport && message.includes('completed its turn')) {
          shouldFailAutoReport = false
          throw new Error('synthetic auto-report failure')
        }

        return originalSendMessage(message, delivery)
      }

      await (manager as any).handleRuntimeSessionEvent(worker.agentId, {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Done.' }],
        },
      })

      managerRuntime!.sendCalls = []

      await (manager as any).handleRuntimeAgentEnd(worker.agentId)
      await vi.advanceTimersByTimeAsync(3_800)

      expect(
        managerRuntime?.sendCalls.some(
          (call) =>
            typeof call.message === 'string' && call.message.includes('IDLE WORKER WATCHDOG'),
        ),
      ).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('kills a busy runtime with abort then marks descriptor terminated', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Killable Worker' })
    const runtime = manager.runtimeByAgentId.get(worker.agentId)
    expect(runtime).toBeDefined()

    await manager.killAgent('manager', worker.agentId)

    expect(runtime!.terminateCalls).toEqual([
      expect.objectContaining({ abort: true }),
    ])
    const descriptor = manager.listAgents().find((agent) => agent.agentId === worker.agentId)
    expect(descriptor?.status).toBe('terminated')
  })

  it('stops all agents by cancelling in-flight work without terminating runtimes', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Stop-All Worker' })
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    const workerRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(managerRuntime).toBeDefined()
    expect(workerRuntime).toBeDefined()

    const state = manager as unknown as { descriptors: Map<string, AgentDescriptor> }
    const managerDescriptor = state.descriptors.get('manager')
    const workerDescriptor = state.descriptors.get(worker.agentId)
    expect(managerDescriptor).toBeDefined()
    expect(workerDescriptor).toBeDefined()

    managerDescriptor!.status = 'streaming'
    workerDescriptor!.status = 'streaming'
    managerRuntime!.busy = true
    workerRuntime!.busy = true

    const stopped = await manager.stopAllAgents('manager', 'manager')

    expect(stopped).toEqual({
      managerId: 'manager',
      stoppedWorkerIds: [worker.agentId],
      managerStopped: true,
      terminatedWorkerIds: [worker.agentId],
      managerTerminated: true,
    })
    expect(managerRuntime!.stopInFlightCalls).toEqual([
      expect.objectContaining({ abort: true }),
    ])
    expect(workerRuntime!.stopInFlightCalls).toEqual([
      expect.objectContaining({ abort: true }),
    ])
    expect(managerRuntime!.terminateCalls).toEqual([])
    expect(workerRuntime!.terminateCalls).toEqual([])

    const managerAfter = manager.listAgents().find((agent) => agent.agentId === 'manager')
    const workerAfter = manager.listAgents().find((agent) => agent.agentId === worker.agentId)
    expect(managerAfter?.status).toBe('idle')
    expect(workerAfter?.status).toBe('idle')
    expect(manager.runtimeByAgentId.has('manager')).toBe(true)
    expect(manager.runtimeByAgentId.has(worker.agentId)).toBe(true)
  })

  it('marks the manager stop notice before worker shutdown during stopAllAgents', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Stop-All Worker' })
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    const workerRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(managerRuntime).toBeDefined()
    expect(workerRuntime).toBeDefined()

    const state = manager as unknown as { descriptors: Map<string, AgentDescriptor> }
    const managerDescriptor = state.descriptors.get('manager')
    const workerDescriptor = state.descriptors.get(worker.agentId)
    expect(managerDescriptor).toBeDefined()
    expect(workerDescriptor).toBeDefined()

    managerDescriptor!.status = 'streaming'
    workerDescriptor!.status = 'streaming'
    managerRuntime!.busy = true
    workerRuntime!.busy = true

    const originalStopInFlight = workerRuntime!.stopInFlight.bind(workerRuntime)
    workerRuntime!.stopInFlight = async (options) => {
      await (manager as any).handleRuntimeSessionEvent('manager', {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [],
          stopReason: 'error',
          errorMessage: 'Request was aborted.',
        },
      })

      await originalStopInFlight(options)
    }

    await manager.stopAllAgents('manager', 'manager')

    const history = manager.getConversationHistory('manager')
    expect(
      history.some(
        (entry) =>
          entry.type === 'conversation_message' &&
          entry.role === 'system' &&
          entry.text === 'Session stopped.',
      ),
    ).toBe(true)
    expect(
      history.some(
        (entry) =>
          entry.type === 'conversation_message' &&
          entry.role === 'system' &&
          entry.text.includes('Manager reply failed'),
      ),
    ).toBe(false)
  })

  it('normalizes persisted streaming workers to idle on restart without recreating runtimes', async () => {
    const config = await makeTempConfig()

    const seedAgents = {
      agents: [
        {
          agentId: 'manager',
          displayName: 'Manager',
          role: 'manager',
          managerId: 'manager',
          status: 'idle',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: config.defaultCwd,
          model: config.defaultModel,
          sessionFile: join(config.paths.sessionsDir, 'manager.jsonl'),
        },
        {
          agentId: 'worker-a',
          displayName: 'Worker A',
          role: 'worker',
          managerId: 'manager',
          status: 'streaming',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: config.defaultCwd,
          model: config.defaultModel,
          sessionFile: join(config.paths.sessionsDir, 'worker-a.jsonl'),
        },
      ],
    }

    await writeFile(config.paths.agentsStoreFile, JSON.stringify(seedAgents, null, 2), 'utf8')

    const manager = new TestSwarmManager(config)
    await manager.boot()

    const agents = manager.listAgents()
    const worker = agents.find((agent) => agent.agentId === 'worker-a')
    const persistedStore = JSON.parse(await readFile(config.paths.agentsStoreFile, 'utf8')) as {
      agents: Array<{ agentId: string; status: AgentDescriptor['status'] }>
    }
    const persistedWorker = persistedStore.agents.find((agent) => agent.agentId === 'worker-a')

    expect(worker?.status).toBe('idle')
    expect(persistedWorker?.status).toBe('idle')
    expect(manager.createdRuntimeIds).toEqual([])
    expect(manager.runtimeByAgentId.get('manager')).toBeUndefined()
    expect(manager.runtimeByAgentId.get('worker-a')).toBeUndefined()
  })

  it('migrates persisted stopped_on_restart statuses to stopped at boot', async () => {
    const config = await makeTempConfig()

    const seedAgents = {
      agents: [
        {
          agentId: 'manager',
          displayName: 'Manager',
          role: 'manager',
          managerId: 'manager',
          status: 'idle',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: config.defaultCwd,
          model: config.defaultModel,
          sessionFile: join(config.paths.sessionsDir, 'manager.jsonl'),
        },
        {
          agentId: 'worker-stopped',
          displayName: 'Worker Stopped',
          role: 'worker',
          managerId: 'manager',
          status: 'stopped_on_restart',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: config.defaultCwd,
          model: config.defaultModel,
          sessionFile: join(config.paths.sessionsDir, 'worker-stopped.jsonl'),
        },
      ],
    }

    await writeFile(config.paths.agentsStoreFile, JSON.stringify(seedAgents, null, 2), 'utf8')

    const manager = new TestSwarmManager(config)
    await manager.boot()

    const migrated = manager.listAgents().find((agent) => agent.agentId === 'worker-stopped')
    const persistedStore = JSON.parse(await readFile(config.paths.agentsStoreFile, 'utf8')) as {
      agents: Array<{ agentId: string; status: AgentDescriptor['status'] }>
    }
    const persistedWorker = persistedStore.agents.find((agent) => agent.agentId === 'worker-stopped')

    expect(migrated?.status).toBe('stopped')
    expect(persistedWorker?.status).toBe('stopped')
  })

  it('lazily creates idle runtimes when a restored agent receives work', async () => {
    const config = await makeTempConfig()

    const seedAgents = {
      agents: [
        {
          agentId: 'manager',
          displayName: 'Manager',
          role: 'manager',
          managerId: 'manager',
          status: 'idle',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: config.defaultCwd,
          model: config.defaultModel,
          sessionFile: join(config.paths.sessionsDir, 'manager.jsonl'),
        },
        {
          agentId: 'worker-idle',
          displayName: 'Worker Idle',
          role: 'worker',
          managerId: 'manager',
          status: 'idle',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: config.defaultCwd,
          model: config.defaultModel,
          sessionFile: join(config.paths.sessionsDir, 'worker-idle.jsonl'),
        },
      ],
    }

    await writeFile(config.paths.agentsStoreFile, JSON.stringify(seedAgents, null, 2), 'utf8')

    const manager = new TestSwarmManager(config)
    await manager.boot()

    expect(manager.createdRuntimeIds).toEqual([])
    expect(manager.runtimeByAgentId.get('worker-idle')).toBeUndefined()

    await manager.sendMessage('manager', 'worker-idle', 'start now')

    const runtime = manager.runtimeByAgentId.get('worker-idle')
    expect(runtime).toBeDefined()
    expect(runtime?.sendCalls.at(-1)?.message).toBe('SYSTEM: start now')
    expect(manager.createdRuntimeIds).toEqual(['worker-idle'])
  })

  it('skips terminated histories at boot and lazy-loads them on demand', async () => {
    const config = await makeTempConfig()

    appendSessionConversationMessage(join(config.paths.sessionsDir, 'manager.jsonl'), 'manager', 'manager-history')
    appendSessionConversationMessage(
      join(config.paths.sessionsDir, 'worker-active.jsonl'),
      'worker-active',
      'active-worker-history',
    )
    appendSessionConversationMessage(
      join(config.paths.sessionsDir, 'worker-terminated.jsonl'),
      'worker-terminated',
      'terminated-worker-history',
    )

    const seedAgents = {
      agents: [
        {
          agentId: 'manager',
          displayName: 'Manager',
          role: 'manager',
          managerId: 'manager',
          status: 'idle',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: config.defaultCwd,
          model: config.defaultModel,
          sessionFile: join(config.paths.sessionsDir, 'manager.jsonl'),
        },
        {
          agentId: 'worker-active',
          displayName: 'Worker Active',
          role: 'worker',
          managerId: 'manager',
          status: 'idle',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: config.defaultCwd,
          model: config.defaultModel,
          sessionFile: join(config.paths.sessionsDir, 'worker-active.jsonl'),
        },
        {
          agentId: 'worker-terminated',
          displayName: 'Worker Terminated',
          role: 'worker',
          managerId: 'manager',
          status: 'terminated',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: config.defaultCwd,
          model: config.defaultModel,
          sessionFile: join(config.paths.sessionsDir, 'worker-terminated.jsonl'),
        },
      ],
    }

    await writeFile(config.paths.agentsStoreFile, JSON.stringify(seedAgents, null, 2), 'utf8')

    const manager = new TestSwarmManager(config)
    await manager.boot()

    expect(manager.createdRuntimeIds).toEqual([])
    expect(manager.getLoadedConversationAgentIdsForTest()).toEqual([])

    const terminatedHistory = manager.getConversationHistory('worker-terminated')
    expect(terminatedHistory.some((entry) => 'text' in entry && entry.text === 'terminated-worker-history')).toBe(true)
    expect(manager.getLoadedConversationAgentIdsForTest()).toEqual(['worker-terminated'])
  })

  it('does not implicitly recreate the configured manager when other agents already exist', async () => {
    const config = await makeTempConfig()

    const seedAgents = {
      agents: [
        {
          agentId: 'ops-manager',
          displayName: 'Ops Manager',
          role: 'manager',
          managerId: 'ops-manager',
          status: 'idle',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: config.defaultCwd,
          model: config.defaultModel,
          sessionFile: join(config.paths.sessionsDir, 'ops-manager.jsonl'),
        },
        {
          agentId: 'ops-worker',
          displayName: 'Ops Worker',
          role: 'worker',
          managerId: 'ops-manager',
          status: 'idle',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: config.defaultCwd,
          model: config.defaultModel,
          sessionFile: join(config.paths.sessionsDir, 'ops-worker.jsonl'),
        },
      ],
    }

    await writeFile(config.paths.agentsStoreFile, JSON.stringify(seedAgents, null, 2), 'utf8')

    const manager = new TestSwarmManager(config)
    await manager.boot()

    const agents = manager.listAgents()
    const restoredWorker = agents.find((agent) => agent.agentId === 'ops-worker')

    expect(agents.some((agent) => agent.agentId === 'manager')).toBe(false)
    expect(restoredWorker?.managerId).toBe('ops-manager')
    expect(manager.createdRuntimeIds).toEqual([])
  })

  it('keeps killed workers terminated across restart', async () => {
    const config = await makeTempConfig()
    const firstBoot = new TestSwarmManager(config)
    await bootWithDefaultManager(firstBoot, config)

    const worker = await firstBoot.spawnAgent('manager', { agentId: 'Killed Worker' })
    await firstBoot.killAgent('manager', worker.agentId)

    const secondBoot = new TestSwarmManager(config)
    await bootWithDefaultManager(secondBoot, config)

    const restored = secondBoot.listAgents().find((agent) => agent.agentId === worker.agentId)
    expect(restored?.status).toBe('terminated')
    expect(secondBoot.createdRuntimeIds).toEqual([])

    await expect(secondBoot.sendMessage('manager', worker.agentId, 'still there?')).rejects.toThrow(
      `Target agent is not running: ${worker.agentId}`,
    )
  })

  it('does not duplicate workers across repeated restarts', async () => {
    const config = await makeTempConfig()
    const firstBoot = new TestSwarmManager(config)
    await bootWithDefaultManager(firstBoot, config)

    const worker = await firstBoot.spawnAgent('manager', { agentId: 'Repeat Worker' })

    const secondBoot = new TestSwarmManager(config)
    await bootWithDefaultManager(secondBoot, config)
    expect(secondBoot.listAgents().filter((agent) => agent.agentId === worker.agentId)).toHaveLength(1)
    expect(secondBoot.createdRuntimeIds).toEqual([])

    const thirdBoot = new TestSwarmManager(config)
    await bootWithDefaultManager(thirdBoot, config)
    expect(thirdBoot.listAgents().filter((agent) => agent.agentId === worker.agentId)).toHaveLength(1)
    expect(thirdBoot.createdRuntimeIds).toEqual([])
  })

  it('preserves the active runtime token when clearing a stale token', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const state = manager as any as {
      runtimeTokensByAgentId: Map<string, number>
      clearRuntimeToken: (agentId: string, runtimeToken?: number) => void
    }

    state.runtimeTokensByAgentId.set('manager', 22)
    state.clearRuntimeToken('manager', 11)

    expect(state.runtimeTokensByAgentId.get('manager')).toBe(22)
  })

  it('does not detach a newer runtime when a stale runtime token is provided', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const descriptor = manager.getAgent('manager')
    expect(descriptor).toBeDefined()
    if (!descriptor) {
      throw new Error('Expected manager descriptor')
    }

    const freshRuntime = new FakeRuntime({ ...descriptor })
    const state = manager as any as {
      runtimes: Map<string, SwarmAgentRuntime>
      runtimeTokensByAgentId: Map<string, number>
      detachRuntime: (agentId: string, runtimeToken?: number) => boolean
    }

    state.runtimes.set('manager', freshRuntime as unknown as SwarmAgentRuntime)
    state.runtimeTokensByAgentId.set('manager', 44)

    expect(state.detachRuntime('manager', 33)).toBe(false)
    expect(state.runtimes.get('manager')).toBe(freshRuntime)
    expect(state.runtimeTokensByAgentId.get('manager')).toBe(44)

    expect(state.detachRuntime('manager', 44)).toBe(true)
    expect(state.runtimes.has('manager')).toBe(false)
    expect(state.runtimeTokensByAgentId.has('manager')).toBe(false)
  })

  it('keeps the winning runtime token current when concurrent runtime creation overlaps', async () => {
    const config = await makeTempConfig()

    let releaseCreation!: () => void
    const creationGate = new Promise<void>((resolve) => {
      releaseCreation = resolve
    })

    class ConcurrentRuntimeCreationSwarmManager extends TestSwarmManager {
      blockAgentId: string | null = null
      observedRuntimeTokens: number[] = []

      protected override async createRuntimeForDescriptor(
        descriptor: AgentDescriptor,
        systemPrompt: string,
        runtimeToken?: number,
      ): Promise<SwarmAgentRuntime> {
        if (descriptor.agentId === this.blockAgentId) {
          this.observedRuntimeTokens.push(runtimeToken ?? -1)
          await creationGate
        }

        return super.createRuntimeForDescriptor(descriptor, systemPrompt, runtimeToken)
      }
    }

    const manager = new ConcurrentRuntimeCreationSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Runtime Race Worker' })
    const descriptor = manager.getAgent(worker.agentId)
    expect(descriptor).toBeDefined()
    if (!descriptor) {
      throw new Error('Expected worker descriptor')
    }

    const state = manager as any as {
      runtimes: Map<string, SwarmAgentRuntime>
      runtimeTokensByAgentId: Map<string, number>
      getOrCreateRuntimeForDescriptor: (descriptor: AgentDescriptor) => Promise<SwarmAgentRuntime>
      handleRuntimeStatus: (
        runtimeToken: number,
        agentId: string,
        status: AgentStatus,
        pendingCount: number,
      ) => Promise<void>
    }

    state.runtimes.delete(worker.agentId)
    state.runtimeTokensByAgentId.delete(worker.agentId)
    manager.blockAgentId = worker.agentId

    const firstCreation = state.getOrCreateRuntimeForDescriptor(descriptor)
    await waitForCondition(() => manager.observedRuntimeTokens.length === 1)

    const secondCreation = state.getOrCreateRuntimeForDescriptor(descriptor)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(manager.observedRuntimeTokens).toHaveLength(1)

    releaseCreation()

    const [firstRuntime, secondRuntime] = await Promise.all([firstCreation, secondCreation])
    expect(firstRuntime).toBe(secondRuntime)
    expect(manager.observedRuntimeTokens).toHaveLength(1)

    const winningRuntimeToken = manager.observedRuntimeTokens[0]
    expect(state.runtimeTokensByAgentId.get(worker.agentId)).toBe(winningRuntimeToken)

    await state.handleRuntimeStatus(winningRuntimeToken, worker.agentId, 'streaming', 0)
    expect(manager.getAgent(worker.agentId)?.status).toBe('streaming')
  })

  it('persists manager conversation history to disk and reloads it on restart', async () => {
    const config = await makeTempConfig()
    const firstBoot = new TestSwarmManager(config)
    await bootWithDefaultManager(firstBoot, config)

    await firstBoot.handleUserMessage('persist this')
    await firstBoot.publishToUser('manager', 'saved reply', 'speak_to_user')

    const secondBoot = new TestSwarmManager(config)
    await bootWithDefaultManager(secondBoot, config)

    const history = secondBoot.getConversationHistory('manager')
    expect(
      history.some(
        (message) =>
          message.type === 'conversation_message' &&
          message.text === 'persist this' &&
          message.source === 'user_input',
      ),
    ).toBe(true)
    expect(
      history.some(
        (message) =>
          message.type === 'conversation_message' &&
          message.text === 'saved reply' &&
          message.source === 'speak_to_user',
      ),
    ).toBe(true)
  })

  it('preserves Unicode speak_to_user text through JSONL persistence and reload', async () => {
    const config = await makeTempConfig()
    const firstBoot = new TestSwarmManager(config)
    await bootWithDefaultManager(firstBoot, config)

    const unicodeReply = 'Unicode — “quotes” café'
    await firstBoot.publishToUser('manager', unicodeReply, 'speak_to_user')

    const managerDescriptor = firstBoot.getAgent('manager')
    expect(managerDescriptor).toBeDefined()
    const sessionFile = managerDescriptor?.sessionFile ?? join(config.paths.sessionsDir, 'manager.jsonl')
    const sessionText = await readFile(sessionFile, 'utf8')
    expect(sessionText).toContain(unicodeReply)

    const secondBoot = new TestSwarmManager(config)
    await bootWithDefaultManager(secondBoot, config)

    const history = secondBoot.getConversationHistory('manager')
    expect(
      history.some(
        (message) =>
          message.type === 'conversation_message' &&
          message.text === unicodeReply &&
          message.source === 'speak_to_user',
      ),
    ).toBe(true)
  })

  it('does not trust a stale conversation cache after the canonical session file is truncated', async () => {
    const config = await makeTempConfig()
    const firstBoot = new TestSwarmManager(config)
    await bootWithDefaultManager(firstBoot, config)

    await firstBoot.handleUserMessage('persist this')
    await firstBoot.publishToUser('manager', 'saved reply', 'speak_to_user')

    const managerDescriptor = firstBoot.getAgent('manager')
    expect(managerDescriptor).toBeDefined()

    const sessionFile = managerDescriptor?.sessionFile ?? join(config.paths.sessionsDir, 'manager.jsonl')
    const cacheFile = getConversationHistoryCacheFilePath(sessionFile)
    const cacheText = await waitForFileText(cacheFile)
    expect(cacheText).toContain('persist this')
    expect(cacheText).toContain('saved reply')

    const sessionManager = SessionManager.open(sessionFile)
    const header = sessionManager.getHeader()
    await writeFile(sessionFile, header ? `${JSON.stringify(header)}\n` : '', 'utf8')

    const secondBoot = new TestSwarmManager(config)
    await bootWithDefaultManager(secondBoot, config)

    const history = secondBoot.getConversationHistory('manager')
    expect(history).toEqual([])
  })

  it('preserves web user and speak_to_user history when internal activity overflows history limits', async () => {
    const config = await makeTempConfig()
    const createdAt = '2026-01-01T00:00:00.000Z'
    await writeFile(
      config.paths.agentsStoreFile,
      JSON.stringify(
        {
          agents: [
            {
              agentId: 'manager',
              displayName: 'Manager',
              role: 'manager',
              managerId: 'manager',
              status: 'idle',
              createdAt,
              updatedAt: createdAt,
              cwd: config.defaultCwd,
              model: config.defaultModel,
              sessionFile: join(config.paths.sessionsDir, 'manager.jsonl'),
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    )

    const sessionManager = SessionManager.open(join(config.paths.sessionsDir, 'manager.jsonl'))
    sessionManager.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'seed' }],
    } as any)
    sessionManager.appendCustomEntry('swarm_conversation_entry', {
      type: 'conversation_message',
      agentId: 'manager',
      role: 'user',
      text: 'web message that must persist',
      timestamp: new Date(1).toISOString(),
      source: 'user_input',
      sourceContext: {
        channel: 'web',
      },
    })
    sessionManager.appendCustomEntry('swarm_conversation_entry', {
      type: 'conversation_message',
      agentId: 'manager',
      role: 'assistant',
      text: 'web reply that must persist',
      timestamp: new Date(2).toISOString(),
      source: 'speak_to_user',
      sourceContext: {
        channel: 'web',
      },
    })
    for (let index = 0; index < 2_200; index += 1) {
      sessionManager.appendCustomEntry('swarm_conversation_entry', {
        type: 'agent_message',
        agentId: 'manager',
        timestamp: new Date(3 + index).toISOString(),
        source: 'agent_to_agent',
        fromAgentId: 'manager',
        toAgentId: 'worker',
        text: `internal-message-${index}`,
      })
    }

    const firstBoot = new TestSwarmManager(config)
    await firstBoot.boot()

    const inMemoryHistory = firstBoot.getConversationHistory('manager')
    expect(
      inMemoryHistory.some(
        (entry) =>
          entry.type === 'conversation_message' &&
          entry.source === 'user_input' &&
          entry.text === 'web message that must persist',
      ),
    ).toBe(true)
    expect(
      inMemoryHistory.some(
        (entry) =>
          entry.type === 'conversation_message' &&
          entry.source === 'speak_to_user' &&
          entry.text === 'web reply that must persist',
      ),
    ).toBe(true)
    expect(
      inMemoryHistory.some((entry) => entry.type === 'agent_message' && entry.text === 'internal-message-0'),
    ).toBe(false)
    expect(
      inMemoryHistory.some((entry) => entry.type === 'agent_message' && entry.text === 'internal-message-2199'),
    ).toBe(true)

    const secondBoot = new TestSwarmManager(config)
    await secondBoot.boot()

    const restoredHistory = secondBoot.getConversationHistory('manager')
    expect(
      restoredHistory.some(
        (entry) =>
          entry.type === 'conversation_message' &&
          entry.source === 'user_input' &&
          entry.text === 'web message that must persist',
      ),
    ).toBe(true)
    expect(
      restoredHistory.some(
        (entry) =>
          entry.type === 'conversation_message' &&
          entry.source === 'speak_to_user' &&
          entry.text === 'web reply that must persist',
      ),
    ).toBe(true)
    expect(
      restoredHistory.some((entry) => entry.type === 'agent_message' && entry.text === 'internal-message-0'),
    ).toBe(false)
    expect(
      restoredHistory.some((entry) => entry.type === 'agent_message' && entry.text === 'internal-message-2199'),
    ).toBe(true)
  })


  it('maps spawn_agent model presets to canonical runtime models with highest reasoning', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const codexWorker = await manager.spawnAgent('manager', {
      agentId: 'Codex Worker',
      model: 'pi-codex',
    })

    const pi54Worker = await manager.spawnAgent('manager', {
      agentId: 'GPT 5.4 Worker',
      model: 'pi-5.4',
    })

    const opusWorker = await manager.spawnAgent('manager', {
      agentId: 'Opus Worker',
      model: 'pi-opus',
    })

    const codexAppWorker = await manager.spawnAgent('manager', {
      agentId: 'Codex App Worker',
      model: 'codex-app',
    })

    expect(codexWorker.model).toEqual({
      provider: 'openai-codex',
      modelId: 'gpt-5.3-codex',
      thinkingLevel: 'xhigh',
    })
    expect(pi54Worker.model).toEqual({
      provider: 'openai-codex',
      modelId: 'gpt-5.4',
      thinkingLevel: 'xhigh',
    })
    expect(opusWorker.model).toEqual({
      provider: 'anthropic',
      modelId: 'claude-opus-4-6',
      thinkingLevel: 'high',
    })
    expect(codexAppWorker.model).toEqual({
      provider: 'openai-codex-app-server',
      modelId: 'default',
      thinkingLevel: 'xhigh',
    })
  })

  it('applies spawn_agent modelId and reasoningLevel overrides over preset defaults', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const overridden = await manager.spawnAgent('manager', {
      agentId: 'Override Worker',
      model: 'pi-codex',
      modelId: 'gpt-5.3-codex-spark',
      reasoningLevel: 'medium',
    })

    expect(overridden.model).toEqual({
      provider: 'openai-codex',
      modelId: 'gpt-5.3-codex-spark',
      thinkingLevel: 'medium',
    })
  })

  it('maps anthropic reasoning none/xhigh to low/high for spawn_agent', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const lowMapped = await manager.spawnAgent('manager', {
      agentId: 'Opus None Worker',
      model: 'pi-opus',
      reasoningLevel: 'none',
    })

    const highMapped = await manager.spawnAgent('manager', {
      agentId: 'Opus Xhigh Worker',
      model: 'pi-opus',
      reasoningLevel: 'xhigh',
    })

    expect(lowMapped.model).toEqual({
      provider: 'anthropic',
      modelId: 'claude-opus-4-6',
      thinkingLevel: 'low',
    })
    expect(highMapped.model).toEqual({
      provider: 'anthropic',
      modelId: 'claude-opus-4-6',
      thinkingLevel: 'high',
    })
  })

  it('applies spawn_agent overrides when inheriting manager model fallback', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const overridden = await manager.spawnAgent('manager', {
      agentId: 'Fallback Override Worker',
      modelId: 'gpt-5.3-codex-spark',
      reasoningLevel: 'low',
    })

    expect(overridden.model).toEqual({
      provider: 'openai-codex',
      modelId: 'gpt-5.3-codex-spark',
      thinkingLevel: 'low',
    })
  })

  it('formats extension runtime errors with extension basename and event details', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', {
      agentId: 'Extension Error Worker',
    })

    await (manager as any).handleRuntimeError(worker.agentId, {
      phase: 'extension',
      message: 'blocked write outside allowed roots',
      details: {
        extensionPath: '/tmp/protected-paths.ts',
        event: 'tool_call',
      },
    })

    const history = manager.getConversationHistory(worker.agentId)
    const systemEvent = [...history]
      .reverse()
      .find((entry) => entry.type === 'conversation_message' && entry.role === 'system')

    expect(systemEvent).toBeDefined()
    if (systemEvent?.type === 'conversation_message') {
      expect(systemEvent.text).toBe(
        '⚠️ Extension error (protected-paths.ts · tool_call): blocked write outside allowed roots',
      )
    }
  })

  it('reroutes spawn_agent model from spark to codex when spark is temporarily quota-blocked', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const sparkWorker = await manager.spawnAgent('manager', {
      agentId: 'Spark Block Source',
      model: 'pi-codex',
      modelId: 'gpt-5.3-codex-spark',
    })

    await (manager as any).handleRuntimeError(sparkWorker.agentId, {
      phase: 'prompt_dispatch',
      message: 'You have hit your ChatGPT usage limit (pro plan). Try again in ~4307 min.',
    })

    const rerouted = await manager.spawnAgent('manager', {
      agentId: 'Spark Fallback Worker',
      model: 'pi-codex',
      modelId: 'gpt-5.3-codex-spark',
    })

    expect(rerouted.model.modelId).toBe('gpt-5.3-codex')
  })

  it('reroutes spawn_agent model from spark to codex when worker message_end stopReason is error', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const sparkWorker = await manager.spawnAgent('manager', {
      agentId: 'Spark Message End Source',
      model: 'pi-codex',
      modelId: 'gpt-5.3-codex-spark',
    })

    await (manager as any).handleRuntimeSessionEvent(sparkWorker.agentId, {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: 'You have hit your ChatGPT usage limit ... in 20 min.',
      },
    })

    const rerouted = await manager.spawnAgent('manager', {
      agentId: 'Spark Message End Fallback Worker',
      model: 'pi-codex',
      modelId: 'gpt-5.3-codex-spark',
    })

    expect(rerouted.model.modelId).toBe('gpt-5.3-codex')
  })

  it('reroutes spawn_agent model from spark to gpt-5.4 when spark and codex are blocked', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const sparkWorker = await manager.spawnAgent('manager', {
      agentId: 'Spark Block Source',
      model: 'pi-codex',
      modelId: 'gpt-5.3-codex-spark',
    })
    const codexWorker = await manager.spawnAgent('manager', {
      agentId: 'Codex Block Source',
      model: 'pi-codex',
      modelId: 'gpt-5.3-codex',
    })

    await (manager as any).handleRuntimeError(sparkWorker.agentId, {
      phase: 'prompt_start',
      message: 'You have hit your ChatGPT usage limit (pro plan). Try again in 120 min.',
    })
    await (manager as any).handleRuntimeError(codexWorker.agentId, {
      phase: 'prompt_dispatch',
      message: 'Rate limit exceeded for requests per minute. Try again in 30 min.',
    })

    const rerouted = await manager.spawnAgent('manager', {
      agentId: 'Spark Escalation Worker',
      model: 'pi-codex',
      modelId: 'gpt-5.3-codex-spark',
    })

    expect(rerouted.model.modelId).toBe('gpt-5.4')
  })

  it('does not reroute spawn_agent model for non-quota runtime errors', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const sparkWorker = await manager.spawnAgent('manager', {
      agentId: 'Spark Non Quota Source',
      model: 'pi-codex',
      modelId: 'gpt-5.3-codex-spark',
    })

    await (manager as any).handleRuntimeError(sparkWorker.agentId, {
      phase: 'prompt_dispatch',
      message: 'Network socket disconnected before secure TLS connection was established.',
    })

    const followup = await manager.spawnAgent('manager', {
      agentId: 'Spark Non Quota Followup',
      model: 'pi-codex',
      modelId: 'gpt-5.3-codex-spark',
    })

    expect(followup.model.modelId).toBe('gpt-5.3-codex-spark')
  })

  it('does not apply quota rerouting outside prompt_dispatch/prompt_start phases', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const sparkWorker = await manager.spawnAgent('manager', {
      agentId: 'Spark Steer Delivery Source',
      model: 'pi-codex',
      modelId: 'gpt-5.3-codex-spark',
    })

    await (manager as any).handleRuntimeError(sparkWorker.agentId, {
      phase: 'steer_delivery',
      message: 'You have hit your ChatGPT usage limit (pro plan). Try again in 30 min.',
    })

    const followup = await manager.spawnAgent('manager', {
      agentId: 'Spark Steer Delivery Followup',
      model: 'pi-codex',
      modelId: 'gpt-5.3-codex-spark',
    })

    expect(followup.model.modelId).toBe('gpt-5.3-codex-spark')
  })

  it('rejects invalid spawn_agent model presets with a clear error', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await expect(
      manager.spawnAgent('manager', {
        agentId: 'Invalid Worker',
        model: 'invalid-model' as any,
      }),
     ).rejects.toThrow('spawn_agent.model must be one of pi-codex|pi-5.4|pi-opus|sdk-opus|sdk-sonnet|pi-grok|codex-app|cursor-acp')
  })

  it('rejects invalid spawn_agent reasoning levels with a clear error', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await expect(
      manager.spawnAgent('manager', {
        agentId: 'Invalid Reasoning Worker',
        reasoningLevel: 'ultra' as any,
      }),
    ).rejects.toThrow('spawn_agent.reasoningLevel must be one of none|low|medium|high|xhigh')
  })

  it('allows deleting the default manager when requested', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const deleted = await manager.deleteManager('manager', 'manager')

    expect(deleted.managerId).toBe('manager')
    expect(deleted.terminatedWorkerIds).toEqual([])
    expect(manager.listAgents()).toHaveLength(1)
    expect(manager.listAgents()[0]?.agentId).toBe('cortex')
  })

  it('allows creating a new manager after deleting the default manager', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.deleteManager('manager', 'manager')

    const recreated = await manager.createManager('cortex', {
      name: 'Recreated Manager',
      cwd: config.defaultCwd,
    })

    expect(recreated.role).toBe('manager')
    expect(manager.listAgents().some((agent) => agent.agentId === recreated.agentId)).toBe(true)
  })

  it('enforces strict manager ownership for worker control operations', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const secondary = await manager.createManager('manager', {
      name: 'Delivery Manager',
      cwd: config.defaultCwd,
    })
    const worker = await manager.spawnAgent(secondary.agentId, { agentId: 'Delivery Worker' })

    await expect(manager.killAgent('manager', worker.agentId)).rejects.toThrow(
      `Only owning manager can kill agent ${worker.agentId}`,
    )
    await expect(manager.sendMessage('manager', worker.agentId, 'cross-manager control')).rejects.toThrow(
      `Manager manager does not own worker ${worker.agentId}`,
    )

    await manager.killAgent(secondary.agentId, worker.agentId)
    const descriptor = manager.listAgents().find((agent) => agent.agentId === worker.agentId)
    expect(descriptor?.status).toBe('terminated')
  })

  it('routes user-to-worker delivery through the owning manager context', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const secondary = await manager.createManager('manager', {
      name: 'Routing Manager',
      cwd: config.defaultCwd,
    })
    const worker = await manager.spawnAgent(secondary.agentId, { agentId: 'Routing Worker' })

    await manager.handleUserMessage('hello owned worker', { targetAgentId: worker.agentId })

    const workerRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(workerRuntime?.sendCalls.at(-1)?.message).toBe('hello owned worker')
  })

  it('accepts any existing directory for manager and worker creation', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const outsideDir = await mkdtemp(join(tmpdir(), 'outside-allowlist-'))

    const externalManager = await manager.createManager('manager', {
      name: 'External Manager',
      cwd: outsideDir,
    })

    const externalWorker = await manager.spawnAgent(externalManager.agentId, {
      agentId: 'External Worker',
      cwd: outsideDir,
    })

    const validation = await manager.validateDirectory(outsideDir)
    const listed = await manager.listDirectories(outsideDir)

    expect(externalManager.cwd).toBe(validation.resolvedPath)
    expect(externalWorker.cwd).toBe(validation.resolvedPath)
    expect(validation.valid).toBe(true)
    expect(validation.message).toBeUndefined()
    expect(listed.resolvedPath).toBe(validation.resolvedPath)
    expect(listed.roots).toEqual([])
  })
})
