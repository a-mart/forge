import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getScheduleFilePath } from '../scheduler/schedule-storage.js'
import { AgentRuntime } from '../swarm/agent-runtime.js'
import { getProfileMemoryPath } from '../swarm/data-paths.js'
import { readSessionMeta } from '../swarm/session-manifest.js'
import { SwarmManager } from '../swarm/swarm-manager.js'
import type {
  AgentContextUsage,
  AgentDescriptor,
  AgentStatus,
  RequestedDeliveryMode,
  SendMessageReceipt,
  SwarmConfig,
} from '../swarm/types.js'
import type { RuntimeUserMessage, SwarmAgentRuntime } from '../swarm/runtime-contracts.js'

const tempRoots: string[] = []

class FakeRuntime {
  readonly descriptor: AgentDescriptor
  sendCalls: Array<{ message: string | RuntimeUserMessage; delivery: RequestedDeliveryMode }> = []
  recycleCalls = 0
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
    return false
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

  async smartCompact(): Promise<unknown> {
    return { status: 'ok' }
  }

  async stopInFlight(): Promise<void> {
    this.descriptor.status = 'idle'
  }

  async terminate(): Promise<void> {
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

class EventSession {
  isStreaming = false
  promptImpl: ((message: string) => Promise<void>) | undefined
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
    await this.promptImpl?.(message)
  }

  async steer(): Promise<void> {}
  async sendUserMessage(): Promise<void> {}
  async abort(): Promise<void> {}
  async compact(): Promise<unknown> { return { ok: true } }
  getContextUsage(): AgentContextUsage | undefined { return undefined }
  dispose(): void {}

  subscribe(_listener: (event: any) => void): () => void {
    return () => {}
  }
}

class TestSwarmManager extends SwarmManager {
  readonly runtimeByAgentId = new Map<string, FakeRuntime>()

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

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function makeTempConfig(port = 8891): Promise<SwarmConfig> {
  const root = await mkdtemp(join(tmpdir(), 'swarm-manager-lifecycle-characterization-'))
  tempRoots.push(root)

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

  const existingManager = manager.listAgents().find(
    (descriptor) => descriptor.agentId === config.managerId && descriptor.role === 'manager',
  )
  if (existingManager) {
    return existingManager
  }

  return manager.createManager('bootstrap', {
    name: config.managerDisplayName ?? config.managerId ?? 'manager',
    cwd: config.defaultCwd,
  })
}

async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 1_000,
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

describe('swarm-manager lifecycle characterization', () => {
  it('invokes runtime callbacks in the live normal-operation sequence', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    const descriptor = await bootWithDefaultManager(manager, config)
    const session = new EventSession()
    const callbackOrder: string[] = []

    const runtime = new AgentRuntime({
      descriptor: structuredClone(descriptor),
      session: session as any,
      systemPrompt: 'You are the manager.',
      callbacks: {
        onStatusChange: async (agentId, status, pendingCount, contextUsage) => {
          callbackOrder.push(`handleRuntimeStatus:${status}`)
          await (manager as any).handleRuntimeStatus(undefined, agentId, status, pendingCount, contextUsage)
        },
        onSessionEvent: async (agentId, event) => {
          callbackOrder.push(`handleRuntimeSessionEvent:${event.type}`)
          await (manager as any).handleRuntimeSessionEvent(agentId, event)
        },
        onAgentEnd: async (agentId) => {
          callbackOrder.push('handleRuntimeAgentEnd')
          await (manager as any).handleRuntimeAgentEnd(agentId)
        },
        onRuntimeError: async (agentId, error) => {
          callbackOrder.push(`handleRuntimeError:${error.phase}`)
          await (manager as any).handleRuntimeError(agentId, error)
        },
      },
    })

    session.isStreaming = true
    await (runtime as any).handleEvent({ type: 'agent_start' })
    await (runtime as any).handleEvent({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Finished the turn.' }],
        stopReason: 'stop',
      },
    })
    session.isStreaming = false
    await (runtime as any).handleEvent({ type: 'agent_end' })

    expect(callbackOrder).toEqual([
      'handleRuntimeSessionEvent:agent_start',
      'handleRuntimeStatus:streaming',
      'handleRuntimeSessionEvent:message_end',
      'handleRuntimeSessionEvent:agent_end',
      'handleRuntimeStatus:idle',
      'handleRuntimeAgentEnd',
    ])
  })

  it('invokes runtime callbacks in the live prompt-dispatch error sequence', async () => {
    const config = await makeTempConfig(8892)
    const manager = new TestSwarmManager(config)
    const descriptor = await bootWithDefaultManager(manager, config)
    const session = new EventSession()
    const callbackOrder: string[] = []

    session.promptImpl = async () => {
      throw new Error('synthetic prompt dispatch failure')
    }

    const runtime = new AgentRuntime({
      descriptor: structuredClone(descriptor),
      session: session as any,
      systemPrompt: 'You are the manager.',
      callbacks: {
        onStatusChange: async (agentId, status, pendingCount, contextUsage) => {
          callbackOrder.push(`handleRuntimeStatus:${status}`)
          await (manager as any).handleRuntimeStatus(undefined, agentId, status, pendingCount, contextUsage)
        },
        onSessionEvent: async (agentId, event) => {
          callbackOrder.push(`handleRuntimeSessionEvent:${event.type}`)
          await (manager as any).handleRuntimeSessionEvent(agentId, event)
        },
        onAgentEnd: async (agentId) => {
          callbackOrder.push('handleRuntimeAgentEnd')
          await (manager as any).handleRuntimeAgentEnd(agentId)
        },
        onRuntimeError: async (agentId, error) => {
          callbackOrder.push(`handleRuntimeError:${error.phase}`)
          await (manager as any).handleRuntimeError(agentId, error)
        },
      },
    })

    await runtime.sendMessage('Trigger the failure path')
    await waitForCondition(() => callbackOrder.length >= 3)

    expect(callbackOrder).toEqual([
      'handleRuntimeError:prompt_dispatch',
      'handleRuntimeStatus:idle',
      'handleRuntimeAgentEnd',
    ])
  })

  it('surfaces the neutral manual stop copy instead of manager error-style text', async () => {
    const config = await makeTempConfig(8893)
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    ;(manager as any).markPendingManualManagerStopNotice('manager')

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

  it('persists worker status transitions into session meta and active-worker stats', async () => {
    const config = await makeTempConfig(8894)
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'meta-worker' })
    const state = manager as unknown as {
      runtimeTokensByAgentId: Map<string, number>
      handleRuntimeStatus: (
        runtimeToken: number | undefined,
        agentId: string,
        status: AgentStatus,
        pendingCount: number,
        contextUsage?: AgentContextUsage,
      ) => Promise<void>
    }
    const runtimeToken = state.runtimeTokensByAgentId.get(worker.agentId)

    await state.handleRuntimeStatus(runtimeToken, worker.agentId, 'streaming', 0)

    const streamingMeta = await readSessionMeta(config.paths.dataDir, 'manager', 'manager')
    expect(streamingMeta?.workers.find((entry) => entry.id === worker.agentId)?.status).toBe('streaming')
    expect(streamingMeta?.stats.activeWorkers).toBe(1)

    await state.handleRuntimeStatus(runtimeToken, worker.agentId, 'idle', 0)

    const idleMeta = await readSessionMeta(config.paths.dataDir, 'manager', 'manager')
    expect(idleMeta?.workers.find((entry) => entry.id === worker.agentId)?.status).toBe('idle')
    expect(idleMeta?.stats.activeWorkers).toBe(0)
  })
})
