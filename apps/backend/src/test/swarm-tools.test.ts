import { describe, expect, it } from 'vitest'
import { buildSwarmTools, type SwarmToolHost } from '../swarm/swarm-tools.js'
import type { AgentDescriptor, SendMessageReceipt, SpawnAgentInput } from '../swarm/types.js'

function makeManagerDescriptor(agentId = 'manager', overrides: Partial<AgentDescriptor> = {}): AgentDescriptor {
  return {
    agentId,
    displayName: agentId,
    role: 'manager',
    managerId: agentId,
    archetypeId: 'manager',
    status: 'idle',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cwd: '/tmp/swarm',
    model: {
      provider: 'openai-codex',
      modelId: 'gpt-5.3-codex',
      thinkingLevel: 'xhigh',
    },
    sessionFile: `/tmp/swarm/${agentId}.jsonl`,
    ...overrides,
  }
}

function makeWorkerDescriptor(
  agentId: string,
  managerId = 'manager',
  overrides: Partial<AgentDescriptor> = {},
): AgentDescriptor {
  return {
    agentId,
    displayName: agentId,
    role: 'worker',
    managerId,
    status: 'idle',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cwd: '/tmp/swarm',
    model: {
      provider: 'anthropic',
      modelId: 'claude-opus-4-6',
      thinkingLevel: 'xhigh',
    },
    sessionFile: `/tmp/swarm/${agentId}.jsonl`,
    ...overrides,
  }
}

function makeHost(spawnImpl: (callerAgentId: string, input: SpawnAgentInput) => Promise<AgentDescriptor>): SwarmToolHost {
  return {
    listAgents(): AgentDescriptor[] {
      return [makeManagerDescriptor()]
    },
    getWorkerActivity() {
      return undefined
    },
    spawnAgent: spawnImpl,
    async killAgent(): Promise<void> {},
    async sendMessage(): Promise<SendMessageReceipt> {
      return {
        targetAgentId: 'worker',
        deliveryId: 'delivery-1',
        acceptedMode: 'prompt',
      }
    },
    async publishToUser(): Promise<{ targetContext: { channel: 'web' } }> {
      return {
        targetContext: { channel: 'web' },
      }
    },
    async requestUserChoice() {
      return []
    },
  }
}

function makeHostWithAgents(
  agents: AgentDescriptor[],
  getWorkerActivity: SwarmToolHost['getWorkerActivity'] = () => undefined,
): SwarmToolHost {
  return {
    listAgents(): AgentDescriptor[] {
      return agents
    },
    getWorkerActivity,
    spawnAgent: async () => makeWorkerDescriptor('worker'),
    async killAgent(): Promise<void> {},
    async sendMessage(): Promise<SendMessageReceipt> {
      return {
        targetAgentId: 'worker',
        deliveryId: 'delivery-1',
        acceptedMode: 'prompt',
      }
    },
    async publishToUser(): Promise<{ targetContext: { channel: 'web' } }> {
      return {
        targetContext: { channel: 'web' },
      }
    },
    async requestUserChoice() {
      return []
    },
  }
}

