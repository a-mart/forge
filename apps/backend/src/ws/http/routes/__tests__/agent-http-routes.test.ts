import { describe, expect, it } from 'vitest'
import { getAvailablePort } from '../../../../test-support/index.js'
import {
  WsServerTestSwarmManager as TestSwarmManager,
  bootWsServerTestManager as bootWithDefaultManager,
  makeWsServerTempConfig as makeTempConfig,
} from '../../../../test-support/ws-integration-harness.js'
import { readSessionMeta } from '../../../../swarm/session-manifest.js'
import { SwarmWebSocketServer } from '../../../server.js'

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
      })
      expect(payload.systemPrompt).toContain('You are the manager agent in a multi-agent swarm.')
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
      })
      expect(payload.systemPrompt).toContain('End users only see messages they send and manager speak_to_user outputs.')
    } finally {
      await server.stop()
    }
  })

})
