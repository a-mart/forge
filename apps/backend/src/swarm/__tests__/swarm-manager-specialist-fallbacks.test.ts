/* eslint-disable @typescript-eslint/no-unused-vars -- split from swarm-manager facade suite */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
const memoryMergeMockState = vi.hoisted(() => ({
  executeLLMMerge: vi.fn(async (..._args: any[]) => '# Swarm Memory\n\n## Decisions\n- merged by mock\n'),
}))
const projectAgentAnalysisMockState = vi.hoisted(() => ({
  analyzeSessionForPromotion: vi.fn(async (..._args: any[]) => ({
    whenToUse: 'Use for release coordination.',
    systemPrompt: 'You are the release coordination manager.',
  })),
}))

vi.mock('../memory-merge.js', async () => {
  const actual = await vi.importActual<typeof import('../memory-merge.js')>('../memory-merge.js')
  return {
    ...actual,
    executeLLMMerge: (...args: Parameters<typeof actual.executeLLMMerge>) =>
      memoryMergeMockState.executeLLMMerge(...args),
  }
})

vi.mock('../project-agent-analysis.js', async () => {
  const actual = await vi.importActual<typeof import('../project-agent-analysis.js')>('../project-agent-analysis.js')
  return {
    ...actual,
    analyzeSessionForPromotion: (...args: Parameters<typeof actual.analyzeSessionForPromotion>) =>
      projectAgentAnalysisMockState.analyzeSessionForPromotion(...args),
  }
})

import { readSessionMeta, writeSessionMeta } from '../session-manifest.js'
import { AgentRuntime } from '../agent-runtime.js'
import type {
  AgentContextUsage,
  AgentDescriptor,
  AgentStatus,
  RequestedDeliveryMode,
  SendMessageReceipt,
  SwarmConfig,
} from '../types.js'
import type {
  RuntimeCreationOptions,
  RuntimeErrorEvent,
  RuntimeSessionEvent,
  RuntimeUserMessage,
  SwarmAgentRuntime,
} from '../runtime-contracts.js'
import {
  bootWithDefaultManager,
  FakeRuntime,
  makeTempConfig as buildTempConfig,
  TestSwarmManager as TestSwarmManagerBase,
} from '../../test-support/index.js'

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

})
