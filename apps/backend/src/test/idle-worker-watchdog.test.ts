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

  async stopInFlight(options?: { abort?: boolean }): Promise<void> {
    this.stopInFlightCalls.push(options)
    this.descriptor.status = 'idle'
  }

  async terminate(options?: { abort?: boolean }): Promise<void> {
    this.terminateCalls.push(options)
    this.descriptor.status = 'terminated'
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

function buildWatchdogBody(worker: AgentDescriptor): string {
  return `⚠️ [IDLE WORKER WATCHDOG — AUTOMATED SYSTEM CHECK]

Worker \`${worker.agentId}\` completed its turn and went idle without sending a message back to you.

This is an automated notification. The worker may have produced useful output in its session log.

Worker session file: ${worker.sessionFile}

Suggested actions:
• Read the worker's session file to check its output
• Send a follow-up message to the worker if you need more information`
}

function buildExpectedModelWatchdogMessage(worker: AgentDescriptor): string {
  return `SYSTEM: ${buildWatchdogBody(worker)}`
}

function buildExpectedUserWatchdogMessage(worker: AgentDescriptor): string {
  return `⚠️ Idle worker detected — \`${worker.agentId}\` completed its turn without reporting back to its manager. The manager has been notified.`
}

afterEach(() => {
  vi.useRealTimers()
})

describe('idle worker watchdog', () => {
  it('sends a synthetic worker->manager message after the grace period when no report is sent', async () => {
    vi.useFakeTimers()

    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Silent Worker' })
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    expect(managerRuntime).toBeDefined()

    await (manager as any).handleRuntimeAgentEnd(worker.agentId)

    await vi.advanceTimersByTimeAsync(2_999)
    expect(managerRuntime?.sendCalls).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1)

    expect(managerRuntime?.sendCalls).toHaveLength(1)
    const watchdogCall = managerRuntime?.sendCalls[0]
    expect(watchdogCall?.delivery).toBe('auto')
    expect(watchdogCall?.message).toBe(buildExpectedModelWatchdogMessage(worker))

    expect(manager.publishedToUserCalls).toHaveLength(1)
    expect(manager.publishedToUserCalls[0]).toMatchObject({
      agentId: 'manager',
      source: 'system',
      text: buildExpectedUserWatchdogMessage(worker),
    })
  })

  it('re-arms watchdog state after a synthetic nudge so a later silent turn triggers again', async () => {
    vi.useFakeTimers()

    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Rearm Worker' })
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    const workerRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(managerRuntime).toBeDefined()
    expect(workerRuntime).toBeDefined()

    await (manager as any).handleRuntimeAgentEnd(worker.agentId)
    await vi.advanceTimersByTimeAsync(3_000)

    const firstWatchdogMessages = managerRuntime?.sendCalls.filter(
      (call) => call.message === buildExpectedModelWatchdogMessage(worker),
    )
    expect(firstWatchdogMessages).toHaveLength(1)
    expect(manager.publishedToUserCalls).toHaveLength(1)

    await manager.sendMessage('manager', worker.agentId, 'Please confirm completion.', 'auto', { origin: 'internal' })
    expect(workerRuntime?.sendCalls).toHaveLength(1)
    expect(workerRuntime?.sendCalls[0]?.message).toBe('SYSTEM: Please confirm completion.')

    await (manager as any).handleRuntimeAgentEnd(worker.agentId)

    await vi.advanceTimersByTimeAsync(2_999)
    const stillOneWatchdogMessage = managerRuntime?.sendCalls.filter(
      (call) => call.message === buildExpectedModelWatchdogMessage(worker),
    )
    expect(stillOneWatchdogMessage).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1)

    const secondWatchdogMessages = managerRuntime?.sendCalls.filter(
      (call) => call.message === buildExpectedModelWatchdogMessage(worker),
    )
    expect(secondWatchdogMessages).toHaveLength(2)

    const publishedWatchdogMessages = manager.publishedToUserCalls.filter(
      (call) => call.agentId === 'manager' && call.source === 'system' && call.text === buildExpectedUserWatchdogMessage(worker),
    )
    expect(publishedWatchdogMessages).toHaveLength(2)
  })

  it('does not emit a watchdog notification when the worker reports to its manager during the turn', async () => {
    vi.useFakeTimers()

    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Reporting Worker' })
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    expect(managerRuntime).toBeDefined()

    await manager.sendMessage(worker.agentId, 'manager', 'done', 'auto', { origin: 'internal' })
    await (manager as any).handleRuntimeAgentEnd(worker.agentId)

    await vi.advanceTimersByTimeAsync(3_000)

    expect(managerRuntime?.sendCalls).toHaveLength(1)
    expect(managerRuntime?.sendCalls[0]?.message).toBe('SYSTEM: done')
    expect(
      managerRuntime?.sendCalls.some((call) =>
        typeof call.message === 'string'
          ? call.message.includes('[IDLE WORKER WATCHDOG — AUTOMATED SYSTEM CHECK]')
          : false,
      ),
    ).toBe(false)
  })

  it('does not emit a watchdog notification across internal turns when the worker has already reported', async () => {
    vi.useFakeTimers()

    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Multi Turn Worker' })
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    expect(managerRuntime).toBeDefined()

    await (manager as any).handleRuntimeSessionEvent(worker.agentId, { type: 'turn_start' })
    await manager.sendMessage(worker.agentId, 'manager', 'completed subtask', 'auto', { origin: 'internal' })
    await (manager as any).handleRuntimeSessionEvent(worker.agentId, { type: 'turn_start' })
    await (manager as any).handleRuntimeAgentEnd(worker.agentId)

    await vi.advanceTimersByTimeAsync(3_000)

    expect(managerRuntime?.sendCalls).toHaveLength(1)
    expect(managerRuntime?.sendCalls[0]?.message).toBe('SYSTEM: completed subtask')
    expect(
      managerRuntime?.sendCalls.some((call) =>
        typeof call.message === 'string'
          ? call.message.includes('[IDLE WORKER WATCHDOG — AUTOMATED SYSTEM CHECK]')
          : false,
      ),
    ).toBe(false)
  })

  it('ignores stale timer callbacks after a newer turn schedules a replacement token', async () => {
    vi.useFakeTimers()

    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Stale Timer Worker' })
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    expect(managerRuntime).toBeDefined()

    await (manager as any).handleRuntimeAgentEnd(worker.agentId)

    const firstToken = (manager as any).watchdogTimerTokens.get(worker.agentId) as number
    const firstTurnSeq = ((manager as any).workerWatchdogState.get(worker.agentId) as { turnSeq: number }).turnSeq

    await vi.advanceTimersByTimeAsync(1_000)
    await (manager as any).handleRuntimeAgentEnd(worker.agentId)

    await (manager as any).handleIdleWorkerWatchdogTimer(worker.agentId, firstTurnSeq, firstToken)
    expect(managerRuntime?.sendCalls).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(2_000)
    expect(managerRuntime?.sendCalls).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(managerRuntime?.sendCalls).toHaveLength(1)
    expect(managerRuntime?.sendCalls[0]?.message).toBe(buildExpectedModelWatchdogMessage(worker))
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

    expect(managerRuntime?.sendCalls).toHaveLength(0)
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

    expect(managerRuntime?.sendCalls).toHaveLength(0)
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

    expect(managerRuntime?.sendCalls).toHaveLength(0)
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
    expect(managerRuntime?.sendCalls[0]?.message).toBe(buildExpectedModelWatchdogMessage(worker))
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

    expect(managerRuntime?.sendCalls).toHaveLength(0)
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

    expect(managerRuntime?.sendCalls).toHaveLength(0)
    expect((manager as any).workerWatchdogState.has(worker.agentId)).toBe(false)
    expect((manager as any).watchdogTimers.has(worker.agentId)).toBe(false)
    expect((manager as any).watchdogTimerTokens.has(worker.agentId)).toBe(false)
  })
})
