import { afterEach, describe, expect, it } from 'vitest'
import { AgentRuntime } from '../swarm/agent-runtime.js'
import { readSessionMeta } from '../swarm/session-manifest.js'
import { bootWithDefaultManager, createTempConfig, TestSwarmManager, type TempConfigHandle } from '../test-support/index.js'
import type { AgentContextUsage, AgentStatus, SwarmConfig } from '../swarm/types.js'

const tempConfigHandles: TempConfigHandle[] = []

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

afterEach(async () => {
  await Promise.all(tempConfigHandles.splice(0).map((handle) => handle.cleanup()))
})

async function makeTempConfig(port = 8891): Promise<SwarmConfig> {
  const handle = await createTempConfig({
    prefix: 'swarm-manager-lifecycle-characterization-',
    port,
  })
  tempConfigHandles.push(handle)
  return handle.config
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