describe('buildSwarmTools', () => {
  it('list_agents returns bounded default output with summary and pagination hint', async () => {
    const workers = Array.from({ length: 30 }, (_, index) => ({
      ...makeWorkerDescriptor(`worker-${String(index + 1).padStart(2, '0')}`),
      updatedAt: `2026-01-${String((index % 9) + 1).padStart(2, '0')}T00:00:00.000Z`,
    }))

    const host = makeHostWithAgents([makeManagerDescriptor(), ...workers])
    const tools = buildSwarmTools(host, makeManagerDescriptor())
    const listTool = tools.find((tool) => tool.name === 'list_agents')
    expect(listTool).toBeDefined()

    const result = await listTool!.execute('tool-call', {}, undefined, undefined, undefined as any)
    const details = result.details as {
      summary: { totalVisible: number; managers: number; workers: number }
      page: { offset: number; limit: number; returned: number; hasMore: boolean; mode: string }
      agents: Array<Record<string, unknown>>
      hint: string
    }

    expect(details.summary).toMatchObject({
      totalVisible: 31,
      managers: 1,
      workers: 30,
    })
    expect(details.page).toMatchObject({
      offset: 0,
      limit: 20,
      returned: 20,
      hasMore: true,
      mode: 'default',
    })
    expect(details.agents[0]).toMatchObject({
      agentId: 'manager',
      role: 'manager',
    })
    expect(details.agents[1]).not.toHaveProperty('sessionFile')
    expect(details.agents[1]).toHaveProperty('cwd', 'swarm')
    expect(details.hint).toContain('offset":20')
  })

  it('list_agents handles zero workers and offset beyond total without throwing', async () => {
    const host = makeHostWithAgents([makeManagerDescriptor()])
    const tools = buildSwarmTools(host, makeManagerDescriptor())
    const listTool = tools.find((tool) => tool.name === 'list_agents')
    expect(listTool).toBeDefined()

    const emptyResult = await listTool!.execute('tool-call', {}, undefined, undefined, undefined as any)
    const emptyDetails = emptyResult.details as {
      summary: { totalVisible: number; workers: number }
      page: { offset: number; returned: number; hasMore: boolean }
      agents: Array<{ agentId: string }>
    }

    expect(emptyDetails.summary).toMatchObject({
      totalVisible: 1,
      workers: 0,
    })
    expect(emptyDetails.page).toMatchObject({
      offset: 0,
      returned: 0,
      hasMore: false,
    })
    expect(emptyDetails.agents.map((agent) => agent.agentId)).toEqual(['manager'])

    const offsetResult = await listTool!.execute(
      'tool-call',
      {
        offset: 50,
        limit: 10,
      },
      undefined,
      undefined,
      undefined as any,
    )
    const offsetDetails = offsetResult.details as {
      page: { offset: number; limit: number; returned: number; hasMore: boolean }
      agents: Array<{ agentId: string }>
    }

    expect(offsetDetails.page).toMatchObject({
      offset: 50,
      limit: 10,
      returned: 0,
      hasMore: false,
    })
    expect(offsetDetails.agents.map((agent) => agent.agentId)).toEqual(['manager'])
  })

  it('list_agents returns one worker correctly when only one exists', async () => {
    const host = makeHostWithAgents([makeManagerDescriptor(), makeWorkerDescriptor('solo-worker')])
    const tools = buildSwarmTools(host, makeManagerDescriptor())
    const listTool = tools.find((tool) => tool.name === 'list_agents')
    expect(listTool).toBeDefined()

    const result = await listTool!.execute('tool-call', {}, undefined, undefined, undefined as any)
    const details = result.details as {
      summary: { totalVisible: number; workers: number }
      page: { returned: number; hasMore: boolean }
      agents: Array<{ agentId: string }>
    }

    expect(details.summary).toMatchObject({
      totalVisible: 2,
      workers: 1,
    })
    expect(details.page).toMatchObject({
      returned: 1,
      hasMore: false,
    })
    expect(details.agents.map((agent) => agent.agentId)).toEqual(['manager', 'solo-worker'])
  })

  it('list_agents treats exactly-at-limit worker counts as a full final page', async () => {
    const workers = Array.from({ length: 20 }, (_, index) => ({
      ...makeWorkerDescriptor(`worker-${String(index + 1).padStart(2, '0')}`),
      updatedAt: `2026-01-${String((index % 9) + 1).padStart(2, '0')}T00:00:00.000Z`,
    }))

    const host = makeHostWithAgents([makeManagerDescriptor(), ...workers])
    const tools = buildSwarmTools(host, makeManagerDescriptor())
    const listTool = tools.find((tool) => tool.name === 'list_agents')
    expect(listTool).toBeDefined()

    const result = await listTool!.execute('tool-call', {}, undefined, undefined, undefined as any)
    const details = result.details as {
      page: { limit: number; returned: number; hasMore: boolean }
      hint: string
    }

    expect(details.page).toMatchObject({
      limit: 20,
      returned: 20,
      hasMore: false,
    })
    expect(details.hint).toContain('list_agents({"verbose":true,"limit":50,"offset":0})')
  })

  it('list_agents sorts active workers first, then most recent idle workers', async () => {
    const streamingWorker = {
      ...makeWorkerDescriptor('worker-streaming'),
      status: 'streaming' as const,
      updatedAt: '2026-01-02T00:00:00.000Z',
    }
    const errorWorker = {
      ...makeWorkerDescriptor('worker-error'),
      status: 'error' as const,
      updatedAt: '2026-01-03T00:00:00.000Z',
    }
    const newerIdleWorker = {
      ...makeWorkerDescriptor('worker-idle-new'),
      status: 'idle' as const,
      updatedAt: '2026-01-05T00:00:00.000Z',
    }
    const olderIdleWorker = {
      ...makeWorkerDescriptor('worker-idle-old'),
      status: 'idle' as const,
      updatedAt: '2026-01-01T00:00:00.000Z',
    }

    const host = makeHostWithAgents([
      makeManagerDescriptor(),
      olderIdleWorker,
      newerIdleWorker,
      errorWorker,
      streamingWorker,
    ])
    const tools = buildSwarmTools(host, makeManagerDescriptor())
    const listTool = tools.find((tool) => tool.name === 'list_agents')
    expect(listTool).toBeDefined()

    const result = await listTool!.execute(
      'tool-call',
      { limit: 10 },
      undefined,
      undefined,
      undefined as any,
    )
    const details = result.details as { agents: Array<{ agentId: string }> }

    expect(details.agents.map((agent) => agent.agentId)).toEqual([
      'manager',
      'worker-streaming',
      'worker-error',
      'worker-idle-new',
      'worker-idle-old',
    ])
  })

  it('list_agents verbose pagination returns full descriptors for only the requested page', async () => {
    const workers = [
      {
        ...makeWorkerDescriptor('worker-a'),
        updatedAt: '2026-01-05T00:00:00.000Z',
      },
      {
        ...makeWorkerDescriptor('worker-b'),
        updatedAt: '2026-01-04T00:00:00.000Z',
      },
      {
        ...makeWorkerDescriptor('worker-c'),
        updatedAt: '2026-01-03T00:00:00.000Z',
      },
      {
        ...makeWorkerDescriptor('worker-d'),
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
    ]

    const host = makeHostWithAgents([makeManagerDescriptor(), ...workers])
    const tools = buildSwarmTools(host, makeManagerDescriptor())
    const listTool = tools.find((tool) => tool.name === 'list_agents')
    expect(listTool).toBeDefined()

    const result = await listTool!.execute(
      'tool-call',
      {
        verbose: true,
        limit: 2,
        offset: 1,
      },
      undefined,
      undefined,
      undefined as any,
    )
    const details = result.details as {
      page: { returned: number; mode: string; hasMore: boolean }
      agents: Array<{ agentId: string; sessionFile?: string }>
    }

    expect(details.page).toMatchObject({
      returned: 2,
      mode: 'verbose',
      hasMore: true,
    })
    expect(details.agents[0].agentId).toBe('manager')
    expect(details.agents[0].sessionFile).toBe('/tmp/swarm/manager.jsonl')
    expect(details.agents.slice(1).map((agent) => agent.agentId)).toEqual(['worker-b', 'worker-c'])
  })

  it('list_agents clamps oversized limits to 100 entries per page', async () => {
    const workers = Array.from({ length: 140 }, (_, index) => makeWorkerDescriptor(`worker-${index + 1}`))

    const host = makeHostWithAgents([makeManagerDescriptor(), ...workers])
    const tools = buildSwarmTools(host, makeManagerDescriptor())
    const listTool = tools.find((tool) => tool.name === 'list_agents')
    expect(listTool).toBeDefined()

    const result = await listTool!.execute(
      'tool-call',
      {
        limit: 999,
      } as any,
      undefined,
      undefined,
      undefined as any,
    )
    const details = result.details as {
      page: { limit: number; returned: number; hasMore: boolean }
    }

    expect(details.page).toMatchObject({
      limit: 100,
      returned: 100,
      hasMore: true,
    })
  })

  it('list_agents does not show other managers by default', async () => {
    const host = makeHostWithAgents([
      makeManagerDescriptor(),
      makeWorkerDescriptor('worker-owned'),
      makeManagerDescriptor('manager-two', {
        profileId: 'alpha',
        sessionLabel: 'Session 2',
      }),
      makeWorkerDescriptor('worker-external', 'manager-two'),
    ])
    const tools = buildSwarmTools(host, makeManagerDescriptor())
    const listTool = tools.find((tool) => tool.name === 'list_agents')
    expect(listTool).toBeDefined()

    const result = await listTool!.execute('tool-call', {}, undefined, undefined, undefined as any)
    const details = result.details as {
      summary: { totalVisible: number; managers: number; workers: number }
      agents: Array<{ agentId: string; isExternal?: boolean }>
    }

    expect(details.summary).toMatchObject({
      totalVisible: 2,
      managers: 1,
      workers: 1,
    })
    expect(details.agents.map((agent) => agent.agentId)).toEqual(['manager', 'worker-owned'])
    expect(details.agents.some((agent) => agent.isExternal === true)).toBe(false)
  })

  it('list_agents shows external managers for manager callers when includeManagers is true', async () => {
    const host = makeHostWithAgents([
      makeManagerDescriptor(),
      makeWorkerDescriptor('worker-owned', 'manager', {
        status: 'streaming',
        updatedAt: '2026-01-03T00:00:00.000Z',
      }),
      makeManagerDescriptor('manager-two', {
        updatedAt: '2026-01-02T00:00:00.000Z',
        profileId: 'alpha',
        sessionLabel: 'Planning',
      }),
      makeWorkerDescriptor('worker-external', 'manager-two'),
      makeManagerDescriptor('manager-three', {
        updatedAt: '2026-01-01T00:00:00.000Z',
        profileId: 'beta',
        sessionLabel: 'Review',
      }),
    ])
    const tools = buildSwarmTools(host, makeManagerDescriptor())
    const listTool = tools.find((tool) => tool.name === 'list_agents')
    expect(listTool).toBeDefined()

    const result = await listTool!.execute(
      'tool-call',
      {
        includeManagers: true,
      },
      undefined,
      undefined,
      undefined as any,
    )
    const details = result.details as {
      summary: { totalVisible: number; managers: number; workers: number }
      page: { returned: number; hasMore: boolean }
      agents: Array<{
        agentId: string
        isExternal?: boolean
        profileId?: string
        sessionLabel?: string
      }>
    }

    expect(details.summary).toMatchObject({
      totalVisible: 4,
      managers: 3,
      workers: 1,
    })
    expect(details.page).toMatchObject({
      returned: 3,
      hasMore: false,
    })
    expect(details.agents.map((agent) => agent.agentId)).toEqual([
      'manager',
      'worker-owned',
      'manager-two',
      'manager-three',
    ])
    expect(details.agents[2]).toMatchObject({
      agentId: 'manager-two',
      isExternal: true,
      profileId: 'alpha',
      sessionLabel: 'Planning',
    })
    expect(details.agents[3]).toMatchObject({
      agentId: 'manager-three',
      isExternal: true,
      profileId: 'beta',
      sessionLabel: 'Review',
    })
    expect(details.agents.some((agent) => agent.agentId === 'worker-external')).toBe(false)
  })

  it('list_agents ignores includeManagers for worker callers', async () => {
    const workerCaller = makeWorkerDescriptor('worker-owned')
    const host = makeHostWithAgents([
      makeManagerDescriptor(),
      workerCaller,
      makeManagerDescriptor('manager-two', {
        profileId: 'alpha',
        sessionLabel: 'Planning',
      }),
      makeWorkerDescriptor('worker-external', 'manager-two'),
    ])
    const tools = buildSwarmTools(host, workerCaller)
    const listTool = tools.find((tool) => tool.name === 'list_agents')
    expect(listTool).toBeDefined()

    const result = await listTool!.execute(
      'tool-call',
      {
        includeManagers: true,
      },
      undefined,
      undefined,
      undefined as any,
    )
    const details = result.details as {
      summary: { totalVisible: number; managers: number; workers: number }
      agents: Array<{ agentId: string; isExternal?: boolean }>
    }

    expect(details.summary).toMatchObject({
      totalVisible: 2,
      managers: 1,
      workers: 1,
    })
    expect(details.agents.map((agent) => agent.agentId)).toEqual(['manager', 'worker-owned'])
    expect(details.agents.some((agent) => agent.isExternal === true)).toBe(false)
  })

  it('list_agents verbose output includes external manager metadata', async () => {
    const host = makeHostWithAgents([
      makeManagerDescriptor(),
      makeManagerDescriptor('manager-two', {
        profileId: 'alpha',
        sessionLabel: 'Planning',
      }),
      makeWorkerDescriptor('worker-owned'),
    ])
    const tools = buildSwarmTools(host, makeManagerDescriptor())
    const listTool = tools.find((tool) => tool.name === 'list_agents')
    expect(listTool).toBeDefined()

    const result = await listTool!.execute(
      'tool-call',
      {
        verbose: true,
        includeManagers: true,
      },
      undefined,
      undefined,
      undefined as any,
    )
    const details = result.details as {
      agents: Array<{
        agentId: string
        isExternal?: boolean
        profileId?: string
        sessionLabel?: string
      }>
    }

    expect(details.agents[2]).toMatchObject({
      agentId: 'manager-two',
      isExternal: true,
      profileId: 'alpha',
      sessionLabel: 'Planning',
    })
  })

  it('list_agents includes worker activity when host reports active worker state', async () => {
    const worker = makeWorkerDescriptor('worker-active', 'manager', {
      status: 'streaming',
      updatedAt: '2026-01-03T00:00:00.000Z',
    })
    const activity = {
      currentTool: 'bash',
      currentToolElapsedSec: 12,
      toolCalls: 5,
      errors: 1,
      turns: 3,
      idleSec: 0,
    }

    const host = makeHostWithAgents([
      makeManagerDescriptor(),
      worker,
    ], (agentId) => (agentId === worker.agentId ? activity : undefined))

    const tools = buildSwarmTools(host, makeManagerDescriptor())
    const listTool = tools.find((tool) => tool.name === 'list_agents')
    expect(listTool).toBeDefined()

    const result = await listTool!.execute('tool-call', {}, undefined, undefined, undefined as any)
    const details = result.details as {
      agents: Array<{
        agentId: string
        activity?: typeof activity
      }>
    }
    const workerEntry = details.agents.find((agent) => agent.agentId === worker.agentId)

    expect(workerEntry).toBeDefined()
    expect(workerEntry?.activity).toEqual(activity)
  })

  it('list_agents omits worker activity when no activity state exists', async () => {
    const worker = makeWorkerDescriptor('worker-idle')
    const host = makeHostWithAgents([
      makeManagerDescriptor(),
      worker,
    ])

    const tools = buildSwarmTools(host, makeManagerDescriptor())
    const listTool = tools.find((tool) => tool.name === 'list_agents')
    expect(listTool).toBeDefined()

    const result = await listTool!.execute('tool-call', {}, undefined, undefined, undefined as any)
    const details = result.details as {
      agents: Array<{
        agentId: string
        activity?: unknown
      }>
    }
    const workerEntry = details.agents.find((agent) => agent.agentId === worker.agentId)

    expect(workerEntry).toBeDefined()
    expect(workerEntry).not.toHaveProperty('activity')
  })

  it('list_agents activity payload includes the expected field shape', async () => {
    const worker = makeWorkerDescriptor('worker-shape', 'manager', {
      status: 'streaming',
      updatedAt: '2026-01-03T00:00:00.000Z',
    })
    const activity = {
      currentTool: 'read',
      currentToolElapsedSec: 4,
      toolCalls: 2,
      errors: 0,
      turns: 1,
      idleSec: 0,
    }

    const host = makeHostWithAgents([
      makeManagerDescriptor(),
      worker,
    ], (agentId) => (agentId === worker.agentId ? activity : undefined))

    const tools = buildSwarmTools(host, makeManagerDescriptor())
    const listTool = tools.find((tool) => tool.name === 'list_agents')
    expect(listTool).toBeDefined()

    const result = await listTool!.execute(
      'tool-call',
      {
        verbose: true,
      },
      undefined,
      undefined,
      undefined as any,
    )

    const details = result.details as {
      agents: Array<{
        agentId: string
        activity?: typeof activity
      }>
    }
    const workerEntry = details.agents.find((agent) => agent.agentId === worker.agentId)

    expect(workerEntry?.activity).toBeDefined()
    expect(workerEntry?.activity).toHaveProperty('currentTool', 'read')
    expect(workerEntry?.activity).toHaveProperty('currentToolElapsedSec', 4)
    expect(workerEntry?.activity).toHaveProperty('toolCalls', 2)
    expect(workerEntry?.activity).toHaveProperty('errors', 0)
    expect(workerEntry?.activity).toHaveProperty('turns', 1)
    expect(workerEntry?.activity).toHaveProperty('idleSec', 0)
  })

  it('propagates spawn_agent model preset to host.spawnAgent', async () => {
    let receivedInput: SpawnAgentInput | undefined

    const host = makeHost(async (_callerAgentId, input) => {
      receivedInput = input
      return {
        ...makeWorkerDescriptor('worker-gpt54'),
        model: {
          provider: 'openai-codex',
          modelId: 'gpt-5.4',
          thinkingLevel: 'xhigh',
        },
      }
    })

    const tools = buildSwarmTools(host, makeManagerDescriptor())
    const spawnTool = tools.find((tool) => tool.name === 'spawn_agent')
    expect(spawnTool).toBeDefined()

    const result = await spawnTool!.execute(
      'tool-call',
      {
        agentId: 'Worker GPT 5.4',
        model: 'pi-5.4',
      },
      undefined,
      undefined,
      undefined as any,
    )

    expect(receivedInput?.model).toBe('pi-5.4')
    expect(result.details).toMatchObject({
      agentId: 'worker-gpt54',
      model: {
        provider: 'openai-codex',
        modelId: 'gpt-5.4',
        thinkingLevel: 'xhigh',
      },
    })
  })

  it('propagates spawn_agent modelId and reasoningLevel overrides to host.spawnAgent', async () => {
    let receivedInput: SpawnAgentInput | undefined

    const host = makeHost(async (_callerAgentId, input) => {
      receivedInput = input
      return makeWorkerDescriptor('worker-opus')
    })

    const tools = buildSwarmTools(host, makeManagerDescriptor())
    const spawnTool = tools.find((tool) => tool.name === 'spawn_agent')
    expect(spawnTool).toBeDefined()

    await spawnTool!.execute(
      'tool-call',
      {
        agentId: 'Worker Opus Override',
        model: 'pi-opus',
        modelId: 'claude-haiku-4-5-20251001',
        reasoningLevel: 'low',
      },
      undefined,
      undefined,
      undefined as any,
    )

    expect(receivedInput?.model).toBe('pi-opus')
    expect(receivedInput?.modelId).toBe('claude-haiku-4-5-20251001')
    expect(receivedInput?.reasoningLevel).toBe('low')
  })

  it('rejects invalid spawn_agent model presets with a clear error', async () => {
    const host = makeHost(async () => makeWorkerDescriptor('worker'))

    const tools = buildSwarmTools(host, makeManagerDescriptor())
    const spawnTool = tools.find((tool) => tool.name === 'spawn_agent')
    expect(spawnTool).toBeDefined()

    await expect(
      spawnTool!.execute(
        'tool-call',
        {
          agentId: 'Worker Invalid',
          model: 'not-allowed-model',
        } as any,
        undefined,
        undefined,
        undefined as any,
      ),
    ).rejects.toThrow('spawn_agent.model must be one of pi-codex|pi-5.4|pi-opus|codex-app')
  })

  it('rejects invalid spawn_agent reasoning levels with a clear error', async () => {
    const host = makeHost(async () => makeWorkerDescriptor('worker'))

    const tools = buildSwarmTools(host, makeManagerDescriptor())
    const spawnTool = tools.find((tool) => tool.name === 'spawn_agent')
    expect(spawnTool).toBeDefined()

    await expect(
      spawnTool!.execute(
        'tool-call',
        {
          agentId: 'Worker Invalid Reasoning',
          reasoningLevel: 'ultra',
        } as any,
        undefined,
        undefined,
        undefined as any,
      ),
    ).rejects.toThrow('spawn_agent.reasoningLevel must be one of none|low|medium|high|xhigh')
  })

  it('forwards speak_to_user target metadata and returns resolved target context', async () => {
    let receivedTarget: { channel: 'web' | 'telegram'; channelId?: string; userId?: string; threadTs?: string } | undefined

    const host: SwarmToolHost = {
      listAgents: () => [makeManagerDescriptor()],
      getWorkerActivity: () => undefined,
      spawnAgent: async () => makeWorkerDescriptor('worker'),
      killAgent: async () => {},
      sendMessage: async () => ({
        targetAgentId: 'worker',
        deliveryId: 'delivery-1',
        acceptedMode: 'prompt',
      }),
      publishToUser: async (_agentId, _text, _source, targetContext) => {
        receivedTarget = targetContext
        return {
          targetContext: {
            channel: targetContext?.channel ?? 'web',
            channelId: targetContext?.channelId,
            userId: targetContext?.userId,
            threadTs: targetContext?.threadTs,
          },
        }
      },
      requestUserChoice: async () => [],
    }

    const tools = buildSwarmTools(host, makeManagerDescriptor())
    const speakTool = tools.find((tool) => tool.name === 'speak_to_user')
    expect(speakTool).toBeDefined()

    const result = await speakTool!.execute(
      'tool-call',
      {
        text: 'Reply in Telegram thread',
        target: {
          channel: 'telegram',
          channelId: '12345',
          threadTs: '173.456',
        },
      },
      undefined,
      undefined,
      undefined as any,
    )

    expect(receivedTarget).toEqual({
      channel: 'telegram',
      channelId: '12345',
      threadTs: '173.456',
    })
    expect(result.details).toMatchObject({
      published: true,
      targetContext: {
        channel: 'telegram',
        channelId: '12345',
        threadTs: '173.456',
      },
    })
  })


})
