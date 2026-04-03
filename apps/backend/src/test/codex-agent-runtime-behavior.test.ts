import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeErrorEvent, RuntimeSessionEvent } from '../swarm/runtime-types.js'
import type { AgentDescriptor, AgentStatus } from '../swarm/types.js'
import { withPlatform } from './test-helpers.js'

const rpcMockState = vi.hoisted(() => ({
  requestImpl: vi.fn<(...args: [any, string, unknown?]) => Promise<unknown>>(async () => ({})),
  instances: [] as any[],
}))

vi.mock('../swarm/codex-jsonrpc-client.js', () => ({
  CodexJsonRpcClient: class MockCodexJsonRpcClient {
    readonly options: {
      command?: string
      args?: string[]
      onNotification?: (notification: unknown) => Promise<void> | void
      onRequest?: (request: unknown) => Promise<unknown>
      onExit?: (error: Error) => void
    }

    readonly command: string | undefined
    readonly args: string[]
    readonly requestCalls: Array<{ method: string; params: unknown }> = []
    readonly notifyCalls: Array<{ method: string; params: unknown }> = []
    disposed = false

    constructor(options: {
      command?: string
      args?: string[]
      onNotification?: (notification: unknown) => Promise<void> | void
      onRequest?: (request: unknown) => Promise<unknown>
      onExit?: (error: Error) => void
    }) {
      this.options = options
      this.command = options.command
      this.args = [...(options.args ?? [])]
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

    emitExit(error: Error): void {
      this.options.onExit?.(error)
    }
  },
}))

import { CodexAgentRuntime } from '../swarm/codex-agent-runtime.js'

function makeDescriptor(baseDir: string): AgentDescriptor {
  return {
    agentId: 'codex-worker',
    displayName: 'Codex Worker',
    role: 'worker',
    managerId: 'manager',
    status: 'idle',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cwd: baseDir,
    model: {
      provider: 'openai-codex-app-server',
      modelId: 'default',
      thinkingLevel: 'xhigh',
    },
    sessionFile: join(baseDir, 'sessions', 'codex-worker.jsonl'),
  }
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve = (_value: T): void => {}
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })

  return { promise, resolve }
}

beforeEach(() => {
  rpcMockState.instances.length = 0
  rpcMockState.requestImpl.mockReset()
  rpcMockState.requestImpl.mockImplementation(async () => ({}))
})

