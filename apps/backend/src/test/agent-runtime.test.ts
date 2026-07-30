import { describe, expect, it, vi, beforeEach } from 'vitest'
import { AgentRuntime } from '../swarm/agent-runtime.js'
import { clearForgePiCompactionFailure, rememberForgePiCompactionFailure } from '../swarm/compaction/forge-pi-compaction-extension.js'
import type { AgentDescriptor } from '../swarm/types.js'

const openAICodexResponsesMockState = vi.hoisted(() => ({
  closeOpenAICodexWebSocketSessions: vi.fn(),
  getOpenAICodexWebSocketDebugStats: vi.fn(),
}))

vi.mock('@earendil-works/pi-ai/api/openai-codex-responses', () => ({
  closeOpenAICodexWebSocketSessions: (...args: unknown[]) =>
    openAICodexResponsesMockState.closeOpenAICodexWebSocketSessions(...args),
  getOpenAICodexWebSocketDebugStats: (...args: unknown[]) =>
    openAICodexResponsesMockState.getOpenAICodexWebSocketDebugStats(...args),
}))

class FakeSession {
  isStreaming = false
  promptCalls: string[] = []
  promptImageCounts: number[] = []
  followUpCalls: string[] = []
  steerCalls: string[] = []
  queuedSteers: string[] = []
  steerImageCounts: number[] = []
  userMessageCalls: Array<string | Array<{ type: string }>> = []
  abortCalls = 0
  disposeCalls = 0
  clearQueueCalls = 0
  listener: ((event: any) => void) | undefined
  contextUsageCalls = 0
  contextUsage: { tokens: number | null; contextWindow: number; percent: number | null } | undefined
  agent = { transport: 'websocket-cached' }
  model = { provider: 'openai-codex', api: 'openai-codex-responses' }
  state: { messages: Array<Record<string, any>> } = { messages: [] }
  authStorageCredentials = new Map<string, unknown>()
  modelRegistry: any = {
    authStorage: {
      get: vi.fn((key: string) => this.authStorageCredentials.get(key)),
      set: vi.fn((key: string, value: unknown) => {
        this.authStorageCredentials.set(key, value)
      }),
    },
  }
  sessionId = 'fake-session-id'
  sessionManager = {
    getEntries: () => [],
  }
  shutdownEvents: any[] = []
  extensionRunner = {
    hasHandlers: (eventName: string) => eventName === 'session_shutdown',
    emit: async (event: any) => {
      this.shutdownEvents.push(event)
    },
  }

  async prompt(message: string, options?: { images?: Array<{ type: string }> }): Promise<void> {
    this.promptCalls.push(message)
    this.promptImageCounts.push(options?.images?.length ?? 0)
  }

  async followUp(message: string): Promise<void> {
    this.followUpCalls.push(message)
  }

  async steer(message: string, images?: Array<{ type: string }>): Promise<void> {
    this.steerCalls.push(message)
    this.queuedSteers.push(message)
    this.steerImageCounts.push(images?.length ?? 0)
  }

  async sendUserMessage(content: string | Array<{ type: string }>): Promise<void> {
    this.userMessageCalls.push(content)
  }

  async abort(): Promise<void> {
    this.abortCalls += 1
  }

  async waitForIdle(): Promise<void> {}

  async compact(): Promise<{ ok: true }> {
    return { ok: true }
  }

  clearQueue(): { steering: string[]; followUp: string[] } {
    this.clearQueueCalls += 1
    return { steering: this.queuedSteers.splice(0), followUp: [] }
  }

  getContextUsage(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined {
    this.contextUsageCalls += 1
    return this.contextUsage
  }

  dispose(): void {
    this.disposeCalls += 1
  }

  subscribe(listener: (event: any) => void): () => void {
    this.listener = listener
    return () => {
      this.listener = undefined
    }
  }

  emit(event: any): void {
    this.listener?.(event)
  }
}


async function emitSessionEvent(runtime: AgentRuntime, session: FakeSession, event: any): Promise<void> {
  session.emit(event)
  await runtime.flushSessionEventQueue()
}

function makeDescriptor(): AgentDescriptor {
  return {
    agentId: 'worker',
    displayName: 'Worker',
    role: 'worker',
    managerId: 'manager',
    status: 'idle',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cwd: '/tmp/project',
    model: {
      provider: 'openai-codex',
      modelId: 'gpt-5.5',
      thinkingLevel: 'medium',
    },
    sessionFile: '/tmp/project/worker.jsonl',
  }
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {}
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve
  })

  return { promise, resolve }
}

async function waitForCondition(
  condition: () => boolean,
  timeoutMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (condition()) {
      return
    }

    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  throw new Error('Timed out waiting for async condition')
}

