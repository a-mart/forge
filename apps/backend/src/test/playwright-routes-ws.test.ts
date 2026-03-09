import { EventEmitter, once } from 'node:events'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket, { WebSocketServer } from 'ws'
import { describe, expect, it } from 'vitest'
import type {
  AgentDescriptor,
  ManagerProfile,
  PlaywrightDiscoveredSession,
  PlaywrightDiscoverySettings,
  PlaywrightDiscoverySnapshot,
} from '@middleman/protocol'
import type { SwarmConfig } from '../swarm/types.js'
import { getScheduleFilePath } from '../scheduler/schedule-storage.js'
import { PlaywrightLivePreviewService } from '../playwright/playwright-live-preview-service.js'
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

  getSessionById(sessionId: string) {
    return this.snapshot.sessions.find((session) => session.id === sessionId) ?? null
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

function createActiveSession(rootDir: string): PlaywrightDiscoveredSession {
  return {
    id: 'session-active',
    sessionName: 'default',
    sessionVersion: '1.0.0',
    schemaVersion: 'v2',
    sessionFilePath: join(rootDir, '.playwright-cli', 'sessions', 'default.session'),
    sessionFileRealPath: join(rootDir, '.playwright-cli', 'sessions', 'default.session'),
    sessionFileUpdatedAt: '2026-03-09T18:00:00.000Z',
    sessionTimestamp: '2026-03-09T18:00:00.000Z',
    rootPath: rootDir,
    rootKind: 'repo-root',
    repoRootPath: rootDir,
    backendRootPath: null,
    worktreePath: null,
    worktreeName: null,
    daemonId: 'daemon-1',
    socketPath: '/tmp/playwright-cli-sockets/daemon-1/default.sock',
    socketExists: true,
    socketResponsive: true,
    cdpResponsive: null,
    liveness: 'active',
    stale: false,
    staleReason: null,
    browserName: 'chromium',
    browserChannel: 'chrome',
    headless: false,
    persistent: true,
    isolated: false,
    userDataDirPath: join(rootDir, '.playwright-cli', 'sessions', 'ud-default-chrome'),
    userDataDirExists: true,
    ports: {
      frontend: 41001,
      backendApi: 41002,
      sandbox: null,
      liteLlm: null,
      cdp: null,
    },
    artifactCounts: {
      pageSnapshots: 0,
      screenshots: 0,
      consoleLogs: 0,
      networkLogs: 0,
      total: 0,
      lastArtifactAt: null,
    },
    duplicateGroupKey: 'session-active',
    duplicateRank: 0,
    preferredInDuplicateGroup: true,
    correlation: {
      matchedAgentId: null,
      matchedAgentDisplayName: null,
      matchedManagerId: null,
      matchedManagerDisplayName: null,
      matchedProfileId: null,
      confidence: 'none',
      reasons: [],
    },
    warnings: [],
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

  it('starts preview leases and proxies controller websocket traffic through backend origin', async () => {
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

    const activeSession = createActiveSession(config.paths.rootDir)
    const snapshot: PlaywrightDiscoverySnapshot = {
      updatedAt: '2026-03-09T18:00:01.000Z',
      lastScanStartedAt: '2026-03-09T18:00:00.500Z',
      lastScanCompletedAt: '2026-03-09T18:00:01.000Z',
      scanDurationMs: 500,
      sequence: 2,
      serviceStatus: 'ready',
      settings,
      rootsScanned: [config.paths.rootDir],
      summary: {
        totalSessions: 1,
        activeSessions: 1,
        inactiveSessions: 0,
        staleSessions: 0,
        legacySessions: 0,
        duplicateSessions: 0,
        correlatedSessions: 0,
        unmatchedSessions: 1,
        worktreeCount: 0,
      },
      sessions: [activeSession],
      warnings: [],
      lastError: null,
    }

    const discovery = new FakePlaywrightDiscovery(snapshot, settings)
    const upstreamPort = await getAvailablePort()
    const upstreamMessages: string[] = []
    const upstreamServer = new WebSocketServer({ host: '127.0.0.1', port: upstreamPort })
    await once(upstreamServer, 'listening')
    upstreamServer.on('connection', (socket) => {
      socket.send(JSON.stringify({ type: 'frame', data: 'ZmFrZQ==' }))
      socket.on('message', (data) => {
        const raw = data.toString()
        upstreamMessages.push(raw)
        socket.send(raw)
      })
    })

    const livePreviewService = new PlaywrightLivePreviewService({
      discoveryService: discovery as unknown as never,
      devtoolsBridge: {
        async startPreviewController() {
          return {
            upstreamControllerUrl: `ws://127.0.0.1:${upstreamPort}/controller`,
            source: 'playwright-cli-daemon' as const,
          }
        },
      },
    })
    await livePreviewService.start()

    const server = new SwarmWebSocketServer({
      swarmManager: swarmManager as unknown as never,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: false,
      playwrightDiscovery: discovery as unknown as never,
      playwrightLivePreviewService: livePreviewService,
      playwrightSettingsService: settingsService,
    })

    await server.start()

    try {
      const startResponse = await fetch(`http://${config.host}:${config.port}/api/playwright/live-preview/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: activeSession.id, mode: 'focus' }),
      })
      const startPayload = (await startResponse.json()) as {
        ok?: boolean
        preview?: {
          previewId: string
          iframeSrc: string
          controllerProxyUrl: string
          mode: string
        }
      }

      expect(startResponse.status).toBe(200)
      expect(startPayload.preview?.previewId).toBeTruthy()
      expect(startPayload.preview?.mode).toBe('focus')
      expect(startPayload.preview?.iframeSrc).toContain('/playwright-live/embed?previewId=')
      expect(startPayload.preview?.controllerProxyUrl).toContain('/playwright-live/ws/controller/')

      const previewId = startPayload.preview?.previewId ?? ''
      const bootstrapResponse = await fetch(
        `http://${config.host}:${config.port}/playwright-live/api/previews/${encodeURIComponent(previewId)}/bootstrap`,
      )
      const bootstrapPayload = (await bootstrapResponse.json()) as {
        bootstrap?: { previewId?: string; sessionId?: string; controllerWsUrl?: string }
      }

      expect(bootstrapResponse.status).toBe(200)
      expect(bootstrapPayload.bootstrap?.previewId).toBe(previewId)
      expect(bootstrapPayload.bootstrap?.sessionId).toBe(activeSession.id)
      expect(bootstrapPayload.bootstrap?.controllerWsUrl).toContain(`/playwright-live/ws/controller/${previewId}`)

      const embedResponse = await fetch(`http://${config.host}:${config.port}/playwright-live/embed?previewId=${encodeURIComponent(previewId)}`)
      const embedHtml = await embedResponse.text()
      expect(embedResponse.status).toBe(200)
      expect(embedHtml).toContain(previewId)

      const proxySocket = new WebSocket(`ws://${config.host}:${config.port}/playwright-live/ws/controller/${encodeURIComponent(previewId)}`)
      await once(proxySocket, 'open')

      const firstMessage = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timed out waiting for proxied frame')), 5_000)
        proxySocket.once('message', (data) => {
          clearTimeout(timeout)
          resolve(data.toString())
        })
      })
      expect(firstMessage).toContain('"type":"frame"')

      proxySocket.send(JSON.stringify({ type: 'ping', source: 'test' }))
      await new Promise<void>((resolve, reject) => {
        const startedAt = Date.now()
        const poll = () => {
          if (upstreamMessages.some((message) => message.includes('"type":"ping"'))) {
            resolve()
            return
          }
          if (Date.now() - startedAt > 5_000) {
            reject(new Error('Timed out waiting for proxied upstream message'))
            return
          }
          setTimeout(poll, 25)
        }
        poll()
      })
      proxySocket.close()

      const releaseResponse = await fetch(
        `http://${config.host}:${config.port}/api/playwright/live-preview/${encodeURIComponent(previewId)}`,
        { method: 'DELETE' },
      )
      const releasePayload = (await releaseResponse.json()) as { ok?: boolean; previewId?: string; released?: boolean }
      expect(releaseResponse.status).toBe(200)
      expect(releasePayload.ok).toBe(true)
      expect(releasePayload.previewId).toBe(previewId)
      expect(releasePayload.released).toBe(true)
    } finally {
      await server.stop()
      await livePreviewService.stop()
      await new Promise<void>((resolve, reject) => {
        upstreamServer.close((error) => {
          if (error) {
            reject(error)
            return
          }
          resolve()
        })
      })
    }
  })
})
