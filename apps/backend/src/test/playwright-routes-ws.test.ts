import { EventEmitter, once } from 'node:events'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { describe, expect, it } from 'vitest'
import type {
  AgentDescriptor,
  ManagerProfile,
  PlaywrightDiscoverySettings,
  PlaywrightDiscoverySnapshot,
} from '@middleman/protocol'
import type { SwarmConfig } from '../swarm/types.js'
import { getScheduleFilePath } from '../scheduler/schedule-storage.js'
import { PlaywrightSettingsService } from '../playwright/playwright-settings-service.js'
import { getSharedPlaywrightDashboardSettingsPath } from '../swarm/data-paths.js'
import { SwarmWebSocketServer } from '../ws/server.js'

class FakeSwarmManager extends EventEmitter {
  constructor(
    private readonly config: SwarmConfig,
    private readonly agents: AgentDescriptor[],
    private readonly profiles: ManagerProfile[] = [],
  ) {
    super()
  }

  getConfig(): SwarmConfig {
    return this.config
  }

  listAgents(): AgentDescriptor[] {
    return [...this.agents]
  }

  getAgent(agentId: string): AgentDescriptor | undefined {
    return this.agents.find((agent) => agent.agentId === agentId)
  }

  listProfiles(): ManagerProfile[] {
    return [...this.profiles]
  }

  getConversationHistory(): [] {
    return []
  }
}

class FakePlaywrightDiscovery extends EventEmitter {
  constructor(
    private readonly snapshot: PlaywrightDiscoverySnapshot,
    private readonly settings: PlaywrightDiscoverySettings,
  ) {
    super()
  }

  getSnapshot(): PlaywrightDiscoverySnapshot {
    return this.snapshot
  }

  getSettings(): PlaywrightDiscoverySettings {
    return this.settings
  }
}

async function getAvailablePort(): Promise<number> {
  const { createServer } = await import('node:net')
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Unable to allocate port')
  }
  const port = address.port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

async function makeTempConfig(): Promise<SwarmConfig> {
  const rootDir = await mkdtemp(join(tmpdir(), 'playwright-routes-test-'))
  const dataDir = join(rootDir, 'data')
  const swarmDir = join(dataDir, 'swarm')
  const sessionsDir = join(dataDir, 'sessions')
  const uploadsDir = join(dataDir, 'uploads')
  const profilesDir = join(dataDir, 'profiles')
  const sharedDir = join(dataDir, 'shared')
  const sharedAuthDir = join(sharedDir, 'auth')
  const sharedAuthFile = join(sharedAuthDir, 'auth.json')
  const sharedSecretsFile = join(sharedDir, 'secrets.json')
  const sharedIntegrationsDir = join(sharedDir, 'integrations')
  const authDir = join(dataDir, 'auth')
  const agentDir = join(dataDir, 'agent')
  const managerAgentDir = join(agentDir, 'manager')
  const repoArchetypesDir = join(rootDir, '.swarm', 'archetypes')
  const memoryDir = join(dataDir, 'memory')
  const memoryFile = join(memoryDir, 'manager.md')
  const repoMemorySkillFile = join(rootDir, '.swarm', 'skills', 'memory', 'SKILL.md')

  await mkdir(swarmDir, { recursive: true })
  await mkdir(sessionsDir, { recursive: true })
  await mkdir(uploadsDir, { recursive: true })
  await mkdir(profilesDir, { recursive: true })
  await mkdir(sharedAuthDir, { recursive: true })
  await mkdir(sharedIntegrationsDir, { recursive: true })
  await mkdir(authDir, { recursive: true })
  await mkdir(memoryDir, { recursive: true })
  await mkdir(agentDir, { recursive: true })
  await mkdir(managerAgentDir, { recursive: true })
  await mkdir(repoArchetypesDir, { recursive: true })

  return {
    host: '127.0.0.1',
    port: await getAvailablePort(),
    debug: false,
    allowNonManagerSubscriptions: false,
    managerId: 'manager',
    managerDisplayName: 'Manager',
    defaultModel: {
      provider: 'openai-codex',
      modelId: 'gpt-5.3-codex',
      thinkingLevel: 'medium',
    },
    defaultCwd: rootDir,
    cwdAllowlistRoots: [rootDir, join(rootDir, 'worktrees')],
    paths: {
      rootDir,
      dataDir,
      swarmDir,
      uploadsDir,
      agentsStoreFile: join(swarmDir, 'agents.json'),
      profilesDir,
      sharedDir,
      sharedAuthDir,
      sharedAuthFile,
      sharedSecretsFile,
      sharedIntegrationsDir,
      sessionsDir,
      memoryDir,
      authDir,
      authFile: join(authDir, 'auth.json'),
      secretsFile: join(dataDir, 'secrets.json'),
      agentDir,
      managerAgentDir,
      repoArchetypesDir,
      memoryFile,
      repoMemorySkillFile,
      schedulesFile: getScheduleFilePath(dataDir, 'manager'),
    },
  }
}

