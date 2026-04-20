import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SessionManager } from '@mariozechner/pi-coding-agent'
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

import type { AgentDescriptor, RequestedDeliveryMode, SwarmConfig } from '../types.js'
import type { RuntimeCreationOptions, SwarmAgentRuntime } from '../runtime-contracts.js'
import { FakeRuntime, TestSwarmManager as TestSwarmManagerBase, bootWithDefaultManager } from '../../test-support/index.js'
import { makeTempConfig as buildTempConfig } from '../../test-support/index.js'

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

async function makeTempConfig(port = 8790): Promise<SwarmConfig> {
  return buildTempConfig({
    prefix: 'swarm-manager-test-',
    port,
    omitSharedAuthFile: true,
    omitSharedSecretsFile: true,
    skipRepoMemorySkillPlaceholder: true,
  })
}


describe('SwarmManager', () => {
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

})
