import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getScheduleFilePath } from '../scheduler/schedule-storage.js'
import { getProfileMemoryPath } from '../swarm/data-paths.js'
import { SwarmManager } from '../swarm/swarm-manager.js'
import type {
  AgentContextUsage,
  AgentDescriptor,
  MessageSourceContext,
  MessageTargetContext,
  RequestedDeliveryMode,
  SendMessageReceipt,
  SwarmConfig,
} from '../swarm/types.js'
import type { RuntimeUserMessage, SwarmAgentRuntime } from '../swarm/runtime-contracts.js'

class FakeRuntime {
  readonly descriptor: AgentDescriptor
  runtimeToken?: number
  sendCalls: Array<{ message: string | RuntimeUserMessage; delivery: RequestedDeliveryMode }> = []
  terminateCalls: Array<{ abort?: boolean } | undefined> = []
  stopInFlightCalls: Array<{ abort?: boolean } | undefined> = []
  terminateImpl?: (options?: { abort?: boolean; shutdownTimeoutMs?: number; drainTimeoutMs?: number }) => Promise<void>
  stopInFlightImpl?: (options?: { abort?: boolean; shutdownTimeoutMs?: number; drainTimeoutMs?: number }) => Promise<void>
  recycleCalls = 0
  contextRecoveryInProgress = false
  private nextDeliveryId = 0

  constructor(descriptor: AgentDescriptor) {
    this.descriptor = descriptor
  }

  getStatus(): AgentDescriptor['status'] {
    return this.descriptor.status
  }

  getPendingCount(): number {
    return 0
  }

  getContextUsage(): AgentContextUsage | undefined {
    return undefined
  }

  isContextRecoveryInProgress(): boolean {
    return this.contextRecoveryInProgress
  }

  async sendMessage(message: string | RuntimeUserMessage, delivery: RequestedDeliveryMode = 'auto'): Promise<SendMessageReceipt> {
    this.sendCalls.push({ message, delivery })
    this.nextDeliveryId += 1

    return {
      targetAgentId: this.descriptor.agentId,
      deliveryId: `delivery-${this.nextDeliveryId}`,
      acceptedMode: 'prompt',
    }
  }

  async compact(): Promise<unknown> {
    return { status: 'ok' }
  }

  async stopInFlight(options?: { abort?: boolean; shutdownTimeoutMs?: number; drainTimeoutMs?: number }): Promise<void> {
    this.stopInFlightCalls.push(options)
    if (this.stopInFlightImpl) {
      return this.stopInFlightImpl(options)
    }
    this.descriptor.status = 'idle'
  }

  async terminate(options?: { abort?: boolean; shutdownTimeoutMs?: number; drainTimeoutMs?: number }): Promise<void> {
    this.terminateCalls.push(options)
    if (this.terminateImpl) {
      return this.terminateImpl(options)
    }
    this.descriptor.status = 'terminated'
  }

  async recycle(): Promise<void> {
    this.recycleCalls += 1
  }

  getCustomEntries(_customType: string): unknown[] {
    return []
  }

  appendCustomEntry(_customType: string, _data?: unknown): string {
    return 'custom-entry-id'
  }
}

class TestSwarmManager extends SwarmManager {
  readonly runtimeByAgentId = new Map<string, FakeRuntime>()
  readonly publishedToUserCalls: Array<{
    agentId: string
    text: string
    source: 'speak_to_user' | 'system'
    targetContext?: MessageTargetContext
  }> = []

  override async publishToUser(
    agentId: string,
    text: string,
    source: 'speak_to_user' | 'system' = 'speak_to_user',
    targetContext?: MessageTargetContext,
  ): Promise<{ targetContext: MessageSourceContext }> {
    this.publishedToUserCalls.push({ agentId, text, source, targetContext })
    return super.publishToUser(agentId, text, source, targetContext)
  }

  protected override async createRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    _systemPrompt: string,
    runtimeToken?: number,
  ): Promise<SwarmAgentRuntime> {
    const resolvedRuntimeToken = runtimeToken ?? (this as any).allocateRuntimeToken(descriptor.agentId)
    const runtime = new FakeRuntime(descriptor)
    runtime.runtimeToken = resolvedRuntimeToken
    ;(this as any).runtimeTokensByAgentId.set(descriptor.agentId, resolvedRuntimeToken)
    this.runtimeByAgentId.set(descriptor.agentId, runtime)
    return runtime as unknown as SwarmAgentRuntime
  }

  protected override async executeSessionMemoryLLMMerge(): Promise<{ mergedContent: string; model: string }> {
    throw new Error('LLM merge disabled in tests')
  }
}

