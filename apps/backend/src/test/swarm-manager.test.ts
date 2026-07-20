import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { getCommonKnowledgePath, getWorkerSessionFilePath } from '../swarm/data-paths.js'
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

import type { AgentDescriptor, SwarmConfig } from '../swarm/types.js'
import type { RuntimeCreationOptions, SwarmAgentRuntime } from '../swarm/runtime-contracts.js'
import {
  FakeRuntime,
  TestSwarmManager as TestSwarmManagerBase,
  bootWithDefaultManager,
  createCodexExternalThreadWorkerDescriptor,
} from '../test-support/index.js'

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

async function projectAssistantFinalText(
  manager: TestSwarmManager,
  agentId: string,
  runtimeMessage: unknown,
  text: string,
): Promise<void> {
  expect(typeof runtimeMessage).toBe('string')
  await (manager as any).handleRuntimeSessionEvent(agentId, {
    type: 'message_start',
    message: { role: 'user', content: runtimeMessage },
  })
  await (manager as any).handleRuntimeSessionEvent(agentId, {
    type: 'message_end',
    message: { role: 'assistant', content: text, stopReason: 'stop' },
  })
  await (manager as any).handleRuntimeSessionEvent(agentId, { type: 'turn_end', toolResults: [] })
}

function formatProjectAgentPeerRuntimeMessage(
  context: {
    fromAgentId: string
    fromDisplayName: string
    external?: boolean
    fromProfileId?: string
    fromProjectName?: string
  },
  message: string,
): string {
  return `[projectAgentContext] ${JSON.stringify(context)}\n[assistantOutputTarget] {"kind":"peer_agent"}\n\n${message}`
}

async function enqueueProjectAgentPeerInput(
  manager: TestSwarmManager,
  agentId: string,
  context: {
    fromAgentId: string
    fromDisplayName: string
    external?: boolean
    fromProfileId?: string
    fromProjectName?: string
  },
  message: string,
): Promise<string> {
  const runtimeMessage = formatProjectAgentPeerRuntimeMessage(context, message)
  await (manager as any).turnContextCoordinator.enqueue(agentId, {
    source: 'project_agent_input',
    runtimeMessageText: runtimeMessage,
    projectAgentContext: context,
    assistantOutputTarget: { kind: 'peer_agent', fromAgentId: context.fromAgentId },
  })
  return runtimeMessage
}

async function projectAssistantFinalTextWithSyntheticUserMessageStart(
  manager: TestSwarmManager,
  agentId: string,
  text: string,
  runtimeMessage: unknown = manager.runtimeByAgentId.get(agentId)?.sendCalls.at(-1)?.message,
): Promise<void> {
  expect(typeof runtimeMessage).toBe('string')
  await (manager as any).handleRuntimeSessionEvent(agentId, { type: 'turn_start' })
  await (manager as any).handleRuntimeSessionEvent(agentId, {
    type: 'message_start',
    message: { role: 'user', content: runtimeMessage },
  })
  await (manager as any).handleRuntimeSessionEvent(agentId, {
    type: 'message_start',
    message: { role: 'assistant', content: '' },
  })
  await (manager as any).handleRuntimeSessionEvent(agentId, {
    type: 'message_end',
    message: { role: 'assistant', content: text, stopReason: 'stop' },
  })
  await (manager as any).handleRuntimeSessionEvent(agentId, { type: 'turn_end', toolResults: [] })
}

async function emitCleanManagerAssistantMessage(
  manager: TestSwarmManager,
  agentId: string,
  text: string,
): Promise<void> {
  await (manager as any).handleRuntimeSessionEvent(agentId, {
    type: 'message_end',
    message: { role: 'assistant', content: text, stopReason: 'stop' },
  })
}

function assistantOutputsFor(manager: TestSwarmManager, agentId: string): any[] {
  return manager
    .getConversationHistory(agentId)
    .filter((entry) => entry.type === 'conversation_message' && entry.source === 'assistant_output')
}

function setActiveAssistantOutputTarget(
  manager: TestSwarmManager,
  agentId: string,
  target: any,
): void {
  const router = (manager as any).assistantOutputRouter
  const routeContext = router.getActiveRoute(agentId)
  router.activateManagerTurn(agentId, {
    target,
    ...(routeContext ? { routeContext } : {}),
    beginUserVisibleObligation: false,
  })
}

