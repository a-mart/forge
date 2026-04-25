import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeErrorEvent, RuntimeSessionEvent } from '../runtime-contracts.js'
import type { AgentDescriptor, AgentStatus } from '../types.js'

const childProcessMockState = vi.hoisted(() => ({
  spawnSync: vi.fn(() => ({ status: 0 })),
}))

const rpcMockState = vi.hoisted(() => ({
  requestImpl: vi.fn<(...args: [any, string, unknown?]) => Promise<unknown>>(async () => ({})),
  instances: [] as any[],
}))

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  return {
    ...actual,
    spawnSync: childProcessMockState.spawnSync,
  }
})

vi.mock('../stdio-jsonrpc-client.js', () => ({
  StdioJsonRpcClient: class MockStdioJsonRpcClient {
    readonly options: {
      command?: string
      args?: string[]
      processLabel?: string
      onNotification?: (notification: unknown) => Promise<void> | void
      onRequest?: (request: unknown) => Promise<unknown>
      onExit?: (error: Error) => void
    }

    readonly command: string | undefined
    readonly args: string[]
    readonly processLabel: string | undefined
    readonly requestCalls: Array<{ method: string; params: unknown }> = []
    readonly notifyCalls: Array<{ method: string; params: unknown }> = []
    disposed = false

    constructor(options: {
      command?: string
      args?: string[]
      processLabel?: string
      onNotification?: (notification: unknown) => Promise<void> | void
      onRequest?: (request: unknown) => Promise<unknown>
      onExit?: (error: Error) => void
    }) {
      this.options = options
      this.command = options.command
      this.args = [...(options.args ?? [])]
      this.processLabel = options.processLabel
      rpcMockState.instances.push(this)
    }

    async request(method: string, params?: unknown): Promise<unknown> {
      this.requestCalls.push({ method, params })
      return await rpcMockState.requestImpl(this, method, params)
    }

    notify(method: string, params?: unknown): void {
      this.notifyCalls.push({ method, params })
    }

    dispose(): void {
      this.disposed = true
    }

    async emitNotification(notification: unknown): Promise<void> {
      await this.options.onNotification?.(notification)
    }

    async emitServerRequest(request: unknown): Promise<unknown> {
      return await this.options.onRequest?.(request)
    }

    emitExit(error: Error): void {
      this.options.onExit?.(error)
    }
  },
}))

import { AcpAgentRuntime } from '../acp-agent-runtime.js'

function makeDescriptor(baseDir: string): AgentDescriptor {
  return {
    agentId: 'acp-worker',
    displayName: 'ACP Worker',
    role: 'worker',
    managerId: 'manager',
    status: 'idle',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cwd: baseDir,
    model: {
      provider: 'cursor-acp',
      modelId: 'default',
      thinkingLevel: 'medium',
    },
    sessionFile: join(baseDir, 'profiles', 'profile-1', 'sessions', 'acp-worker', 'session.jsonl'),
  }
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve = (_value: T): void => {}
  let reject = (_error: unknown): void => {}
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })

  return { promise, resolve, reject }
}

async function waitForCondition(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (condition()) {
      return
    }

    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  throw new Error('Timed out waiting for async condition')
}

async function loadCustomEntries(sessionFile: string, customType: string): Promise<unknown[]> {
  const content = await readFile(sessionFile, 'utf8')
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { type?: string; customType?: string; data?: unknown })
    .filter((entry) => entry.type === 'custom' && entry.customType === customType)
    .map((entry) => entry.data)
}

function readPromptParts(params: unknown): Array<Record<string, unknown>> {
  const prompt = (params as { prompt?: unknown[] } | undefined)?.prompt
  return Array.isArray(prompt) ? (prompt as Array<Record<string, unknown>>) : []
}

const previousAcpEnabled = process.env.FORGE_ACP_ENABLED

afterEach(() => {
  if (previousAcpEnabled === undefined) {
    delete process.env.FORGE_ACP_ENABLED
  } else {
    process.env.FORGE_ACP_ENABLED = previousAcpEnabled
  }
})