describe('CodexAgentRuntime behavior', () => {
  it('passes non-default reasoning overrides to codex app-server args', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'swarm-codex-runtime-'))
    const descriptor = makeDescriptor(tempDir)
    descriptor.model.thinkingLevel = 'medium'
    await mkdir(dirname(descriptor.sessionFile), { recursive: true })

    rpcMockState.requestImpl.mockImplementation(async (_client: any, method: string) => {
      if (method === 'initialize') {
        return {}
      }

      if (method === 'account/read') {
        return { requiresOpenaiAuth: false, account: { id: 'acct-1' } }
      }

      if (method === 'thread/start') {
        return { thread: { id: 'thread-1' } }
      }

      return {}
    })

    const runtime = await CodexAgentRuntime.create({
      descriptor,
      callbacks: {
        onStatusChange: async () => {},
      },
      systemPrompt: 'You are a test codex runtime.',
      tools: [],
    })

    const instance = rpcMockState.instances[0]
    expect(instance.args).toEqual([
      'app-server',
      '--listen',
      'stdio://',
      '-c',
      'model_reasoning_effort="medium"',
    ])

    await runtime.terminate({ abort: false })
  })

  it('authenticates with CODEX_API_KEY and resumes a persisted thread', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'swarm-codex-runtime-'))
    const descriptor = makeDescriptor(tempDir)
    await mkdir(dirname(descriptor.sessionFile), { recursive: true })

    const runtimePrototype = CodexAgentRuntime.prototype as any
    const originalReadPersistedState = runtimePrototype.readPersistedRuntimeState
    runtimePrototype.readPersistedRuntimeState = () => ({
      threadId: 'persisted-thread',
    })

    const previousApiKey = process.env.CODEX_API_KEY
    process.env.CODEX_API_KEY = 'sk-test-key'

    try {
      let accountReadCalls = 0

      rpcMockState.requestImpl.mockImplementation(async (_client: any, method: string, params: unknown) => {
        if (method === 'initialize') {
          return {}
        }

        if (method === 'account/read') {
          accountReadCalls += 1
          if (accountReadCalls === 1) {
            return { requiresOpenaiAuth: true, account: null }
          }

          return { requiresOpenaiAuth: true, account: { id: 'acct-1' } }
        }

        if (method === 'account/login/start') {
          expect(params).toMatchObject({
            type: 'apiKey',
            apiKey: 'sk-test-key',
          })
          return { ok: true }
        }

        if (method === 'thread/resume') {
          expect(params).toMatchObject({
            threadId: 'persisted-thread',
            cwd: descriptor.cwd,
          })
          return { thread: { id: 'resumed-thread' } }
        }

        throw new Error(`Unexpected method: ${method}`)
      })

      const runtime = await CodexAgentRuntime.create({
        descriptor,
        callbacks: {
          onStatusChange: async () => {},
        },
        systemPrompt: 'You are a test codex runtime.',
        tools: [],
      })

      const instance = rpcMockState.instances[0]
      const calledMethods = instance.requestCalls.map((entry: { method: string }) => entry.method)

      expect(calledMethods).toContain('account/login/start')
      expect(calledMethods).toContain('thread/resume')
      expect(calledMethods).not.toContain('thread/start')

      await runtime.terminate({ abort: false })
    } finally {
      runtimePrototype.readPersistedRuntimeState = originalReadPersistedState
      if (previousApiKey === undefined) {
        delete process.env.CODEX_API_KEY
      } else {
        process.env.CODEX_API_KEY = previousApiKey
      }
    }
  })

  it('falls back to thread/start when thread/resume fails and throws when auth is still missing', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'swarm-codex-runtime-'))
    const descriptor = makeDescriptor(tempDir)
    await mkdir(dirname(descriptor.sessionFile), { recursive: true })

    const runtimePrototype = CodexAgentRuntime.prototype as any
    const originalReadPersistedState = runtimePrototype.readPersistedRuntimeState
    runtimePrototype.readPersistedRuntimeState = () => ({
      threadId: 'stale-thread',
    })

    try {
      rpcMockState.requestImpl.mockImplementation(async (_client: any, method: string) => {
        if (method === 'initialize') {
          return {}
        }

        if (method === 'account/read') {
          return { requiresOpenaiAuth: false, account: { id: 'acct-2' } }
        }

        if (method === 'thread/resume') {
          throw new Error('resume failed')
        }

        if (method === 'thread/start') {
          return { thread: { id: 'new-thread' } }
        }

        throw new Error(`Unexpected method: ${method}`)
      })

      const runtime = await CodexAgentRuntime.create({
        descriptor: makeDescriptor(tempDir),
        callbacks: {
          onStatusChange: async () => {},
        },
        systemPrompt: 'You are a test codex runtime.',
        tools: [],
      })

      const instance = rpcMockState.instances[0]
      const calledMethods = instance.requestCalls.map((entry: { method: string }) => entry.method)
      expect(calledMethods).toContain('thread/resume')
      expect(calledMethods).toContain('thread/start')

      await runtime.terminate({ abort: false })

      rpcMockState.instances.length = 0
      rpcMockState.requestImpl.mockReset()
      rpcMockState.requestImpl.mockImplementation(async (_client: any, method: string) => {
        if (method === 'initialize') {
          return {}
        }

        if (method === 'account/read') {
          return { requiresOpenaiAuth: true, account: null }
        }

        return {}
      })

      await expect(
        CodexAgentRuntime.create({
          descriptor: makeDescriptor(tempDir),
          callbacks: {
            onStatusChange: async () => {},
          },
          systemPrompt: 'You are a test codex runtime.',
          tools: [],
        }),
      ).rejects.toThrow('Codex runtime requires authentication.')

      const failedInstance = rpcMockState.instances[0]
      expect(failedInstance.disposed).toBe(true)
    } finally {
      runtimePrototype.readPersistedRuntimeState = originalReadPersistedState
    }
  })

  it('queues steer while turn/start is pending and flushes steers in order once start resolves', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'swarm-codex-runtime-'))
    const descriptor = makeDescriptor(tempDir)
    await mkdir(dirname(descriptor.sessionFile), { recursive: true })

    const turnStartDeferred = createDeferred<{ turn: { id: string } }>()

    rpcMockState.requestImpl.mockImplementation(async (_client: any, method: string, params: unknown) => {
      if (method === 'initialize') {
        return {}
      }

      if (method === 'account/read') {
        return { requiresOpenaiAuth: false, account: { id: 'acct-1' } }
      }

      if (method === 'thread/start') {
        return { thread: { id: 'thread-1' } }
      }

      if (method === 'turn/start') {
        return await turnStartDeferred.promise
      }

      if (method === 'turn/steer') {
        return {
          accepted: true,
          input: params,
        }
      }

      throw new Error(`Unexpected method: ${method}`)
    })

    const runtime = await CodexAgentRuntime.create({
      descriptor,
      callbacks: {
        onStatusChange: async () => {},
      },
      systemPrompt: 'You are a test codex runtime.',
      tools: [],
    })

    const firstPromise = runtime.sendMessage('first prompt')
    await Promise.resolve()

    const queuedOne = await runtime.sendMessage('queued steer one')
    const queuedTwo = await runtime.sendMessage('queued steer two')
    expect(queuedOne.acceptedMode).toBe('steer')
    expect(queuedTwo.acceptedMode).toBe('steer')

    turnStartDeferred.resolve({ turn: { id: 'turn-1' } })

    const first = await firstPromise
    expect(first.acceptedMode).toBe('prompt')

    const instance = rpcMockState.instances[0]
    const requestMethods = instance.requestCalls.map((entry: { method: string }) => entry.method)
    const steerCalls = instance.requestCalls.filter((entry: { method: string }) => entry.method === 'turn/steer')

    expect(requestMethods).toEqual(expect.arrayContaining(['turn/start', 'turn/steer', 'turn/steer']))
    expect(steerCalls).toHaveLength(2)
    expect(steerCalls[0]?.params).toMatchObject({
      expectedTurnId: 'turn-1',
    })
    expect(steerCalls[1]?.params).toMatchObject({
      expectedTurnId: 'turn-1',
    })

    await runtime.terminate({ abort: false })
  })

  it('builds specialist fallback replay snapshots for active codex turns, including accepted queued steers', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'swarm-codex-runtime-'))
    const descriptor = makeDescriptor(tempDir)
    await mkdir(dirname(descriptor.sessionFile), { recursive: true })

    rpcMockState.requestImpl.mockImplementation(async (_client: any, method: string) => {
      if (method === 'initialize') {
        return {}
      }

      if (method === 'account/read') {
        return { requiresOpenaiAuth: false, account: { id: 'acct-1' } }
      }

      if (method === 'thread/start') {
        return { thread: { id: 'thread-1' } }
      }

      if (method === 'turn/start') {
        return { turn: { id: 'turn-1' } }
      }

      if (method === 'turn/steer') {
        return { accepted: true }
      }

      throw new Error(`Unexpected method: ${method}`)
    })

    const runtime = await CodexAgentRuntime.create({
      descriptor,
      callbacks: {
        onStatusChange: async () => {},
      },
      systemPrompt: 'You are a test codex runtime.',
      tools: [],
    })

    await runtime.sendMessage('first prompt')
    await runtime.sendMessage('queued steer')

    await expect(runtime.prepareForSpecialistFallbackReplay?.()).resolves.toEqual({
      messages: [
        {
          text: 'first prompt',
          images: [],
        },
        {
          text: 'queued steer',
          images: [],
        },
      ],
    })

    const instance = rpcMockState.instances[0]
    await instance.emitNotification({
      method: 'turn/completed',
    })

    await expect(runtime.prepareForSpecialistFallbackReplay?.()).resolves.toBeUndefined()

    await runtime.terminate({ abort: false })
  })

  it('recovers from steer delivery failure by starting the queued message as a new turn', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'swarm-codex-runtime-'))
    const descriptor = makeDescriptor(tempDir)
    await mkdir(dirname(descriptor.sessionFile), { recursive: true })

    const runtimeErrors: RuntimeErrorEvent[] = []
    let turnStartCalls = 0

    rpcMockState.requestImpl.mockImplementation(async (_client: any, method: string) => {
      if (method === 'initialize') {
        return {}
      }

      if (method === 'account/read') {
        return { requiresOpenaiAuth: false, account: { id: 'acct-1' } }
      }

      if (method === 'thread/start') {
        return { thread: { id: 'thread-1' } }
      }

      if (method === 'turn/start') {
        turnStartCalls += 1
        return { turn: { id: `turn-${turnStartCalls}` } }
      }

      if (method === 'turn/steer') {
        throw new Error('no active turn to steer')
      }

      throw new Error(`Unexpected method: ${method}`)
    })

    const runtime = await CodexAgentRuntime.create({
      descriptor,
      callbacks: {
        onStatusChange: async () => {},
        onRuntimeError: async (_agentId, event) => {
          runtimeErrors.push(event)
        },
      },
      systemPrompt: 'You are a test codex runtime.',
      tools: [],
    })

    const first = await runtime.sendMessage('first prompt')
    expect(first.acceptedMode).toBe('prompt')

    const queued = await runtime.sendMessage('queued after steer failure')
    expect(queued.acceptedMode).toBe('steer')

    const instance = rpcMockState.instances[0]
    const requestMethods = instance.requestCalls.map((entry: { method: string }) => entry.method)
    const turnStartRequests = instance.requestCalls.filter((entry: { method: string }) => entry.method === 'turn/start')
    const steerRequests = instance.requestCalls.filter((entry: { method: string }) => entry.method === 'turn/steer')

    expect(requestMethods).toEqual(
      expect.arrayContaining(['turn/start', 'turn/steer', 'turn/start']),
    )
    expect(turnStartRequests).toHaveLength(2)
    expect(steerRequests).toHaveLength(1)
    expect(runtimeErrors).toContainEqual(
      expect.objectContaining({
        phase: 'steer_delivery',
        message: 'no active turn to steer',
        details: expect.objectContaining({
          queuedDeliveryId: queued.deliveryId,
        }),
      }),
    )
    expect(runtime.getStatus()).toBe('streaming')

    await runtime.terminate({ abort: false })
  })

  it('translates turn notifications, handles runtime exit, and reports terminated status', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'swarm-codex-runtime-'))
    const descriptor = makeDescriptor(tempDir)
    await mkdir(dirname(descriptor.sessionFile), { recursive: true })

    const statuses: AgentStatus[] = []
    const sessionEvents: RuntimeSessionEvent[] = []
    const runtimeErrors: RuntimeErrorEvent[] = []
    let agentEndCalls = 0

    rpcMockState.requestImpl.mockImplementation(async (_client: any, method: string) => {
      if (method === 'initialize') {
        return {}
      }

      if (method === 'account/read') {
        return { requiresOpenaiAuth: false, account: { id: 'acct-1' } }
      }

      if (method === 'thread/start') {
        return { thread: { id: 'thread-1' } }
      }

      return {}
    })

    const runtime = await CodexAgentRuntime.create({
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
      systemPrompt: 'You are a test codex runtime.',
      tools: [],
    })

    const instance = rpcMockState.instances[0]
    await instance.emitNotification({
      method: 'turn/started',
      params: {
        turn: { id: 'turn-42' },
      },
    })
    await instance.emitNotification({
      method: 'item/agentMessage/delta',
      params: {
        delta: 'Hello from codex',
      },
    })
    await instance.emitNotification({
      method: 'turn/completed',
    })

    expect(statuses).toContain('streaming')
    expect(statuses).toContain('idle')
    expect(agentEndCalls).toBe(1)
    expect(sessionEvents).toContainEqual(
      expect.objectContaining({
        type: 'message_update',
        message: {
          role: 'assistant',
          content: 'Hello from codex',
        },
      }),
    )

    instance.emitExit(new Error('app-server crashed'))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(runtimeErrors).toContainEqual(
      expect.objectContaining({
        phase: 'runtime_exit',
        message: 'app-server crashed',
      }),
    )
    expect(runtime.getStatus()).toBe('terminated')
    expect(statuses.at(-1)).toBe('terminated')
    expect(sessionEvents).toContainEqual(
      expect.objectContaining({
        type: 'tool_execution_end',
        toolName: 'codex-app-server',
        isError: true,
      }),
    )
    await expect(runtime.sendMessage('after exit')).rejects.toThrow('is terminated')
  })

  it('interrupts active turns during terminate() and clears pending queues', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'swarm-codex-runtime-'))
    const descriptor = makeDescriptor(tempDir)
    await mkdir(dirname(descriptor.sessionFile), { recursive: true })

    rpcMockState.requestImpl.mockImplementation(async (_client: any, method: string) => {
      if (method === 'initialize') {
        return {}
      }

      if (method === 'account/read') {
        return { requiresOpenaiAuth: false, account: { id: 'acct-1' } }
      }

      if (method === 'thread/start') {
        return { thread: { id: 'thread-1' } }
      }

      if (method === 'turn/start') {
        return { turn: { id: 'turn-1' } }
      }

      if (method === 'turn/steer') {
        return { ok: true }
      }

      if (method === 'turn/interrupt') {
        return { interrupted: true }
      }

      throw new Error(`Unexpected method: ${method}`)
    })

    const runtime = await CodexAgentRuntime.create({
      descriptor,
      callbacks: {
        onStatusChange: async () => {},
      },
      systemPrompt: 'You are a test codex runtime.',
      tools: [],
    })

    await runtime.sendMessage('start a turn')
    await runtime.sendMessage('queue while active')
    expect(runtime.getPendingCount()).toBe(1)

    await runtime.terminate()

    const instance = rpcMockState.instances[0]
    expect(
      instance.requestCalls.some(
        (entry: { method: string; params: { turnId?: string } }) =>
          entry.method === 'turn/interrupt' && entry.params?.turnId === 'turn-1',
      ),
    ).toBe(true)
    expect(runtime.getPendingCount()).toBe(0)
    expect(runtime.getStatus()).toBe('terminated')
  })

  it('bounds stopInFlight when pending custom entry writes never settle', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'swarm-codex-runtime-'))
    const descriptor = makeDescriptor(tempDir)
    await mkdir(dirname(descriptor.sessionFile), { recursive: true })

    rpcMockState.requestImpl.mockImplementation(async (_client: any, method: string) => {
      if (method === 'initialize') {
        return {}
      }

      if (method === 'account/read') {
        return { requiresOpenaiAuth: false, account: { id: 'acct-1' } }
      }

      if (method === 'thread/start') {
        return { thread: { id: 'thread-1' } }
      }

      if (method === 'turn/start') {
        return { turn: { id: 'turn-1' } }
      }

      if (method === 'turn/interrupt') {
        throw new Error('interrupt timed out')
      }

      return {}
    })

    const runtime = await CodexAgentRuntime.create({
      descriptor,
      callbacks: {
        onStatusChange: async () => {},
      },
      systemPrompt: 'You are a test codex runtime.',
      tools: [],
    })

    await runtime.sendMessage('start a turn')
    ;(runtime as any).pendingCustomEntryWrites.add(new Promise(() => {}))

    await expect(
      runtime.stopInFlight({ abort: true, shutdownTimeoutMs: 20, drainTimeoutMs: 20 }),
    ).resolves.toBeUndefined()

    expect(runtime.getStatus()).toBe('idle')
    expect(runtime.getPendingCount()).toBe(0)
  })

  it('uses codex.cmd by default on win32', async () => {
    await withPlatform('win32', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'swarm-codex-runtime-'))
      const descriptor = makeDescriptor(tempDir)
      await mkdir(dirname(descriptor.sessionFile), { recursive: true })

      rpcMockState.requestImpl.mockImplementation(async (_client: any, method: string) => {
        if (method === 'initialize') {
          return {}
        }

        if (method === 'account/read') {
          return { requiresOpenaiAuth: false, account: { id: 'acct-1' } }
        }

        if (method === 'thread/start') {
          return { thread: { id: 'thread-1' } }
        }

        return {}
      })

      const runtime = await CodexAgentRuntime.create({
        descriptor,
        callbacks: {
          onStatusChange: async () => {},
        },
        systemPrompt: 'You are a test codex runtime.',
        tools: [],
      })

      const instance = rpcMockState.instances[0]
      expect(instance.command).toBe('codex.cmd')

      await runtime.terminate({ abort: false })
    })
  })

  it('self-disables shutdown RPC after an unsupported-method response on win32', async () => {
    await withPlatform('win32', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'swarm-codex-runtime-'))
      const descriptor = makeDescriptor(tempDir)
      await mkdir(dirname(descriptor.sessionFile), { recursive: true })

      rpcMockState.requestImpl.mockImplementation(async (_client: any, method: string) => {
        if (method === 'initialize') {
          return {}
        }

        if (method === 'account/read') {
          return { requiresOpenaiAuth: false, account: { id: 'acct-1' } }
        }

        if (method === 'thread/start') {
          return { thread: { id: 'thread-1' } }
        }

        if (method === 'shutdown') {
          throw new Error('method not found')
        }

        return {}
      })

      const runtime = await CodexAgentRuntime.create({
        descriptor,
        callbacks: {
          onStatusChange: async () => {},
        },
        systemPrompt: 'You are a test codex runtime.',
        tools: [],
      })

      const instance = rpcMockState.instances[0]
      await (runtime as any).tryGracefulShutdownRpc()
      await (runtime as any).tryGracefulShutdownRpc()

      expect(instance.requestCalls.filter((entry: { method: string }) => entry.method === 'shutdown')).toHaveLength(1)
      expect((runtime as any).shutdownRpcSupported).toBe(false)

      await runtime.terminate({ abort: false })
    })
  })
})
