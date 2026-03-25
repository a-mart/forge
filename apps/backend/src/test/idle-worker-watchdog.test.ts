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
import type { RuntimeUserMessage, SwarmAgentRuntime } from '../swarm/runtime-types.js'

class FakeRuntime {
  readonly descriptor: AgentDescriptor
  sendCalls: Array<{ message: string | RuntimeUserMessage; delivery: RequestedDeliveryMode }> = []
  terminateCalls: Array<{ abort?: boolean } | undefined> = []
  stopInFlightCalls: Array<{ abort?: boolean } | undefined> = []
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
    this.descriptor.status = 'idle'
  }

  async terminate(options?: { abort?: boolean; shutdownTimeoutMs?: number; drainTimeoutMs?: number }): Promise<void> {
    this.terminateCalls.push(options)
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
    _runtimeToken?: number,
  ): Promise<SwarmAgentRuntime> {
    const runtime = new FakeRuntime(descriptor)
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
  const sharedAuthDir = join(sharedDir, 'auth')
  const sharedAuthFile = join(sharedAuthDir, 'auth.json')
  const sharedSecretsFile = join(sharedDir, 'secrets.json')
  const sharedIntegrationsDir = join(sharedDir, 'integrations')
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

function buildExpectedAutoCompletionMessage(worker: AgentDescriptor): string {
  return `SYSTEM: Worker ${worker.agentId} completed its turn.`
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
    const batchQueues = (manager as any).watchdogBatchQueueByManager as Map<string, Set<string>>
    const batchTimers = (manager as any).watchdogBatchTimersByManager as Map<string, unknown>

    expect(watchdogTimers.has(worker.agentId)).toBe(true)
    expect(watchdogState.has(worker.agentId)).toBe(true)
    expect(watchdogTokens.has(worker.agentId)).toBe(true)

    await vi.advanceTimersByTimeAsync(3_000)

    expect(batchQueues.get('manager')?.has(worker.agentId)).toBe(true)
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

    await (manager as any).handleRuntimeAgentEnd(worker.agentId)
    await advanceToWatchdogBatchFlush()
    expect(getBatchedWatchdogMessages(managerRuntime)).toHaveLength(1)

    await (manager as any).handleRuntimeAgentEnd(worker.agentId)
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

    await (manager as any).handleRuntimeAgentEnd(worker.agentId)
    await advanceToWatchdogBatchFlush()

    await vi.advanceTimersByTimeAsync(15_000)
    await (manager as any).handleRuntimeAgentEnd(worker.agentId)
    await advanceToWatchdogBatchFlush()

    await vi.advanceTimersByTimeAsync(30_000)
    await (manager as any).handleRuntimeAgentEnd(worker.agentId)
    await advanceToWatchdogBatchFlush()

    expect(getBatchedWatchdogMessages(managerRuntime)).toHaveLength(3)

    const afterThirdState = (manager as any).workerWatchdogState.get(worker.agentId)
    expect(afterThirdState?.circuitOpen).toBe(true)

    await vi.advanceTimersByTimeAsync(60_000)
    await (manager as any).handleRuntimeAgentEnd(worker.agentId)
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

    await (manager as any).handleRuntimeAgentEnd(worker.agentId)
    await advanceToWatchdogBatchFlush()
    expect(getBatchedWatchdogMessages(managerRuntime)).toHaveLength(1)

    await manager.sendMessage(worker.agentId, 'manager', 'done', 'auto', { origin: 'internal' })

    const resetState = (manager as any).workerWatchdogState.get(worker.agentId)
    expect(resetState?.consecutiveNotifications).toBe(0)
    expect(resetState?.suppressedUntilMs).toBe(0)
    expect(resetState?.circuitOpen).toBe(false)

    // End the reported turn (no watchdog expected), then a new silent turn should notify again immediately.
    await (manager as any).handleRuntimeAgentEnd(worker.agentId)
    await advanceToWatchdogBatchFlush()
    expect(getBatchedWatchdogMessages(managerRuntime)).toHaveLength(1)

    await (manager as any).handleRuntimeAgentEnd(worker.agentId)
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
})