async function startRuntimeUserTurn(
  manager: TestSwarmManager,
  agentId = 'manager',
  runtimeMessage: unknown = manager.runtimeByAgentId.get(agentId)?.sendCalls.at(-1)?.message,
): Promise<string> {
  expect(typeof runtimeMessage).toBe('string')
  const content = runtimeMessage as string
  await (manager as any).handleRuntimeSessionEvent(agentId, {
    type: 'message_start',
    message: { role: 'user', content },
  })
  return content
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



  it('sends manager user input as steer delivery, without SYSTEM prefixing, and with source metadata annotation', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.handleUserMessage('interrupt current plan')

    const managerRuntime = manager.runtimeByAgentId.get('manager')
    expect(managerRuntime).toBeDefined()
    expect(managerRuntime?.sendCalls.at(-1)?.delivery).toBe('steer')
    expect(managerRuntime?.sendCalls.at(-1)?.message).toBe('[sourceContext] {"channel":"web"}\n[assistantOutputTarget] {"kind":"session_transcript"}\n\ninterrupt current plan')
  })

  it('streams worker active-tool snapshots even when the manager is idle', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    seedManagerDescriptorForRuntimeEventTests(manager, config)
    const state = manager as unknown as {
      descriptors: Map<string, AgentDescriptor>
      conversationEntriesByAgentId: Map<string, unknown[]>
    }
    state.descriptors.get('manager')!.profileId = 'manager'
    state.descriptors.set('worker-1', {
      agentId: 'worker-1',
      displayName: 'Worker',
      role: 'worker',
      managerId: 'manager',
      status: 'streaming',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      cwd: config.defaultCwd,
      model: config.defaultModel,
      sessionFile: join(config.paths.sessionsDir, 'worker-1.jsonl'),
    })
    state.conversationEntriesByAgentId.set('worker-1', [])

    const snapshots: Array<Record<string, unknown>> = []
    manager.on('session_active_tools_snapshot', (event) => snapshots.push(event as Record<string, unknown>))

    await manager.handleRuntimeSessionEvent('worker-1', {
      type: 'tool_execution_start',
      toolName: 'bash',
      toolCallId: 'worker-tool-1',
      args: { command: 'sleep 1' },
    })

    expect(manager.getAgent('manager')?.status).toBe('idle')
    expect(manager.getSessionActiveToolsSnapshot('manager')).toMatchObject({
      type: 'session_active_tools_snapshot',
      sessionAgentId: 'manager',
      activeTools: [
        {
          sessionAgentId: 'manager',
          actorAgentId: 'worker-1',
          toolCallId: 'worker-tool-1',
          toolName: 'bash',
        },
      ],
    })
    expect(snapshots.at(-1)).toMatchObject({ sessionAgentId: 'manager', activeTools: [{ actorAgentId: 'worker-1' }] })
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

  it('refreshes manual stop notice and allowance for delayed invalidated-token abort callbacks', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    seedManagerDescriptorForRuntimeEventTests(manager, config)
    const controller = (manager as any).runtimeController

    vi.useFakeTimers()
    try {
      const token = controller.allocateRuntimeToken('manager')
      ;(manager as any).markPendingManualManagerStopNotice('manager')
      controller.allowInvalidatedManualStopMessageEnd('manager', token)
      controller.clearRuntimeToken('manager')

      vi.advanceTimersByTime(16_000)
      ;(manager as any).markPendingManualManagerStopNotice('manager')
      controller.allowInvalidatedManualStopMessageEnd('manager', token)

      await controller.handleRuntimeSessionEvent(token, 'manager', {
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
    } finally {
      vi.useRealTimers()
    }
  })

  it('immediate manual stop notice clears stale pending notice and invalidated-token allowance', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    seedManagerDescriptorForRuntimeEventTests(manager, config)
    const controller = (manager as any).runtimeController
    const token = controller.allocateRuntimeToken('manager')

    ;(manager as any).markPendingManualManagerStopNotice('manager')
    controller.allowInvalidatedManualStopMessageEnd('manager', token)
    controller.clearRuntimeToken('manager')
    ;(manager as any).emitImmediateManualManagerStopNotice('manager')

    await controller.handleRuntimeSessionEvent(token, 'manager', {
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
      history.filter(
        (entry) =>
          entry.type === 'conversation_message' &&
          entry.role === 'system' &&
          entry.text === 'Session stopped.',
      ),
    ).toHaveLength(1)
    expect(
      history.some(
        (entry) =>
          entry.type === 'conversation_message' &&
          entry.role === 'system' &&
          entry.text.includes('Manager reply failed'),
      ),
    ).toBe(false)
  })

  it('expires delayed invalidated-token allowance with the pending manual stop notice', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    seedManagerDescriptorForRuntimeEventTests(manager, config)
    const controller = (manager as any).runtimeController

    vi.useFakeTimers()
    try {
      const token = controller.allocateRuntimeToken('manager')
      ;(manager as any).markPendingManualManagerStopNotice('manager')
      controller.allowInvalidatedManualStopMessageEnd('manager', token)
      controller.clearRuntimeToken('manager')

      vi.advanceTimersByTime(16_000)

      await controller.handleRuntimeSessionEvent(token, 'manager', {
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
      ).toBe(false)
      expect(
        history.some(
          (entry) =>
            entry.type === 'conversation_message' &&
            entry.role === 'system' &&
            entry.text.includes('Manager reply failed'),
        ),
      ).toBe(false)
    } finally {
      vi.useRealTimers()
    }
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

  it('projects normal manager assistant turns as assistant_output conversation messages', async () => {
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

    await (manager as any).handleRuntimeSessionEvent('manager', { type: 'turn_end', toolResults: [] })

    const history = manager.getConversationHistory('manager')
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({
      type: 'conversation_message',
      role: 'assistant',
      source: 'assistant_output',
      text: 'normal hidden manager assistant turn',
    })
  })

  it('projects non-error manager turns that mention token limits as assistant_output', async () => {
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
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({
      type: 'conversation_message',
      role: 'assistant',
      source: 'assistant_output',
      text: 'We should keep the summary short to avoid token limit issues.',
    })
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

  it('projects direct web manager assistant final text as assistant_output', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.handleUserMessage('summarize this')
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    const runtimeMessage = managerRuntime?.sendCalls.at(-1)?.message
    expect(typeof runtimeMessage).toBe('string')

    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'message_start',
      message: { role: 'user', content: runtimeMessage },
    })
    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'message_end',
      message: { role: 'assistant', content: 'Direct final answer', stopReason: 'stop' },
    })
    await (manager as any).handleRuntimeSessionEvent('manager', { type: 'turn_end', toolResults: [] })

    const assistantOutputs = manager
      .getConversationHistory('manager')
      .filter((entry) => entry.type === 'conversation_message' && entry.source === 'assistant_output')

    expect(assistantOutputs).toHaveLength(1)
    expect(assistantOutputs[0]).toMatchObject({
      role: 'assistant',
      text: 'Direct final answer',
      sourceContext: { channel: 'web' },
    })
  })

  it('still warns when a direct web user turn ends without anything visible', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.handleUserMessage('Please answer this request.')
    await startRuntimeUserTurn(manager)
    expect((manager as any).resolveManagerAssistantFinalOutputRoute('manager', undefined)).toEqual(
      expect.objectContaining({ requiresVisibleResponse: true }),
    )
    await (manager as any).handleRuntimeSessionEvent('manager', { type: 'turn_end', toolResults: [] })
    await (manager as any).handleRuntimeSessionEvent('manager', { type: 'agent_end' })

    expect(
      manager.getConversationHistory('manager').filter(
        (entry) =>
          entry.type === 'conversation_message' &&
          entry.role === 'system' &&
          entry.text === 'The manager completed this turn without a visible response.',
      ),
    ).toHaveLength(1)
  })

  it('flushes preserved present_choices assistant text only after opening the choice request', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    const runtimeController = (manager as any).runtimeController
    const originalFlush = runtimeController.flushPreservedManagerAssistantOutputForTool.bind(runtimeController)
    const flushOrderChecks: boolean[] = []
    vi.spyOn(runtimeController, 'flushPreservedManagerAssistantOutputForTool').mockImplementation(
      (agentId: string, toolName: string) => {
        flushOrderChecks.push(
          manager.getConversationHistory('manager').some(
            (entry: any) => entry.type === 'choice_request' && entry.status === 'pending',
          ),
        )
        return originalFlush(agentId, toolName)
      },
    )

    runtimeController.activateManagerAssistantOutputTurn('manager', { kind: 'session_transcript', channel: 'web' })
    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'message_end',
      message: {
        role: 'assistant',
        stopReason: 'toolUse',
        content: [
          { type: 'text', text: 'Pick one option.' },
          { type: 'toolCall', name: 'present_choices', id: 'choice-1', arguments: { questions: [] } },
        ],
      },
    })

    const pending = manager.requestUserChoice('manager', [
      {
        id: 'q1',
        question: 'Choose one.',
        options: [
          { id: 'alpha', label: 'Alpha' },
          { id: 'beta', label: 'Beta' },
        ],
      },
    ])

    const choiceRequest = manager.getConversationHistory('manager').find(
      (entry: any) => entry.type === 'choice_request' && entry.status === 'pending',
    ) as any
    expect(choiceRequest).toBeDefined()
    expect(flushOrderChecks).toEqual([true])
    expect(assistantOutputsFor(manager, 'manager')).toMatchObject([
      { text: 'Pick one option.', source: 'assistant_output' },
    ])

    manager.resolveChoiceRequest(choiceRequest.choiceId, [{ questionId: 'q1', selectedOptionIds: ['alpha'] }])
    await expect(pending).resolves.toEqual([{ questionId: 'q1', selectedOptionIds: ['alpha'] }])
  })

  it('projects manager assistant final text after answered web present_choices continuation', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.handleUserMessage('help me decide')
    await startRuntimeUserTurn(manager, 'manager')
    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'message_end',
      message: {
        role: 'assistant',
        stopReason: 'toolUse',
        content: [
          { type: 'thinking', thinking: 'hidden initial thinking', signature: 'hidden-signature' },
          { type: 'text', text: 'Pick one option.' },
          { type: 'toolCall', name: 'present_choices', id: 'choice-tool-1', arguments: { questions: [] } },
        ],
      },
    })
    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'tool_execution_start',
      toolName: 'present_choices',
      toolCallId: 'choice-tool-1',
      args: {},
    })

    const pending = manager.requestUserChoice('manager', [
      {
        id: 'q1',
        question: 'Choose one.',
        options: [
          { id: 'alpha', label: 'Alpha' },
          { id: 'beta', label: 'Beta' },
        ],
      },
    ])
    const choiceRequest = manager.getConversationHistory('manager').find(
      (entry: any) => entry.type === 'choice_request' && entry.status === 'pending',
    ) as any
    expect(choiceRequest).toBeDefined()

    await (manager as any).handleRuntimeSessionEvent('manager', { type: 'turn_end', toolResults: [] })

    manager.resolveChoiceRequest(choiceRequest.choiceId, [{ questionId: 'q1', selectedOptionIds: ['alpha'] }])
    await expect(pending).resolves.toEqual([{ questionId: 'q1', selectedOptionIds: ['alpha'] }])
    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'tool_execution_end',
      toolName: 'present_choices',
      toolCallId: 'choice-tool-1',
      isError: false,
      result: { answers: [{ questionId: 'q1', selectedOptionIds: ['alpha'] }] },
    })
    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'message_end',
      message: {
        role: 'assistant',
        stopReason: 'stop',
        content: [
          { type: 'thinking', thinking: 'hidden final thinking', signature: 'secret-signature' },
          { type: 'text', text: 'Final clean answer.' },
        ],
      },
    })
    await (manager as any).handleRuntimeSessionEvent('manager', { type: 'turn_end', toolResults: [] })

    const choiceRows = manager
      .getConversationHistory('manager')
      .filter((entry: any) => entry.type === 'choice_request' && entry.choiceId === choiceRequest.choiceId)
    expect(choiceRows.map((entry: any) => entry.status)).toEqual(['pending', 'answered'])

    expect(assistantOutputsFor(manager, 'manager')).toMatchObject([
      { text: 'Pick one option.', source: 'assistant_output' },
      { text: 'Final clean answer.', source: 'assistant_output' },
    ])
    expect(assistantOutputsFor(manager, 'manager').map((entry) => entry.text).join('\n')).not.toContain('hidden')
    expect((manager as any).assistantOutputRouter.activateChoiceContinuation(
      choiceRequest.choiceId,
      'manager',
    )).toBe(false)

    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'message_end',
      message: { role: 'assistant', content: 'Unrelated internal text', stopReason: 'stop' },
    })
    await (manager as any).handleRuntimeSessionEvent('manager', { type: 'turn_end', toolResults: [] })
    expect(assistantOutputsFor(manager, 'manager').map((entry) => entry.text)).toEqual([
      'Pick one option.',
      'Final clean answer.',
      'Unrelated internal text',
    ])
  })

  it('does not project non-web present_choices continuations into the web transcript', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.handleUserMessage('telegram choice', {
      sourceContext: { channel: 'telegram', channelId: 'telegram-channel', userId: 'telegram-user' },
    })
    await startRuntimeUserTurn(manager, 'manager')
    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'message_end',
      message: {
        role: 'assistant',
        stopReason: 'toolUse',
        content: [
          { type: 'text', text: 'Pick one option.' },
          { type: 'toolCall', name: 'present_choices', id: 'choice-tool-1', arguments: { questions: [] } },
        ],
      },
    })
    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'tool_execution_start',
      toolName: 'present_choices',
      toolCallId: 'choice-tool-1',
      args: {},
    })

    const pending = manager.requestUserChoice('manager', [{ id: 'q1', question: 'Choose one.' }])
    const choiceRequest = manager.getConversationHistory('manager').find(
      (entry: any) => entry.type === 'choice_request' && entry.status === 'pending',
    ) as any
    await (manager as any).handleRuntimeSessionEvent('manager', { type: 'turn_end', toolResults: [] })
    manager.resolveChoiceRequest(choiceRequest.choiceId, [{ questionId: 'q1', selectedOptionIds: ['alpha'] }])
    await expect(pending).resolves.toEqual([{ questionId: 'q1', selectedOptionIds: ['alpha'] }])
    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'tool_execution_end',
      toolName: 'present_choices',
      toolCallId: 'choice-tool-1',
      isError: false,
      result: {},
    })
    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'message_end',
      message: { role: 'assistant', content: 'Telegram-only final answer.', stopReason: 'stop' },
    })
    await (manager as any).handleRuntimeSessionEvent('manager', { type: 'turn_end', toolResults: [] })

    expect(assistantOutputsFor(manager, 'manager')).toEqual([])
  })

  it('does not flush preserved present_choices assistant text when choice creation fails', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    const runtimeController = (manager as any).runtimeController
    const flushSpy = vi.spyOn(runtimeController, 'flushPreservedManagerAssistantOutputForTool')

    await expect(manager.requestUserChoice('missing-agent', [
      { id: 'q1', question: 'Choose one.' },
    ])).rejects.toThrow('Agent not found: missing-agent')

    expect(flushSpy).not.toHaveBeenCalled()
    expect(assistantOutputsFor(manager, 'manager')).toEqual([])
  })

  it('projects direct web manager assistant final text when no-echo provider emits synthetic user message_start', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.handleUserMessage('summarize with claude ordering')
    await projectAssistantFinalTextWithSyntheticUserMessageStart(manager, 'manager', 'Direct final answer without provider echo')

    expect(assistantOutputsFor(manager, 'manager')).toHaveLength(1)
    expect(assistantOutputsFor(manager, 'manager')[0]).toMatchObject({
      role: 'assistant',
      text: 'Direct final answer without provider echo',
      sourceContext: { channel: 'web' },
    })
  })

  it('keeps the next identical Pi context while suppressing the superseded final', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const runtimeText = 'identical queued Pi runtime text'
    const firstSourceContext = { channel: 'web' as const, messageId: 'first-turn' }
    const secondSourceContext = { channel: 'web' as const, messageId: 'second-turn' }
    const enqueueInboundTurnContext = (manager as any).turnContextCoordinator.enqueue.bind(
      (manager as any).turnContextCoordinator,
    ) as (
      agentId: string,
      context: any,
    ) => Promise<unknown>

    await enqueueInboundTurnContext('manager', {
      source: 'user_input',
      runtimeMessageText: runtimeText,
      sourceContext: firstSourceContext,
      assistantOutputTarget: { kind: 'session_transcript', channel: 'web', sourceContext: firstSourceContext },
    })
    await enqueueInboundTurnContext('manager', {
      source: 'user_input',
      runtimeMessageText: runtimeText,
      sourceContext: secondSourceContext,
      assistantOutputTarget: { kind: 'session_transcript', channel: 'web', sourceContext: secondSourceContext },
    })

    await (manager as any).handleRuntimeSessionEvent('manager', { type: 'turn_start' })
    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'message_start',
      message: { role: 'user', content: runtimeText },
    })
    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'message_end',
      message: { role: 'assistant', content: 'First identical turn final', stopReason: 'stop' },
    })
    await (manager as any).handleRuntimeSessionEvent('manager', { type: 'turn_end', toolResults: [] })

    await projectAssistantFinalTextWithSyntheticUserMessageStart(manager, 'manager', 'Second identical turn final', runtimeText)

    expect(assistantOutputsFor(manager, 'manager')).toMatchObject([
      { text: 'Second identical turn final', sourceContext: { channel: secondSourceContext.channel } },
    ])
    expect(assistantOutputsFor(manager, 'manager').map((entry) => entry.text))
      .not.toContain('First identical turn final')
  })





  it('clears turn-start activation on runtime error so later turns cannot inherit stale context', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.handleUserMessage('web turn before runtime error')
    await (manager as any).handleRuntimeSessionEvent('manager', { type: 'turn_start' })
    await (manager as any).handleRuntimeError('manager', { message: 'runtime failed after turn_start' })

    await manager.handleUserMessage('web turn after runtime error')
    await projectAssistantFinalTextWithSyntheticUserMessageStart(manager, 'manager', 'Recovered direct final')

    await manager.handleUserMessage('telegram turn after runtime error', {
      sourceContext: { channel: 'telegram', channelId: 'telegram-channel', userId: 'telegram-user' },
    })
    await projectAssistantFinalTextWithSyntheticUserMessageStart(manager, 'manager', 'Protected final must not project')

    expect(assistantOutputsFor(manager, 'manager').map((entry) => entry.text)).toEqual([
      'Recovered direct final',
    ])
  })


  it('does not project direct assistant final text for collaboration or telegram inputs', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.dispatchRuntimeUserMessage({
      targetAgentId: 'manager',
      text: 'collab update',
      sourceContext: { channel: 'web', channelId: 'collab-channel', userId: 'user-1' },
      collaborationAuthor: {
        userId: 'user-1',
        displayName: 'Adam',
        role: 'admin',
        workspaceId: 'workspace-1',
        channelId: 'collab-channel',
      },
    })
    const collabRuntimeMessage = manager.runtimeByAgentId.get('manager')?.sendCalls.at(-1)?.message
    expect(typeof collabRuntimeMessage).toBe('string')
    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'message_start',
      message: { role: 'user', content: collabRuntimeMessage },
    })
    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'message_end',
      message: { role: 'assistant', content: 'Collab direct final', stopReason: 'stop' },
    })
    await (manager as any).handleRuntimeSessionEvent('manager', { type: 'turn_end', toolResults: [] })

    await manager.handleUserMessage('telegram update', {
      sourceContext: { channel: 'telegram', channelId: 'telegram-channel', userId: 'telegram-user' },
    })
    const telegramRuntimeMessage = manager.runtimeByAgentId.get('manager')?.sendCalls.at(-1)?.message
    expect(typeof telegramRuntimeMessage).toBe('string')
    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'message_start',
      message: { role: 'user', content: telegramRuntimeMessage },
    })
    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'message_end',
      message: { role: 'assistant', content: 'Telegram direct final', stopReason: 'stop' },
    })
    await (manager as any).handleRuntimeSessionEvent('manager', { type: 'turn_end', toolResults: [] })

    const assistantOutputs = manager
      .getConversationHistory('manager')
      .filter((entry) => entry.type === 'conversation_message' && entry.source === 'assistant_output')

    expect(assistantOutputs).toEqual([])
  })

  it('gates remembered web transcript targets through manager surface policy', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    const state = manager as unknown as { descriptors: Map<string, AgentDescriptor> }

    state.descriptors.get('manager')!.sessionSurface = 'collab'
    setActiveAssistantOutputTarget(manager, 'manager', {
      kind: 'session_transcript',
      channel: 'web',
      sourceContext: { channel: 'web' },
    })
    await emitCleanManagerAssistantMessage(manager, 'manager', 'Misclassified collab final must not project')
    expect(assistantOutputsFor(manager, 'manager')).toEqual([])

    state.descriptors.get('manager')!.sessionSurface = undefined
    setActiveAssistantOutputTarget(manager, 'manager', {
      kind: 'session_transcript',
      channel: 'web',
      sourceContext: { channel: 'web' },
    })
    await emitCleanManagerAssistantMessage(manager, 'manager', 'Normal remembered web final projects')
    expect(assistantOutputsFor(manager, 'manager').map((entry) => entry.text)).toEqual([
      'Normal remembered web final projects',
    ])
  })




  it('allows assistant_output for direct web project-agent and Agent Architect session transcripts', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.setSessionProjectAgent('manager', { whenToUse: 'Answer as a project agent' })
    await manager.handleUserMessage('project-agent direct web turn')
    await projectAssistantFinalText(
      manager,
      'manager',
      manager.runtimeByAgentId.get('manager')?.sendCalls.at(-1)?.message,
      'Project agent direct answer',
    )

    await manager.handleUserMessage('project-agent delegated web turn')
    await startRuntimeUserTurn(manager)
    const worker = await manager.spawnAgent('manager', {
      agentId: 'Project Agent Worker',
      initialMessage: 'Do the delegated work.',
    })
    await (manager as any).handleRuntimeSessionEvent('manager', { type: 'turn_end', toolResults: [] })
    await (manager as any).handleRuntimeSessionEvent(worker.agentId, {
      type: 'message_end',
      message: { role: 'assistant', content: 'Project-agent work finished.', stopReason: 'stop' },
    })
    await (manager as any).handleRuntimeAgentEnd(worker.agentId)
    await projectAssistantFinalText(
      manager,
      'manager',
      manager.runtimeByAgentId.get('manager')?.sendCalls.at(-1)?.message,
      'Project agent delegated answer',
    )

    const state = manager as unknown as { descriptors: Map<string, AgentDescriptor> }
    state.descriptors.get('manager')!.projectAgent = undefined
    state.descriptors.get('manager')!.archetypeId = 'agent-architect'
    state.descriptors.get('manager')!.sessionPurpose = 'agent_creator'

    await manager.handleUserMessage('agent architect direct web turn')
    await projectAssistantFinalText(
      manager,
      'manager',
      manager.runtimeByAgentId.get('manager')?.sendCalls.at(-1)?.message,
      'Agent Architect direct answer',
    )

    expect(assistantOutputsFor(manager, 'manager').map((entry) => entry.text)).toEqual([
      'Project agent direct answer',
      'Project agent delegated answer',
      'Agent Architect direct answer',
    ])
  })

  it('keeps Cortex direct web assistant text explicit-tool-only for now', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    const state = manager as unknown as { descriptors: Map<string, AgentDescriptor> }
    state.descriptors.get('manager')!.archetypeId = 'cortex'

    await manager.handleUserMessage('cortex direct web turn')
    await projectAssistantFinalText(
      manager,
      'manager',
      manager.runtimeByAgentId.get('manager')?.sendCalls.at(-1)?.message,
      'Cortex direct answer',
    )

    expect(assistantOutputsFor(manager, 'manager')).toEqual([])
  })

  it('projects project-agent peer input clean finals in normal web-visible manager sessions', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const runtimeMessage = await enqueueProjectAgentPeerInput(
      manager,
      'manager',
      {
        fromAgentId: 'it-ops-director',
        fromDisplayName: 'IT Ops Director',
        external: false,
        fromProfileId: 'middleman-project',
        fromProjectName: 'Middleman Project',
      },
      'Plain-film setup finished; summarize this to Adam.',
    )

    await projectAssistantFinalText(
      manager,
      'manager',
      runtimeMessage,
      'The plain-film setup is complete and ready for review.',
    )

    expect(assistantOutputsFor(manager, 'manager').map((entry) => entry.text)).toEqual([
      'The plain-film setup is complete and ready for review.',
    ])
  })

  it('projects external project-agent peer finals to the interactive web session, keeping collab and Cortex hidden', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    // Regression (ortho-hr/clario 2026-07-08): a plain web session coordinated
    // with an external project agent; the reply arrived as peer input and the
    // manager's wrap-up final was suppressed by the blanket external-turn
    // exclusion — the user's answer was delivered nowhere. The wrap-up is
    // addressed to the session owner and must render.
    const externalRuntimeMessage = await enqueueProjectAgentPeerInput(
      manager,
      'manager',
      {
        fromAgentId: 'it-ops-director',
        fromDisplayName: 'IT Ops Director',
        external: true,
        fromProfileId: 'it-ops',
        fromProjectName: 'it-ops',
      },
      'Checklist/guidance for the SQL access work',
    )
    await projectAssistantFinalText(manager, 'manager', externalRuntimeMessage, 'IT Ops responded with the access guidance.')
    expect(assistantOutputsFor(manager, 'manager').map((entry) => entry.text)).toEqual([
      'IT Ops responded with the access guidance.',
    ])

    const state = manager as unknown as { descriptors: Map<string, AgentDescriptor> }
    state.descriptors.get('manager')!.sessionSurface = 'collab'
    const collabRuntimeMessage = await enqueueProjectAgentPeerInput(
      manager,
      'manager',
      { fromAgentId: 'collab-peer', fromDisplayName: 'Collab Peer', external: false },
      'Collaboration protected update',
    )
    await projectAssistantFinalText(manager, 'manager', collabRuntimeMessage, 'Collab peer final must stay hidden')

    state.descriptors.get('manager')!.sessionSurface = undefined
    state.descriptors.get('manager')!.profileId = 'cortex'
    const cortexRuntimeMessage = await enqueueProjectAgentPeerInput(
      manager,
      'manager',
      { fromAgentId: 'cortex-peer', fromDisplayName: 'Cortex Peer', external: false },
      'Cortex protected update',
    )
    await projectAssistantFinalText(manager, 'manager', cortexRuntimeMessage, 'Cortex peer final must stay hidden')

    expect(assistantOutputsFor(manager, 'manager').map((entry) => entry.text)).toEqual([
      'IT Ops responded with the access guidance.',
    ])
  })

  it('does not warn after a tool-only project-agent callback follows a visible completion', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    const sessionManager = await bootWithDefaultManager(manager, config)
    const documentation = await manager.createManager(sessionManager.agentId, {
      name: 'Documentation',
      cwd: config.defaultCwd,
    })
    await manager.setSessionProjectAgent(documentation.agentId, { whenToUse: 'Review documentation impact.' })

    await manager.handleUserMessage('Finish the UI change and report back.')
    await startRuntimeUserTurn(manager)
    await emitCleanManagerAssistantMessage(manager, 'manager', 'Done. The UI change is complete.')
    await (manager as any).handleRuntimeSessionEvent('manager', { type: 'turn_end', toolResults: [] })
    await (manager as any).handleRuntimeSessionEvent('manager', { type: 'agent_end' })

    await manager.sendMessage('manager', documentation.agentId, 'Check whether the docs need an update.', 'auto')
    await manager.sendMessage(
      documentation.agentId,
      'manager',
      'Received. I am checking the relevant help and documentation now.',
      'auto',
    )
    await startRuntimeUserTurn(manager)
    expect((manager as any).resolveManagerAssistantFinalOutputRoute('manager', undefined)).toEqual(
      expect.objectContaining({
        decision: expect.objectContaining({ visible: true, channel: 'web' }),
        requiresVisibleResponse: false,
      }),
    )
    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'tool_execution_start',
      toolCallId: 'continue-docs-check',
      toolName: 'send_message_to_agent',
      args: {},
    })
    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'tool_execution_end',
      toolCallId: 'continue-docs-check',
      toolName: 'send_message_to_agent',
      result: { content: [{ type: 'text', text: 'Queued message for Documentation.' }] },
      isError: false,
    })
    await (manager as any).handleRuntimeSessionEvent('manager', { type: 'turn_end', toolResults: [] })
    await (manager as any).handleRuntimeSessionEvent('manager', { type: 'agent_end' })

    expect(assistantOutputsFor(manager, 'manager').map((entry) => entry.text)).toEqual([
      'Done. The UI change is complete.',
    ])
    expect(
      manager.getConversationHistory('manager').filter(
        (entry) =>
          entry.type === 'conversation_message' &&
          entry.role === 'system' &&
          entry.text === 'The manager completed this turn without a visible response.',
      ),
    ).toEqual([])
  })

  it('routes internal manager messages and project-agent peer context out of the default web transcript', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    const sender = await bootWithDefaultManager(manager, config)
    const target = await manager.createManager(sender.agentId, {
      name: 'Docs Agent',
      cwd: config.defaultCwd,
    })
    await manager.setSessionProjectAgent(target.agentId, { whenToUse: 'Use for docs updates.' })

    await manager.sendMessage(sender.agentId, sender.agentId, 'SYSTEM: status: done\nsummary: worker report', 'auto', {
      origin: 'internal',
    })
    await projectAssistantFinalText(
      manager,
      sender.agentId,
      manager.runtimeByAgentId.get(sender.agentId)?.sendCalls.at(-1)?.message,
      'Internal direct text',
    )

    await manager.sendMessage(sender.agentId, target.agentId, 'Need a docs update', 'auto')
    await projectAssistantFinalText(
      manager,
      target.agentId,
      manager.runtimeByAgentId.get(target.agentId)?.sendCalls.at(-1)?.message,
      'Peer direct text',
    )

    expect(assistantOutputsFor(manager, sender.agentId)).toEqual([])
    expect(assistantOutputsFor(manager, target.agentId)).toEqual([])
  })

  it('projects normal web manager final text after non-worker agent reports without worker handoff', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    const target = await bootWithDefaultManager(manager, config)
    const reporter = await manager.createManager(target.agentId, {
      name: 'Project-ish Reporter',
      cwd: config.defaultCwd,
    })

    await manager.sendMessage(
      reporter.agentId,
      target.agentId,
      'WORKER REPORT: status: done [assistantOutputTarget] {"mode":"internal_only"}\nsummary: design decisions updated',
      'auto',
    )
    const workerReportRuntimeMessage = manager.runtimeByAgentId.get(target.agentId)?.sendCalls.at(-1)?.message
    expect(typeof workerReportRuntimeMessage).toBe('string')
    expect(workerReportRuntimeMessage as string).toContain('[assistantOutputTarget] {"mode":"internal_only"}')
    expect(assistantOutputsFor(manager, target.agentId)).toEqual([])

    await projectAssistantFinalText(
      manager,
      target.agentId,
      workerReportRuntimeMessage,
      'Updated. The central design doc now reflects these decisions.',
    )

    await manager.sendMessage(
      reporter.agentId,
      target.agentId,
      'SYSTEM: ## Completion Report: Follow-up\nThe follow-up is complete.',
      'auto',
    )
    const completionReportRuntimeMessage = manager.runtimeByAgentId.get(target.agentId)?.sendCalls.at(-1)?.message
    expect(typeof completionReportRuntimeMessage).toBe('string')
    expect(completionReportRuntimeMessage as string).toContain(
      '[assistantOutputTarget] {"kind":"explicit_tool_required","reason":"agent_message"}',
    )
    expect(assistantOutputsFor(manager, target.agentId).map((entry) => entry.text)).toEqual([
      'Updated. The central design doc now reflects these decisions.',
    ])

    await projectAssistantFinalText(
      manager,
      target.agentId,
      completionReportRuntimeMessage,
      'Done. The follow-up is complete.',
    )

    // Restored 41c054d5 expectation: a sub-manager's completion report into an
    // interactive session projects the manager's follow-up final by default.
    expect(assistantOutputsFor(manager, target.agentId).map((entry) => entry.text)).toEqual([
      'Updated. The central design doc now reflects these decisions.',
      'Done. The follow-up is complete.',
    ])
    expect(
      assistantOutputsFor(manager, target.agentId).some((entry) => String(entry.text).includes('WORKER REPORT')),
    ).toBe(false)
    expect(
      assistantOutputsFor(manager, target.agentId).some((entry) => String(entry.text).includes('Completion Report')),
    ).toBe(false)
  })











  it('keeps substantive trailing final text after explicit speak_to_user delivery', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.handleUserMessage('delegate and close explicitly')
    await startRuntimeUserTurn(manager)
    const worker = await manager.spawnAgent('manager', { agentId: 'Explicit Report Worker', initialMessage: 'Do it.' })
    await (manager as any).handleRuntimeSessionEvent('manager', { type: 'turn_end', toolResults: [] })

    await (manager as any).handleRuntimeSessionEvent(worker.agentId, {
      type: 'message_end',
      message: { role: 'assistant', content: 'Explicit closeout result.', stopReason: 'stop' },
    })
    await (manager as any).handleRuntimeAgentEnd(worker.agentId)
    const reportRuntimeMessage = await startRuntimeUserTurn(manager)
    expect(reportRuntimeMessage).toContain('[workerResult]')
    await manager.publishToUser('manager', 'Explicit closeout', 'speak_to_user')
    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'message_end',
      message: { role: 'assistant', content: 'Duplicate closeout', stopReason: 'stop' },
    })
    await (manager as any).handleRuntimeSessionEvent('manager', { type: 'turn_end', toolResults: [] })

    expect(assistantOutputsFor(manager, 'manager').map((entry) => entry.text)).toEqual(['Duplicate closeout'])
    expect(
      manager.getConversationHistory('manager').filter(
        (entry) =>
          entry.type === 'conversation_message' &&
          entry.role === 'assistant' &&
          (entry.source === 'speak_to_user' || entry.source === 'assistant_output'),
      ),
    ).toEqual([
      expect.objectContaining({ source: 'speak_to_user', text: 'Explicit closeout' }),
      expect.objectContaining({ source: 'assistant_output', text: 'Duplicate closeout' }),
    ])
  })

  it('uses exact NO_REPLY to suppress the provider final after speak_to_user delivery', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.handleUserMessage('delegate and close explicitly')
    await startRuntimeUserTurn(manager)
    const worker = await manager.spawnAgent('manager', { agentId: 'Silent Final Worker', initialMessage: 'Do it.' })
    await (manager as any).handleRuntimeSessionEvent('manager', { type: 'turn_end', toolResults: [] })

    await (manager as any).handleRuntimeSessionEvent(worker.agentId, {
      type: 'message_end',
      message: { role: 'assistant', content: 'Explicit closeout result.', stopReason: 'stop' },
    })
    await (manager as any).handleRuntimeAgentEnd(worker.agentId)
    const reportRuntimeMessage = await startRuntimeUserTurn(manager)
    expect(reportRuntimeMessage).toContain('[workerResult]')
    await manager.publishToUser('manager', 'Explicit closeout', 'speak_to_user')
    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'message_end',
      message: { role: 'assistant', content: 'NO_REPLY', stopReason: 'stop' },
    })
    await (manager as any).handleRuntimeSessionEvent('manager', { type: 'turn_end', toolResults: [] })

    expect(assistantOutputsFor(manager, 'manager')).toEqual([])
    expect(
      manager.getConversationHistory('manager').filter(
        (entry) =>
          entry.type === 'conversation_message' &&
          entry.role === 'assistant' &&
          (entry.source === 'speak_to_user' || entry.source === 'assistant_output'),
      ),
    ).toEqual([
      expect.objectContaining({ source: 'speak_to_user', text: 'Explicit closeout' }),
    ])
    expect(
      manager.getConversationHistory('manager').some(
        (entry) => 'text' in entry && typeof entry.text === 'string' && entry.text.trim() === 'NO_REPLY',
      ),
    ).toBe(false)
  })






  it('projects assistant_output after canonical speak_to_user publication even when duplicate', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.handleUserMessage('answer explicitly')
    const runtimeMessage = manager.runtimeByAgentId.get('manager')?.sendCalls.at(-1)?.message
    expect(typeof runtimeMessage).toBe('string')
    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'message_start',
      message: { role: 'user', content: runtimeMessage },
    })
    await manager.publishToUser('manager', 'Explicit answer', 'speak_to_user')
    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'tool_execution_end',
      toolName: 'speak_to_user',
      toolCallId: 'tool-1',
      isError: false,
      result: { providerWrappedResult: { noPublishedFlag: true } },
    })
    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'message_end',
      message: { role: 'assistant', content: 'Duplicate direct final', stopReason: 'stop' },
    })
    await (manager as any).handleRuntimeSessionEvent('manager', { type: 'turn_end', toolResults: [] })

    expect(assistantOutputsFor(manager, 'manager').map((entry) => entry.text)).toEqual(['Duplicate direct final'])
  })

  it('retains legacy source metadata internally while failing closed for output routing', async () => {
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
      '[sourceContext] {"channel":"telegram","channelId":"123456","userId":"456789","threadTs":"173.456","channelType":"group","teamId":"T789"}\n[assistantOutputTarget] {"mode":"internal_only"}\n\nreply in telegram thread',
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

  it('uses explicit web speak_to_user targets without inferred fallback behavior', async () => {
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
      channel: 'web',
      userId: '000111',
    })

    const history = manager.getConversationHistory('manager')
    const assistantEvent = [...history]
      .reverse()
      .find((entry) => entry.type === 'conversation_message' && entry.source === 'speak_to_user')

    expect(assistantEvent).toBeDefined()
    if (assistantEvent?.type === 'conversation_message') {
      expect(assistantEvent.sourceContext).toEqual({
        channel: 'web',
        channelId: undefined,
        userId: '000111',
        messageId: undefined,
        threadTs: undefined,
        integrationProfileId: undefined,
        channelType: undefined,
        teamId: undefined,
      })
    }
  })

  it('rejects explicit retired-channel speak_to_user targets', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await expect(
      manager.publishToUser('manager', 'ack from manager', 'speak_to_user', {
        channel: 'telegram',
      }),
    ).rejects.toThrow('speak_to_user only supports web delivery')
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

  it('coalesces duplicate agents_snapshot emissions within the same turn', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const snapshots: Array<{ type: string; agents: AgentDescriptor[] }> = []
    manager.on('agents_snapshot', (event) => {
      if (event.type === 'agents_snapshot') {
        snapshots.push(event)
      }
    })

    const initialVersion = manager.getAgentsSnapshotVersion()
    const eventCoordinator = (manager as any).eventCoordinator
    eventCoordinator.emitAgentsSnapshot()
    eventCoordinator.emitAgentsSnapshot()
    eventCoordinator.emitAgentsSnapshot()

    expect(snapshots).toHaveLength(0)

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(snapshots).toHaveLength(1)
    expect(manager.getAgentsSnapshotVersion()).toBe(initialVersion + 1)
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

    await manager.sendMessage('manager', worker.agentId, 'WORKER REPORT: status: done', 'auto')
    expect(workerRuntime?.sendCalls.at(-1)?.message).toBe('SYSTEM: WORKER REPORT: status: done')
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

  it('passes terminateExternalThreadSidecarTurn cleanup callback through manager killAgent for Codex sidecars', async () => {
    const config = await makeTempConfig()
    const terminateExternalThreadSidecarTurn = vi.fn(async (agentId: string) => {
      const descriptor = manager.getAgent(agentId)
      if (descriptor) {
        descriptor.status = 'idle'
      }
    })
    const manager = new TestSwarmManager(config, { terminateExternalThreadSidecarTurn })
    const session = await bootWithDefaultManager(manager, config)
    const codex = createCodexExternalThreadWorkerDescriptor(config.defaultCwd, session.agentId, {
      agentId: `${session.agentId}--codex`,
      status: 'streaming',
      profileId: session.profileId,
      sessionFile: getWorkerSessionFilePath(config.paths.dataDir, session.profileId!, session.agentId, `${session.agentId}--codex`),
    })

    ;(manager as unknown as { descriptors: Map<string, AgentDescriptor> }).descriptors.set(codex.agentId, codex)

    await manager.killAgent(session.agentId, codex.agentId)

    expect(terminateExternalThreadSidecarTurn).toHaveBeenCalledTimes(1)
    expect(terminateExternalThreadSidecarTurn).toHaveBeenCalledWith(codex.agentId)
    expect(manager.getAgent(codex.agentId)?.status).toBe('terminated')
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
})