function createManagerDescriptor(rootDir: string): AgentDescriptor {
  return {
    agentId: 'manager',
    managerId: 'manager',
    displayName: 'Manager',
    role: 'manager',
    status: 'idle',
    createdAt: '2026-03-09T18:00:00.000Z',
    updatedAt: '2026-03-09T18:00:00.000Z',
    cwd: rootDir,
    model: {
      provider: 'openai-codex',
      modelId: 'gpt-5.3-codex',
      thinkingLevel: 'medium',
    },
    sessionFile: join(rootDir, 'sessions', 'manager.jsonl'),
  }
}

describe('Playwright routes and WS bootstrap', () => {
  it('keeps /api/settings/playwright available when discovery service is unavailable', async () => {
    const config = await makeTempConfig()
    const swarmManager = new FakeSwarmManager(config, [createManagerDescriptor(config.paths.rootDir)])
    const settingsService = new PlaywrightSettingsService({ dataDir: config.paths.dataDir })
    await settingsService.load()

    const server = new SwarmWebSocketServer({
      swarmManager: swarmManager as unknown as never,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: false,
      playwrightDiscovery: null,
      playwrightSettingsService: settingsService,
    })

    await server.start()
    try {
      const settingsResponse = await fetch(`http://${config.host}:${config.port}/api/settings/playwright`)
      const settingsPayload = (await settingsResponse.json()) as { settings: PlaywrightDiscoverySettings }
      expect(settingsResponse.status).toBe(200)
      expect(settingsPayload.settings.effectiveEnabled).toBe(false)

      const updateResponse = await fetch(`http://${config.host}:${config.port}/api/settings/playwright`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      })
      const updatePayload = (await updateResponse.json()) as {
        settings: PlaywrightDiscoverySettings
        snapshot: PlaywrightDiscoverySnapshot
      }

      expect(updateResponse.status).toBe(200)
      expect(updatePayload.settings.enabled).toBe(true)
      expect(updatePayload.snapshot.serviceStatus).toBe('error')
      expect(updatePayload.snapshot.lastError).toBe('Playwright discovery service is unavailable')

      const stored = JSON.parse(
        await readFile(getSharedPlaywrightDashboardSettingsPath(config.paths.dataDir), 'utf8'),
      ) as Record<string, unknown>
      expect(stored.enabled).toBe(true)
    } finally {
      await server.stop()
    }
  })

  it('includes Playwright snapshot and settings in WS bootstrap when discovery is available', async () => {
    const config = await makeTempConfig()
    const swarmManager = new FakeSwarmManager(config, [createManagerDescriptor(config.paths.rootDir)])
    const settingsService = new PlaywrightSettingsService({ dataDir: config.paths.dataDir })
    await settingsService.load()

    const settings: PlaywrightDiscoverySettings = {
      enabled: true,
      effectiveEnabled: true,
      source: 'settings',
      envOverride: null,
      scanRoots: [],
      pollIntervalMs: 10_000,
      socketProbeTimeoutMs: 750,
      staleSessionThresholdMs: 3_600_000,
      updatedAt: '2026-03-09T18:00:00.000Z',
    }

    const snapshot: PlaywrightDiscoverySnapshot = {
      updatedAt: '2026-03-09T18:00:01.000Z',
      lastScanStartedAt: '2026-03-09T18:00:00.500Z',
      lastScanCompletedAt: '2026-03-09T18:00:01.000Z',
      scanDurationMs: 500,
      sequence: 1,
      serviceStatus: 'ready',
      settings,
      rootsScanned: [],
      summary: {
        totalSessions: 0,
        activeSessions: 0,
        inactiveSessions: 0,
        staleSessions: 0,
        legacySessions: 0,
        duplicateSessions: 0,
        correlatedSessions: 0,
        unmatchedSessions: 0,
        worktreeCount: 0,
      },
      sessions: [],
      warnings: [],
      lastError: null,
    }

    const discovery = new FakePlaywrightDiscovery(snapshot, settings)
    const server = new SwarmWebSocketServer({
      swarmManager: swarmManager as unknown as never,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: false,
      playwrightDiscovery: discovery as unknown as never,
      playwrightSettingsService: settingsService,
    })

    await server.start()
    const socket = new WebSocket(`ws://${config.host}:${config.port}`)

    try {
      await once(socket, 'open')
      socket.send(JSON.stringify({ type: 'subscribe', agentId: 'manager' }))

      const messages: Array<{ type?: string }> = []
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Timed out waiting for Playwright bootstrap events'))
        }, 5_000)

        socket.on('message', (data) => {
          const event = JSON.parse(data.toString()) as { type?: string }
          messages.push(event)
          const types = new Set(messages.map((message) => message.type))
          if (
            types.has('playwright_discovery_snapshot') &&
            types.has('playwright_discovery_settings_updated')
          ) {
            clearTimeout(timeout)
            resolve()
          }
        })
      })

      expect(messages.map((message) => message.type)).toContain('playwright_discovery_snapshot')
      expect(messages.map((message) => message.type)).toContain('playwright_discovery_settings_updated')
    } finally {
      socket.close()
      await server.stop()
    }
  })
})