beforeEach(() => {
  process.env.FORGE_ACP_ENABLED = 'true'
  childProcessMockState.spawnSync.mockReset()
  childProcessMockState.spawnSync.mockReturnValue({ status: 0 })
  rpcMockState.instances.length = 0
  rpcMockState.requestImpl.mockReset()
  rpcMockState.requestImpl.mockImplementation(async () => ({}))
})

describe('AcpAgentRuntime', () => {
  it('starts successfully, initializes ACP, and persists runtime state immediately', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'forge-acp-runtime-'))
    const descriptor = makeDescriptor(tempDir)
    await mkdir(dirname(descriptor.sessionFile), { recursive: true })

    rpcMockState.requestImpl.mockImplementation(async (_client: any, method: string) => {
      if (method === 'initialize') {
        return {}
      }

      if (method === 'session/new') {
        return { sessionId: 'acp-session-1' }
      }

      if (method === 'session/set_mode') {
        return {}
      }

      throw new Error(`Unexpected method: ${method}`)
    })

    const runtime = await AcpAgentRuntime.create({
      descriptor,
      callbacks: {
        onStatusChange: async () => {},
      },
      systemPrompt: 'You are a Cursor ACP runtime.',
    })

    const instance = rpcMockState.instances[0]
    expect(instance.command).toBe('agent')
    expect(instance.args).toEqual(['acp'])
    expect(instance.processLabel).toBe('Cursor ACP')
    expect(instance.requestCalls.map((entry: { method: string }) => entry.method)).toEqual([
      'initialize',
      'session/new',
      'session/set_mode',
    ])
    expect(childProcessMockState.spawnSync).toHaveBeenCalledWith(
      'agent',
      ['--version'],
      expect.objectContaining({
        cwd: descriptor.cwd,
        stdio: 'ignore',
      }),
    )
    expect(runtime.getCustomEntries('swarm_acp_runtime_state')).toEqual([
      expect.objectContaining({
        sessionId: 'acp-session-1',
        modeId: 'agent',
      }),
    ])

    const persistedEntries = await loadCustomEntries(descriptor.sessionFile, 'swarm_acp_runtime_state')
    expect(persistedEntries).toEqual([
      expect.objectContaining({
        sessionId: 'acp-session-1',
        modeId: 'agent',
      }),
    ])

    await runtime.terminate({ abort: false })
  })

  it('fails startup before spawn when the ACP gate is disabled', async () => {
    process.env.FORGE_ACP_ENABLED = 'false'

    const tempDir = await mkdtemp(join(tmpdir(), 'forge-acp-runtime-'))
    const descriptor = makeDescriptor(tempDir)
    await mkdir(dirname(descriptor.sessionFile), { recursive: true })

    await expect(
      AcpAgentRuntime.create({
        descriptor,
        callbacks: {
          onStatusChange: async () => {},
        },
        systemPrompt: 'You are a Cursor ACP runtime.',
      }),
    ).rejects.toThrow('ACP runtime is disabled (FORGE_ACP_ENABLED=false)')

    expect(childProcessMockState.spawnSync).not.toHaveBeenCalled()
    expect(rpcMockState.instances).toHaveLength(0)
  })

  it('fails startup with a clear install hint when the Cursor Agent CLI is missing from PATH', async () => {
    childProcessMockState.spawnSync.mockReturnValue({
      error: Object.assign(new Error('spawn agent ENOENT'), { code: 'ENOENT' }),
    })

    const tempDir = await mkdtemp(join(tmpdir(), 'forge-acp-runtime-'))
    const descriptor = makeDescriptor(tempDir)
    await mkdir(dirname(descriptor.sessionFile), { recursive: true })

    await expect(
      AcpAgentRuntime.create({
        descriptor,
        callbacks: {
          onStatusChange: async () => {},
        },
        systemPrompt: 'You are a Cursor ACP runtime.',
      }),
    ).rejects.toThrow('Cursor Agent CLI not found on PATH. Install from cursor.com/docs/cli/installation')

    expect(rpcMockState.instances).toHaveLength(0)
  })

  it('maps auth-required startup failures to a clear agent login message', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'forge-acp-runtime-'))
    const descriptor = makeDescriptor(tempDir)
    await mkdir(dirname(descriptor.sessionFile), { recursive: true })

    rpcMockState.requestImpl.mockImplementation(async (_client: any, method: string) => {
      if (method === 'initialize') {
        return {}
      }

      if (method === 'session/new') {
        const error = new Error('Not authenticated. Run agent login to continue.') as Error & { code?: number }
        error.code = 401
        throw error
      }

      throw new Error(`Unexpected method: ${method}`)
    })

    await expect(
      AcpAgentRuntime.create({
        descriptor,
        callbacks: {
          onStatusChange: async () => {},
        },
        systemPrompt: 'You are a Cursor ACP runtime.',
      }),
    ).rejects.toThrow('Run `agent login` to authenticate before using ACP specialists')

    const instance = rpcMockState.instances[0]
    expect(instance.disposed).toBe(true)
  })

  it('falls back from session/load to session/new when the persisted ACP session is stale', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'forge-acp-runtime-'))
    const descriptor = makeDescriptor(tempDir)
    await mkdir(dirname(descriptor.sessionFile), { recursive: true })

    await writeFile(
      descriptor.sessionFile,
      [
        JSON.stringify({
          type: 'session',
          version: 3,
          id: 'header-1',
          timestamp: '2026-01-01T00:00:00.000Z',
          cwd: descriptor.cwd,
        }),
        JSON.stringify({
          type: 'custom',
          customType: 'swarm_acp_runtime_state',
          id: 'entry-1',
          parentId: 'header-1',
          timestamp: '2026-01-01T00:00:01.000Z',
          data: {
            sessionId: 'stale-session',
            modeId: 'agent',
            savedAt: '2026-01-01T00:00:01.000Z',
          },
        }),
      ].join('\n') + '\n',
      'utf8',
    )

    const prompts: Array<Array<Record<string, unknown>>> = []

    rpcMockState.requestImpl.mockImplementation(async (_client: any, method: string, params: unknown) => {
      if (method === 'initialize') {
        return {}
      }

      if (method === 'session/load') {
        throw new Error('session not found')
      }

      if (method === 'session/new') {
        return { sessionId: 'fresh-session' }
      }

      if (method === 'session/set_mode') {
        return {}
      }

      if (method === 'session/prompt') {
        prompts.push(readPromptParts(params))
        return { ok: true }
      }

      throw new Error(`Unexpected method: ${method}`)
    })

    const runtime = await AcpAgentRuntime.create({
      descriptor,
      callbacks: {
        onStatusChange: async () => {},
      },
      systemPrompt: 'You are a Cursor ACP runtime.',
    })

    const instance = rpcMockState.instances[0]
    expect(instance.requestCalls.map((entry: { method: string }) => entry.method)).toEqual([
      'initialize',
      'session/load',
      'session/new',
      'session/set_mode',
    ])
    expect(instance.requestCalls[1]?.params).toMatchObject({
      sessionId: 'stale-session',
    })

    const persistedEntries = await loadCustomEntries(descriptor.sessionFile, 'swarm_acp_runtime_state')
    expect(persistedEntries.at(-1)).toMatchObject({
      sessionId: 'fresh-session',
      modeId: 'agent',
    })

    await runtime.sendMessage('hello after fallback')
    expect(prompts).toEqual([
      [
        {
          type: 'text',
          text: '<system_context>\nYou are a Cursor ACP runtime.\n</system_context>',
        },
        {
          type: 'text',
          text: 'hello after fallback',
        },
      ],
    ])

    await runtime.terminate({ abort: false })
  })

  it('prepends the system prompt for the first prompt after loading an ACP session', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'forge-acp-runtime-'))
    const descriptor = makeDescriptor(tempDir)
    await mkdir(dirname(descriptor.sessionFile), { recursive: true })
    await writeFile(
      descriptor.sessionFile,
      [
        JSON.stringify({
          type: 'session',
          version: 3,
          id: 'header-1',
          timestamp: '2026-01-01T00:00:00.000Z',
          cwd: descriptor.cwd,
        }),
        JSON.stringify({
          type: 'custom',
          customType: 'swarm_acp_runtime_state',
          id: 'entry-1',
          parentId: 'header-1',
          timestamp: '2026-01-01T00:00:01.000Z',
          data: {
            sessionId: 'loaded-session',
            modeId: 'agent',
            savedAt: '2026-01-01T00:00:01.000Z',
          },
        }),
      ].join('\n') + '\n',
      'utf8',
    )

    const prompts: Array<Array<Record<string, unknown>>> = []

    rpcMockState.requestImpl.mockImplementation(async (_client: any, method: string, params: unknown) => {
      if (method === 'initialize') {
        return {}
      }

      if (method === 'session/load') {
        return { sessionId: 'loaded-session' }
      }

      if (method === 'session/set_mode') {
        return {}
      }

      if (method === 'session/prompt') {
        prompts.push(readPromptParts(params))
        return { ok: true }
      }

      throw new Error(`Unexpected method: ${method}`)
    })

    const runtime = await AcpAgentRuntime.create({
      descriptor,
      callbacks: {
        onStatusChange: async () => {},
      },
      systemPrompt: 'You are a Cursor ACP runtime.',
    })

    await runtime.sendMessage('hello from loaded session')
    await waitForCondition(() => prompts.length === 1 && runtime.getStatus() === 'idle')
    await runtime.sendMessage('follow-up after load')
    await waitForCondition(() => prompts.length === 2 && runtime.getStatus() === 'idle')

    expect(prompts).toEqual([
      [
        {
          type: 'text',
          text: '<system_context>\nYou are a Cursor ACP runtime.\n</system_context>',
        },
        {
          type: 'text',
          text: 'hello from loaded session',
        },
      ],
      [
        {
          type: 'text',
          text: 'follow-up after load',
        },
      ],
    ])

    await runtime.terminate({ abort: false })
  })

  it('streams assistant text, maps tool events, and invokes onAgentEnd when the queue drains', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'forge-acp-runtime-'))
    const descriptor = makeDescriptor(tempDir)
    await mkdir(dirname(descriptor.sessionFile), { recursive: true })

    const promptDeferred = createDeferred<unknown>()
    const statuses: AgentStatus[] = []
    const sessionEvents: RuntimeSessionEvent[] = []
    const runtimeErrors: RuntimeErrorEvent[] = []
    let agentEndCalls = 0

    rpcMockState.requestImpl.mockImplementation(async (_client: any, method: string) => {
      if (method === 'initialize') {
        return {}
      }

      if (method === 'session/new') {
        return { sessionId: 'acp-session-1' }
      }

      if (method === 'session/set_mode') {
        return {}
      }

      if (method === 'session/prompt') {
        return await promptDeferred.promise
      }

      throw new Error(`Unexpected method: ${method}`)
    })

    const runtime = await AcpAgentRuntime.create({
      descriptor,
      callbacks: {
        onStatusChange: async (_agentId, status) => {
          statuses.push(status)
        },
        onSessionEvent: async (_agentId, event) => {
          sessionEvents.push(event)
        },
        onRuntimeError: async (_agentId, event) => {
          runtimeErrors.push(event)
        },
        onAgentEnd: async () => {
          agentEndCalls += 1
        },
      },
      systemPrompt: 'You are a Cursor ACP runtime.',
    })

    const receipt = await runtime.sendMessage('hello')
    expect(receipt.acceptedMode).toBe('prompt')
    expect(runtime.getStatus()).toBe('streaming')

    const instance = rpcMockState.instances[0]
    await instance.emitNotification({
      method: 'session/update',
      params: {
        sessionId: 'acp-session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Hel' },
        },
      },
    })
    await instance.emitNotification({
      method: 'session/update',
      params: {
        sessionId: 'acp-session-1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tool-1',
          title: 'Read file',
          kind: 'native',
          status: 'pending',
          rawInput: { path: 'README.md', toolName: 'read' },
        },
      },
    })
    await instance.emitNotification({
      method: 'session/update',
      params: {
        sessionId: 'acp-session-1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tool-1',
          status: 'in_progress',
          rawOutput: { step: 'reading' },
        },
      },
    })
    await instance.emitNotification({
      method: 'session/update',
      params: {
        sessionId: 'acp-session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'lo' },
        },
      },
    })
    await instance.emitNotification({
      method: 'session/update',
      params: {
        sessionId: 'acp-session-1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tool-1',
          status: 'completed',
          rawOutput: { text: 'done' },
        },
      },
    })

    promptDeferred.resolve({ ok: true })
    await waitForCondition(() => agentEndCalls === 1)

    expect(statuses).toContain('streaming')
    expect(statuses.at(-1)).toBe('idle')
    expect(runtimeErrors).toEqual([])
    expect(sessionEvents).toEqual(
      expect.arrayContaining([
        { type: 'agent_start' },
        { type: 'turn_start' },
        {
          type: 'message_start',
          message: {
            role: 'assistant',
            content: '',
          },
        },
        {
          type: 'message_update',
          message: {
            role: 'assistant',
            content: 'Hel',
          },
        },
        {
          type: 'message_update',
          message: {
            role: 'assistant',
            content: 'Hello',
          },
        },
        {
          type: 'tool_execution_start',
          toolName: 'read_file',
          toolCallId: 'tool-1',
          args: { path: 'README.md', toolName: 'read' },
        },
        {
          type: 'tool_execution_update',
          toolName: 'read_file',
          toolCallId: 'tool-1',
          partialResult: { step: 'reading' },
        },
        {
          type: 'tool_execution_end',
          toolName: 'read_file',
          toolCallId: 'tool-1',
          result: { text: 'done' },
          isError: false,
        },
        {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: 'Hello',
          },
        },
        {
          type: 'turn_end',
          toolResults: [{ text: 'done' }],
        },
        { type: 'agent_end' },
      ]),
    )

    await runtime.terminate({ abort: false })
  })

  it('queues follow-up prompts locally and dispatches them after the active turn completes', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'forge-acp-runtime-'))
    const descriptor = makeDescriptor(tempDir)
    await mkdir(dirname(descriptor.sessionFile), { recursive: true })

    const promptDeferreds = [createDeferred<unknown>(), createDeferred<unknown>()]
    const prompts: Array<Array<Record<string, unknown>>> = []
    let promptCallCount = 0
    let agentEndCalls = 0

    rpcMockState.requestImpl.mockImplementation(async (_client: any, method: string, params: unknown) => {
      if (method === 'initialize') {
        return {}
      }

      if (method === 'session/new') {
        return { sessionId: 'acp-session-1' }
      }

      if (method === 'session/set_mode') {
        return {}
      }

      if (method === 'session/prompt') {
        prompts.push(readPromptParts(params))
        const deferred = promptDeferreds[promptCallCount]
        promptCallCount += 1
        return await deferred!.promise
      }

      throw new Error(`Unexpected method: ${method}`)
    })

    const runtime = await AcpAgentRuntime.create({
      descriptor,
      callbacks: {
        onStatusChange: async () => {},
        onAgentEnd: async () => {
          agentEndCalls += 1
        },
      },
      systemPrompt: 'You are a Cursor ACP runtime.',
    })

    const first = await runtime.sendMessage('first prompt')
    const followUp = await runtime.sendMessage('queued follow-up')

    expect(first.acceptedMode).toBe('prompt')
    expect(followUp.acceptedMode).toBe('steer')
    expect(runtime.getPendingCount()).toBe(1)

    promptDeferreds[0]!.resolve({ ok: true })
    await waitForCondition(() => prompts.length === 2)
    expect(prompts).toEqual([
      [
        {
          type: 'text',
          text: '<system_context>\nYou are a Cursor ACP runtime.\n</system_context>',
        },
        {
          type: 'text',
          text: 'first prompt',
        },
      ],
      [
        {
          type: 'text',
          text: 'queued follow-up',
        },
      ],
    ])
    expect(runtime.getPendingCount()).toBe(0)
    expect(agentEndCalls).toBe(0)

    promptDeferreds[1]!.resolve({ ok: true })
    await waitForCondition(() => agentEndCalls === 1)
    expect(runtime.getStatus()).toBe('idle')

    await runtime.terminate({ abort: false })
  })

  it('cancels the active turn, clears local prompt state, and allows a new prompt after stopInFlight', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'forge-acp-runtime-'))
    const descriptor = makeDescriptor(tempDir)
    await mkdir(dirname(descriptor.sessionFile), { recursive: true })

    const promptDeferreds = [createDeferred<unknown>(), createDeferred<unknown>()]
    const prompts: Array<Array<Record<string, unknown>>> = []
    const sessionEvents: RuntimeSessionEvent[] = []
    let promptCallCount = 0
    let agentEndCalls = 0

    rpcMockState.requestImpl.mockImplementation(async (_client: any, method: string, params: unknown) => {
      if (method === 'initialize') {
        return {}
      }

      if (method === 'session/new') {
        return { sessionId: 'acp-session-1' }
      }

      if (method === 'session/set_mode') {
        return {}
      }

      if (method === 'session/prompt') {
        prompts.push(readPromptParts(params))
        const deferred = promptDeferreds[promptCallCount]
        promptCallCount += 1
        return await deferred!.promise
      }

      throw new Error(`Unexpected method: ${method}`)
    })

    const runtime = await AcpAgentRuntime.create({
      descriptor,
      callbacks: {
        onStatusChange: async () => {},
        onSessionEvent: async (_agentId, event) => {
          sessionEvents.push(event)
        },
        onAgentEnd: async () => {
          agentEndCalls += 1
        },
      },
      systemPrompt: 'You are a Cursor ACP runtime.',
    })

    await runtime.sendMessage('cancel me')
    expect(runtime.getStatus()).toBe('streaming')

    await runtime.stopInFlight()

    const instance = rpcMockState.instances[0]
    expect(instance.notifyCalls).toContainEqual({
      method: 'session/cancel',
      params: {
        sessionId: 'acp-session-1',
      },
    })
    expect(runtime.getStatus()).toBe('idle')
    expect(runtime.getPendingCount()).toBe(0)

    const eventCountAfterStop = sessionEvents.length
    await instance.emitNotification({
      method: 'session/update',
      params: {
        sessionId: 'acp-session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'late text' },
        },
      },
    })
    await instance.emitNotification({
      method: 'session/update',
      params: {
        sessionId: 'acp-session-1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tool-1',
          title: 'Read file',
          kind: 'native',
          status: 'pending',
          rawInput: { path: 'README.md', toolName: 'read' },
        },
      },
    })

    expect(sessionEvents).toHaveLength(eventCountAfterStop)

    const followUpReceipt = await runtime.sendMessage('fresh prompt after cancel')
    expect(followUpReceipt.acceptedMode).toBe('prompt')
    expect(prompts).toEqual([
      [
        {
          type: 'text',
          text: '<system_context>\nYou are a Cursor ACP runtime.\n</system_context>',
        },
        {
          type: 'text',
          text: 'cancel me',
        },
      ],
      [
        {
          type: 'text',
          text: 'fresh prompt after cancel',
        },
      ],
    ])

    promptDeferreds[1]!.resolve({ ok: true })
    await waitForCondition(() => runtime.getStatus() === 'idle')

    promptDeferreds[0]!.resolve({ cancelled: true })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(agentEndCalls).toBe(1)
    expect(runtime.getStatus()).toBe('idle')

    await runtime.terminate({ abort: false })
  })

  it('marks the runtime terminated and reports runtime_exit when the ACP subprocess exits unexpectedly', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'forge-acp-runtime-'))
    const descriptor = makeDescriptor(tempDir)
    await mkdir(dirname(descriptor.sessionFile), { recursive: true })

    const runtimeErrors: RuntimeErrorEvent[] = []
    const statuses: AgentStatus[] = []

    rpcMockState.requestImpl.mockImplementation(async (_client: any, method: string) => {
      if (method === 'initialize') {
        return {}
      }

      if (method === 'session/new') {
        return { sessionId: 'acp-session-1' }
      }

      if (method === 'session/set_mode') {
        return {}
      }

      throw new Error(`Unexpected method: ${method}`)
    })

    const runtime = await AcpAgentRuntime.create({
      descriptor,
      callbacks: {
        onStatusChange: async (_agentId, status) => {
          statuses.push(status)
        },
        onRuntimeError: async (_agentId, event) => {
          runtimeErrors.push(event)
        },
      },
      systemPrompt: 'You are a Cursor ACP runtime.',
    })

    const instance = rpcMockState.instances[0]
    instance.emitExit(new Error('cursor acp crashed'))
    await waitForCondition(() => runtime.getStatus() === 'terminated')

    expect(runtimeErrors).toContainEqual(
      expect.objectContaining({
        phase: 'runtime_exit',
        message: 'cursor acp crashed',
      }),
    )
    expect(statuses.at(-1)).toBe('terminated')
    await expect(runtime.sendMessage('after exit')).rejects.toThrow('is terminated')
  })

  it('sends ACP image prompt parts when runtime messages include images', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'forge-acp-runtime-'))
    const descriptor = makeDescriptor(tempDir)
    await mkdir(dirname(descriptor.sessionFile), { recursive: true })

    const prompts: Array<Array<Record<string, unknown>>> = []

    rpcMockState.requestImpl.mockImplementation(async (_client: any, method: string, params: unknown) => {
      if (method === 'initialize') {
        return {}
      }

      if (method === 'session/new') {
        return { sessionId: 'acp-session-1' }
      }

      if (method === 'session/set_mode') {
        return {}
      }

      if (method === 'session/prompt') {
        prompts.push(readPromptParts(params))
        return { ok: true }
      }

      throw new Error(`Unexpected method: ${method}`)
    })

    const runtime = await AcpAgentRuntime.create({
      descriptor,
      callbacks: {
        onStatusChange: async () => {},
      },
      systemPrompt: 'You are a Cursor ACP runtime.',
    })

    await runtime.sendMessage({
      text: 'inspect this image',
      images: [
        {
          mimeType: 'image/png',
          data: 'YWJjMTIz',
        },
      ],
    })

    expect(prompts).toEqual([
      [
        {
          type: 'text',
          text: '<system_context>\nYou are a Cursor ACP runtime.\n</system_context>',
        },
        {
          type: 'text',
          text: 'inspect this image',
        },
        {
          type: 'image',
          mimeType: 'image/png',
          data: 'YWJjMTIz',
        },
      ],
    ])

    await runtime.terminate({ abort: false })
  })

  it('recovers to idle when prompt-finalization callbacks throw', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'forge-acp-runtime-'))
    const descriptor = makeDescriptor(tempDir)
    await mkdir(dirname(descriptor.sessionFile), { recursive: true })

    const promptDeferred = createDeferred<unknown>()
    const statuses: AgentStatus[] = []
    const unhandledRejections: unknown[] = []
    const handleUnhandledRejection = (error: unknown) => {
      unhandledRejections.push(error)
    }
    process.on('unhandledRejection', handleUnhandledRejection)

    rpcMockState.requestImpl.mockImplementation(async (_client: any, method: string) => {
      if (method === 'initialize') {
        return {}
      }

      if (method === 'session/new') {
        return { sessionId: 'acp-session-1' }
      }

      if (method === 'session/set_mode') {
        return {}
      }

      if (method === 'session/prompt') {
        return await promptDeferred.promise
      }

      throw new Error(`Unexpected method: ${method}`)
    })

    const runtime = await AcpAgentRuntime.create({
      descriptor,
      callbacks: {
        onStatusChange: async (_agentId, status) => {
          statuses.push(status)
        },
        onSessionEvent: async (_agentId, event) => {
          if (event.type === 'message_end') {
            throw new Error('session event sink failed')
          }
        },
      },
      systemPrompt: 'You are a Cursor ACP runtime.',
    })

    await runtime.sendMessage('trigger finalization failure')
    const instance = rpcMockState.instances[0]
    await instance.emitNotification({
      method: 'session/update',
      params: {
        sessionId: 'acp-session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'hello' },
        },
      },
    })

    promptDeferred.resolve({ ok: true })
    await waitForCondition(() => runtime.getStatus() === 'idle')
    await new Promise((resolve) => setTimeout(resolve, 0))

    process.off('unhandledRejection', handleUnhandledRejection)

    expect(statuses).toContain('streaming')
    expect(statuses.at(-1)).toBe('idle')
    expect(unhandledRejections).toEqual([])

    await runtime.terminate({ abort: false })
  })

  it('runs unexpected-exit cleanup when the ACP subprocess exits unexpectedly', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'forge-acp-runtime-'))
    const descriptor = makeDescriptor(tempDir)
    await mkdir(dirname(descriptor.sessionFile), { recursive: true })

    const cleanup = vi.fn(async () => undefined)

    rpcMockState.requestImpl.mockImplementation(async (_client: any, method: string) => {
      if (method === 'initialize') {
        return {}
      }

      if (method === 'session/new') {
        return { sessionId: 'acp-session-1' }
      }

      if (method === 'session/set_mode') {
        return {}
      }

      throw new Error(`Unexpected method: ${method}`)
    })

    const runtime = await AcpAgentRuntime.create({
      descriptor,
      callbacks: {
        onStatusChange: async () => {},
      },
      systemPrompt: 'You are a Cursor ACP runtime.',
      onUnexpectedExit: cleanup,
    })

    const instance = rpcMockState.instances[0]
    instance.emitExit(new Error('cursor acp crashed'))
    await waitForCondition(() => cleanup.mock.calls.length === 1 && runtime.getStatus() === 'terminated')

    await expect(runtime.sendMessage('after exit')).rejects.toThrow('is terminated')
  })

  it('handles known ACP extension requests explicitly', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'forge-acp-runtime-'))
    const descriptor = makeDescriptor(tempDir)
    await mkdir(dirname(descriptor.sessionFile), { recursive: true })

    rpcMockState.requestImpl.mockImplementation(async (_client: any, method: string) => {
      if (method === 'initialize') {
        return {}
      }

      if (method === 'session/new') {
        return { sessionId: 'acp-session-1' }
      }

      if (method === 'session/set_mode') {
        return {}
      }

      throw new Error(`Unexpected method: ${method}`)
    })

    const runtime = await AcpAgentRuntime.create({
      descriptor,
      callbacks: {
        onStatusChange: async () => {},
      },
      systemPrompt: 'You are a Cursor ACP runtime.',
    })

    const instance = rpcMockState.instances[0]
    await expect(
      instance.emitServerRequest({
        id: 'ask-1',
        method: 'cursor/ask_question',
        params: {},
      }),
    ).resolves.toEqual({
      outcome: {
        outcome: 'skipped',
      },
    })
    await expect(
      instance.emitServerRequest({
        id: 'plan-1',
        method: 'cursor/create_plan',
        params: {},
      }),
    ).resolves.toEqual({
      outcome: {
        outcome: 'accepted',
      },
    })
    await expect(
      instance.emitServerRequest({
        id: 'task-1',
        method: 'cursor/task',
        params: {},
      }),
    ).resolves.toEqual({
      outcome: {
        outcome: 'completed',
      },
    })

    await runtime.terminate({ abort: false })
  })

  it('auto-approves ACP permission requests with allow-once', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'forge-acp-runtime-'))
    const descriptor = makeDescriptor(tempDir)
    await mkdir(dirname(descriptor.sessionFile), { recursive: true })

    rpcMockState.requestImpl.mockImplementation(async (_client: any, method: string) => {
      if (method === 'initialize') {
        return {}
      }

      if (method === 'session/new') {
        return { sessionId: 'acp-session-1' }
      }

      if (method === 'session/set_mode') {
        return {}
      }

      throw new Error(`Unexpected method: ${method}`)
    })

    const runtime = await AcpAgentRuntime.create({
      descriptor,
      callbacks: {
        onStatusChange: async () => {},
      },
      systemPrompt: 'You are a Cursor ACP runtime.',
    })

    const instance = rpcMockState.instances[0]
    await expect(
      instance.emitServerRequest({
        id: 'permission-1',
        method: 'session/request_permission',
        params: {
          sessionId: 'acp-session-1',
        },
      }),
    ).resolves.toEqual({
      outcome: {
        outcome: 'selected',
        optionId: 'allow-once',
      },
    })

    await runtime.terminate({ abort: false })
  })
})