describe('AgentRuntime', () => {
  beforeEach(() => {
    openAICodexResponsesMockState.closeOpenAICodexWebSocketSessions.mockReset()
    openAICodexResponsesMockState.getOpenAICodexWebSocketDebugStats.mockReset()
    clearForgePiCompactionFailure('worker')
    clearForgePiCompactionFailure('worker::stale')
    clearForgePiCompactionFailure('worker::fresh')
    clearForgePiCompactionFailure('worker::shared')
  })

  it('does not replay broker capacity failures when the broker returns the same exhausted lease', async () => {
    const session = new FakeSession()
    const runtimeErrors: unknown[] = []
    const runtime = new AgentRuntime({
      descriptor: makeDescriptor(),
      session: session as any,
      callbacks: {
        onStatusChange: () => {},
        onRuntimeError: (_agentId, error) => runtimeErrors.push(error),
      },
    })
    const handle = {
      leaseId: 'lease-exhausted',
      renewedAtMs: Date.now(),
      identity: { clientId: 'forge', sessionId: 'worker' },
      lease: {
        leaseId: 'lease-exhausted',
        accountId: 'acct-1',
        credential: { type: 'oauth', access: 'access-1', refresh: '', expires: 1_700_000_000_000, accountId: 'acct-1' },
      },
    }
    const brokerRuntimeService = {
      report: vi.fn(async () => handle),
      applyLeaseToAuthStorage: vi.fn(async (_authStorage, nextHandle) => nextHandle),
    }
    runtime.configureOpenAIAuthBrokerController(brokerRuntimeService as any, handle as any)

    const handled = await (runtime as any).openAIAuthBrokerController.attemptRecovery(
      new Error('rate limit exhausted'),
      'rate limit exhausted',
      { text: 'retry me' },
    )

    expect(handled).toBe(false)
    expect(session.promptCalls).toEqual([])
    expect(brokerRuntimeService.applyLeaseToAuthStorage).not.toHaveBeenCalled()
    expect(runtimeErrors).toContainEqual(expect.objectContaining({
      phase: 'prompt_dispatch',
      message: 'Forge Auth broker reported capacity exhaustion for OpenAI/Codex but did not provide a replacement lease.',
      details: expect.objectContaining({ stage: 'broker_lease:no_replacement_capacity' }),
    }))
  })

  it('does not immediately replay the same broker lease on full-dispatch capacity failures', async () => {
    const session = new FakeSession()
    const runtimeErrors: unknown[] = []
    const handle = {
      leaseId: 'lease-exhausted',
      renewedAtMs: Date.now(),
      identity: { clientId: 'forge', sessionId: 'worker' },
      lease: {
        leaseId: 'lease-exhausted',
        accountId: 'acct-1',
        credential: { type: 'oauth', access: 'access-1', refresh: '', expires: 1_700_000_000_000, accountId: 'acct-1' },
      },
    }
    const brokerRuntimeService = {
      isBrokerModeActive: vi.fn(async () => true),
      renewIfNeeded: vi.fn(async () => handle),
      report: vi.fn(async () => handle),
      applyLeaseToAuthStorage: vi.fn(async (_authStorage, nextHandle) => nextHandle),
    }

    session.prompt = async (message: string): Promise<void> => {
      session.promptCalls.push(message)
      throw new Error('HTTP 429 quota exhausted')
    }

    const runtime = new AgentRuntime({
      descriptor: makeDescriptor(),
      session: session as any,
      callbacks: {
        onStatusChange: () => {},
        onRuntimeError: (_agentId, error) => runtimeErrors.push(error),
      },
    })
    runtime.configureOpenAIAuthBrokerController(brokerRuntimeService as any, handle as any)

    await runtime.sendMessage('retry me')
    await waitForCondition(() => brokerRuntimeService.report.mock.calls.length === 1)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(session.promptCalls).toEqual(['retry me'])
    expect(brokerRuntimeService.report).toHaveBeenCalledWith(
      handle,
      'capacity_error',
      expect.objectContaining({ message: 'HTTP 429 quota exhausted' }),
    )
    expect(runtimeErrors).toContainEqual(expect.objectContaining({
      phase: 'prompt_dispatch',
      message: 'Forge Auth broker reported capacity exhaustion for OpenAI/Codex but did not provide a replacement lease.',
      details: expect.objectContaining({ stage: 'broker_lease:no_replacement_capacity' }),
    }))
  })

  it('replays full-dispatch broker capacity failures after applying a replacement lease', async () => {
    const session = new FakeSession()
    const runtimeErrors: unknown[] = []
    const initialHandle = {
      leaseId: 'lease-exhausted',
      renewedAtMs: Date.now(),
      identity: { clientId: 'forge', sessionId: 'worker' },
      lease: {
        leaseId: 'lease-exhausted',
        accountId: 'acct-1',
        credential: { type: 'oauth', access: 'access-1', refresh: '', expires: 1_700_000_000_000, accountId: 'acct-1' },
      },
    }
    const replacementHandle = {
      leaseId: 'lease-replacement',
      renewedAtMs: Date.now(),
      identity: { clientId: 'forge', sessionId: 'worker' },
      lease: {
        leaseId: 'lease-replacement',
        accountId: 'acct-2',
        credential: { type: 'oauth', access: 'access-2', refresh: '', expires: 1_700_000_000_000, accountId: 'acct-2' },
      },
    }
    const brokerRuntimeService = {
      isBrokerModeActive: vi.fn(async () => true),
      renewIfNeeded: vi.fn(async (handleArg: unknown) => handleArg),
      report: vi.fn(async () => replacementHandle),
      applyLeaseToAuthStorage: vi.fn(async (_authStorage, nextHandle) => nextHandle),
    }
    let promptAttempts = 0

    session.prompt = async (message: string): Promise<void> => {
      session.promptCalls.push(message)
      promptAttempts += 1
      if (promptAttempts === 1) {
        throw new Error('HTTP 429 quota exhausted')
      }
    }

    const runtime = new AgentRuntime({
      descriptor: makeDescriptor(),
      session: session as any,
      callbacks: {
        onStatusChange: () => {},
        onRuntimeError: (_agentId, error) => runtimeErrors.push(error),
      },
    })
    runtime.configureOpenAIAuthBrokerController(brokerRuntimeService as any, initialHandle as any)

    await runtime.sendMessage('retry me')
    await waitForCondition(() => session.promptCalls.length === 2)

    expect(session.promptCalls).toEqual(['retry me', 'retry me'])
    expect(brokerRuntimeService.report).toHaveBeenCalledTimes(1)
    expect(brokerRuntimeService.applyLeaseToAuthStorage).toHaveBeenCalledWith(
      expect.anything(),
      replacementHandle,
    )
    expect(openAICodexResponsesMockState.closeOpenAICodexWebSocketSessions).toHaveBeenCalledWith('fake-session-id')
    expect(runtimeErrors).toEqual([])
  })

  it('fails closed before dispatch when an active broker runtime sees local auth mode', async () => {
    const session = new FakeSession()
    const runtimeErrors: unknown[] = []
    const runtime = new AgentRuntime({
      descriptor: makeDescriptor(),
      session: session as any,
      callbacks: {
        onStatusChange: () => {},
        onRuntimeError: (_agentId, error) => runtimeErrors.push(error),
      },
    })
    const handle = {
      leaseId: 'lease-broker',
      renewedAtMs: Date.now(),
      identity: { clientId: 'forge', sessionId: 'worker' },
      lease: {
        leaseId: 'lease-broker',
        credential: { type: 'oauth', access: 'access-1', refresh: '', expires: 1_700_000_000_000 },
      },
    }
    const brokerRuntimeService = {
      isBrokerModeActive: vi.fn(async () => false),
      release: vi.fn(async () => undefined),
    }
    runtime.configureOpenAIAuthBrokerController(brokerRuntimeService as any, handle as any)

    await runtime.sendMessage('hello')
    await waitForCondition(() => runtimeErrors.length > 0)

    expect(session.promptCalls).toEqual([])
    expect(brokerRuntimeService.release).toHaveBeenCalledWith(
      expect.objectContaining({ leaseId: 'lease-broker' }),
      'auth_source_change',
    )
    expect(runtimeErrors).toContainEqual(expect.objectContaining({
      phase: 'prompt_dispatch',
      message: expect.stringContaining('auth source changed to local credentials'),
    }))
  })

  it('fails closed before dispatch when a local OpenAI runtime sees broker mode enabled', async () => {
    const session = new FakeSession()
    const runtimeErrors: unknown[] = []
    const runtime = new AgentRuntime({
      descriptor: makeDescriptor(),
      session: session as any,
      callbacks: {
        onStatusChange: () => {},
        onRuntimeError: (_agentId, error) => runtimeErrors.push(error),
      },
    })
    runtime.configureOpenAIAuthBrokerController({
      isBrokerModeActive: vi.fn(async () => true),
    } as any)

    await runtime.sendMessage('hello')
    await waitForCondition(() => runtimeErrors.length > 0)

    expect(session.promptCalls).toEqual([])
    expect(runtimeErrors).toContainEqual(expect.objectContaining({
      phase: 'prompt_dispatch',
      message: expect.stringContaining('auth source changed to Forge Auth broker'),
    }))
  })

  it('returns sanitized codex transport debug diagnostics', () => {
    openAICodexResponsesMockState.getOpenAICodexWebSocketDebugStats.mockReturnValue({
      requests: 2,
      connectionsCreated: 1,
      connectionsReused: 1,
      cachedContextRequests: 1,
      storeTrueRequests: 1,
      fullContextRequests: 1,
      deltaRequests: 1,
      lastInputItems: 4,
      lastDeltaInputItems: 1,
      lastPreviousResponseId: 'resp_secret',
    })
    const session = new FakeSession()
    const runtime = new AgentRuntime({
      descriptor: makeDescriptor(),
      session: session as any,
      callbacks: {
        onStatusChange: () => {},
      },
    })

    const diagnostics = runtime.getCodexTransportDebugDiagnostics()

    expect(openAICodexResponsesMockState.getOpenAICodexWebSocketDebugStats).toHaveBeenCalledWith('fake-session-id')
    expect(diagnostics).toMatchObject({
      transport: 'websocket-cached',
      modelProvider: 'openai-codex',
      modelApi: 'openai-codex-responses',
      piSessionIdPresent: true,
      websocketStatsStatus: 'available',
      directPiSessionStatsStatus: 'available',
      websocketStats: {
        requests: 2,
        connectionsCreated: 1,
        connectionsReused: 1,
        cachedContextRequests: 1,
        storeTrueRequests: 1,
        fullContextRequests: 1,
        deltaRequests: 1,
        lastInputItems: 4,
        lastDeltaInputItems: 1,
      },
    })
    expect(JSON.stringify(diagnostics)).not.toContain('lastPreviousResponseId')
    expect(JSON.stringify(diagnostics)).not.toContain('resp_secret')
  })

  it('queues steer for all messages when runtime is busy', async () => {
    const session = new FakeSession()

    const runtime = new AgentRuntime({
      descriptor: makeDescriptor(),
      session: session as any,
      callbacks: {
        onStatusChange: () => {},
      },
    })

    session.isStreaming = true

    const autoReceipt = await runtime.sendMessage('auto message')
    const followUpReceipt = await runtime.sendMessage('explicit followup', 'followUp')
    const steerReceipt = await runtime.sendMessage('steer message', 'steer')

    expect(autoReceipt.acceptedMode).toBe('steer')
    expect(followUpReceipt.acceptedMode).toBe('steer')
    expect(steerReceipt.acceptedMode).toBe('steer')
    expect(session.followUpCalls).toEqual([])
    expect(session.steerCalls).toEqual(['auto message', 'explicit followup', 'steer message'])
  })

  it('queues steer while prompt dispatch is in progress', async () => {
    const session = new FakeSession()
    const deferred = createDeferred()

    session.prompt = async (message: string): Promise<void> => {
      session.promptCalls.push(message)
      await deferred.promise
    }

    const runtime = new AgentRuntime({
      descriptor: makeDescriptor(),
      session: session as any,
      callbacks: {
        onStatusChange: () => {},
      },
    })

    const first = await runtime.sendMessage('first prompt')
    const second = await runtime.sendMessage('queued auto')
    const third = await runtime.sendMessage('queued followup', 'followUp')

    expect(first.acceptedMode).toBe('prompt')
    expect(second.acceptedMode).toBe('steer')
    expect(third.acceptedMode).toBe('steer')
    expect(session.promptCalls).toEqual(['first prompt'])
    expect(session.followUpCalls).toEqual([])
    expect(session.steerCalls).toEqual(['queued auto', 'queued followup'])

    deferred.resolve()
    await Promise.resolve()
  })

  it('consumes pending queue when queued user message starts', async () => {
    const session = new FakeSession()
    const statuses: number[] = []

    const runtime = new AgentRuntime({
      descriptor: makeDescriptor(),
      session: session as any,
      callbacks: {
        onStatusChange: (_agentId, _status, pendingCount) => {
          statuses.push(pendingCount)
        },
      },
    })

    session.isStreaming = true
    await runtime.sendMessage('queued one', 'auto')
    expect(runtime.getPendingCount()).toBe(1)

    await emitSessionEvent(runtime, session, {
      type: 'message_start',
      message: {
        role: 'user',
        content: 'queued one',
      },
    })

    expect(runtime.getPendingCount()).toBe(0)
    expect(statuses.at(-1)).toBe(0)
  })

  it('reuses cached context usage for throttled streaming updates and refreshes it on turn/tool boundaries', async () => {
    const session = new FakeSession()
    const statuses: Array<{ status: string; contextUsage: unknown }> = []
    const nowSpy = vi.spyOn(Date, 'now')

    try {
      session.contextUsage = {
        tokens: 128,
        contextWindow: 1000,
        percent: 12.8,
      }

      const runtime = new AgentRuntime({
        descriptor: makeDescriptor(),
        session: session as any,
        callbacks: {
          onStatusChange: (_agentId, status, _pendingCount, contextUsage) => {
            statuses.push({ status, contextUsage })
          },
        },
      })

      nowSpy.mockReturnValue(1_000)
      await emitSessionEvent(runtime, session, { type: 'agent_start' })
      await waitForCondition(() => statuses.length === 1)

      expect(session.contextUsageCalls).toBe(1)
      expect(statuses.at(-1)).toEqual({
        status: 'streaming',
        contextUsage: {
          tokens: 128,
          contextWindow: 1000,
          percent: 12.8,
        },
      })

      session.contextUsage = {
        tokens: 160,
        contextWindow: 1000,
        percent: 16,
      }
      nowSpy.mockReturnValue(2_500)
      await emitSessionEvent(runtime, session, {
        type: 'message_update',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'partial' }],
        },
      })
      await waitForCondition(() => statuses.length === 2)

      expect(session.contextUsageCalls).toBe(1)
      expect(statuses.at(-1)).toEqual({
        status: 'streaming',
        contextUsage: {
          tokens: 128,
          contextWindow: 1000,
          percent: 12.8,
        },
      })

      session.contextUsage = {
        tokens: 192,
        contextWindow: 1000,
        percent: 19.2,
      }
      await emitSessionEvent(runtime, session, {
        type: 'turn_end',
        toolResults: [],
      })
      expect(session.contextUsageCalls).toBe(2)

      session.contextUsage = {
        tokens: 224,
        contextWindow: 1000,
        percent: 22.4,
      }
      nowSpy.mockReturnValue(4_000)
      await emitSessionEvent(runtime, session, {
        type: 'message_update',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'more partial' }],
        },
      })
      await waitForCondition(() => statuses.length === 3)

      expect(session.contextUsageCalls).toBe(2)
      expect(statuses.at(-1)).toEqual({
        status: 'streaming',
        contextUsage: {
          tokens: 192,
          contextWindow: 1000,
          percent: 19.2,
        },
      })

      session.contextUsage = {
        tokens: 256,
        contextWindow: 1000,
        percent: 25.6,
      }
      await emitSessionEvent(runtime, session, {
        type: 'tool_execution_end',
        toolName: 'bash',
        toolCallId: 'tool-1',
        result: { ok: true },
        isError: false,
      })
      expect(session.contextUsageCalls).toBe(3)

      session.contextUsage = {
        tokens: 320,
        contextWindow: 1000,
        percent: 32,
      }
      nowSpy.mockReturnValue(5_500)
      await emitSessionEvent(runtime, session, {
        type: 'message_update',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'final partial' }],
        },
      })
      await waitForCondition(() => statuses.length === 4)

      expect(session.contextUsageCalls).toBe(3)
      expect(statuses.at(-1)).toEqual({
        status: 'streaming',
        contextUsage: {
          tokens: 256,
          contextWindow: 1000,
          percent: 25.6,
        },
      })
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('passes image attachments through prompt options when text is present', async () => {
    const session = new FakeSession()

    const runtime = new AgentRuntime({
      descriptor: makeDescriptor(),
      session: session as any,
      callbacks: {
        onStatusChange: () => {},
      },
    })

    await runtime.sendMessage({
      text: 'describe this image',
      images: [{ mimeType: 'image/png', data: 'aGVsbG8=' }],
    })

    await waitForCondition(() => session.promptCalls.length === 1)

    expect(session.promptCalls).toEqual(['describe this image'])
    expect(session.promptImageCounts).toEqual([1])
    expect(session.userMessageCalls).toHaveLength(0)
  })

  it('uses sendUserMessage for image-only prompts', async () => {
    const session = new FakeSession()

    const runtime = new AgentRuntime({
      descriptor: makeDescriptor(),
      session: session as any,
      callbacks: {
        onStatusChange: () => {},
      },
    })

    await runtime.sendMessage({
      text: '',
      images: [{ mimeType: 'image/png', data: 'aGVsbG8=' }],
    })

    await waitForCondition(() => session.userMessageCalls.length === 1)

    expect(session.promptCalls).toHaveLength(0)
    expect(session.userMessageCalls).toHaveLength(1)
    expect(Array.isArray(session.userMessageCalls[0])).toBe(true)
  })

  it('surfaces prompt failures, resets status to idle, and invokes onAgentEnd', async () => {
    const session = new FakeSession()
    const statuses: string[] = []
    const runtimeErrors: Array<{ phase: string; message: string }> = []
    let agentEndCalls = 0

    session.prompt = async (): Promise<void> => {
      await emitSessionEvent(runtime, session, { type: 'agent_start' })
      throw new Error('provider outage')
    }

    const runtime = new AgentRuntime({
      descriptor: makeDescriptor(),
      session: session as any,
      callbacks: {
        onStatusChange: (_agentId, status) => {
          statuses.push(status)
        },
        onRuntimeError: (_agentId, error) => {
          runtimeErrors.push({
            phase: error.phase,
            message: error.message,
          })
        },
        onAgentEnd: () => {
          agentEndCalls += 1
        },
      },
    })

    const receipt = await runtime.sendMessage('trigger failure')
    expect(receipt.acceptedMode).toBe('prompt')

    await Promise.resolve()
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(runtimeErrors).toEqual([
      expect.objectContaining({
        phase: 'prompt_dispatch',
        message: 'provider outage',
      }),
    ])
    expect(statuses).toContain('streaming')
    expect(statuses).toContain('idle')
    expect(runtime.getStatus()).toBe('idle')
    expect(agentEndCalls).toBe(1)
  })

  it('retries prompt dispatch once for transient failures before succeeding', async () => {
    const session = new FakeSession()
    const runtimeErrors: Array<{ phase: string; message: string }> = []
    let promptAttempts = 0

    session.prompt = async (message: string): Promise<void> => {
      session.promptCalls.push(message)
      promptAttempts += 1
      if (promptAttempts === 1) {
        throw new Error('temporary provider outage')
      }
    }

    const runtime = new AgentRuntime({
      descriptor: makeDescriptor(),
      session: session as any,
      callbacks: {
        onStatusChange: () => {},
        onRuntimeError: (_agentId, error) => {
          runtimeErrors.push({
            phase: error.phase,
            message: error.message,
          })
        },
      },
    })

    const receipt = await runtime.sendMessage('retry me')
    expect(receipt.acceptedMode).toBe('prompt')

    await Promise.resolve()
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(session.promptCalls).toEqual(['retry me', 'retry me'])
    expect(runtimeErrors).toEqual([])
    expect(runtime.getStatus()).toBe('idle')
  })

  it('clears queued pending deliveries when prompt dispatch fails after retries', async () => {
    const session = new FakeSession()
    const deferred = createDeferred()
    const pendingStatuses: number[] = []
    const runtimeErrors: Array<{ phase: string; details?: Record<string, unknown> }> = []
    let promptAttempts = 0

    session.prompt = async (message: string): Promise<void> => {
      session.promptCalls.push(message)
      promptAttempts += 1

      if (promptAttempts === 1) {
        await deferred.promise
      }

      throw new Error('provider outage')
    }

    const runtime = new AgentRuntime({
      descriptor: makeDescriptor(),
      session: session as any,
      callbacks: {
        onStatusChange: (_agentId, _status, pendingCount) => {
          pendingStatuses.push(pendingCount)
        },
        onRuntimeError: (_agentId, error) => {
          runtimeErrors.push({
            phase: error.phase,
            details: error.details,
          })
        },
      },
    })

    const first = await runtime.sendMessage('first prompt')
    const queued = await runtime.sendMessage('queued followup')

    expect(first.acceptedMode).toBe('prompt')
    expect(queued.acceptedMode).toBe('steer')
    expect(runtime.getPendingCount()).toBe(1)
    expect(session.steerCalls).toEqual(['queued followup'])

    deferred.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(runtime.getPendingCount()).toBe(0)
    expect(session.clearQueueCalls).toBe(1)
    expect(session.queuedSteers).toEqual([])
    expect(runtimeErrors).toEqual([
      expect.objectContaining({
        phase: 'prompt_dispatch',
        details: expect.objectContaining({
          droppedPendingCount: 1,
          attempt: 2,
          maxAttempts: 2,
        }),
      }),
    ])
    expect(pendingStatuses).toContain(1)
    expect(pendingStatuses).toContain(0)
    expect(runtime.getStatus()).toBe('idle')
  })

  it('uses provider-neutral Anthropic rotation messages for pooled failover', async () => {
    const session = new FakeSession()
    const runtimeErrors: Array<{ phase: string; message: string }> = []
    const authStorageSet = vi.fn()
    let promptAttempts = 0

    session.prompt = async (message: string): Promise<void> => {
      session.promptCalls.push(message)
      promptAttempts += 1
      if (promptAttempts < 3) {
        throw new Error('Request failed with status: 529 {"type":"overloaded_error"}')
      }
    }

    ;(session as any).model = { provider: 'anthropic', id: 'claude-opus-4-6' }
    ;(session as any).modelRegistry = {
      authStorage: {
        set: authStorageSet,
      },
    }

    const pool = {
      markAuthError: vi.fn(),
      markExhausted: vi.fn().mockResolvedValue(undefined),
      select: vi.fn().mockResolvedValue({
        credentialId: 'cred_second',
        authStorageKey: 'anthropic:cred_second',
      }),
      getEarliestCooldownExpiry: vi.fn().mockResolvedValue(undefined),
      buildRuntimeAuthData: vi.fn().mockResolvedValue({
        anthropic: { type: 'oauth', access: 'anthropic-second-token' },
      }),
      markUsed: vi.fn().mockResolvedValue(undefined),
    }

    const runtime = new AgentRuntime({
      descriptor: {
        ...makeDescriptor(),
        model: {
          provider: 'anthropic',
          modelId: 'claude-opus-4-6',
          thinkingLevel: 'medium',
        },
      },
      session: session as any,
      callbacks: {
        onStatusChange: () => {},
        onRuntimeError: (_agentId, error) => {
          runtimeErrors.push({
            phase: error.phase,
            message: error.message,
          })
        },
      },
    })

    runtime.pooledCredentialId = 'cred_primary'
    runtime.pooledCredentialProvider = 'anthropic'
    runtime.credentialPoolService = pool as any

    const receipt = await runtime.sendMessage('retry with rotation')
    expect(receipt.acceptedMode).toBe('prompt')

    await waitForCondition(() => session.promptCalls.length === 3)

    expect(pool.markExhausted).toHaveBeenCalledWith(
      'anthropic',
      'cred_primary',
      expect.objectContaining({
        cooldownUntil: expect.any(Number),
      }),
    )
    expect(pool.select).toHaveBeenCalledWith('anthropic', {
      excludeCredentialId: 'cred_primary',
    })
    expect(pool.buildRuntimeAuthData).toHaveBeenCalledWith('anthropic', 'cred_second')
    expect(pool.markUsed).toHaveBeenCalledWith('anthropic', 'cred_second')
    expect(authStorageSet).toHaveBeenCalledWith('anthropic', {
      type: 'oauth',
      access: 'anthropic-second-token',
    })
    expect(runtime.pooledCredentialId).toBe('cred_second')
    expect(runtimeErrors).toContainEqual({
      phase: 'prompt_dispatch',
      message: 'Anthropic rate limit hit — rotating to another account and retrying.',
    })
  })

  it('marks pooled credentials auth_error and attempts fallback rotation for broader auth failures like 403 forbidden', async () => {
    const session = new FakeSession()

    session.prompt = async (): Promise<void> => {
      throw new Error('HTTP 403 forbidden: OAuth token expired')
    }

    ;(session as any).model = { provider: 'anthropic', id: 'claude-opus-4-6' }

    const pool = {
      markAuthError: vi.fn().mockResolvedValue(undefined),
      markExhausted: vi.fn(),
      select: vi.fn(),
      getEarliestCooldownExpiry: vi.fn(),
    }

    const runtime = new AgentRuntime({
      descriptor: {
        ...makeDescriptor(),
        model: {
          provider: 'anthropic',
          modelId: 'claude-opus-4-6',
          thinkingLevel: 'medium',
        },
      },
      session: session as any,
      callbacks: {
        onStatusChange: () => {},
        onRuntimeError: () => {},
      },
    })

    runtime.pooledCredentialId = 'cred_primary'
    runtime.pooledCredentialProvider = 'anthropic'
    runtime.credentialPoolService = pool as any

    await runtime.sendMessage('auth failure')
    await waitForCondition(() => pool.markAuthError.mock.calls.length === 1)

    expect(pool.markAuthError).toHaveBeenCalledWith('anthropic', 'cred_primary')
    expect(pool.markExhausted).not.toHaveBeenCalled()
    expect(pool.select).toHaveBeenCalledWith('anthropic', {
      excludeCredentialId: 'cred_primary',
    })
  })

  it('uses provider-neutral Anthropic exhaustion messages when every pooled account is cooling down', async () => {
    const session = new FakeSession()
    const runtimeErrors: Array<{ phase: string; message: string }> = []

    session.prompt = async (message: string): Promise<void> => {
      session.promptCalls.push(message)
      throw new Error('HTTP 429 too many requests')
    }

    ;(session as any).model = { provider: 'anthropic', id: 'claude-opus-4-6' }

    const pool = {
      markAuthError: vi.fn(),
      markExhausted: vi.fn().mockResolvedValue(undefined),
      select: vi.fn().mockResolvedValue(null),
      getEarliestCooldownExpiry: vi.fn().mockResolvedValue(undefined),
    }

    const runtime = new AgentRuntime({
      descriptor: {
        ...makeDescriptor(),
        model: {
          provider: 'anthropic',
          modelId: 'claude-opus-4-6',
          thinkingLevel: 'medium',
        },
      },
      session: session as any,
      callbacks: {
        onStatusChange: () => {},
        onRuntimeError: (_agentId, error) => {
          runtimeErrors.push({
            phase: error.phase,
            message: error.message,
          })
        },
      },
    })

    runtime.pooledCredentialId = 'cred_primary'
    runtime.pooledCredentialProvider = 'anthropic'
    runtime.credentialPoolService = pool as any

    await runtime.sendMessage('still limited')
    await waitForCondition(() => runtimeErrors.length >= 2)

    expect(pool.markExhausted).toHaveBeenCalledWith(
      'anthropic',
      'cred_primary',
      expect.objectContaining({
        cooldownUntil: expect.any(Number),
      }),
    )
    expect(runtimeErrors).toContainEqual({
      phase: 'prompt_dispatch',
      message: 'All Anthropic accounts are rate-limited.',
    })
  })

  it('reports compaction-related prompt failures with compaction phase', async () => {
    const session = new FakeSession()
    const phases: string[] = []

    session.prompt = async (): Promise<void> => {
      throw new Error('auto compaction failed while preparing prompt')
    }

    const runtime = new AgentRuntime({
      descriptor: makeDescriptor(),
      session: session as any,
      callbacks: {
        onStatusChange: () => {},
        onRuntimeError: (_agentId, error) => {
          phases.push(error.phase)
        },
      },
    })

    await runtime.sendMessage('trigger compaction failure')
    await Promise.resolve()
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(phases.at(-1)).toBe('compaction')
    expect(runtime.getStatus()).toBe('idle')
  })

  it('emits a status update after manual compaction with refreshed context usage', async () => {
    const session = new FakeSession()
    session.contextUsage = {
      tokens: 920,
      contextWindow: 1000,
      percent: 92,
    }

    const contextTokensByStatus: number[] = []
    const runtimeRef: { current?: AgentRuntime } = {}

    session.compact = async (): Promise<{ ok: true }> => {
      expect(runtimeRef.current?.isContextRecoveryInProgress()).toBe(true)
      session.contextUsage = {
        tokens: 220,
        contextWindow: 1000,
        percent: 22,
      }
      return { ok: true }
    }

    const runtime = new AgentRuntime({
      descriptor: makeDescriptor(),
      session: session as any,
      callbacks: {
        onStatusChange: (_agentId, _status, _pendingCount, contextUsage) => {
          if (contextUsage) {
            contextTokensByStatus.push(contextUsage.tokens)
          }
        },
      },
    })
    runtimeRef.current = runtime

    await runtime.compact('trim older turns')

    expect(contextTokensByStatus.at(-1)).toBe(220)
    expect(runtime.isContextRecoveryInProgress()).toBe(false)
  })

  it('continues manual compaction and clears in-progress flag when start status emit rejects', async () => {
    const session = new FakeSession()
    let compactCalled = false
    let statusEmitCalls = 0

    session.compact = async (): Promise<{ ok: true }> => {
      compactCalled = true
      return { ok: true }
    }

    const runtime = new AgentRuntime({
      descriptor: makeDescriptor(),
      session: session as any,
      callbacks: {
        onStatusChange: async () => {
          statusEmitCalls += 1
          if (statusEmitCalls === 1) {
            throw new Error('start status emit failed')
          }
        },
      },
    })

    await runtime.compact('trim older turns')

    expect(compactCalled).toBe(true)
    expect(runtime.isContextRecoveryInProgress()).toBe(false)
  })

  it('surfaces configured Forge compaction failures when Pi returns a cancelled manual compaction result', async () => {
    const session = new FakeSession()
    session.compact = async (): Promise<never> => {
      rememberForgePiCompactionFailure('worker', {
        kind: 'configured_auth_unavailable',
        message: 'Compaction auth unavailable in the active runtime registry for configured model on worker: provider unavailable',
        userFacingMessage: 'Configured compaction auth is unavailable in the active runtime. Check Authentication or choose a different compaction model.',
        cancelledByUser: false,
        details: {
          cancelKind: 'configured_auth_unavailable',
          compactionCancelled: true,
          compactionRetryPlanned: false,
          userFacingMessage: 'Configured compaction auth is unavailable in the active runtime. Check Authentication or choose a different compaction model.',
        },
      })
      throw new Error('Compaction cancelled')
    }

    const runtime = new AgentRuntime({
      descriptor: makeDescriptor(),
      session: session as any,
      callbacks: {
        onStatusChange: () => {},
      },
    })

    await expect(runtime.compact('trim older turns')).rejects.toMatchObject({
      name: 'ForgePiCompactionFailure',
      message: 'Compaction auth unavailable in the active runtime registry for configured model on worker: provider unavailable',
      details: expect.objectContaining({
        cancelKind: 'configured_auth_unavailable',
        userFacingMessage: 'Configured compaction auth is unavailable in the active runtime. Check Authentication or choose a different compaction model.',
      }),
    })
  })

  it('projects cancelled auto compaction separately from configured Forge compaction failures', async () => {
    const session = new FakeSession()
    const runtimeErrors: Array<Record<string, any>> = []
    const runtime = new AgentRuntime({
      descriptor: makeDescriptor(),
      session: session as any,
      callbacks: {
        onStatusChange: () => {},
        onRuntimeError: (_agentId, error) => {
          runtimeErrors.push(error as Record<string, any>)
        },
      },
    })

    await emitSessionEvent(runtime, session, { type: 'compaction_start', reason: 'threshold' })
    rememberForgePiCompactionFailure('worker', {
      kind: 'configured_model_unavailable',
      message: 'Configured compaction model is unavailable in the active runtime registry for worker',
      userFacingMessage: 'Configured compaction model is unavailable in the active runtime. Choose a different compaction model or authenticate that provider.',
      cancelledByUser: false,
      details: {
        cancelKind: 'configured_model_unavailable',
        compactionCancelled: true,
        compactionRetryPlanned: false,
        userFacingMessage: 'Configured compaction model is unavailable in the active runtime. Choose a different compaction model or authenticate that provider.',
      },
    })
    await emitSessionEvent(runtime, session, { type: 'compaction_end', reason: 'threshold', result: undefined, aborted: true, willRetry: false })
    await waitForCondition(() => runtimeErrors.length === 2)

    expect(runtimeErrors[0]).toMatchObject({
      phase: 'compaction',
      message: 'Automatic compaction started',
      details: expect.objectContaining({
        recoveryStage: 'auto_compaction_started',
        userFacingMessage: 'Context is getting full — compacting automatically.',
      }),
    })
    expect(runtimeErrors[1]).toMatchObject({
      phase: 'compaction',
      message: 'Configured compaction model is unavailable in the active runtime registry for worker',
      details: expect.objectContaining({
        cancelKind: 'configured_model_unavailable',
        compactionRetryPlanned: false,
        userFacingMessage: 'Configured compaction model is unavailable in the active runtime. Choose a different compaction model or authenticate that provider.',
      }),
    })

    runtimeErrors.length = 0
    await emitSessionEvent(runtime, session, { type: 'compaction_start', reason: 'threshold' })
    await emitSessionEvent(runtime, session, { type: 'compaction_end', reason: 'threshold', result: undefined, aborted: true, willRetry: false })
    await waitForCondition(() => runtimeErrors.length === 2)

    expect(runtimeErrors[0]).toMatchObject({
      phase: 'compaction',
      message: 'Automatic compaction started',
      details: expect.objectContaining({
        recoveryStage: 'auto_compaction_started',
        userFacingMessage: 'Context is getting full — compacting automatically.',
      }),
    })
    expect(runtimeErrors[1]).toMatchObject({
      phase: 'compaction',
      message: 'Automatic compaction was cancelled',
      details: expect.objectContaining({
        userCancelled: true,
        compactionRetryPlanned: false,
        userFacingMessage: 'Automatic compaction was cancelled.',
      }),
    })
  })

  it('uses timeout-specific automatic compaction copy when the runtime reports an auto-compaction timeout', async () => {
    const session = new FakeSession()
    const runtimeErrors: Array<Record<string, any>> = []
    session.compact = async (): Promise<never> => {
      throw new Error('retry compaction failed')
    }

    const runtime = new AgentRuntime({
      descriptor: makeDescriptor(),
      session: session as any,
      callbacks: {
        onStatusChange: () => {},
        onRuntimeError: (_agentId, error) => {
          runtimeErrors.push(error as Record<string, any>)
        },
      },
    })

    await emitSessionEvent(runtime, session, { type: 'compaction_start', reason: 'threshold' })
    await emitSessionEvent(runtime, session, {
      type: 'compaction_end',
      reason: 'threshold',
      result: undefined,
      aborted: false,
      willRetry: false,
      errorMessage: 'threshold compaction timed out after 300000ms',
    })

    await waitForCondition(() => runtimeErrors.some(
      (entry) => entry.details?.userFacingMessage === 'Automatic compaction timed out; context was not reduced.',
    ))

    expect(runtimeErrors).toContainEqual(
      expect.objectContaining({
        phase: 'compaction',
        message: 'threshold compaction timed out after 300000ms',
        details: expect.objectContaining({
          recoveryStage: 'auto_compaction_failed',
          userFacingMessage: 'Automatic compaction timed out; context was not reduced.',
        }),
      }),
    )
  })

  it('does not inherit stale Forge compaction failures from an earlier runtime scope', async () => {
    const session = new FakeSession()
    session.compact = async (): Promise<never> => {
      throw new Error('Compaction cancelled')
    }

    rememberForgePiCompactionFailure('worker::stale', {
      kind: 'configured_auth_unavailable',
      message: 'stale configured compaction auth failure',
      userFacingMessage: 'Configured compaction auth is unavailable in the active runtime.',
      cancelledByUser: false,
      details: {
        cancelKind: 'configured_auth_unavailable',
        compactionCancelled: true,
        compactionRetryPlanned: false,
      },
    })

    const runtime = new AgentRuntime({
      descriptor: makeDescriptor(),
      session: session as any,
      compactionFailureScopeKey: 'worker::fresh',
      callbacks: {
        onStatusChange: () => {},
      },
    })

    await expect(runtime.compact('trim older turns')).rejects.toMatchObject({
      name: 'Error',
      message: 'Compaction cancelled',
    })
  })

  it('clears stale Forge compaction failures at auto-compaction start before an unrelated abort result', async () => {
    const session = new FakeSession()
    const runtimeErrors: Array<Record<string, any>> = []
    const runtime = new AgentRuntime({
      descriptor: makeDescriptor(),
      session: session as any,
      compactionFailureScopeKey: 'worker::shared',
      callbacks: {
        onStatusChange: () => {},
        onRuntimeError: (_agentId, error) => {
          runtimeErrors.push(error as Record<string, any>)
        },
      },
    })

    rememberForgePiCompactionFailure('worker::shared', {
      kind: 'configured_model_unavailable',
      message: 'stale configured compaction model failure',
      userFacingMessage: 'Configured compaction model is unavailable in the active runtime.',
      cancelledByUser: false,
      details: {
        cancelKind: 'configured_model_unavailable',
        compactionCancelled: true,
        compactionRetryPlanned: false,
      },
    })

    await emitSessionEvent(runtime, session, { type: 'compaction_start', reason: 'threshold' })
    await emitSessionEvent(runtime, session, { type: 'compaction_end', reason: 'threshold', result: undefined, aborted: true, willRetry: false })
    await waitForCondition(() => runtimeErrors.length === 2)

    expect(runtimeErrors[0]).toMatchObject({
      phase: 'compaction',
      message: 'Automatic compaction started',
      details: expect.objectContaining({
        recoveryStage: 'auto_compaction_started',
        userFacingMessage: 'Context is getting full — compacting automatically.',
      }),
    })
    expect(runtimeErrors[1]).toMatchObject({
      phase: 'compaction',
      message: 'Automatic compaction was cancelled',
      details: expect.objectContaining({
        userCancelled: true,
        compactionRetryPlanned: false,
      }),
    })
  })

  it('terminates by aborting active session and marking status terminated', async () => {
    const session = new FakeSession()

    const runtime = new AgentRuntime({
      descriptor: makeDescriptor(),
      session: session as any,
      callbacks: {
        onStatusChange: () => {},
      },
    })

    await runtime.terminate({ abort: true })

    expect(session.abortCalls).toBe(1)
    expect(session.disposeCalls).toBe(1)
    expect(session.shutdownEvents).toEqual([{ type: 'session_shutdown', reason: 'quit' }])
    expect(runtime.getStatus()).toBe('terminated')
  })

  it('emits reload session shutdown metadata when recycling or replacing the runtime', async () => {
    const recycleSession = new FakeSession()
    const recycleRuntime = new AgentRuntime({
      descriptor: makeDescriptor(),
      session: recycleSession as any,
      callbacks: {
        onStatusChange: () => {},
      },
    })

    await recycleRuntime.recycle()

    expect(recycleSession.shutdownEvents).toEqual([{ type: 'session_shutdown', reason: 'reload' }])
    expect(recycleSession.disposeCalls).toBe(1)

    const replacementSession = new FakeSession()
    const replacementRuntime = new AgentRuntime({
      descriptor: makeDescriptor(),
      session: replacementSession as any,
      callbacks: {
        onStatusChange: () => {},
      },
    })

    await replacementRuntime.shutdownForReplacement()

    expect(replacementSession.shutdownEvents).toEqual([{ type: 'session_shutdown', reason: 'reload' }])
    expect(replacementSession.disposeCalls).toBe(1)
  })

  it('closes OpenAI Codex websocket cache on runtime dispose', async () => {
    const session = new FakeSession()
    const runtime = new AgentRuntime({
      descriptor: makeDescriptor(),
      session: session as any,
      callbacks: {
        onStatusChange: () => {},
      },
    })

    await runtime.terminate({ abort: false })

    expect(openAICodexResponsesMockState.closeOpenAICodexWebSocketSessions).toHaveBeenCalledWith('fake-session-id')
  })

  it('does not close OpenAI Codex websocket cache for no-op pooled auth reconcile', async () => {
    const session = new FakeSession()
    const authValues = new Map<string, any>([
      ['openai-codex', { type: 'oauth', access: 'token', accountId: 'acct_1' }],
    ])
    session.modelRegistry = {
      authStorage: {
        get: vi.fn((key: string) => authValues.get(key)),
        set: vi.fn((key: string, value: any) => authValues.set(key, value)),
      },
    }
    const runtime = new AgentRuntime({
      descriptor: makeDescriptor(),
      session: session as any,
      callbacks: {
        onStatusChange: () => {},
      },
    })

    runtime.pooledCredentialId = 'cred_primary'
    runtime.pooledCredentialProvider = 'openai-codex'
    runtime.credentialPoolService = {
      buildRuntimeAuthData: vi.fn(async () => ({
        'openai-codex': { type: 'oauth', access: 'token', accountId: 'acct_1' },
      })),
    } as any
    ;(runtime as any).lastActivityAtMs = Date.now() - 120_000

    await (runtime as any).reconcilePooledAuthBeforeDispatch()

    expect(session.modelRegistry.authStorage.set).toHaveBeenCalledWith('openai-codex', {
      type: 'oauth',
      access: 'token',
      accountId: 'acct_1',
    })
    expect(openAICodexResponsesMockState.closeOpenAICodexWebSocketSessions).not.toHaveBeenCalled()
  })

  it('closes OpenAI Codex websocket cache when pooled credential id or material changes', async () => {
    const session = new FakeSession()
    const authValues = new Map<string, any>([
      ['openai-codex', { type: 'oauth', access: 'token', accountId: 'acct_1' }],
    ])
    session.modelRegistry = {
      authStorage: {
        get: vi.fn((key: string) => authValues.get(key)),
        set: vi.fn((key: string, value: any) => authValues.set(key, value)),
      },
    }
    const runtime = new AgentRuntime({
      descriptor: makeDescriptor(),
      session: session as any,
      callbacks: {
        onStatusChange: () => {},
      },
    })

    runtime.pooledCredentialId = 'cred_primary'
    runtime.pooledCredentialProvider = 'openai-codex'

    await (runtime as any).applyPooledRuntimeAuth('openai-codex', 'cred_second', {
      'openai-codex': { type: 'oauth', access: 'token-2', accountId: 'acct_2' },
    })

    expect(openAICodexResponsesMockState.closeOpenAICodexWebSocketSessions).toHaveBeenCalledWith('fake-session-id')

    openAICodexResponsesMockState.closeOpenAICodexWebSocketSessions.mockClear()
    runtime.pooledCredentialId = 'cred_second'
    runtime.pooledCredentialProvider = 'openai-codex'
    runtime.credentialPoolService = {
      buildRuntimeAuthData: vi.fn(async () => ({
        'openai-codex': { type: 'oauth', access: 'token-3', accountId: 'acct_2' },
      })),
    } as any
    ;(runtime as any).lastActivityAtMs = Date.now() - 120_000

    await (runtime as any).reconcilePooledAuthBeforeDispatch()

    expect(openAICodexResponsesMockState.closeOpenAICodexWebSocketSessions).toHaveBeenCalledWith('fake-session-id')
  })

  it('does not close OpenAI Codex websocket cache for Anthropic pooled credential rotation', async () => {
    const session = new FakeSession()
    session.model = { provider: 'anthropic' }
    const descriptor = makeDescriptor()
    descriptor.model = { provider: 'anthropic', modelId: 'claude-opus-4.7', thinkingLevel: 'high' }
    const runtime = new AgentRuntime({
      descriptor,
      session: session as any,
      callbacks: {
        onStatusChange: () => {},
      },
    })

    runtime.pooledCredentialId = 'cred_primary'
    runtime.pooledCredentialProvider = 'anthropic'
    await (runtime as any).applyPooledRuntimeAuth('anthropic', 'cred_second', {
      anthropic: { type: 'oauth', access: 'token-2' },
    })

    expect(openAICodexResponsesMockState.closeOpenAICodexWebSocketSessions).not.toHaveBeenCalled()
  })

  it('forwards only explicitly supported Pi session events', async () => {
    const session = new FakeSession()
    const forwardedEvents: any[] = []
    const runtime = new AgentRuntime({
      descriptor: makeDescriptor(),
      session: session as any,
      callbacks: {
        onStatusChange: () => {},
        onSessionEvent: (_agentId, event) => {
          forwardedEvents.push(event)
        },
      },
    })

    await (runtime as any).handleEvent({ type: 'turn_start' })
    await (runtime as any).handleEvent({ type: 'queue_update', steering: [], followUp: [] })
    await (runtime as any).handleEvent({ type: 'session_info_changed', name: 'Renamed session' })
    await (runtime as any).handleEvent({ type: 'thinking_level_changed', level: 'high' })
    await (runtime as any).handleEvent({ type: 'future_pi_event', payload: true })

    expect(forwardedEvents).toEqual([{ type: 'turn_start' }])
  })

  it('bounds stopInFlight when session abort never resolves', async () => {
    const session = new FakeSession()
    const abortDeferred = createDeferred()
    session.abort = async () => {
      session.abortCalls += 1
      await abortDeferred.promise
    }

    const runtime = new AgentRuntime({
      descriptor: makeDescriptor(),
      session: session as any,
      callbacks: {
        onStatusChange: () => {},
      },
    })

    await expect(runtime.stopInFlight({ abort: true, shutdownTimeoutMs: 25 })).resolves.toBeUndefined()

    expect(session.abortCalls).toBe(1)
    expect(runtime.getStatus()).toBe('idle')
  })
})
