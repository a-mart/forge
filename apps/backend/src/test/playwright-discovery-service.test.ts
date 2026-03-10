import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
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

async function createSocketServer(socketPath: string): Promise<() => Promise<void>> {
  const { createServer } = await import('node:net')
  await rm(socketPath, { force: true })
  const server = createServer((socket) => {
    socket.end()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => resolve())
  })

  return async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
    })
    await rm(socketPath, { force: true })
  }
}

function createTempSocketPath(prefix: string): string {
  return join(tmpdir(), `${prefix}-${process.pid}-${Math.random().toString(16).slice(2, 8)}.sock`)
}

async function writeSessionFile(
  rootDir: string,
  fileName: string,
  options: { socketPath: string; timestamp?: number; name?: string },
): Promise<void> {
  const sessionsDir = join(rootDir, '.playwright-cli', 'sessions')
  await mkdir(sessionsDir, { recursive: true })
  await writeFile(
    join(sessionsDir, fileName),
    JSON.stringify({
      name: options.name ?? fileName.replace(/\.session$/, ''),
      timestamp: options.timestamp ?? Date.parse('2026-03-09T18:00:00.000Z'),
      socketPath: options.socketPath,
    }),
    'utf8',
  )
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

  it('limits agent-derived scan roots to the current manager scope', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'playwright-discovery-scope-'))
    const foreignRoot = await mkdtemp(join(tmpdir(), 'playwright-discovery-foreign-'))
    const currentSocketPath = createTempSocketPath('pw-current')
    const foreignSocketPath = createTempSocketPath('pw-foreign')
    const closeCurrentSocket = await createSocketServer(currentSocketPath)
    const closeForeignSocket = await createSocketServer(foreignSocketPath)

    const foreignWorker: AgentDescriptor = {
      ...createManagerDescriptor(rootDir),
      agentId: 'foreign-worker',
      displayName: 'Foreign Worker',
      role: 'worker',
      managerId: 'foreign-manager',
      cwd: foreignRoot,
      sessionFile: join(foreignRoot, 'sessions', 'foreign-worker.jsonl'),
    }

    const config = await makeTempConfig(rootDir)
    const swarmManager = new FakeSwarmManager(config, [createManagerDescriptor(rootDir), foreignWorker])
    const settingsService = new PlaywrightSettingsService({ dataDir: config.paths.dataDir })
    await settingsService.load()
    await settingsService.update({ enabled: true })
    await writeSessionFile(rootDir, 'current.session', { socketPath: currentSocketPath, name: 'current' })
    await writeSessionFile(foreignRoot, 'foreign.session', { socketPath: foreignSocketPath, name: 'foreign' })

    const service = new PlaywrightDiscoveryService({
      swarmManager: swarmManager as unknown as never,
      settingsService,
      now: () => new Date('2026-03-09T18:00:00.000Z'),
    })

    await service.start()

    try {
      const snapshot = service.getSnapshot()
      expect(snapshot.sessions.map((session) => session.sessionName)).toEqual(['current'])
      expect(snapshot.rootsScanned).toHaveLength(1)
      expect(snapshot.rootsScanned).not.toContain(foreignRoot)
    } finally {
      await service.stop()
      await Promise.all([closeCurrentSocket(), closeForeignSocket()])
    }
  })

  it('includes current-manager child roots during discovery even when child descriptors are terminated', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'playwright-discovery-restart-'))
    const recoveredWorkerRoot = await mkdtemp(join(tmpdir(), 'playwright-discovery-recovered-'))
    const recoveredSocketPath = createTempSocketPath('pw-recovered')
    const closeRecoveredSocket = await createSocketServer(recoveredSocketPath)

    const recoveredWorker: AgentDescriptor = {
      ...createManagerDescriptor(rootDir),
      agentId: 'recovered-worker',
      displayName: 'Recovered Worker',
      role: 'worker',
      managerId: 'manager',
      status: 'terminated',
      cwd: recoveredWorkerRoot,
      sessionFile: join(recoveredWorkerRoot, 'sessions', 'recovered-worker.jsonl'),
    }

    const config = await makeTempConfig(rootDir)
    const swarmManager = new FakeSwarmManager(config, [createManagerDescriptor(rootDir), recoveredWorker])
    const settingsService = new PlaywrightSettingsService({ dataDir: config.paths.dataDir })
    await settingsService.load()
    await settingsService.update({ enabled: true })
    await writeSessionFile(recoveredWorkerRoot, 'recovered.session', { socketPath: recoveredSocketPath, name: 'recovered' })

    const service = new PlaywrightDiscoveryService({
      swarmManager: swarmManager as unknown as never,
      settingsService,
      now: () => new Date('2026-03-09T18:00:00.000Z'),
    })

    await service.start()

    try {
      const snapshot = service.getSnapshot()
      expect(snapshot.sessions.map((session) => session.sessionName)).toEqual(['recovered'])
      expect(snapshot.sessions[0]?.rootPath).toContain(basename(recoveredWorkerRoot))
    } finally {
      await service.stop()
      await closeRecoveredSocket()
    }
  })

  it('marks non-preferred duplicate sessions as not previewable', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'playwright-discovery-duplicates-'))
    const sharedSocketPath = createTempSocketPath('pw-shared')
    const closeSocket = await createSocketServer(sharedSocketPath)

    const config = await makeTempConfig(rootDir)
    const swarmManager = new FakeSwarmManager(config, [createManagerDescriptor(rootDir)])
    const settingsService = new PlaywrightSettingsService({ dataDir: config.paths.dataDir })
    await settingsService.load()
    await settingsService.update({ enabled: true })
    await writeSessionFile(rootDir, 'preferred.session', {
      socketPath: sharedSocketPath,
      name: 'preferred',
      timestamp: Date.parse('2026-03-09T18:00:01.000Z'),
    })
    await writeSessionFile(rootDir, 'shadow.session', {
      socketPath: sharedSocketPath,
      name: 'shadow',
      timestamp: Date.parse('2026-03-09T18:00:00.000Z'),
    })

    const service = new PlaywrightDiscoveryService({
      swarmManager: swarmManager as unknown as never,
      settingsService,
      now: () => new Date('2026-03-09T18:00:02.000Z'),
    })

    await service.start()

    try {
      const snapshot = service.getSnapshot()
      // Summary still reports the duplicate was detected (computed pre-filter)
      expect(snapshot.summary.duplicateSessions).toBe(1)
      // Only the preferred session survives into the sessions array
      expect(snapshot.sessions).toHaveLength(1)
      const preferred = snapshot.sessions.find((session) => session.sessionName === 'preferred')
      expect(preferred?.preferredInDuplicateGroup).toBe(true)
      expect(preferred?.previewability?.previewable).toBe(true)
      // Non-preferred duplicate is filtered out — it must not appear
      const shadow = snapshot.sessions.find((session) => session.sessionName === 'shadow')
      expect(shadow).toBeUndefined()
    } finally {
      await service.stop()
      await closeSocket()
    }
  })
})