async function makeTempConfig(port = 8796): Promise<SwarmConfig> {
  const root = await mkdtemp(join(tmpdir(), 'idle-worker-watchdog-test-'))
  const dataDir = join(root, 'data')
  const swarmDir = join(dataDir, 'swarm')
  const sessionsDir = join(dataDir, 'sessions')
  const uploadsDir = join(dataDir, 'uploads')
  const profilesDir = join(dataDir, 'profiles')
  const sharedDir = join(dataDir, 'shared')
  const sharedConfigDir = join(sharedDir, 'config')
  const sharedCacheDir = join(sharedDir, 'cache')
  const sharedStateDir = join(sharedDir, 'state')
  const sharedAuthDir = join(sharedConfigDir, 'auth')
  const sharedAuthFile = join(sharedAuthDir, 'auth.json')
  const sharedSecretsFile = join(sharedConfigDir, 'secrets.json')
  const sharedIntegrationsDir = join(sharedConfigDir, 'integrations')
  const authDir = join(dataDir, 'auth')
  const agentDir = join(dataDir, 'agent')
  const managerAgentDir = join(agentDir, 'manager')
  const repoArchetypesDir = join(root, '.swarm', 'archetypes')
  const memoryDir = join(dataDir, 'memory')
  const memoryFile = getProfileMemoryPath(dataDir, 'manager')
  const repoMemorySkillFile = join(root, '.swarm', 'skills', 'memory', 'SKILL.md')

  await mkdir(swarmDir, { recursive: true })
  await mkdir(sessionsDir, { recursive: true })
  await mkdir(uploadsDir, { recursive: true })
  await mkdir(profilesDir, { recursive: true })
  await mkdir(sharedAuthDir, { recursive: true })
  await mkdir(sharedIntegrationsDir, { recursive: true })
  await mkdir(sharedCacheDir, { recursive: true })
  await mkdir(sharedStateDir, { recursive: true })
  await mkdir(authDir, { recursive: true })
  await mkdir(memoryDir, { recursive: true })
  await mkdir(agentDir, { recursive: true })
  await mkdir(managerAgentDir, { recursive: true })
  await mkdir(repoArchetypesDir, { recursive: true })

  return {
    host: '127.0.0.1',
    port,
    debug: false,
    isDesktop: false,
  cortexEnabled: true,
    allowNonManagerSubscriptions: false,
    managerId: 'manager',
    managerDisplayName: 'Manager',
    defaultModel: {
      provider: 'openai-codex',
      modelId: 'gpt-5.3-codex',
      thinkingLevel: 'medium',
    },
    defaultCwd: root,
    cwdAllowlistRoots: [root, join(root, 'worktrees')],
    paths: {
      rootDir: root,
      dataDir,
      swarmDir,
      uploadsDir,
      agentsStoreFile: join(swarmDir, 'agents.json'),
      profilesDir,
      sharedDir,
      sharedConfigDir,
      sharedCacheDir,
      sharedStateDir,
      sharedAuthDir,
      sharedAuthFile,
      sharedSecretsFile,
      sharedIntegrationsDir,
      sessionsDir,
      memoryDir,
      authDir,
      authFile: join(authDir, 'auth.json'),
      secretsFile: join(dataDir, 'secrets.json'),
      agentDir,
      managerAgentDir,
      repoArchetypesDir,
      memoryFile,
      repoMemorySkillFile,
      schedulesFile: getScheduleFilePath(dataDir, 'manager'),
    },
  }
}

async function bootWithDefaultManager(manager: TestSwarmManager, config: SwarmConfig): Promise<AgentDescriptor> {
  await manager.boot()
  const managerId = config.managerId ?? 'manager'
  const managerName = config.managerDisplayName ?? managerId

  const existingManager = manager.listAgents().find(
    (descriptor) => descriptor.agentId === managerId && descriptor.role === 'manager',
  )
  if (existingManager) {
    return existingManager
  }

  const callerAgentId =
    manager
      .listAgents()
      .find((descriptor) => descriptor.role === 'manager')
      ?.agentId ?? managerId

  const createdManager = await manager.createManager(callerAgentId, {
    name: managerName,
    cwd: config.defaultCwd,
  })

  const createdRuntime = manager.runtimeByAgentId.get(createdManager.agentId)
  if (createdRuntime) {
    createdRuntime.sendCalls = []
  }

  return createdManager
}

function getBatchedWatchdogMessages(runtime: FakeRuntime | undefined): string[] {
  if (!runtime) {
    return []
  }

  return runtime.sendCalls
    .map((call) => call.message)
    .filter((message): message is string => typeof message === 'string')
    .filter((message) => message.includes('[IDLE WORKER WATCHDOG — BATCHED]'))
}

function getSystemWatchdogPublishes(manager: TestSwarmManager): Array<{ agentId: string; text: string }> {
  return manager.publishedToUserCalls
    .filter((call) => call.source === 'system')
    .filter((call) => call.text.includes('Idle worker watchdog'))
    .map((call) => ({ agentId: call.agentId, text: call.text }))
}

async function advanceToWatchdogBatchFlush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(3_000)
  await vi.advanceTimersByTimeAsync(750)
}

async function startWorkerTurn(manager: TestSwarmManager, worker: AgentDescriptor | string): Promise<void> {
  const workerId = typeof worker === 'string' ? worker : worker.agentId
  await (manager as any).handleRuntimeStatus(undefined, workerId, 'streaming', 1)
}

async function finishWorkerTurnViaIdleStatus(manager: TestSwarmManager, worker: AgentDescriptor | string): Promise<void> {
  const workerId = typeof worker === 'string' ? worker : worker.agentId
  await (manager as any).handleRuntimeStatus(undefined, workerId, 'idle', 0)
}

function buildExpectedAutoCompletionMessage(worker: AgentDescriptor): string {
  return `SYSTEM: Worker ${worker.agentId} completed its turn.`
}

function buildExpectedDetailedCompletionMessage(worker: AgentDescriptor, text: string): string {
  return [
    `SYSTEM: Worker ${worker.agentId} completed its turn.`,
    '',
    'Last assistant message:',
    text,
  ].join('\n')
}

function appendWorkerAssistantMessage(
  manager: TestSwarmManager,
  worker: AgentDescriptor | string,
  text: string,
  timestamp = '2026-04-06T00:00:00.000Z',
): void {
  const workerId = typeof worker === 'string' ? worker : worker.agentId
  const history = ((manager as any).conversationEntriesByAgentId.get(workerId) as any[] | undefined) ?? []
  history.push({
    type: 'conversation_message',
    agentId: workerId,
    role: 'assistant',
    text,
    timestamp,
    source: 'system',
  })
  ;(manager as any).conversationEntriesByAgentId.set(workerId, history)
}

