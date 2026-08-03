import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getAvailablePort } from '../../../../test-support/index.js'
import {
  WsServerTestSwarmManager as TestSwarmManager,
  bootWsServerTestManager as bootWithDefaultManager,
  makeWsServerTempConfig as makeTempConfig,
} from '../../../../test-support/ws-integration-harness.js'
import { readSessionMeta } from '../../../../swarm/session-manifest.js'
import { SwarmWebSocketServer } from '../../../server.js'

async function createRepoProjectAgentDefinition(rootDir: string, options: {
  definitionId: string
  handle?: string
  whenToUse?: string
  prompt?: string
  references?: Record<string, string>
}): Promise<void> {
  const definitionDir = join(rootDir, '.forge', 'project-agents', options.definitionId)
  await mkdir(join(definitionDir, 'reference'), { recursive: true })
  await writeFile(
    join(definitionDir, 'config.json'),
    JSON.stringify({
      version: 1,
      handle: options.handle ?? options.definitionId,
      whenToUse: options.whenToUse ?? 'Use for repository docs.',
    }),
    'utf8',
  )
  await writeFile(join(definitionDir, 'prompt.md'), options.prompt ?? 'Repo prompt body', 'utf8')
  for (const [fileName, content] of Object.entries(options.references ?? {})) {
    await writeFile(join(definitionDir, 'reference', fileName), content, 'utf8')
  }
}

