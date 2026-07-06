import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SessionManager } from '@mariozechner/pi-coding-agent'
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

function enqueueProjectAgentPeerInput(
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
): string {
  const runtimeMessage = formatProjectAgentPeerRuntimeMessage(context, message)
  ;(manager as any).enqueueInboundTurnContext(agentId, {
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
  const workerReportMarker = '[assistantOutputTarget] {"kind":"explicit_tool_required","reason":"worker_report"}'



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

    expect(managerRuntime?.sendCalls.at(-1)?.message).toBe(
      `WORKER REPORT: status: done\n${workerReportMarker}`,
    )

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
    expect((manager as any).pendingChoiceAssistantOutputContinuationByChoiceId.size).toBe(0)

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

  it('does not let a Pi user message_start consume the next identical queued context', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const runtimeText = 'identical queued Pi runtime text'
    const firstSourceContext = { channel: 'web' as const, messageId: 'first-turn' }
    const secondSourceContext = { channel: 'web' as const, messageId: 'second-turn' }
    const enqueueInboundTurnContext = (manager as any).enqueueInboundTurnContext.bind(manager) as (
      agentId: string,
      context: any,
    ) => () => void

    enqueueInboundTurnContext('manager', {
      source: 'user_input',
      runtimeMessageText: runtimeText,
      sourceContext: firstSourceContext,
      assistantOutputTarget: { kind: 'session_transcript', channel: 'web', sourceContext: firstSourceContext },
    })
    enqueueInboundTurnContext('manager', {
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
      { text: 'First identical turn final', sourceContext: { channel: firstSourceContext.channel } },
      { text: 'Second identical turn final', sourceContext: { channel: secondSourceContext.channel } },
    ])
  })

  it('projects worker-report closeout when provider starts report turns with synthetic user message_start', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.handleUserMessage('delegate with claude ordering')
    const delegationRuntimeMessage = manager.runtimeByAgentId.get('manager')?.sendCalls.at(-1)?.message
    expect(typeof delegationRuntimeMessage).toBe('string')
    await (manager as any).handleRuntimeSessionEvent('manager', { type: 'turn_start' })
    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'message_start',
      message: { role: 'user', content: delegationRuntimeMessage },
    })
    const worker = await manager.spawnAgent('manager', { agentId: 'Turn Start Worker', initialMessage: 'Do delegated work.' })
    await (manager as any).handleRuntimeSessionEvent('manager', { type: 'turn_end', toolResults: [] })

    await manager.sendMessage(worker.agentId, 'manager', 'status: done\nsummary: delegated work finished', 'auto')
    const reportRuntimeMessage = manager.runtimeByAgentId.get('manager')?.sendCalls.at(-1)?.message
    expect(reportRuntimeMessage).toContain(workerReportMarker)

    await projectAssistantFinalTextWithSyntheticUserMessageStart(manager, 'manager', 'Done, delegated work finished.')

    expect(assistantOutputsFor(manager, 'manager').map((entry) => entry.text)).toEqual([
      'Done, delegated work finished.',
    ])
  })

  it('projects status-completed worker closeout when provider emits only user message_end for the report turn', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.handleUserMessage('continue after restart')
    const delegationRuntimeMessage = manager.runtimeByAgentId.get('manager')?.sendCalls.at(-1)?.message
    expect(typeof delegationRuntimeMessage).toBe('string')
    await (manager as any).handleRuntimeSessionEvent('manager', { type: 'turn_start' })
    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'message_end',
      message: { role: 'user', content: delegationRuntimeMessage },
    })
    const worker = await manager.spawnAgent('manager', { agentId: 'Message End Worker', initialMessage: 'Continue delegated work.' })
    await (manager as any).handleRuntimeSessionEvent('manager', { type: 'turn_end', toolResults: [] })

    await manager.sendMessage(worker.agentId, 'manager', 'status: completed\nsummary: delegated work finished', 'followUp')
    const reportRuntimeMessage = manager.runtimeByAgentId.get('manager')?.sendCalls.at(-1)?.message
    expect(reportRuntimeMessage).toContain('WORKER REPORT: status: completed')
    expect(reportRuntimeMessage).toContain(workerReportMarker)

    await (manager as any).handleRuntimeSessionEvent('manager', { type: 'turn_start' })
    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'message_end',
      message: { role: 'user', content: reportRuntimeMessage },
    })
    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'message_end',
      message: { role: 'assistant', content: 'Clean reset is done.', stopReason: 'stop' },
    })
    await (manager as any).handleRuntimeSessionEvent('manager', { type: 'turn_end', toolResults: [] })

    expect(assistantOutputsFor(manager, 'manager').map((entry) => entry.text)).toEqual([
      'Clean reset is done.',
    ])
  })

  it('deterministically delivers a terminal worker outcome when the manager stays silent (backstop)', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.handleUserMessage('delegate the rerun')
    const delegationRuntimeMessage = manager.runtimeByAgentId.get('manager')?.sendCalls.at(-1)?.message
    await (manager as any).handleRuntimeSessionEvent('manager', { type: 'turn_start' })
    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'message_start',
      message: { role: 'user', content: delegationRuntimeMessage },
    })
    const worker = await manager.spawnAgent('manager', { agentId: 'Backstop Worker', initialMessage: 'Do the rerun.' })
    await (manager as any).handleRuntimeSessionEvent('manager', { type: 'turn_end', toolResults: [] })

    // Worker reports terminal; this establishes the manager's active web
    // worker-report route context that the backstop reuses as its web gate.
    await manager.sendMessage(worker.agentId, 'manager', 'status: blocked\nsummary: rerun failed before a Graph response', 'auto')
    const reportRuntimeMessage = manager.runtimeByAgentId.get('manager')?.sendCalls.at(-1)?.message as string
    expect(reportRuntimeMessage).toContain(workerReportMarker)

    // The manager begins the report turn (activating the web worker-report route
    // context, incl. the source worker id) but then stays silent — the runtime's
    // resample ladder exhausts. The deterministic backstop surfaces the outcome
    // instead of the passive notice.
    await (manager as any).handleRuntimeSessionEvent('manager', { type: 'turn_start' })
    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'message_start',
      message: { role: 'user', content: reportRuntimeMessage },
    })
    const delivered = manager.deliverTerminalObligationBackstop('manager', reportRuntimeMessage)
    expect(delivered).toBe(true)

    const outputs = assistantOutputsFor(manager, 'manager')
    expect(outputs).toHaveLength(1)
    // Attribution is best-effort: when the active route context carries the
    // source worker id the line names it (`Backstop Worker`); otherwise it
    // gracefully falls back to "A background task". This harness does not drive
    // the full inbound-projection path that populates the route context's
    // worker id, so accept either form here — the attribution formatting itself
    // is unit-tested in swarm-manager-utils.test.ts. The load-bearing guarantee
    // (the outcome is delivered at all, with status + summary) is asserted below.
    expect(outputs[0].text).toMatch(/`Backstop Worker`|A background task/)
    expect(outputs[0].text).toContain('was blocked')
    expect(outputs[0].text).toContain('rerun failed before a Graph response')
    expect(outputs[0].text).not.toContain('assistantOutputTarget')

    // Dedup: a re-entrant exhaustion for the same report must not double-deliver.
    const redelivered = manager.deliverTerminalObligationBackstop('manager', reportRuntimeMessage)
    expect(redelivered).toBe(false)
    expect(assistantOutputsFor(manager, 'manager')).toHaveLength(1)
  })

  it('matches provider-selected queued turns by runtime message instead of FIFO order', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.handleUserMessage('delegate before out-of-order queue')
    const delegationRuntimeMessage = manager.runtimeByAgentId.get('manager')?.sendCalls.at(-1)?.message
    expect(typeof delegationRuntimeMessage).toBe('string')
    await (manager as any).handleRuntimeSessionEvent('manager', { type: 'turn_start' })
    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'message_start',
      message: { role: 'user', content: delegationRuntimeMessage },
    })
    const worker = await manager.spawnAgent('manager', { agentId: 'Out Of Order Worker', initialMessage: 'Do delegated work.' })
    await (manager as any).handleRuntimeSessionEvent('manager', { type: 'turn_end', toolResults: [] })

    const managerRuntime = manager.runtimeByAgentId.get('manager') as FakeRuntime
    managerRuntime.busy = true
    await manager.sendMessage(worker.agentId, 'manager', 'status: done\nsummary: queued worker report', 'auto')
    const workerReportRuntimeMessage = managerRuntime.sendCalls.at(-1)?.message
    expect(typeof workerReportRuntimeMessage).toBe('string')

    await manager.handleUserMessage('telegram selected before worker report', {
      sourceContext: { channel: 'telegram', channelId: 'telegram-channel', userId: 'telegram-user' },
    })
    const telegramRuntimeMessage = managerRuntime.sendCalls.at(-1)?.message
    expect(typeof telegramRuntimeMessage).toBe('string')
    managerRuntime.busy = false

    await projectAssistantFinalTextWithSyntheticUserMessageStart(
      manager,
      'manager',
      'Telegram protected output must not project',
      telegramRuntimeMessage,
    )
    expect(assistantOutputsFor(manager, 'manager')).toEqual([])

    await projectAssistantFinalTextWithSyntheticUserMessageStart(
      manager,
      'manager',
      'Worker report output projects when its actual turn runs',
      workerReportRuntimeMessage,
    )
    expect(assistantOutputsFor(manager, 'manager').map((entry) => entry.text)).toEqual([
      'Worker report output projects when its actual turn runs',
    ])
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

  it('does not project protected contexts when no-echo provider emits synthetic user message_start', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    const sender = await bootWithDefaultManager(manager, config)

    await manager.handleUserMessage('telegram turn_start protected', {
      sourceContext: { channel: 'telegram', channelId: 'telegram-channel', userId: 'telegram-user' },
    })
    await projectAssistantFinalTextWithSyntheticUserMessageStart(manager, 'manager', 'Telegram direct final')

    await manager.dispatchRuntimeUserMessage({
      targetAgentId: 'manager',
      text: 'collab turn_start protected',
      sourceContext: { channel: 'web', channelId: 'collab-channel', userId: 'user-1' },
      collaborationAuthor: {
        userId: 'user-1',
        displayName: 'Adam',
        role: 'admin',
        workspaceId: 'workspace-1',
        channelId: 'collab-channel',
      },
    })
    await projectAssistantFinalTextWithSyntheticUserMessageStart(manager, 'manager', 'Collab direct final')

    const target = await manager.createManager(sender.agentId, {
      name: 'Peer Target',
      cwd: config.defaultCwd,
    })
    await manager.setSessionProjectAgent(target.agentId, { whenToUse: 'Use for peer messages.' })
    await manager.sendMessage(sender.agentId, target.agentId, 'Peer context request', 'auto')
    await projectAssistantFinalTextWithSyntheticUserMessageStart(manager, target.agentId, 'Peer direct final')

    const state = manager as unknown as { descriptors: Map<string, AgentDescriptor> }
    state.descriptors.get('manager')!.archetypeId = 'cortex'
    const cortexWorker = await manager.spawnAgent('manager', { agentId: 'Cortex Report Worker' })
    await manager.sendMessage(cortexWorker.agentId, 'manager', 'status: done\nsummary: cortex report', 'auto')
    await projectAssistantFinalTextWithSyntheticUserMessageStart(manager, 'manager', 'Cortex worker closeout')

    expect(assistantOutputsFor(manager, 'manager')).toEqual([])
    expect(assistantOutputsFor(manager, target.agentId)).toEqual([])
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
    const state = manager as unknown as {
      descriptors: Map<string, AgentDescriptor>
      activeAssistantOutputTargetByManagerId: Map<string, unknown>
    }

    state.descriptors.get('manager')!.sessionSurface = 'collab'
    state.activeAssistantOutputTargetByManagerId.set('manager', {
      kind: 'session_transcript',
      channel: 'web',
      sourceContext: { channel: 'web' },
    })
    await emitCleanManagerAssistantMessage(manager, 'manager', 'Misclassified collab final must not project')
    expect(assistantOutputsFor(manager, 'manager')).toEqual([])

    state.descriptors.get('manager')!.sessionSurface = undefined
    state.activeAssistantOutputTargetByManagerId.set('manager', {
      kind: 'session_transcript',
      channel: 'web',
      sourceContext: { channel: 'web' },
    })
    await emitCleanManagerAssistantMessage(manager, 'manager', 'Normal remembered web final projects')
    expect(assistantOutputsFor(manager, 'manager').map((entry) => entry.text)).toEqual([
      'Normal remembered web final projects',
    ])
  })

  it('projects terminal worker-report closeouts without replaying telegram worker output', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.handleUserMessage('telegram clean final then delegated work', {
      sourceContext: { channel: 'telegram', channelId: 'telegram-channel', userId: 'telegram-user' },
    })
    await startRuntimeUserTurn(manager)
    await emitCleanManagerAssistantMessage(manager, 'manager', 'Telegram interim clean text')

    const worker = await manager.spawnAgent('manager', {
      agentId: 'Telegram Continuation Worker',
      initialMessage: 'Do telegram continuation work.',
    })
    await manager.sendMessage(worker.agentId, 'manager', 'status: done\nsummary: telegram continuation finished', 'auto')
    const reportRuntimeMessage = manager.runtimeByAgentId.get('manager')?.sendCalls.at(-1)?.message
    expect(reportRuntimeMessage).toContain(workerReportMarker)

    await projectAssistantFinalText(manager, 'manager', reportRuntimeMessage, 'Telegram worker closeout must stay hidden')

    expect(assistantOutputsFor(manager, 'manager').map((entry) => entry.text)).toEqual([
      'Telegram worker closeout must stay hidden',
    ])
  })

  it('projects terminal worker-report closeouts without replaying collaboration worker output', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.dispatchRuntimeUserMessage({
      targetAgentId: 'manager',
      text: 'collab clean final then delegated work',
      sourceContext: { channel: 'web', channelId: 'collab-channel', userId: 'user-1' },
      collaborationAuthor: {
        userId: 'user-1',
        displayName: 'Adam',
        role: 'admin',
        workspaceId: 'workspace-1',
        channelId: 'collab-channel',
      },
    })
    await startRuntimeUserTurn(manager)
    await emitCleanManagerAssistantMessage(manager, 'manager', 'Collab interim clean text')

    const worker = await manager.spawnAgent('manager', {
      agentId: 'Collab Continuation Worker',
      initialMessage: 'Do collab continuation work.',
    })
    await manager.sendMessage(worker.agentId, 'manager', 'status: done\nsummary: collab continuation finished', 'auto')
    const reportRuntimeMessage = manager.runtimeByAgentId.get('manager')?.sendCalls.at(-1)?.message
    expect(reportRuntimeMessage).toContain(workerReportMarker)

    await projectAssistantFinalText(manager, 'manager', reportRuntimeMessage, 'Collab worker closeout must stay hidden')

    expect(assistantOutputsFor(manager, 'manager').map((entry) => entry.text)).toEqual([
      'Collab worker closeout must stay hidden',
    ])
  })

  it('projects terminal worker-report closeouts without replaying peer worker output', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    const sender = await bootWithDefaultManager(manager, config)
    const target = await manager.createManager(sender.agentId, {
      name: 'Peer Continuation Target',
      cwd: config.defaultCwd,
    })
    await manager.setSessionProjectAgent(target.agentId, { whenToUse: 'Use for peer continuation tests.' })

    await manager.sendMessage(sender.agentId, target.agentId, 'peer clean final then delegated work', 'auto')
    await startRuntimeUserTurn(manager, target.agentId)
    ;(manager as any).activeAssistantOutputTargetByManagerId.set(target.agentId, {
      kind: 'peer_agent',
      fromAgentId: sender.agentId,
    })
    await emitCleanManagerAssistantMessage(manager, target.agentId, 'Peer interim clean text')

    const worker = await manager.spawnAgent(target.agentId, {
      agentId: 'Peer Continuation Worker',
    })
    await manager.sendMessage(target.agentId, worker.agentId, 'Do peer continuation work.', 'auto')
    await manager.sendMessage(worker.agentId, target.agentId, 'status: done\nsummary: peer continuation finished', 'auto')
    const reportRuntimeMessage = manager.runtimeByAgentId.get(target.agentId)?.sendCalls.at(-1)?.message
    expect(reportRuntimeMessage).toContain(workerReportMarker)

    await projectAssistantFinalText(manager, target.agentId, reportRuntimeMessage, 'Peer worker closeout must stay hidden')

    expect(assistantOutputsFor(manager, target.agentId).map((entry) => entry.text)).toEqual([
      'Peer worker closeout must stay hidden',
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

    const runtimeMessage = enqueueProjectAgentPeerInput(
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

  it('does not project external, collaboration, or Cortex project-agent peer clean finals to web', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const externalRuntimeMessage = enqueueProjectAgentPeerInput(
      manager,
      'manager',
      {
        fromAgentId: 'shared-agent',
        fromDisplayName: 'Shared Agent',
        external: true,
        fromProfileId: 'external-profile',
        fromProjectName: 'External Project',
      },
      'External protected update',
    )
    await projectAssistantFinalText(manager, 'manager', externalRuntimeMessage, 'External peer final must stay hidden')

    const state = manager as unknown as { descriptors: Map<string, AgentDescriptor> }
    state.descriptors.get('manager')!.sessionSurface = 'collab'
    const collabRuntimeMessage = enqueueProjectAgentPeerInput(
      manager,
      'manager',
      { fromAgentId: 'collab-peer', fromDisplayName: 'Collab Peer', external: false },
      'Collaboration protected update',
    )
    await projectAssistantFinalText(manager, 'manager', collabRuntimeMessage, 'Collab peer final must stay hidden')

    state.descriptors.get('manager')!.sessionSurface = undefined
    state.descriptors.get('manager')!.profileId = 'cortex'
    const cortexRuntimeMessage = enqueueProjectAgentPeerInput(
      manager,
      'manager',
      { fromAgentId: 'cortex-peer', fromDisplayName: 'Cortex Peer', external: false },
      'Cortex protected update',
    )
    await projectAssistantFinalText(manager, 'manager', cortexRuntimeMessage, 'Cortex peer final must stay hidden')

    expect(assistantOutputsFor(manager, 'manager')).toEqual([])
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

    expect(assistantOutputsFor(manager, target.agentId).map((entry) => entry.text)).toEqual([
      'Updated. The central design doc now reflects these decisions.',
    ])
    expect(
      assistantOutputsFor(manager, target.agentId).some((entry) => String(entry.text).includes('WORKER REPORT')),
    ).toBe(false)
    expect(
      assistantOutputsFor(manager, target.agentId).some((entry) => String(entry.text).includes('Completion Report')),
    ).toBe(false)
  })

  it('projects manager final text after an inherited direct-web worker report', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.handleUserMessage('delegate this')
    await startRuntimeUserTurn(manager)
    const worker = await manager.spawnAgent('manager', { agentId: 'Report Worker', initialMessage: 'Do the delegated work.' })
    await (manager as any).handleRuntimeSessionEvent('manager', { type: 'turn_end', toolResults: [] })

    await manager.sendMessage(worker.agentId, 'manager', 'status: done\nsummary: delegated work finished', 'auto')
    const reportRuntimeMessage = manager.runtimeByAgentId.get('manager')?.sendCalls.at(-1)?.message
    expect(typeof reportRuntimeMessage).toBe('string')
    expect(reportRuntimeMessage as string).toContain('[assistantOutputTarget] {"kind":"explicit_tool_required","reason":"worker_report"}')

    await projectAssistantFinalText(manager, 'manager', reportRuntimeMessage, 'Done, the delegated work finished.')

    expect(assistantOutputsFor(manager, 'manager').map((entry) => entry.text)).toEqual([
      'Done, the delegated work finished.',
    ])
  })

  it('routes explicit-tool-required agent completion input out of the default web transcript', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.handleUserMessage('delegate and summarize completion')
    await startRuntimeUserTurn(manager)
    const worker = await manager.spawnAgent('manager', { agentId: 'Completion Report Worker', initialMessage: 'Do the cleanup.' })
    await (manager as any).handleRuntimeSessionEvent('manager', { type: 'turn_end', toolResults: [] })

    await manager.sendMessage(
      worker.agentId,
      'manager',
      'SYSTEM: ## Completion Report: Cleanup + PR flow\nRemoved the mistaken copy and opened the PR.',
      'auto',
    )
    const reportRuntimeMessage = manager.runtimeByAgentId.get('manager')?.sendCalls.at(-1)?.message
    expect(reportRuntimeMessage).toContain('[assistantOutputTarget] {"kind":"explicit_tool_required","reason":"agent_message"}')
    expect(assistantOutputsFor(manager, 'manager')).toEqual([])

    await projectAssistantFinalText(manager, 'manager', reportRuntimeMessage, 'Done. Removed the mistaken copy and opened the PR.')

    expect(assistantOutputsFor(manager, 'manager')).toEqual([])
    expect(
      assistantOutputsFor(manager, 'manager').some((entry) => String(entry.text).includes('## Completion Report')),
    ).toBe(false)
  })

  it('does not project explicit-tool-required completion inputs inherited from protected contexts', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    const sender = await bootWithDefaultManager(manager, config)

    await manager.handleUserMessage('telegram delegated completion', {
      sourceContext: { channel: 'telegram', channelId: 'telegram-channel', userId: 'telegram-user' },
    })
    await startRuntimeUserTurn(manager)
    const telegramWorker = await manager.spawnAgent('manager', { agentId: 'Telegram Completion Worker', initialMessage: 'Do telegram work.' })
    await (manager as any).handleRuntimeSessionEvent('manager', { type: 'turn_end', toolResults: [] })
    await manager.sendMessage(
      telegramWorker.agentId,
      'manager',
      'SYSTEM: ## Completion Report: Telegram work\nFinished protected work.',
      'auto',
    )
    const telegramReportRuntimeMessage = manager.runtimeByAgentId.get('manager')?.sendCalls.at(-1)?.message
    expect(telegramReportRuntimeMessage).toContain('[assistantOutputTarget] {"kind":"explicit_tool_required","reason":"agent_message"}')
    await projectAssistantFinalText(manager, 'manager', telegramReportRuntimeMessage, 'Telegram completion must stay hidden')

    const peerTarget = await manager.createManager(sender.agentId, {
      name: 'Peer Completion Target',
      cwd: config.defaultCwd,
    })
    await manager.setSessionProjectAgent(peerTarget.agentId, { whenToUse: 'Use for peer completion tests.' })
    await manager.sendMessage(sender.agentId, peerTarget.agentId, 'peer delegated completion', 'auto')
    await startRuntimeUserTurn(manager, peerTarget.agentId)
    const peerWorker = await manager.spawnAgent(peerTarget.agentId, { agentId: 'Peer Completion Worker', initialMessage: 'Do peer work.' })
    await (manager as any).handleRuntimeSessionEvent(peerTarget.agentId, { type: 'turn_end', toolResults: [] })
    await manager.sendMessage(
      peerWorker.agentId,
      peerTarget.agentId,
      'SYSTEM: ## Completion Report: Peer work\nFinished peer work.',
      'auto',
    )
    const peerReportRuntimeMessage = manager.runtimeByAgentId.get(peerTarget.agentId)?.sendCalls.at(-1)?.message
    expect(peerReportRuntimeMessage).toContain('[assistantOutputTarget] {"kind":"explicit_tool_required","reason":"agent_message"}')
    await projectAssistantFinalText(manager, peerTarget.agentId, peerReportRuntimeMessage, 'Peer completion must stay hidden')

    expect(assistantOutputsFor(manager, 'manager')).toEqual([])
    expect(assistantOutputsFor(manager, peerTarget.agentId)).toEqual([])
  })

  it('keeps worker-report assistant targets across non-final worker callbacks', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.handleUserMessage('delegate with progress first')
    await startRuntimeUserTurn(manager)
    const worker = await manager.spawnAgent('manager', { agentId: 'Progress Then Final Worker', initialMessage: 'Do work and report progress.' })
    await (manager as any).handleRuntimeSessionEvent('manager', { type: 'turn_end', toolResults: [] })

    await manager.sendMessage(worker.agentId, 'manager', 'progress: halfway done', 'auto')
    const progressRuntimeMessage = manager.runtimeByAgentId.get('manager')?.sendCalls.at(-1)?.message
    expect(progressRuntimeMessage).toContain('[assistantOutputTarget] {"kind":"explicit_tool_required","reason":"agent_message"}')

    await manager.sendMessage(worker.agentId, 'manager', 'status: done\nsummary: final report after progress', 'auto')
    const finalReportRuntimeMessage = manager.runtimeByAgentId.get('manager')?.sendCalls.at(-1)?.message
    expect(finalReportRuntimeMessage).toContain(workerReportMarker)

    await projectAssistantFinalText(manager, 'manager', finalReportRuntimeMessage, 'Final report projected after progress.')

    expect(assistantOutputsFor(manager, 'manager').map((entry) => entry.text)).toEqual([
      'Final report projected after progress.',
    ])
  })

  it('keeps worker-report input guidance explicit across repeated reports', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.handleUserMessage('delegate once')
    await startRuntimeUserTurn(manager)
    const worker = await manager.spawnAgent('manager', { agentId: 'Once Worker', initialMessage: 'Do one thing.' })
    await (manager as any).handleRuntimeSessionEvent('manager', { type: 'turn_end', toolResults: [] })

    await manager.sendMessage(worker.agentId, 'manager', 'status: done\nsummary: first report', 'auto')
    const firstReportRuntimeMessage = manager.runtimeByAgentId.get('manager')?.sendCalls.at(-1)?.message
    expect(firstReportRuntimeMessage).toContain(workerReportMarker)
    await projectAssistantFinalText(manager, 'manager', firstReportRuntimeMessage, 'First report projected.')

    await manager.sendMessage(worker.agentId, 'manager', 'status: done\nsummary: second report', 'auto')
    const secondReportRuntimeMessage = manager.runtimeByAgentId.get('manager')?.sendCalls.at(-1)?.message
    expect(secondReportRuntimeMessage).toContain(workerReportMarker)
    expect(assistantOutputsFor(manager, 'manager').map((entry) => entry.text)).toEqual([
      'First report projected.',
    ])

    await projectAssistantFinalText(manager, 'manager', secondReportRuntimeMessage, 'Second report projected by default.')

    expect(assistantOutputsFor(manager, 'manager').map((entry) => entry.text)).toEqual([
      'First report projected.',
      'Second report projected by default.',
    ])
  })

  it('projects manager final text after an inherited auto/terminal worker report', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.handleUserMessage('delegate for auto report')
    await startRuntimeUserTurn(manager)
    const worker = await manager.spawnAgent('manager', { agentId: 'Auto Report Worker', initialMessage: 'Do auto-reported work.' })
    await (manager as any).handleRuntimeSessionEvent('manager', { type: 'turn_end', toolResults: [] })

    await manager.sendMessage('manager', 'manager', 'WORKER REPORT: status: done\nsummary: auto report finished', 'auto', {
      origin: 'internal',
      workerReportSourceAgentId: worker.agentId,
    } as any)
    const reportRuntimeMessage = manager.runtimeByAgentId.get('manager')?.sendCalls.at(-1)?.message
    expect(typeof reportRuntimeMessage).toBe('string')
    expect(reportRuntimeMessage as string).toContain(workerReportMarker)

    await projectAssistantFinalText(manager, 'manager', reportRuntimeMessage, 'Done, the auto-reported work finished.')

    expect(assistantOutputsFor(manager, 'manager').map((entry) => entry.text)).toEqual([
      'Done, the auto-reported work finished.',
    ])
  })

  it('projects normal web worker-report closeouts even when report input guidance lacks handoff', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.handleUserMessage('delegate then manager fails')
    await startRuntimeUserTurn(manager)
    const worker = await manager.spawnAgent('manager', { agentId: 'Stale Inheritance Worker', initialMessage: 'Do work before failure.' })
    await (manager as any).handleRuntimeError('manager', { phase: 'prompt_start', message: 'runtime failed before worker report' })

    await manager.sendMessage(worker.agentId, 'manager', 'status: done\nsummary: finished after failure', 'auto')
    const reportRuntimeMessage = manager.runtimeByAgentId.get('manager')?.sendCalls.at(-1)?.message
    expect(typeof reportRuntimeMessage).toBe('string')
    expect(reportRuntimeMessage as string).toContain(workerReportMarker)

    // The worker report input remains internal/routed; only the manager's clean final
    // assistant text is projected to the web transcript.
    expect(assistantOutputsFor(manager, 'manager')).toEqual([])

    await projectAssistantFinalText(manager, 'manager', reportRuntimeMessage, 'Stale output still projects.')

    expect(assistantOutputsFor(manager, 'manager').map((entry) => entry.text)).toEqual([
      'Stale output still projects.',
    ])
  })

  it('projects normal web manager final text through multi-hop worker reports without handoff provenance', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.handleUserMessage('delegate through multiple workers')
    await startRuntimeUserTurn(manager)
    const workerA = await manager.spawnAgent('manager', { agentId: 'Multi Hop Worker A', initialMessage: 'Do the first step.' })
    await (manager as any).handleRuntimeError('manager', { phase: 'prompt_start', message: 'manager failed before worker A report' })

    await manager.sendMessage(workerA.agentId, 'manager', 'status: done\nsummary: first step finished', 'auto')
    const workerAReportRuntimeMessage = await startRuntimeUserTurn(manager)
    expect(workerAReportRuntimeMessage).toContain(workerReportMarker)

    const workerB = await manager.spawnAgent('manager', { agentId: 'Multi Hop Worker B', initialMessage: 'Do the second step.' })
    await (manager as any).handleRuntimeError('manager', { phase: 'prompt_start', message: 'manager failed before worker B report' })

    await manager.sendMessage(workerB.agentId, 'manager', 'status: done\nsummary: second step finished', 'auto')
    const workerBReportRuntimeMessage = manager.runtimeByAgentId.get('manager')?.sendCalls.at(-1)?.message
    expect(typeof workerBReportRuntimeMessage).toBe('string')
    expect(workerBReportRuntimeMessage as string).toContain(workerReportMarker)
    expect(assistantOutputsFor(manager, 'manager')).toEqual([])

    await projectAssistantFinalText(manager, 'manager', workerBReportRuntimeMessage, 'Both delegated steps are complete.')

    expect(assistantOutputsFor(manager, 'manager').map((entry) => entry.text)).toEqual([
      'Both delegated steps are complete.',
    ])
  })

  it('projects normal web worker-report closeouts even without an active root', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Background Internal Worker' })
    await manager.sendMessage('manager', worker.agentId, 'SYSTEM: background maintenance work', 'auto', {
      origin: 'internal',
    })

    await manager.sendMessage(worker.agentId, 'manager', 'status: done\nsummary: background maintenance finished', 'auto')
    const reportRuntimeMessage = manager.runtimeByAgentId.get('manager')?.sendCalls.at(-1)?.message
    expect(typeof reportRuntimeMessage).toBe('string')
    expect(reportRuntimeMessage as string).toContain(workerReportMarker)

    await projectAssistantFinalText(manager, 'manager', reportRuntimeMessage, 'Background closeout now projects')

    await manager.sendMessage(worker.agentId, 'manager', 'status: done\nsummary: repeated background maintenance finished', 'auto')
    const repeatedReportRuntimeMessage = manager.runtimeByAgentId.get('manager')?.sendCalls.at(-1)?.message
    expect(typeof repeatedReportRuntimeMessage).toBe('string')
    expect(repeatedReportRuntimeMessage as string).toContain(workerReportMarker)
    await projectAssistantFinalText(manager, 'manager', repeatedReportRuntimeMessage, 'Repeated background closeout now projects')

    expect(assistantOutputsFor(manager, 'manager').map((entry) => entry.text)).toEqual([
      'Background closeout now projects',
      'Repeated background closeout now projects',
    ])
  })

  it('keeps explicit worker-report assistant_output after speak_to_user', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.handleUserMessage('delegate and close explicitly')
    await startRuntimeUserTurn(manager)
    const worker = await manager.spawnAgent('manager', { agentId: 'Explicit Report Worker', initialMessage: 'Do it.' })
    await (manager as any).handleRuntimeSessionEvent('manager', { type: 'turn_end', toolResults: [] })

    await manager.sendMessage(worker.agentId, 'manager', 'status: done\nsummary: explicit closeout', 'auto')
    const reportRuntimeMessage = await startRuntimeUserTurn(manager)
    expect(reportRuntimeMessage).toContain(workerReportMarker)
    await manager.publishToUser('manager', 'Explicit closeout', 'speak_to_user')
    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'message_end',
      message: { role: 'assistant', content: 'Duplicate closeout', stopReason: 'stop' },
    })
    await (manager as any).handleRuntimeSessionEvent('manager', { type: 'turn_end', toolResults: [] })

    expect(assistantOutputsFor(manager, 'manager').map((entry) => entry.text)).toEqual(['Duplicate closeout'])
  })

  it('projects terminal worker-report closeouts after runtime errors clear stale handoffs', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    const sender = await bootWithDefaultManager(manager, config)

    await manager.handleUserMessage('telegram delegated work before runtime error', {
      sourceContext: { channel: 'telegram', channelId: 'telegram-channel', userId: 'telegram-user' },
    })
    await startRuntimeUserTurn(manager)
    const telegramWorker = await manager.spawnAgent('manager', { agentId: 'Cleared Telegram Worker', initialMessage: 'Do telegram work.' })
    await (manager as any).handleRuntimeError('manager', { phase: 'prompt_start', message: 'runtime failed before telegram report' })
    await manager.sendMessage(telegramWorker.agentId, 'manager', 'status: done\nsummary: telegram work finished after error', 'auto')
    const telegramReportRuntimeMessage = manager.runtimeByAgentId.get('manager')?.sendCalls.at(-1)?.message
    expect(telegramReportRuntimeMessage).toContain(workerReportMarker)
    await projectAssistantFinalText(manager, 'manager', telegramReportRuntimeMessage, 'Telegram closeout after cleared handoff')

    await manager.dispatchRuntimeUserMessage({
      targetAgentId: 'manager',
      text: 'collab delegated work before runtime error',
      sourceContext: { channel: 'web', channelId: 'collab-channel', userId: 'user-1' },
      collaborationAuthor: {
        userId: 'user-1',
        displayName: 'Adam',
        role: 'admin',
        workspaceId: 'workspace-1',
        channelId: 'collab-channel',
      },
    })
    await startRuntimeUserTurn(manager)
    const collabWorker = await manager.spawnAgent('manager', { agentId: 'Cleared Collab Worker', initialMessage: 'Do collab work.' })
    await (manager as any).handleRuntimeError('manager', { phase: 'prompt_start', message: 'runtime failed before collab report' })
    await manager.sendMessage(collabWorker.agentId, 'manager', 'status: done\nsummary: collab work finished after error', 'auto')
    const collabReportRuntimeMessage = manager.runtimeByAgentId.get('manager')?.sendCalls.at(-1)?.message
    expect(collabReportRuntimeMessage).toContain(workerReportMarker)
    await projectAssistantFinalText(manager, 'manager', collabReportRuntimeMessage, 'Collab closeout after cleared handoff')

    const peerTarget = await manager.createManager(sender.agentId, {
      name: 'Cleared Peer Target',
      cwd: config.defaultCwd,
    })
    await manager.setSessionProjectAgent(peerTarget.agentId, { whenToUse: 'Use for cleared peer messages.' })
    await manager.sendMessage(sender.agentId, peerTarget.agentId, 'peer delegated work before runtime error', 'auto')
    await startRuntimeUserTurn(manager, peerTarget.agentId)
    const peerWorker = await manager.spawnAgent(peerTarget.agentId, { agentId: 'Cleared Peer Worker' })
    ;(manager as any).activeAssistantOutputTargetByManagerId.set(peerTarget.agentId, {
      kind: 'peer_agent',
      fromAgentId: sender.agentId,
    })
    await manager.sendMessage(peerTarget.agentId, peerWorker.agentId, 'Do peer work.', 'auto')
    await (manager as any).handleRuntimeError(peerTarget.agentId, { phase: 'prompt_start', message: 'runtime failed before peer report' })
    await manager.sendMessage(peerWorker.agentId, peerTarget.agentId, 'status: done\nsummary: peer work finished after error', 'auto')
    const peerReportRuntimeMessage = manager.runtimeByAgentId.get(peerTarget.agentId)?.sendCalls.at(-1)?.message
    expect(peerReportRuntimeMessage).toContain(workerReportMarker)
    await projectAssistantFinalText(manager, peerTarget.agentId, peerReportRuntimeMessage, 'Peer closeout after cleared handoff')

    expect(assistantOutputsFor(manager, 'manager').map((entry) => entry.text)).toEqual([
      'Telegram closeout after cleared handoff',
      'Collab closeout after cleared handoff',
    ])
    expect(assistantOutputsFor(manager, peerTarget.agentId).map((entry) => entry.text)).toEqual([
      'Peer closeout after cleared handoff',
    ])
  })

  it('projects terminal worker-error auto-report closeout as manager output only', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.handleUserMessage('telegram delegated work before worker error', {
      sourceContext: { channel: 'telegram', channelId: 'telegram-channel', userId: 'telegram-user' },
    })
    await startRuntimeUserTurn(manager)
    const worker = await manager.spawnAgent('manager', { agentId: 'Errored Telegram Worker', initialMessage: 'Do telegram work.' })
    await (manager as any).handleRuntimeError(worker.agentId, { phase: 'prompt_dispatch', message: 'worker failed before reporting' })

    await manager.sendMessage('manager', 'manager', 'WORKER REPORT: status: blocked\nsummary: worker failed before reporting', 'auto', {
      origin: 'internal',
      workerReportSourceAgentId: worker.agentId,
    } as any)
    const reportRuntimeMessage = manager.runtimeByAgentId.get('manager')?.sendCalls.at(-1)?.message
    expect(reportRuntimeMessage).toContain(workerReportMarker)
    await projectAssistantFinalText(manager, 'manager', reportRuntimeMessage, 'Worker error closeout must stay routed')

    expect(assistantOutputsFor(manager, 'manager').map((entry) => entry.text)).toEqual([
      'Worker error closeout must stay routed',
    ])
  })

  it('projects terminal worker-report closeouts while keeping reports explicit', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.handleUserMessage('telegram delegated work', {
      sourceContext: { channel: 'telegram', channelId: 'telegram-channel', userId: 'telegram-user' },
    })
    await startRuntimeUserTurn(manager)
    const telegramWorker = await manager.spawnAgent('manager', { agentId: 'Telegram Worker', initialMessage: 'Do telegram work.' })
    await (manager as any).handleRuntimeSessionEvent('manager', { type: 'turn_end', toolResults: [] })
    await manager.sendMessage(telegramWorker.agentId, 'manager', 'status: done\nsummary: telegram work finished', 'auto')
    const telegramReportRuntimeMessage = manager.runtimeByAgentId.get('manager')?.sendCalls.at(-1)?.message
    expect(telegramReportRuntimeMessage).toContain(workerReportMarker)
    await projectAssistantFinalText(manager, 'manager', telegramReportRuntimeMessage, 'Telegram closeout')

    await manager.sendMessage(telegramWorker.agentId, 'manager', 'status: done\nsummary: duplicate telegram closeout', 'auto')
    const duplicateTelegramReportRuntimeMessage = manager.runtimeByAgentId.get('manager')?.sendCalls.at(-1)?.message
    expect(duplicateTelegramReportRuntimeMessage).toContain(workerReportMarker)
    await projectAssistantFinalText(manager, 'manager', duplicateTelegramReportRuntimeMessage, 'Duplicate telegram closeout')

    await manager.dispatchRuntimeUserMessage({
      targetAgentId: 'manager',
      text: 'collab delegated work',
      sourceContext: { channel: 'web', channelId: 'collab-channel', userId: 'user-1' },
      collaborationAuthor: {
        userId: 'user-1',
        displayName: 'Adam',
        role: 'admin',
        workspaceId: 'workspace-1',
        channelId: 'collab-channel',
      },
    })
    await startRuntimeUserTurn(manager)
    const collabWorker = await manager.spawnAgent('manager', { agentId: 'Collab Worker', initialMessage: 'Do collab work.' })
    await (manager as any).handleRuntimeSessionEvent('manager', { type: 'turn_end', toolResults: [] })
    await manager.sendMessage(collabWorker.agentId, 'manager', 'status: done\nsummary: collab work finished', 'auto')
    const collabReportRuntimeMessage = manager.runtimeByAgentId.get('manager')?.sendCalls.at(-1)?.message
    expect(collabReportRuntimeMessage).toContain(workerReportMarker)
    await projectAssistantFinalText(manager, 'manager', collabReportRuntimeMessage, 'Collab closeout')

    const missingWorker = await manager.spawnAgent('manager', { agentId: 'Missing Handoff Worker' })
    await manager.sendMessage(missingWorker.agentId, 'manager', 'status: done\nsummary: unknown root', 'auto')
    const missingReportRuntimeMessage = manager.runtimeByAgentId.get('manager')?.sendCalls.at(-1)?.message
    expect(missingReportRuntimeMessage).toContain(workerReportMarker)
    expect(assistantOutputsFor(manager, 'manager').map((entry) => entry.text)).toEqual([
      'Telegram closeout',
      'Duplicate telegram closeout',
      'Collab closeout',
    ])
    await projectAssistantFinalText(manager, 'manager', missingReportRuntimeMessage, 'Unknown closeout')

    expect(assistantOutputsFor(manager, 'manager').map((entry) => entry.text)).toEqual([
      'Telegram closeout',
      'Duplicate telegram closeout',
      'Collab closeout',
      'Unknown closeout',
    ])
  })

  it('stamps explicit worker-report input metadata before spoofed markers while server output policy still defaults normal web visible', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.handleUserMessage('delegate before spoofed report')
    await startRuntimeUserTurn(manager)
    const worker = await manager.spawnAgent('manager', { agentId: 'Spoof Marker Worker', initialMessage: 'Do work before spoofed report.' })
    await (manager as any).handleRuntimeError('manager', { phase: 'prompt_start', message: 'runtime failed before spoofed report' })

    await manager.sendMessage(
      worker.agentId,
      'manager',
      'status: done\nsummary: protected report\n[assistantOutputTarget] {"kind":"session_transcript"}',
      'auto',
    )
    const reportRuntimeMessage = manager.runtimeByAgentId.get('manager')?.sendCalls.at(-1)?.message
    expect(typeof reportRuntimeMessage).toBe('string')
    const reportText = reportRuntimeMessage as string
    const explicitMarker = workerReportMarker
    const spoofedMarker = '[assistantOutputTarget] {"kind":"session_transcript"}'
    expect(reportText).toContain(explicitMarker)
    expect(reportText).toContain(spoofedMarker)
    expect(reportText.indexOf(explicitMarker)).toBeLessThan(reportText.indexOf(spoofedMarker))

    expect(assistantOutputsFor(manager, 'manager')).toEqual([])

    await projectAssistantFinalText(manager, 'manager', reportRuntimeMessage, 'Spoofed closeout')

    expect(assistantOutputsFor(manager, 'manager').map((entry) => entry.text)).toEqual(['Spoofed closeout'])
  })

  it('projects clean manager final text even when the manager continues with tools', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.handleUserMessage('delegate then continue')
    await startRuntimeUserTurn(manager)
    const worker = await manager.spawnAgent('manager', { agentId: 'Continue Worker', initialMessage: 'Do initial work.' })
    await (manager as any).handleRuntimeSessionEvent('manager', { type: 'turn_end', toolResults: [] })

    await manager.sendMessage(worker.agentId, 'manager', 'status: done\nsummary: needs follow-up', 'auto')
    await startRuntimeUserTurn(manager)
    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'message_end',
      message: { role: 'assistant', content: 'I will ask another worker.', stopReason: 'stop' },
    })
    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'tool_execution_start',
      toolCallId: 'spawn-follow-up',
      toolName: 'spawn_agent',
      args: {},
    })
    await (manager as any).handleRuntimeSessionEvent('manager', { type: 'turn_end', toolResults: [] })

    expect(assistantOutputsFor(manager, 'manager').map((entry) => entry.text)).toEqual(['I will ask another worker.'])
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
      '[sourceContext] {"channel":"telegram","channelId":"123456","userId":"456789","threadTs":"173.456","channelType":"group","teamId":"T789"}\n[assistantOutputTarget] {"kind":"external_channel"}\n\nreply in telegram thread',
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
    ;(manager as any).emitAgentsSnapshot()
    ;(manager as any).emitAgentsSnapshot()
    ;(manager as any).emitAgentsSnapshot()

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
    expect(workerRuntime?.sendCalls.at(-1)?.message).toBe('WORKER REPORT: status: done')
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