function failAutoCompletionReports(runtime: FakeRuntime): void {
  const originalSendMessage = runtime.sendMessage.bind(runtime)
  runtime.sendMessage = async (message, delivery = 'auto') => {
    if (
      typeof message === 'string' &&
      message.startsWith('SYSTEM: Worker ') &&
      message.includes('completed its turn') &&
      !message.includes('[IDLE WORKER WATCHDOG — BATCHED]')
    ) {
      throw new Error('synthetic auto-report failure')
    }

    return originalSendMessage(message, delivery)
  }
}

function createDeferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })

  return { promise, resolve, reject }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('idle worker watchdog', () => {
  it('auto-reports worker completion before watchdog batching would run', async () => {
    vi.useFakeTimers()

    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const workerA = await manager.spawnAgent('manager', { agentId: 'Batch Worker A' })
    const workerB = await manager.spawnAgent('manager', { agentId: 'Batch Worker B' })
    const workerC = await manager.spawnAgent('manager', { agentId: 'Batch Worker C' })
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    expect(managerRuntime).toBeDefined()

    await (manager as any).handleRuntimeAgentEnd(workerA.agentId)
    await (manager as any).handleRuntimeAgentEnd(workerB.agentId)
    await (manager as any).handleRuntimeAgentEnd(workerC.agentId)

    expect(managerRuntime?.sendCalls).toHaveLength(3)
    expect(managerRuntime?.sendCalls.map((call) => call.message)).toEqual([
      buildExpectedAutoCompletionMessage(workerA),
      buildExpectedAutoCompletionMessage(workerB),
      buildExpectedAutoCompletionMessage(workerC),
    ])

    await advanceToWatchdogBatchFlush()

    expect(getBatchedWatchdogMessages(managerRuntime)).toHaveLength(0)
    expect(getSystemWatchdogPublishes(manager)).toHaveLength(0)
  })

  it('batch flush skips stale workers and still notifies for valid queued workers', async () => {
    vi.useFakeTimers()

    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const validWorker = await manager.spawnAgent('manager', { agentId: 'Valid Batch Worker' })
    const staleWorker = await manager.spawnAgent('manager', { agentId: 'Stale Batch Worker' })
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    expect(managerRuntime).toBeDefined()
    failAutoCompletionReports(managerRuntime!)

    await (manager as any).handleRuntimeAgentEnd(validWorker.agentId)
    await (manager as any).handleRuntimeAgentEnd(staleWorker.agentId)

    await vi.advanceTimersByTimeAsync(3_000)

    ;(manager as any).descriptors.delete(staleWorker.agentId)
    ;(manager as any).workerWatchdogState.delete(staleWorker.agentId)

    await vi.advanceTimersByTimeAsync(750)

    const watchdogMessages = getBatchedWatchdogMessages(managerRuntime)
    expect(watchdogMessages).toHaveLength(1)
    expect(watchdogMessages[0]).toContain('1 worker went idle without reporting this turn.')
    expect(watchdogMessages[0]).toContain(`\`${validWorker.agentId}\``)
    expect(watchdogMessages[0]).not.toContain(`\`${staleWorker.agentId}\``)
  })

  it('consecutive silent turns with auto-report still auto-report every turn', async () => {
    vi.useFakeTimers()

    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Consecutive Silent Worker' })
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    const workerRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(managerRuntime).toBeDefined()
    expect(workerRuntime).toBeDefined()

    await startWorkerTurn(manager, worker)
    await finishWorkerTurnViaIdleStatus(manager, worker)

    await manager.sendMessage('manager', worker.agentId, 'next instruction', 'auto', { origin: 'internal' })
    await startWorkerTurn(manager, worker)
    await finishWorkerTurnViaIdleStatus(manager, worker)

    expect(workerRuntime?.sendCalls).toHaveLength(1)
    expect(workerRuntime?.sendCalls[0]?.message).toBe('SYSTEM: next instruction')
    expect(managerRuntime?.sendCalls.map((call) => call.message)).toEqual([
      buildExpectedAutoCompletionMessage(worker),
      buildExpectedAutoCompletionMessage(worker),
    ])

    await advanceToWatchdogBatchFlush()
    expect(getBatchedWatchdogMessages(managerRuntime)).toHaveLength(0)
    expect(getSystemWatchdogPublishes(manager)).toHaveLength(0)
  })

  it('drops stale queued watchdog entries when a new turn starts before the prior batch flush', async () => {
    vi.useFakeTimers()

    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Queued Turn Worker' })
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    expect(managerRuntime).toBeDefined()
    failAutoCompletionReports(managerRuntime!)

    await startWorkerTurn(manager, worker)
    await finishWorkerTurnViaIdleStatus(manager, worker)
    await vi.advanceTimersByTimeAsync(3_000)

    const batchQueues = (manager as any).watchdogBatchQueueByManager as Map<
      string,
      Map<string, { workerId: string; turnSeq: number }>
    >
    expect(batchQueues.get('manager')?.get(worker.agentId)?.turnSeq).toBe(1)

    await startWorkerTurn(manager, worker)
    expect(batchQueues.get('manager')?.has(worker.agentId) ?? false).toBe(false)

    await finishWorkerTurnViaIdleStatus(manager, worker)
    await vi.advanceTimersByTimeAsync(750)

    expect(getBatchedWatchdogMessages(managerRuntime)).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(3_000)
    await vi.advanceTimersByTimeAsync(750)

    const watchdogMessages = getBatchedWatchdogMessages(managerRuntime)
    expect(watchdogMessages).toHaveLength(1)
    expect(watchdogMessages[0]).toContain(`\`${worker.agentId}\``)
    expect(getSystemWatchdogPublishes(manager)).toHaveLength(1)
  })

  it('falls back to a generic completion signal when a later silent turn would reuse the same summary', async () => {
    vi.useFakeTimers()

    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Duplicate Summary Worker' })
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    const workerRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(managerRuntime).toBeDefined()
    expect(workerRuntime).toBeDefined()

    appendWorkerAssistantMessage(manager, worker, 'Finished task.', new Date(Date.now() + 60_000).toISOString())

    await (manager as any).handleRuntimeAgentEnd(worker.agentId)
    await manager.sendMessage('manager', worker.agentId, 'next instruction', 'auto', { origin: 'internal' })
    await startWorkerTurn(manager, worker)
    await finishWorkerTurnViaIdleStatus(manager, worker)

    expect(workerRuntime?.sendCalls).toHaveLength(1)
    expect(workerRuntime?.sendCalls[0]?.message).toBe('SYSTEM: next instruction')
    expect(managerRuntime?.sendCalls.map((call) => call.message)).toEqual([
      buildExpectedDetailedCompletionMessage(worker, 'Finished task.'),
      buildExpectedAutoCompletionMessage(worker),
    ])

    await advanceToWatchdogBatchFlush()
    expect(getBatchedWatchdogMessages(managerRuntime)).toHaveLength(0)
    expect(getSystemWatchdogPublishes(manager)).toHaveLength(0)
  })

  it('suppresses watchdog scheduling while the worker runtime is in context recovery', async () => {
    vi.useFakeTimers()

    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Recovering Worker' })
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    const workerRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(managerRuntime).toBeDefined()
    expect(workerRuntime).toBeDefined()

    workerRuntime!.contextRecoveryInProgress = true

    await (manager as any).handleRuntimeAgentEnd(worker.agentId)
    await advanceToWatchdogBatchFlush()

    expect(getBatchedWatchdogMessages(managerRuntime)).toHaveLength(0)
    expect(getSystemWatchdogPublishes(manager)).toHaveLength(0)
  })

  it('suppresses watchdog notifications while the parent manager runtime is in context recovery', async () => {
    vi.useFakeTimers()

    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Worker Under Recovering Manager' })
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    expect(managerRuntime).toBeDefined()

    managerRuntime!.contextRecoveryInProgress = true

    await (manager as any).handleRuntimeAgentEnd(worker.agentId)
    await advanceToWatchdogBatchFlush()

    expect(getBatchedWatchdogMessages(managerRuntime)).toHaveLength(0)
    expect(getSystemWatchdogPublishes(manager)).toHaveLength(0)
  })

  it('worker report to parent marks reportedThisTurn and suppresses watchdog for that turn', async () => {
    vi.useFakeTimers()

    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Reporting Worker' })
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    expect(managerRuntime).toBeDefined()

    await manager.sendMessage(worker.agentId, 'manager', 'turn complete', 'auto', { origin: 'internal' })

    const reportedState = (manager as any).workerWatchdogState.get(worker.agentId)
    expect(reportedState?.reportedThisTurn).toBe(true)

    await (manager as any).handleRuntimeAgentEnd(worker.agentId)
    await advanceToWatchdogBatchFlush()

    expect(getBatchedWatchdogMessages(managerRuntime)).toHaveLength(0)
    expect(getSystemWatchdogPublishes(manager)).toHaveLength(0)
  })

  it('suppresses watchdog arming while a worker report to the parent manager is still in flight', async () => {
    vi.useFakeTimers()

    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Racing Reporter' })
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    expect(managerRuntime).toBeDefined()

    const receipt = {
      targetAgentId: 'manager',
      deliveryId: 'deferred-delivery',
      acceptedMode: 'prompt',
    } satisfies SendMessageReceipt
    const deferredSend = createDeferred<SendMessageReceipt>()
    const sendStarted = createDeferred<void>()
    let sendStartedSignaled = false

    managerRuntime!.sendMessage = async (message, delivery = 'auto') => {
      managerRuntime!.sendCalls.push({ message, delivery })
      if (!sendStartedSignaled) {
        sendStartedSignaled = true
        sendStarted.resolve()
      }
      return deferredSend.promise
    }

    const sendPromise = manager.sendMessage(worker.agentId, 'manager', 'turn complete', 'auto', { origin: 'internal' })
    await sendStarted.promise

    const stateWhilePending = (manager as any).workerWatchdogState.get(worker.agentId)
    expect(stateWhilePending?.pendingReportTurnSeq).toBe(0)

    await (manager as any).handleRuntimeAgentEnd(worker.agentId)

    const stateAfterEnd = (manager as any).workerWatchdogState.get(worker.agentId)
    expect(stateAfterEnd?.turnSeq).toBe(0)
    expect(stateAfterEnd?.deferredFinalizeTurnSeq).toBe(0)
    expect(((manager as any).watchdogTimers as Map<string, unknown>).has(worker.agentId)).toBe(false)

    deferredSend.resolve(receipt)
    await sendPromise
    await vi.runAllTicks()
    await advanceToWatchdogBatchFlush()

    const finalState = (manager as any).workerWatchdogState.get(worker.agentId)
    expect(finalState?.turnSeq).toBe(1)
    expect(finalState?.pendingReportTurnSeq).toBeNull()
    expect(finalState?.deferredFinalizeTurnSeq).toBeNull()
    expect(getBatchedWatchdogMessages(managerRuntime)).toHaveLength(0)
    expect(getSystemWatchdogPublishes(manager)).toHaveLength(0)
  })

  it('finalizes a deferred idle worker turn if the in-flight parent report send fails', async () => {
    vi.useFakeTimers()

    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Failing Reporter' })
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    expect(managerRuntime).toBeDefined()

    const originalSendMessage = managerRuntime!.sendMessage.bind(managerRuntime)
    const deferredSend = createDeferred<SendMessageReceipt>()
    const sendStarted = createDeferred<void>()
    let callCount = 0
    let sendStartedSignaled = false

    managerRuntime!.sendMessage = async (message, delivery = 'auto') => {
      callCount += 1
      if (callCount === 1) {
        managerRuntime!.sendCalls.push({ message, delivery })
        if (!sendStartedSignaled) {
          sendStartedSignaled = true
          sendStarted.resolve()
        }
        return deferredSend.promise
      }

      return originalSendMessage(message, delivery)
    }

    const sendPromise = manager.sendMessage(worker.agentId, 'manager', 'turn complete', 'auto', { origin: 'internal' })
    await sendStarted.promise
    await (manager as any).handleRuntimeAgentEnd(worker.agentId)

    deferredSend.reject(new Error('synthetic send failure'))
    await expect(sendPromise).rejects.toThrow('synthetic send failure')
    await vi.runAllTicks()
    await advanceToWatchdogBatchFlush()

    expect(managerRuntime!.sendCalls).toHaveLength(2)
    expect(String(managerRuntime!.sendCalls[0]?.message)).toContain('turn complete')
    expect(managerRuntime!.sendCalls[1]?.message).toBe(buildExpectedAutoCompletionMessage(worker))

    const finalState = (manager as any).workerWatchdogState.get(worker.agentId)
    expect(finalState?.turnSeq).toBe(1)
    expect(finalState?.pendingReportTurnSeq).toBeNull()
    expect(finalState?.deferredFinalizeTurnSeq).toBeNull()
    expect(((manager as any).watchdogTimers as Map<string, unknown>).has(worker.agentId)).toBe(false)
    expect(getBatchedWatchdogMessages(managerRuntime)).toHaveLength(0)
    expect(getSystemWatchdogPublishes(manager)).toHaveLength(0)
  })

  it('worker report to a non-parent target does not satisfy watchdog reporting', async () => {
    vi.useFakeTimers()

    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const reportingWorker = await manager.spawnAgent('manager', { agentId: 'Non Parent Reporter' })
    const nonParentTarget = await manager.spawnAgent('manager', { agentId: 'Sibling Target' })
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    expect(managerRuntime).toBeDefined()
    failAutoCompletionReports(managerRuntime!)

    await manager.sendMessage(reportingWorker.agentId, nonParentTarget.agentId, 'status ping', 'auto', {
      origin: 'internal',
    })

    const stateAfterSiblingReport = (manager as any).workerWatchdogState.get(reportingWorker.agentId)
    expect(stateAfterSiblingReport?.reportedThisTurn ?? false).toBe(false)

    await (manager as any).handleRuntimeAgentEnd(reportingWorker.agentId)
    await advanceToWatchdogBatchFlush()

    const watchdogMessages = getBatchedWatchdogMessages(managerRuntime)
    expect(watchdogMessages).toHaveLength(1)
    expect(watchdogMessages[0]).toContain(`\`${reportingWorker.agentId}\``)
  })

  it('worker in non-idle streaming/error state is skipped when watchdog timer fires', async () => {
    vi.useFakeTimers()

    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const streamingWorker = await manager.spawnAgent('manager', { agentId: 'Streaming Worker' })
    const erroredWorker = await manager.spawnAgent('manager', { agentId: 'Errored Worker' })
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    expect(managerRuntime).toBeDefined()

    const descriptors = (manager as any).descriptors as Map<string, AgentDescriptor>
    const streamingDescriptor = descriptors.get(streamingWorker.agentId)
    const erroredDescriptor = descriptors.get(erroredWorker.agentId)
    expect(streamingDescriptor).toBeDefined()
    expect(erroredDescriptor).toBeDefined()

    streamingDescriptor!.status = 'streaming'
    erroredDescriptor!.status = 'error'

    await (manager as any).handleRuntimeAgentEnd(streamingWorker.agentId)
    await (manager as any).handleRuntimeAgentEnd(erroredWorker.agentId)
    await advanceToWatchdogBatchFlush()

    expect(getBatchedWatchdogMessages(managerRuntime)).toHaveLength(0)
    expect(getSystemWatchdogPublishes(manager)).toHaveLength(0)
  })

  it('message prep failure does not wedge pendingReportTurnSeq', async () => {
    vi.useFakeTimers()

    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Prep Failure Worker' })
    const originalPrepareModelInboundMessage = (manager as any).prepareModelInboundMessage
    ;(manager as any).prepareModelInboundMessage = async () => {
      throw new Error('synthetic prep failure')
    }

    await expect(
      manager.sendMessage(worker.agentId, 'manager', 'turn complete', 'auto', { origin: 'internal' }),
    ).rejects.toThrow('synthetic prep failure')

    const watchdogState = (manager as any).workerWatchdogState.get(worker.agentId)
    expect(watchdogState?.pendingReportTurnSeq).toBeNull()

    ;(manager as any).prepareModelInboundMessage = originalPrepareModelInboundMessage
  })

  it('clearWatchdogState removes worker watchdog maps and pending batch queue entries', async () => {
    vi.useFakeTimers()

    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Cleanup Worker' })
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    expect(managerRuntime).toBeDefined()
    failAutoCompletionReports(managerRuntime!)

    await (manager as any).handleRuntimeAgentEnd(worker.agentId)

    const watchdogTimers = (manager as any).watchdogTimers as Map<string, unknown>
    const watchdogState = (manager as any).workerWatchdogState as Map<string, unknown>
    const watchdogTokens = (manager as any).watchdogTimerTokens as Map<string, number>
    const batchQueues = (manager as any).watchdogBatchQueueByManager as Map<
      string,
      Map<string, { workerId: string; turnSeq: number }>
    >
    const batchTimers = (manager as any).watchdogBatchTimersByManager as Map<string, unknown>

    expect(watchdogTimers.has(worker.agentId)).toBe(true)
    expect(watchdogState.has(worker.agentId)).toBe(true)
    expect(watchdogTokens.has(worker.agentId)).toBe(true)

    await vi.advanceTimersByTimeAsync(3_000)

    expect(batchQueues.get('manager')?.get(worker.agentId)?.workerId).toBe(worker.agentId)
    expect(batchTimers.has('manager')).toBe(true)

    ;(manager as any).clearWatchdogState(worker.agentId)

    expect(watchdogTimers.has(worker.agentId)).toBe(false)
    expect(watchdogState.has(worker.agentId)).toBe(false)
    expect(watchdogTokens.has(worker.agentId)).toBe(false)
    expect(batchQueues.has('manager')).toBe(false)
    expect(batchTimers.has('manager')).toBe(false)

    await vi.advanceTimersByTimeAsync(750)
    expect(getBatchedWatchdogMessages(managerRuntime)).toHaveLength(0)
    expect(getSystemWatchdogPublishes(manager)).toHaveLength(0)
  })

  it('applies exponential backoff so repeated silent turns do not immediately re-notify', async () => {
    vi.useFakeTimers()

    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Backoff Worker' })
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    expect(managerRuntime).toBeDefined()
    failAutoCompletionReports(managerRuntime!)

    await startWorkerTurn(manager, worker)
    await finishWorkerTurnViaIdleStatus(manager, worker)
    await advanceToWatchdogBatchFlush()
    expect(getBatchedWatchdogMessages(managerRuntime)).toHaveLength(1)

    await startWorkerTurn(manager, worker)
    await finishWorkerTurnViaIdleStatus(manager, worker)
    await advanceToWatchdogBatchFlush()

    expect(getBatchedWatchdogMessages(managerRuntime)).toHaveLength(1)

    const watchdogState = (manager as any).workerWatchdogState.get(worker.agentId)
    expect(watchdogState?.consecutiveNotifications).toBe(1)
    expect(watchdogState?.suppressedUntilMs).toBeGreaterThan(0)
  })

  it('opens the watchdog circuit breaker after repeated notifications', async () => {
    vi.useFakeTimers()

    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Circuit Worker' })
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    expect(managerRuntime).toBeDefined()
    failAutoCompletionReports(managerRuntime!)

    await startWorkerTurn(manager, worker)
    await finishWorkerTurnViaIdleStatus(manager, worker)
    await advanceToWatchdogBatchFlush()

    await vi.advanceTimersByTimeAsync(15_000)
    await startWorkerTurn(manager, worker)
    await finishWorkerTurnViaIdleStatus(manager, worker)
    await advanceToWatchdogBatchFlush()

    await vi.advanceTimersByTimeAsync(30_000)
    await startWorkerTurn(manager, worker)
    await finishWorkerTurnViaIdleStatus(manager, worker)
    await advanceToWatchdogBatchFlush()

    expect(getBatchedWatchdogMessages(managerRuntime)).toHaveLength(3)

    const afterThirdState = (manager as any).workerWatchdogState.get(worker.agentId)
    expect(afterThirdState?.circuitOpen).toBe(true)

    await vi.advanceTimersByTimeAsync(60_000)
    await startWorkerTurn(manager, worker)
    await finishWorkerTurnViaIdleStatus(manager, worker)
    await advanceToWatchdogBatchFlush()

    expect(getBatchedWatchdogMessages(managerRuntime)).toHaveLength(3)
  })

  it('resets suppression when worker reports to parent manager, allowing future watchdog notifications', async () => {
    vi.useFakeTimers()

    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Reset Worker' })
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    expect(managerRuntime).toBeDefined()
    failAutoCompletionReports(managerRuntime!)

    await startWorkerTurn(manager, worker)
    await finishWorkerTurnViaIdleStatus(manager, worker)
    await advanceToWatchdogBatchFlush()
    expect(getBatchedWatchdogMessages(managerRuntime)).toHaveLength(1)

    await startWorkerTurn(manager, worker)
    await manager.sendMessage(worker.agentId, 'manager', 'done', 'auto', { origin: 'internal' })

    const resetState = (manager as any).workerWatchdogState.get(worker.agentId)
    expect(resetState?.consecutiveNotifications).toBe(0)
    expect(resetState?.suppressedUntilMs).toBe(0)
    expect(resetState?.circuitOpen).toBe(false)

    // End the reported turn (no watchdog expected), then a new silent turn should notify again immediately.
    await finishWorkerTurnViaIdleStatus(manager, worker)
    await advanceToWatchdogBatchFlush()
    expect(getBatchedWatchdogMessages(managerRuntime)).toHaveLength(1)

    await startWorkerTurn(manager, worker)
    await finishWorkerTurnViaIdleStatus(manager, worker)
    await advanceToWatchdogBatchFlush()

    expect(getBatchedWatchdogMessages(managerRuntime)).toHaveLength(2)
  })

  it('does not emit a watchdog notification when the worker is in error state', async () => {
    vi.useFakeTimers()

    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Errored Worker' })
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    expect(managerRuntime).toBeDefined()

    await (manager as any).handleRuntimeAgentEnd(worker.agentId)

    const workerDescriptor = (manager as any).descriptors.get(worker.agentId) as AgentDescriptor
    workerDescriptor.status = 'error'
    ;(manager as any).descriptors.set(worker.agentId, workerDescriptor)

    await vi.advanceTimersByTimeAsync(3_000)

    expect(managerRuntime?.sendCalls).toHaveLength(1)
    expect(managerRuntime?.sendCalls[0]?.message).toBe(buildExpectedAutoCompletionMessage(worker))
  })

  it('does not emit a watchdog notification when the worker is streaming', async () => {
    vi.useFakeTimers()

    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Streaming Worker' })
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    expect(managerRuntime).toBeDefined()

    await (manager as any).handleRuntimeAgentEnd(worker.agentId)

    const workerDescriptor = (manager as any).descriptors.get(worker.agentId) as AgentDescriptor
    workerDescriptor.status = 'streaming'
    ;(manager as any).descriptors.set(worker.agentId, workerDescriptor)

    await vi.advanceTimersByTimeAsync(3_000)

    expect(managerRuntime?.sendCalls).toHaveLength(1)
    expect(managerRuntime?.sendCalls[0]?.message).toBe(buildExpectedAutoCompletionMessage(worker))
  })

  it('does not emit a watchdog notification when the parent manager is not running', async () => {
    vi.useFakeTimers()

    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Orphan Worker' })
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    expect(managerRuntime).toBeDefined()

    await (manager as any).handleRuntimeAgentEnd(worker.agentId)

    const managerDescriptor = (manager as any).descriptors.get('manager') as AgentDescriptor
    managerDescriptor.status = 'terminated'
    ;(manager as any).descriptors.set('manager', managerDescriptor)

    await vi.advanceTimersByTimeAsync(3_000)

    expect(managerRuntime?.sendCalls).toHaveLength(1)
    expect(managerRuntime?.sendCalls[0]?.message).toBe(buildExpectedAutoCompletionMessage(worker))
  })

  it('still emits a watchdog notification when worker messages a non-parent target', async () => {
    vi.useFakeTimers()

    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Non Parent Reporter' })
    const otherWorker = await manager.spawnAgent('manager', { agentId: 'Different Target Worker' })
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    const otherWorkerRuntime = manager.runtimeByAgentId.get(otherWorker.agentId)
    expect(managerRuntime).toBeDefined()
    expect(otherWorkerRuntime).toBeDefined()

    await manager.sendMessage(worker.agentId, otherWorker.agentId, 'hello peer', 'auto', { origin: 'internal' })
    await (manager as any).handleRuntimeAgentEnd(worker.agentId)

    expect(otherWorkerRuntime?.sendCalls).toHaveLength(1)
    expect(otherWorkerRuntime?.sendCalls[0]?.message).toBe('SYSTEM: hello peer')

    await vi.advanceTimersByTimeAsync(3_000)

    expect(managerRuntime?.sendCalls).toHaveLength(1)
    expect(managerRuntime?.sendCalls[0]?.message).toBe(buildExpectedAutoCompletionMessage(worker))
  })

  it('does not schedule watchdog activity for manager-role agent_end events', async () => {
    vi.useFakeTimers()

    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const managerRuntime = manager.runtimeByAgentId.get('manager')
    expect(managerRuntime).toBeDefined()

    await (manager as any).handleRuntimeAgentEnd('manager')
    await vi.advanceTimersByTimeAsync(3_000)

    expect(managerRuntime?.sendCalls).toHaveLength(0)
    expect((manager as any).watchdogTimers.size).toBe(0)
    expect((manager as any).workerWatchdogState.size).toBe(0)
  })

  it('does not recreate watchdog state when a worker is killed during message prep', async () => {
    vi.useFakeTimers()

    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Killed During Prep Worker' })
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    const originalPrepareModelInboundMessage = (manager as any).prepareModelInboundMessage
    expect(managerRuntime).toBeDefined()

    const deferredPrep = createDeferred<string | RuntimeUserMessage>()
    ;(manager as any).prepareModelInboundMessage = async () => deferredPrep.promise

    await startWorkerTurn(manager, worker)
    const sendPromise = manager.sendMessage(worker.agentId, 'manager', 'turn complete', 'auto', { origin: 'internal' })
    await vi.runAllTicks()

    expect((manager as any).workerWatchdogState.get(worker.agentId)?.pendingReportTurnSeq).toBeNull()

    await manager.killAgent('manager', worker.agentId)

    deferredPrep.resolve('SYSTEM: turn complete')
    const receipt = await sendPromise
    await vi.runAllTicks()

    expect(receipt.targetAgentId).toBe('manager')
    expect(managerRuntime?.sendCalls).toHaveLength(1)
    expect(managerRuntime?.sendCalls[0]?.message).toBe('SYSTEM: turn complete')
    expect((manager as any).workerWatchdogState.has(worker.agentId)).toBe(false)
    expect((manager as any).watchdogTimers.has(worker.agentId)).toBe(false)
    expect((manager as any).watchdogTimerTokens.has(worker.agentId)).toBe(false)

    ;(manager as any).prepareModelInboundMessage = originalPrepareModelInboundMessage
  })

  it('clears watchdog state in terminateDescriptor via killAgent', async () => {
    vi.useFakeTimers()

    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Killed Worker' })
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    expect(managerRuntime).toBeDefined()

    await (manager as any).handleRuntimeAgentEnd(worker.agentId)

    await manager.killAgent('manager', worker.agentId)

    await vi.advanceTimersByTimeAsync(3_000)

    expect(managerRuntime?.sendCalls).toHaveLength(1)
    expect(managerRuntime?.sendCalls[0]?.message).toBe(buildExpectedAutoCompletionMessage(worker))
    expect((manager as any).workerWatchdogState.has(worker.agentId)).toBe(false)
    expect((manager as any).watchdogTimers.has(worker.agentId)).toBe(false)
    expect((manager as any).watchdogTimerTokens.has(worker.agentId)).toBe(false)
  })

  it('clears a stale watchdog timer when a new worker turn starts streaming', async () => {
    vi.useFakeTimers()

    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Timer Reset Worker' })
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    expect(managerRuntime).toBeDefined()
    failAutoCompletionReports(managerRuntime!)

    await (manager as any).handleRuntimeAgentEnd(worker.agentId)

    expect(((manager as any).watchdogTimers as Map<string, unknown>).has(worker.agentId)).toBe(true)

    await startWorkerTurn(manager, worker)

    expect(((manager as any).watchdogTimers as Map<string, unknown>).has(worker.agentId)).toBe(false)

    await advanceToWatchdogBatchFlush()
    expect(getBatchedWatchdogMessages(managerRuntime)).toHaveLength(0)
    expect(getSystemWatchdogPublishes(manager)).toHaveLength(0)
  })

  it('status-idle fallback finalizes a streamed worker turn without agent_end', async () => {
    vi.useFakeTimers()

    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Status Idle Worker' })
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    expect(managerRuntime).toBeDefined()
    failAutoCompletionReports(managerRuntime!)

    await startWorkerTurn(manager, worker)
    await (manager as any).handleRuntimeStatus(undefined, worker.agentId, 'idle', 0)

    expect(((manager as any).watchdogTimers as Map<string, unknown>).has(worker.agentId)).toBe(true)

    await advanceToWatchdogBatchFlush()

    const watchdogMessages = getBatchedWatchdogMessages(managerRuntime)
    expect(watchdogMessages).toHaveLength(1)
    expect(watchdogMessages[0]).toContain(`\`${worker.agentId}\``)
  })

  it('clears watchdog state in stopAllAgents for affected workers', async () => {
    vi.useFakeTimers()

    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Stopped Worker' })
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    expect(managerRuntime).toBeDefined()

    await (manager as any).handleRuntimeAgentEnd(worker.agentId)

    await manager.stopAllAgents('manager', 'manager')

    await vi.advanceTimersByTimeAsync(3_000)

    expect(managerRuntime?.sendCalls).toHaveLength(1)
    expect(managerRuntime?.sendCalls[0]?.message).toBe(buildExpectedAutoCompletionMessage(worker))
    expect((manager as any).workerWatchdogState.has(worker.agentId)).toBe(false)
    expect((manager as any).watchdogTimers.has(worker.agentId)).toBe(false)
    expect((manager as any).watchdogTimerTokens.has(worker.agentId)).toBe(false)
  })

  it('suppresses late worker callbacks during stopAllAgents teardown', async () => {
    vi.useFakeTimers()

    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Late Callback Worker' })
    const workerRuntime = manager.runtimeByAgentId.get(worker.agentId)
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    const runtimeToken = ((manager as any).runtimeTokensByAgentId as Map<string, number>).get(worker.agentId)
    expect(workerRuntime).toBeDefined()
    expect(managerRuntime).toBeDefined()
    expect(runtimeToken).toBeDefined()
    if (runtimeToken === undefined) {
      throw new Error('Expected worker runtime token')
    }

    await startWorkerTurn(manager, worker)

    const stopStarted = createDeferred<void>()
    const stopDeferred = createDeferred<void>()
    workerRuntime!.stopInFlightImpl = async () => {
      stopStarted.resolve()
      await stopDeferred.promise
      workerRuntime!.descriptor.status = 'idle'
    }

    const stopAllPromise = manager.stopAllAgents('manager', 'manager')
    await stopStarted.promise

    await (manager as any).handleRuntimeStatus(runtimeToken, worker.agentId, 'idle', 0)
    await (manager as any).handleRuntimeAgentEnd(runtimeToken, worker.agentId)
    await vi.runAllTicks()

    expect((manager as any).workerWatchdogState.has(worker.agentId)).toBe(false)
    expect((manager as any).watchdogTimers.has(worker.agentId)).toBe(false)
    expect((manager as any).watchdogBatchQueueByManager.has('manager')).toBe(false)

    stopDeferred.resolve()
    await stopAllPromise
    await advanceToWatchdogBatchFlush()

    expect(managerRuntime?.sendCalls).toHaveLength(0)
    expect(getBatchedWatchdogMessages(managerRuntime)).toHaveLength(0)
    expect(getSystemWatchdogPublishes(manager)).toHaveLength(0)
    expect((manager as any).workerWatchdogState.has(worker.agentId)).toBe(false)
    expect((manager as any).watchdogTimers.has(worker.agentId)).toBe(false)
    expect((manager as any).watchdogTimerTokens.has(worker.agentId)).toBe(false)
    expect((manager as any).watchdogBatchQueueByManager.has('manager')).toBe(false)
    expect((manager as any).watchdogBatchTimersByManager.has('manager')).toBe(false)
  })
})