describe('SwarmWebSocketServer', () => {
  it('compacts manager context through POST /api/agents/:agentId/compact', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    try {
      const response = await fetch(`http://${config.host}:${config.port}/api/agents/manager/compact`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          customInstructions: 'Preserve unresolved TODOs in the summary.',
        }),
      })

      expect(response.status).toBe(200)
      const payload = (await response.json()) as {
        ok: boolean
        agentId: string
        result: { status: string; customInstructions: string | null }
      }

      expect(payload.ok).toBe(true)
      expect(payload.agentId).toBe('manager')
      expect(payload.result).toEqual({
        status: 'ok',
        customInstructions: 'Preserve unresolved TODOs in the summary.',
      })

      const runtime = manager.runtimeByAgentId.get('manager')
      expect(runtime?.compactCalls).toEqual(['Preserve unresolved TODOs in the summary.'])

      const history = manager.getConversationHistory('manager')
      expect(
        history.some(
          (event) =>
            event.type === 'conversation_message' &&
            event.source === 'system' &&
            event.text === 'Compacting manager context...',
        ),
      ).toBe(true)
      expect(
        history.some(
          (event) =>
            event.type === 'conversation_message' &&
            event.source === 'system' &&
            event.text === 'Compaction complete.',
        ),
      ).toBe(true)
    } finally {
      await server.stop()
    }
  })

  it('maps manual compaction operational blockers to 409 through POST /api/agents/:agentId/compact', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    const runtime = manager.runtimeByAgentId.get('manager')
    expect(runtime).toBeDefined()

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    try {
      const cases = [
        'Claude runtime for agent manager is already compacting.',
        'Context recovery is already in progress',
        'Claude runtime compaction requires agent manager to be idle.',
        'agent busy',
      ]

      for (const message of cases) {
        runtime!.compactImpl = async () => {
          throw new Error(message)
        }
        const response = await fetch(`http://${config.host}:${config.port}/api/agents/manager/compact`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify({ customInstructions: 'Preserve blockers.' }),
        })
        expect(response.status, message).toBe(409)
        await expect(response.json()).resolves.toEqual({ error: message })
      }
    } finally {
      await server.stop()
    }
  })

  it('returns smart compaction result parity through POST /api/agents/:agentId/smart-compact', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    const runtime = manager.runtimeByAgentId.get('manager')
    expect(runtime).toBeDefined()
    runtime!.smartCompactResult = { compacted: false, reason: 'claude_runtime_below_compaction_threshold' }

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    try {
      const response = await fetch(`http://${config.host}:${config.port}/api/agents/manager/smart-compact`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          customInstructions: 'Preserve unresolved TODOs in the summary.',
        }),
      })

      expect(response.status).toBe(200)
      const payload = (await response.json()) as {
        ok: boolean
        agentId: string
        result: { compacted: false; reason: string }
      }

      expect(payload).toEqual({
        ok: true,
        agentId: 'manager',
        result: { compacted: false, reason: 'claude_runtime_below_compaction_threshold' },
      })
      expect(runtime!.smartCompactCalls).toEqual(['Preserve unresolved TODOs in the summary.'])
    } finally {
      await server.stop()
    }
  })

  it('returns persisted manager system prompts through GET /api/agents/:agentId/system-prompt', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    const managerDescriptor = await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    try {
      const response = await fetch(
        `http://${config.host}:${config.port}/api/agents/${encodeURIComponent(managerDescriptor.agentId)}/system-prompt`,
      )

      expect(response.status).toBe(200)
      const payload = (await response.json()) as {
        agentId: string
        role: 'manager'
        systemPrompt: string | null
        model: string | null
        archetypeId: string | null
      }

      const meta = await readSessionMeta(config.paths.dataDir, 'manager', managerDescriptor.agentId)
      expect(meta?.resolvedSystemPrompt).toEqual(expect.any(String))
      expect(payload).toEqual({
        agentId: managerDescriptor.agentId,
        role: 'manager',
        systemPrompt: meta?.resolvedSystemPrompt ?? null,
        model: `${managerDescriptor.model.provider}/${managerDescriptor.model.modelId}`,
        archetypeId: managerDescriptor.archetypeId ?? null,
        initialModelInput: {
          status: 'pending',
          message: 'Available after the first model request.',
        },
      })
      expect(payload.systemPrompt).toContain('You are the manager agent in a multi-agent swarm.')
    } finally {
      await server.stop()
    }
  })

  it('returns the persisted initial Pi model input after capture', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)
    const manager = new TestSwarmManager(config)
    const managerDescriptor = await bootWithDefaultManager(manager, config)
    const capture = {
      version: 1,
      runtime: 'pi',
      capturedAt: '2026-01-01T00:00:00.000Z',
      fidelity: {
        capturePoint: 'pi_stream_fn',
        context: 'exact_provider_independent',
        images: 'byte_summary',
        requestMetadata: 'safe_projection',
      },
      systemPrompt: 'Final first-request prompt',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      tools: [{ name: 'read', parameters: { type: 'object' } }],
      model: { provider: 'openai-codex', id: 'gpt-5.4', api: 'openai-codex-responses' },
      requestMetadata: { reasoning: 'high' },
    }
    const persistedSession = await readFile(managerDescriptor.sessionFile, 'utf8')
    const captureEntry = {
      type: 'custom',
      id: 'initial-model-input-entry',
      parentId: null,
      timestamp: '2026-01-01T00:00:00.000Z',
      customType: 'swarm_pi_initial_model_input',
      data: capture,
    }
    const assistantEntry = {
      type: 'message',
      id: 'initial-model-response-entry',
      parentId: 'initial-model-input-entry',
      timestamp: '2026-01-01T00:00:01.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'hello back' }],
        provider: 'openai-codex',
        model: 'gpt-5.4',
        usage: {
          input: 12,
          output: 3,
          cacheRead: 5,
          cacheWrite: 2,
          totalTokens: 22,
        },
        stopReason: 'stop',
        timestamp: 1_767_225_601_000,
      },
    }
    await writeFile(
      managerDescriptor.sessionFile,
      `${persistedSession.trimEnd()}\n${JSON.stringify(captureEntry)}\n${JSON.stringify(assistantEntry)}\n`,
      'utf8',
    )
    // Reopen from the persisted JSONL rather than relying on the live runtime.
    ;(manager as unknown as { services: { runtime: { runtimes: Map<string, unknown> } } })
      .services.runtime.runtimes.delete(managerDescriptor.agentId)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })
    await server.start()

    try {
      const response = await fetch(
        `http://${config.host}:${config.port}/api/agents/${encodeURIComponent(managerDescriptor.agentId)}/system-prompt`,
      )

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({
        agentId: managerDescriptor.agentId,
        initialModelInput: {
          status: 'available',
          capture: {
            version: 1,
            runtime: 'pi',
            systemPrompt: 'Final first-request prompt',
            messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
            tools: [{ name: 'read', parameters: { type: 'object' } }],
            requestMetadata: { reasoning: 'high' },
          },
          tokenUsage: {
            source: 'provider_reported',
            inputTokens: 19,
            uncachedInputTokens: 12,
            cacheReadInputTokens: 5,
            cacheWriteInputTokens: 2,
          },
        },
      })
    } finally {
      await server.stop()
    }
  })

  it('returns initial model input as unsupported for Cursor SDK runtimes', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)
    const manager = new TestSwarmManager(config)
    const managerDescriptor = await bootWithDefaultManager(manager, config)
    Object.assign(manager.runtimeByAgentId.get(managerDescriptor.agentId)!, { runtimeType: 'cursor-sdk' })

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })
    await server.start()

    try {
      const response = await fetch(
        `http://${config.host}:${config.port}/api/agents/${encodeURIComponent(managerDescriptor.agentId)}/system-prompt`,
      )

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({
        initialModelInput: {
          status: 'unsupported',
          message: 'Initial model-input capture is currently available for Pi runtimes only.',
        },
      })
    } finally {
      await server.stop()
    }
  })

  it('returns initial model input as unsupported for inactive noncanonical Cursor SDK descriptors', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)
    const manager = new TestSwarmManager(config)
    const managerDescriptor = await bootWithDefaultManager(manager, config)
    const managerState = manager as unknown as {
      descriptors: Map<string, { model: { provider: string }; status: string }>
      services: { runtime: { runtimes: Map<string, unknown> } }
    }
    const inactiveDescriptor = managerState.descriptors.get(managerDescriptor.agentId)
    expect(inactiveDescriptor).toBeDefined()
    inactiveDescriptor!.model.provider = ' Cursor-SDK '
    inactiveDescriptor!.status = 'stopped'
    managerState.services.runtime.runtimes.delete(managerDescriptor.agentId)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })
    await server.start()

    try {
      const response = await fetch(
        `http://${config.host}:${config.port}/api/agents/${encodeURIComponent(managerDescriptor.agentId)}/system-prompt`,
      )

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({
        initialModelInput: {
          status: 'unsupported',
          message: 'Initial model-input capture is currently available for Pi runtimes only.',
        },
      })
    } finally {
      await server.stop()
    }
  })

  it('returns persisted local manager prompt after override changes before runtime recycle', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    const managerDescriptor = await bootWithDefaultManager(manager, config)
    const metaBeforeChange = await readSessionMeta(config.paths.dataDir, 'manager', managerDescriptor.agentId)
    expect(metaBeforeChange?.resolvedSystemPrompt).toEqual(expect.any(String))

    const liveState = manager as unknown as {
      descriptors: Map<string, { sessionSystemPrompt?: string }>
    }
    liveState.descriptors.get(managerDescriptor.agentId)!.sessionSystemPrompt = 'New override that should wait for recycle.'

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    try {
      const response = await fetch(
        `http://${config.host}:${config.port}/api/agents/${encodeURIComponent(managerDescriptor.agentId)}/system-prompt`,
      )

      expect(response.status).toBe(200)
      const payload = (await response.json()) as { systemPrompt: string | null }
      expect(payload.systemPrompt).toBe(metaBeforeChange?.resolvedSystemPrompt)
      expect(payload.systemPrompt).not.toContain('New override that should wait for recycle.')
    } finally {
      await server.stop()
    }
  })

  it('refreshes repo project-agent prompts on idle source drift through GET /api/agents/:agentId/system-prompt', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)
    execFileSync('git', ['init'], { cwd: config.defaultCwd, stdio: 'ignore' })
    await createRepoProjectAgentDefinition(config.defaultCwd, {
      definitionId: 'docs',
      whenToUse: 'Maintain repository docs v1.',
      prompt: 'Repo docs prompt v1',
      references: { 'guide.md': '# Guide v1' },
    })

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    const activated = await manager.activateRepoProjectAgent({
      profileId: 'manager',
      sessionAgentId: 'manager',
      definitionId: 'docs',
      mode: 'create',
    })

    const staleMeta = await readSessionMeta(config.paths.dataDir, 'manager', activated.agentId)
    expect(staleMeta?.resolvedSystemPrompt).toContain('Repo docs prompt v1')

    await createRepoProjectAgentDefinition(config.defaultCwd, {
      definitionId: 'docs',
      whenToUse: 'Maintain repository docs v2.',
      prompt: 'Repo docs prompt v2',
      references: { 'guide.md': '# Guide v2' },
    })

    const firstRuntime = manager.runtimeByAgentId.get(activated.agentId)
    expect(firstRuntime).toBeDefined()

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    try {
      const response = await fetch(
        `http://${config.host}:${config.port}/api/agents/${encodeURIComponent(activated.agentId)}/system-prompt`,
      )

      expect(response.status).toBe(200)
      const payload = (await response.json()) as {
        agentId: string
        role: 'manager'
        systemPrompt: string | null
      }

      expect(payload.agentId).toBe(activated.agentId)
      expect(payload.systemPrompt).toContain('Repo docs prompt v2')
      expect(payload.systemPrompt).toContain('# Guide v2')
      expect(payload.systemPrompt).not.toContain('Repo docs prompt v1')
      expect(payload.systemPrompt).not.toContain('# Guide v1')
      expect(firstRuntime?.recycleCalls).toBe(1)
      expect(manager.getAgent(activated.agentId)?.projectAgent?.whenToUse).toBe('Maintain repository docs v2.')

      const metaAfterRead = await readSessionMeta(config.paths.dataDir, 'manager', activated.agentId)
      expect(metaAfterRead?.resolvedSystemPrompt).toBe(staleMeta?.resolvedSystemPrompt)
      expect(metaAfterRead?.resolvedSystemPrompt).toContain('Repo docs prompt v1')
    } finally {
      await server.stop()
    }
  })

  it('blocks busy stale repo project-agent prompts through GET /api/agents/:agentId/system-prompt', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)
    execFileSync('git', ['init'], { cwd: config.defaultCwd, stdio: 'ignore' })
    await createRepoProjectAgentDefinition(config.defaultCwd, {
      definitionId: 'docs',
      whenToUse: 'Maintain repository docs v1.',
      prompt: 'Repo docs prompt v1',
    })

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    const activated = await manager.activateRepoProjectAgent({
      profileId: 'manager',
      sessionAgentId: 'manager',
      definitionId: 'docs',
      mode: 'create',
    })

    const runtime = manager.runtimeByAgentId.get(activated.agentId)
    expect(runtime).toBeDefined()
    runtime!.pendingCount = 1
    runtime!.descriptor.status = 'streaming'
    const liveState = manager as unknown as {
      descriptors: Map<string, { status: string }>
      runtimes: Map<string, unknown>
    }
    liveState.descriptors.get(activated.agentId)!.status = 'streaming'
    liveState.runtimes.set(activated.agentId, runtime!)

    await createRepoProjectAgentDefinition(config.defaultCwd, {
      definitionId: 'docs',
      whenToUse: 'Maintain repository docs v2.',
      prompt: 'Repo docs prompt v2',
    })
    const recycleCallsBeforeRead = runtime!.recycleCalls

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    try {
      const response = await fetch(
        `http://${config.host}:${config.port}/api/agents/${encodeURIComponent(activated.agentId)}/system-prompt`,
      )

      expect(response.status).toBe(409)
      const payload = (await response.json()) as { error: string }
      expect(payload.error).toMatch(/Repository project-agent source docs changed while .*active runtime/i)
      expect(runtime?.recycleCalls).toBe(recycleCallsBeforeRead)

      const metaAfterRead = await readSessionMeta(config.paths.dataDir, 'manager', activated.agentId)
      expect(metaAfterRead?.resolvedSystemPrompt).toContain('Repo docs prompt v1')
      expect(metaAfterRead?.resolvedSystemPrompt).not.toContain('Repo docs prompt v2')
    } finally {
      await server.stop()
    }
  })

  it('returns persisted worker system prompts through GET /api/agents/:agentId/system-prompt', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    const worker = await manager.spawnAgent('manager', { agentId: 'Prompt Worker' })

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    try {
      const response = await fetch(`http://${config.host}:${config.port}/api/agents/${encodeURIComponent(worker.agentId)}/system-prompt`)

      expect(response.status).toBe(200)
      const payload = (await response.json()) as {
        agentId: string
        role: 'worker'
        systemPrompt: string | null
        model: string | null
        archetypeId: string | null
      }

      const meta = await readSessionMeta(config.paths.dataDir, 'manager', 'manager')
      const workerMeta = meta?.workers.find((entry) => entry.id === worker.agentId)
      expect(workerMeta?.systemPrompt).toEqual(expect.any(String))
      expect(payload).toEqual({
        agentId: worker.agentId,
        role: 'worker',
        systemPrompt: workerMeta?.systemPrompt ?? null,
        model: workerMeta?.model ?? `${worker.model.provider}/${worker.model.modelId}`,
        archetypeId: worker.archetypeId ?? null,
        initialModelInput: {
          status: 'pending',
          message: 'Available after the first model request.',
        },
      })
      expect(payload.systemPrompt).toContain('End users see only manager-owned user-visible outputs: final assistant replies, direct-web assistant progress updates, routed `speak_to_user` deliveries, and structured choice UI.')
    } finally {
      await server.stop()
    }
  })

})
