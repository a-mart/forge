import { describe, expect, it, vi } from 'vitest'
import { AgentRuntime } from '../swarm/agent-runtime.js'
import type { AgentDescriptor } from '../swarm/types.js'

class FakeSession {
  isStreaming = false
  promptCalls: string[] = []
  promptImageCounts: number[] = []
  followUpCalls: string[] = []
  steerCalls: string[] = []
  steerImageCounts: number[] = []
  userMessageCalls: Array<string | Array<{ type: string }>> = []
  abortCalls = 0
  disposeCalls = 0
  listener: ((event: any) => void) | undefined
  contextUsageCalls = 0
  contextUsage: { tokens: number | null; contextWindow: number; percent: number | null } | undefined

  async prompt(message: string, options?: { images?: Array<{ type: string }> }): Promise<void> {
    this.promptCalls.push(message)
    this.promptImageCounts.push(options?.images?.length ?? 0)
  }

  async followUp(message: string): Promise<void> {
    this.followUpCalls.push(message)
  }

  async steer(message: string, images?: Array<{ type: string }>): Promise<void> {
    this.steerCalls.push(message)
    this.steerImageCounts.push(images?.length ?? 0)
  }

  async sendUserMessage(content: string | Array<{ type: string }>): Promise<void> {
    this.userMessageCalls.push(content)
  }

  async abort(): Promise<void> {
    this.abortCalls += 1
  }

  async compact(): Promise<{ ok: true }> {
    return { ok: true }
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
      modelId: 'gpt-5.3-codex',
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

    session.emit({
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
      session.emit({ type: 'agent_start' })
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
      session.emit({
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
      session.emit({
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
      session.emit({
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
      session.emit({
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
      session.emit({
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
      session.emit({ type: 'agent_start' })
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

    session.compact = async (): Promise<{ ok: true }> => {
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

    await runtime.compact('trim older turns')

    expect(contextTokensByStatus.at(-1)).toBe(220)
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
    expect(runtime.getStatus()).toBe('terminated')
  })
})
