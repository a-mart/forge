import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AgentDescriptor, SwarmConfig } from '../swarm/types.js'
import { getScheduleFilePath } from '../scheduler/schedule-storage.js'
import { PlaywrightDiscoveryService } from '../playwright/playwright-discovery-service.js'
import { PlaywrightSettingsService } from '../playwright/playwright-settings-service.js'

class FakeSwarmManager extends EventEmitter {
  constructor(
    private readonly config: SwarmConfig,
    private readonly agents: AgentDescriptor[],
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

async function makeTempConfig(rootDir: string): Promise<SwarmConfig> {
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
    displayName: 'Manager',
    role: 'manager',
    managerId: 'manager',
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

describe('PlaywrightDiscoveryService', () => {
  it('serializes startup, manual rescans, and settings-update scans through one queue', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'playwright-discovery-queue-'))
    const config = await makeTempConfig(rootDir)
    const swarmManager = new FakeSwarmManager(config, [createManagerDescriptor(rootDir)])
    const settingsService = new PlaywrightSettingsService({ dataDir: config.paths.dataDir })
    await settingsService.load()
    await settingsService.update({ enabled: true })

    const service = new PlaywrightDiscoveryService({
      swarmManager: swarmManager as unknown as never,
      settingsService,
      now: () => new Date('2026-03-09T18:00:00.000Z'),
    })

    let concurrentScans = 0
    let maxConcurrentScans = 0
    const scanOrder: string[] = []
    let releaseScan!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseScan = resolve
    })

    ;(service as any).runScan = vi.fn(async (reason: string) => {
      concurrentScans += 1
      maxConcurrentScans = Math.max(maxConcurrentScans, concurrentScans)
      scanOrder.push(`start:${reason}`)
      await gate
      ;(service as any).currentSnapshot = {
        ...(service as any).currentSnapshot,
        serviceStatus: 'ready',
        lastError: `scan:${reason}`,
        updatedAt: `done:${reason}`,
      }
      scanOrder.push(`end:${reason}`)
      concurrentScans -= 1
    })

    const startPromise = service.start()
    const rescanPromise = service.triggerRescan('manual')
    const updatePromise = service.updateSettings({ pollIntervalMs: 4_000 })

    await Promise.resolve()
    releaseScan()

    await startPromise
    const rescanSnapshot = await rescanPromise
    const updateResult = await updatePromise

    expect(maxConcurrentScans).toBe(1)
    expect(scanOrder).toEqual([
      'start:startup',
      'end:startup',
      'start:manual',
      'end:manual',
      'start:settings_update',
      'end:settings_update',
    ])
    expect(rescanSnapshot.lastError).toBe('scan:manual')
    expect(updateResult.snapshot.lastError).toBe('scan:settings_update')
  })

  it('surfaces malformed session files as snapshot warnings with exact paths', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'playwright-discovery-warning-'))
    const config = await makeTempConfig(rootDir)
    const swarmManager = new FakeSwarmManager(config, [createManagerDescriptor(rootDir)])
    const settingsService = new PlaywrightSettingsService({ dataDir: config.paths.dataDir })
    await settingsService.load()
    await settingsService.update({ enabled: true })

    const sessionsDir = join(rootDir, '.playwright-cli', 'sessions')
    await mkdir(sessionsDir, { recursive: true })
    const badSessionPath = join(sessionsDir, 'broken.session')
    await writeFile(badSessionPath, '{not valid json', 'utf8')
    const normalizedBadSessionPath = await import('node:fs/promises').then(({ realpath }) =>
      realpath(badSessionPath).catch(() => badSessionPath),
    )

    const service = new PlaywrightDiscoveryService({
      swarmManager: swarmManager as unknown as never,
      settingsService,
      now: () => new Date('2026-03-09T18:00:00.000Z'),
    })

    await service.start()

    try {
      const snapshot = service.getSnapshot()
      expect(snapshot.warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining(`Invalid Playwright session JSON ${normalizedBadSessionPath}`),
        ]),
      )
    } finally {
      await service.stop()
    }
  })
})
