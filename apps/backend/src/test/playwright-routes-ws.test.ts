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
} from '@forge/protocol'
import type { SwarmConfig } from '../swarm/types.js'
import { getScheduleFilePath } from '../scheduler/schedule-storage.js'
import { PlaywrightLivePreviewService } from '../playwright/playwright-live-preview-service.js'
import { PlaywrightSettingsService } from '../playwright/playwright-settings-service.js'
import { getSharedPlaywrightDashboardSettingsPath } from '../swarm/data-paths.js'
import { SwarmWebSocketServer } from '../ws/server.js'
import { withPlatform } from './test-helpers.js'

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

  listBootstrapAgents(): AgentDescriptor[] {
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

function createSession(
  rootDir: string,
  overrides: Partial<PlaywrightDiscoveredSession> = {},
): PlaywrightDiscoveredSession {
  const base: PlaywrightDiscoveredSession = {
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
    previewability: {
      previewable: true,
      unavailableReason: null,
    },
  }

  return {
    ...base,
    ...overrides,
    ports: {
      ...base.ports,
      ...(overrides.ports ?? {}),
    },
    artifactCounts: {
      ...base.artifactCounts,
      ...(overrides.artifactCounts ?? {}),
    },
    correlation: {
      ...base.correlation,
      ...(overrides.correlation ?? {}),
      reasons: overrides.correlation?.reasons ?? base.correlation.reasons,
    },
    previewability: overrides.previewability ?? base.previewability,
  }
}

function createActiveSession(rootDir: string): PlaywrightDiscoveredSession {
  return createSession(rootDir)
}

function createSettings(): PlaywrightDiscoverySettings {
  return {
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
}

function createSnapshot(
  settings: PlaywrightDiscoverySettings,
  sessions: PlaywrightDiscoveredSession[],
): PlaywrightDiscoverySnapshot {
  return {
    updatedAt: '2026-03-09T18:00:01.000Z',
    lastScanStartedAt: '2026-03-09T18:00:00.500Z',
    lastScanCompletedAt: '2026-03-09T18:00:01.000Z',
    scanDurationMs: 500,
    sequence: 1,
    serviceStatus: 'ready',
    settings,
    rootsScanned: sessions.length > 0 ? [sessions[0].rootPath] : [],
    summary: {
      totalSessions: sessions.length,
      activeSessions: sessions.filter((session) => session.liveness === 'active').length,
      inactiveSessions: sessions.filter((session) => session.liveness === 'inactive').length,
      staleSessions: sessions.filter((session) => session.liveness === 'stale').length,
      legacySessions: 0,
      duplicateSessions: 0,
      correlatedSessions: 0,
      unmatchedSessions: sessions.length,
      worktreeCount: 0,
    },
    sessions,
    warnings: [],
    lastError: null,
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

  it('forces effectiveEnabled=false on win32 even when persisted settings are enabled', async () => {
    await withPlatform('win32', async () => {
      const config = await makeTempConfig()
      const swarmManager = new FakeSwarmManager(config, [createManagerDescriptor(config.paths.rootDir)])
      const settingsService = new PlaywrightSettingsService({ dataDir: config.paths.dataDir })
      await settingsService.load()
      await settingsService.update({ enabled: true })

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
        const response = await fetch(`http://${config.host}:${config.port}/api/settings/playwright`)
        const payload = (await response.json()) as { settings: PlaywrightDiscoverySettings }

        expect(response.status).toBe(200)
        expect(payload.settings.enabled).toBe(true)
        expect(payload.settings.effectiveEnabled).toBe(false)
      } finally {
        await server.stop()
      }
    })
  })

  it('includes Playwright snapshot and settings in WS bootstrap when discovery is available', async () => {
    const config = await makeTempConfig()
    const swarmManager = new FakeSwarmManager(config, [createManagerDescriptor(config.paths.rootDir)])
    const settingsService = new PlaywrightSettingsService({ dataDir: config.paths.dataDir })
    await settingsService.load()

    const settings = createSettings()
    const snapshot = createSnapshot(settings, [])

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

  it('rejects disallowed HTTP and websocket origins for live preview routes', async () => {
    const config = await makeTempConfig()
    const swarmManager = new FakeSwarmManager(config, [createManagerDescriptor(config.paths.rootDir)])
    const settingsService = new PlaywrightSettingsService({ dataDir: config.paths.dataDir })
    await settingsService.load()

    const settings = createSettings()
    const activeSession = createActiveSession(config.paths.rootDir)
    const snapshot = createSnapshot(settings, [activeSession])
    const discovery = new FakePlaywrightDiscovery(snapshot, settings)

    const livePreviewService = new PlaywrightLivePreviewService({
      discoveryService: discovery as unknown as never,
      devtoolsBridge: {
        async startPreviewController() {
          return {
            upstreamControllerUrl: 'ws://127.0.0.1:49000/controller',
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
      const blockedStart = await fetch(`http://${config.host}:${config.port}/api/playwright/live-preview/start`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://evil.example',
        },
        body: JSON.stringify({ sessionId: activeSession.id }),
      })
      expect(blockedStart.status).toBe(403)

      const blockedAsset = await fetch(`http://${config.host}:${config.port}/playwright-live/assets/index-CcsbAkl3.css`, {
        headers: {
          origin: 'http://127.0.0.1:47188',
        },
      })
      expect(blockedAsset.status).toBe(403)

      const allowedStart = await fetch(`http://${config.host}:${config.port}/api/playwright/live-preview/start`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'http://127.0.0.1:47188',
        },
        body: JSON.stringify({ sessionId: activeSession.id }),
      })
      const allowedPayload = (await allowedStart.json()) as { preview?: { previewId?: string } }
      expect(allowedStart.status).toBe(200)
      expect(allowedPayload.preview?.previewId).toBeTruthy()

      const previewId = allowedPayload.preview?.previewId ?? ''
      const blockedSocket = new WebSocket(
        `ws://${config.host}:${config.port}/playwright-live/ws/controller/${encodeURIComponent(previewId)}`,
        { origin: 'https://evil.example' },
      )
      const blockedSocketStatus = await new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timed out waiting for websocket origin rejection')), 5_000)
        blockedSocket.once('unexpected-response', (request, response) => {
          clearTimeout(timeout)
          resolve(response.statusCode ?? 0)
        })
        blockedSocket.once('open', () => {
          clearTimeout(timeout)
          reject(new Error('Blocked websocket unexpectedly opened'))
        })
      })
      expect(blockedSocketStatus).toBe(403)
    } finally {
      await server.stop()
      await livePreviewService.stop()
    }
  })

  it('serves vendored live preview JS and CSS assets from /playwright-live/assets', async () => {
    const config = await makeTempConfig()
    const swarmManager = new FakeSwarmManager(config, [createManagerDescriptor(config.paths.rootDir)])
    const settingsService = new PlaywrightSettingsService({ dataDir: config.paths.dataDir })
    await settingsService.load()

    const settings = createSettings()
    const activeSession = createActiveSession(config.paths.rootDir)
    const snapshot = createSnapshot(settings, [activeSession])
    const discovery = new FakePlaywrightDiscovery(snapshot, settings)

    const livePreviewService = new PlaywrightLivePreviewService({
      discoveryService: discovery as unknown as never,
      devtoolsBridge: {
        async startPreviewController() {
          return {
            upstreamControllerUrl: 'ws://127.0.0.1:49000/controller',
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
      const jsResponse = await fetch(`http://${config.host}:${config.port}/playwright-live/assets/index-BlUdtOgD.js`)
      const jsBody = await jsResponse.text()
      expect(jsResponse.status).toBe(200)
      expect(jsResponse.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
      expect(jsBody.length).toBeGreaterThan(0)

      const cssResponse = await fetch(`http://${config.host}:${config.port}/playwright-live/assets/index-CcsbAkl3.css`)
      const cssBody = await cssResponse.text()
      expect(cssResponse.status).toBe(200)
      expect(cssResponse.headers.get('content-type')).toBe('text/css; charset=utf-8')
      expect(cssBody.length).toBeGreaterThan(0)

      const traversalResponse = await fetch(`http://${config.host}:${config.port}/playwright-live/assets/%2E%2E%2Fembed.js`)
      expect(traversalResponse.status).toBe(403)
    } finally {
      await server.stop()
      await livePreviewService.stop()
    }
  })

  it('rejects inactive and unresponsive sessions with explicit previewability errors', async () => {
    const config = await makeTempConfig()
    const swarmManager = new FakeSwarmManager(config, [createManagerDescriptor(config.paths.rootDir)])
    const settingsService = new PlaywrightSettingsService({ dataDir: config.paths.dataDir })
    await settingsService.load()

    const settings = createSettings()
    const inactiveSession = createSession(config.paths.rootDir, {
      id: 'session-inactive',
      liveness: 'inactive',
      previewability: {
        previewable: false,
        unavailableReason: 'Session default is inactive',
      },
    })
    const unresponsiveSession = createSession(config.paths.rootDir, {
      id: 'session-unresponsive',
      socketResponsive: false,
      previewability: {
        previewable: false,
        unavailableReason: 'Session default does not have a responsive Playwright socket',
      },
    })
    const snapshot = createSnapshot(settings, [inactiveSession, unresponsiveSession])
    const discovery = new FakePlaywrightDiscovery(snapshot, settings)

    const livePreviewService = new PlaywrightLivePreviewService({
      discoveryService: discovery as unknown as never,
      devtoolsBridge: {
        async startPreviewController() {
          throw new Error('bridge should not be called for non-previewable sessions')
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
      const blockedInactive = await fetch(`http://${config.host}:${config.port}/api/playwright/live-preview/start`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'http://127.0.0.1:47188',
        },
        body: JSON.stringify({ sessionId: inactiveSession.id }),
      })
      const inactivePayload = (await blockedInactive.json()) as { error?: string }
      expect(blockedInactive.status).toBe(409)
      expect(inactivePayload.error).toContain('inactive')

      const blockedUnresponsive = await fetch(`http://${config.host}:${config.port}/api/playwright/live-preview/start`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'http://127.0.0.1:47188',
        },
        body: JSON.stringify({ sessionId: unresponsiveSession.id }),
      })
      const unresponsivePayload = (await blockedUnresponsive.json()) as { error?: string }
      expect(blockedUnresponsive.status).toBe(409)
      expect(unresponsivePayload.error).toContain('responsive Playwright socket')

      const sessionsListResponse = await fetch(`http://${config.host}:${config.port}/playwright-live/api/sessions/list`)
      const sessionsListPayload = (await sessionsListResponse.json()) as {
        sessions?: Array<{ canConnect?: boolean; unavailableReason?: string; config?: { socketPath?: string; workspaceDir?: string } }>
      }
      expect(sessionsListResponse.status).toBe(200)
      expect(sessionsListPayload.sessions?.every((session) => session.canConnect === false)).toBe(true)
      expect(JSON.stringify(sessionsListPayload)).not.toContain('/tmp/playwright-cli-sockets')
      expect(JSON.stringify(sessionsListPayload)).not.toContain(config.paths.rootDir)
    } finally {
      await server.stop()
      await livePreviewService.stop()
    }
  })

  it('starts preview leases, prewarms controller state, and replays buffered method-style tabs/frame to late clients', async () => {
    const config = await makeTempConfig()
    const swarmManager = new FakeSwarmManager(config, [createManagerDescriptor(config.paths.rootDir)])
    const settingsService = new PlaywrightSettingsService({ dataDir: config.paths.dataDir })
    await settingsService.load()

    const settings = createSettings()
    const activeSession = createActiveSession(config.paths.rootDir)
    const snapshot = createSnapshot(settings, [activeSession])

    const discovery = new FakePlaywrightDiscovery(snapshot, settings)
    const upstreamPort = await getAvailablePort()
    const upstreamMessages: string[] = []
    let upstreamConnectionCount = 0
    let resolveFirstUpstreamPrimed: (() => void) | null = null
    const firstUpstreamPrimed = new Promise<void>((resolve) => {
      resolveFirstUpstreamPrimed = resolve
    })
    const upstreamServer = new WebSocketServer({ host: '127.0.0.1', port: upstreamPort })
    await once(upstreamServer, 'listening')
    upstreamServer.on('connection', (socket) => {
      upstreamConnectionCount += 1
      if (upstreamConnectionCount === 1) {
        socket.send(
          JSON.stringify({
            method: 'tabs',
            params: {
              tabs: [
                {
                  pageId: 'page-1',
                  selected: true,
                  title: 'Example',
                  url: 'https://example.com',
                  inspectorUrl: 'http://127.0.0.1:9222/devtools/inspector.html',
                },
              ],
            },
          }),
        )
        socket.send(JSON.stringify({ method: 'frame', params: { data: 'ZmFrZQ==' } }))
        resolveFirstUpstreamPrimed?.()
      }
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
      const isTabsMessage = (message: string): boolean =>
        message.includes('"type":"tabs"') || message.includes('"method":"tabs"')
      const isFrameMessage = (message: string): boolean =>
        message.includes('"type":"frame"') || message.includes('"method":"frame"')

      const waitForTabsAndFrame = async (socket: WebSocket, timeoutMessage: string): Promise<string[]> => {
        return await new Promise<string[]>((resolve, reject) => {
          const messages: string[] = []
          const timeout = setTimeout(() => {
            socket.off('message', onMessage)
            reject(new Error(timeoutMessage))
          }, 5_000)

          const onMessage = (data: WebSocket.RawData) => {
            const raw = data.toString()
            messages.push(raw)
            if (messages.some(isTabsMessage) && messages.some(isFrameMessage)) {
              clearTimeout(timeout)
              socket.off('message', onMessage)
              resolve(messages)
            }
          }

          socket.on('message', onMessage)
        })
      }

      const startResponse = await fetch(`http://${config.host}:${config.port}/api/playwright/live-preview/start`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'http://127.0.0.1:47188',
        },
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
      await firstUpstreamPrimed
      expect(upstreamConnectionCount).toBe(1)

      const bootstrapResponse = await fetch(
        `http://${config.host}:${config.port}/playwright-live/api/previews/${encodeURIComponent(previewId)}/bootstrap`,
      )
      const bootstrapPayload = (await bootstrapResponse.json()) as {
        bootstrap?: {
          previewId?: string
          sessionId?: string
          controllerWsUrl?: string
          inspectorWsUrl?: string | null
          session?: { socketPath?: string | null; sessionFilePath?: string; rootPath?: string }
        }
      }

      expect(bootstrapResponse.status).toBe(200)
      expect(bootstrapPayload.bootstrap?.previewId).toBe(previewId)
      expect(bootstrapPayload.bootstrap?.sessionId).toBe(activeSession.id)
      expect(bootstrapPayload.bootstrap?.controllerWsUrl).toContain(`/playwright-live/ws/controller/${previewId}`)
      expect(bootstrapPayload.bootstrap?.inspectorWsUrl).toBeNull()
      expect(bootstrapPayload.bootstrap?.session?.socketPath).toBe(`mm-session:${activeSession.id}`)
      expect(bootstrapPayload.bootstrap?.session?.sessionFilePath).toBe('')
      expect(bootstrapPayload.bootstrap?.session?.rootPath).not.toContain(config.paths.rootDir)

      const embedResponse = await fetch(`http://${config.host}:${config.port}/playwright-live/embed?previewId=${encodeURIComponent(previewId)}`)
      const embedHtml = await embedResponse.text()
      expect(embedResponse.status).toBe(200)
      expect(embedHtml).toContain(previewId)
      expect(embedHtml.indexOf('document.body.dataset')).toBeGreaterThan(embedHtml.indexOf('<body>'))
      expect(embedHtml).not.toContain(activeSession.socketPath ?? '')

      const proxySocket = new WebSocket(
        `ws://${config.host}:${config.port}/playwright-live/ws/controller/${encodeURIComponent(previewId)}`,
        {
          origin: `http://${config.host}:${config.port}`,
        },
      )
      const proxiedMessagesPromise = waitForTabsAndFrame(
        proxySocket,
        'Timed out waiting for proxied controller replay events',
      )
      await once(proxySocket, 'open')
      const proxiedMessages = await proxiedMessagesPromise
      expect(upstreamConnectionCount).toBe(1)

      const tabsMessage = proxiedMessages.find(isTabsMessage) ?? ''
      expect(tabsMessage).toContain('"method":"tabs"')
      expect(tabsMessage).not.toContain('127.0.0.1:9222')
      expect(tabsMessage).toContain('"inspectorUrl":null')

      const secondProxySocket = new WebSocket(
        `ws://${config.host}:${config.port}/playwright-live/ws/controller/${encodeURIComponent(previewId)}`,
        {
          origin: `http://${config.host}:${config.port}`,
        },
      )
      const secondProxiedMessagesPromise = waitForTabsAndFrame(
        secondProxySocket,
        'Timed out waiting for buffered controller replay events for second client',
      )
      await once(secondProxySocket, 'open')
      const secondProxiedMessages = await secondProxiedMessagesPromise
      expect(upstreamConnectionCount).toBe(1)
      expect(secondProxiedMessages.some(isFrameMessage)).toBe(true)
      expect(secondProxiedMessages.some((message) => message.includes('"method":"frame"'))).toBe(true)

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
      const closePromise = once(proxySocket, 'close')
      const secondClosePromise = once(secondProxySocket, 'close')
      const releaseResponse = await fetch(
        `http://${config.host}:${config.port}/api/playwright/live-preview/${encodeURIComponent(previewId)}`,
        {
          method: 'DELETE',
          headers: {
            origin: 'http://127.0.0.1:47188',
          },
        },
      )
      const releasePayload = (await releaseResponse.json()) as { ok?: boolean; previewId?: string; released?: boolean }
      expect(releaseResponse.status).toBe(200)
      expect(releasePayload.ok).toBe(true)
      expect(releasePayload.previewId).toBe(previewId)
      expect(releasePayload.released).toBe(true)
      await Promise.all([closePromise, secondClosePromise])

      const expiredBootstrapResponse = await fetch(
        `http://${config.host}:${config.port}/playwright-live/api/previews/${encodeURIComponent(previewId)}/bootstrap`,
      )
      expect(expiredBootstrapResponse.status).toBe(410)

      const expiredSocket = new WebSocket(
        `ws://${config.host}:${config.port}/playwright-live/ws/controller/${encodeURIComponent(previewId)}`,
        {
          origin: `http://${config.host}:${config.port}`,
        },
      )
      const expiredStatus = await new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timed out waiting for expired websocket rejection')), 5_000)
        expiredSocket.once('unexpected-response', (request, response) => {
          clearTimeout(timeout)
          resolve(response.statusCode ?? 0)
        })
        expiredSocket.once('open', () => {
          clearTimeout(timeout)
          reject(new Error('Expired websocket unexpectedly opened'))
        })
      })
      expect(expiredStatus).toBe(410)
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

  it('bootstraps the first controller client when no buffered tabs state exists', async () => {
    const config = await makeTempConfig()
    const swarmManager = new FakeSwarmManager(config, [createManagerDescriptor(config.paths.rootDir)])
    const settingsService = new PlaywrightSettingsService({ dataDir: config.paths.dataDir })
    await settingsService.load()

    const settings = createSettings()
    const activeSession = createActiveSession(config.paths.rootDir)
    const snapshot = createSnapshot(settings, [activeSession])
    const discovery = new FakePlaywrightDiscovery(snapshot, settings)

    let selectedPageId: string | null = null
    const upstreamRequests: Array<{ id: number; method: string; params?: Record<string, unknown> }> = []
    const upstreamPort = await getAvailablePort()
    const upstreamServer = new WebSocketServer({ host: '127.0.0.1', port: upstreamPort })
    await once(upstreamServer, 'listening')
    upstreamServer.on('connection', (socket) => {
      socket.on('message', (data) => {
        const request = JSON.parse(data.toString()) as { id: number; method: string; params?: Record<string, unknown> }
        upstreamRequests.push(request)

        if (request.method === 'tabs') {
          socket.send(
            JSON.stringify({
              id: request.id,
              result: {
                tabs: [
                  {
                    pageId: 'page-1',
                    selected: selectedPageId === 'page-1',
                    title: 'Example',
                    url: 'https://example.com',
                    inspectorUrl: 'http://127.0.0.1:9222/devtools/inspector.html',
                  },
                ],
              },
            }),
          )
          return
        }

        if (request.method === 'selectTab') {
          selectedPageId = typeof request.params?.pageId === 'string' ? request.params.pageId : null
          socket.send(JSON.stringify({ id: request.id, result: { ok: true } }))
        }
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
        headers: {
          'content-type': 'application/json',
          origin: 'http://127.0.0.1:47188',
        },
        body: JSON.stringify({ sessionId: activeSession.id, mode: 'focus' }),
      })
      const startPayload = (await startResponse.json()) as { preview?: { previewId?: string } }
      expect(startResponse.status).toBe(200)

      const previewId = startPayload.preview?.previewId ?? ''
      expect(previewId).toBeTruthy()

      const proxySocket = new WebSocket(
        `ws://${config.host}:${config.port}/playwright-live/ws/controller/${encodeURIComponent(previewId)}`,
        {
          origin: `http://${config.host}:${config.port}`,
        },
      )
      const tabsMessagePromise = new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timed out waiting for synthetic tabs bootstrap event')), 5_000)
        proxySocket.on('message', (data) => {
          const raw = data.toString()
          if (raw.includes('"method":"tabs"')) {
            clearTimeout(timeout)
            resolve(raw)
          }
        })
      })

      await once(proxySocket, 'open')
      const tabsMessage = await tabsMessagePromise
      expect(tabsMessage).toContain('"selected":true')
      expect(tabsMessage).toContain('"inspectorUrl":null')

      await new Promise<void>((resolve, reject) => {
        const startedAt = Date.now()
        const poll = () => {
          const tabsRequests = upstreamRequests.filter((request) => request.method === 'tabs')
          const selectTabRequest = upstreamRequests.find((request) => request.method === 'selectTab')
          if (tabsRequests.length >= 2 && selectTabRequest) {
            resolve()
            return
          }
          if (Date.now() - startedAt > 5_000) {
            reject(new Error('Timed out waiting for upstream bootstrap requests'))
            return
          }
          setTimeout(poll, 25)
        }
        poll()
      })

      expect(upstreamRequests.filter((request) => request.method === 'tabs')).toHaveLength(2)
      expect(upstreamRequests.find((request) => request.method === 'selectTab')?.params?.pageId).toBe('page-1')

      proxySocket.close()
      await once(proxySocket, 'close')
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

  it('expires preview leases and returns 410 after expiry', async () => {
    const config = await makeTempConfig()
    const swarmManager = new FakeSwarmManager(config, [createManagerDescriptor(config.paths.rootDir)])
    const settingsService = new PlaywrightSettingsService({ dataDir: config.paths.dataDir })
    await settingsService.load()

    const settings = createSettings()
    const activeSession = createActiveSession(config.paths.rootDir)
    const snapshot = createSnapshot(settings, [activeSession])
    const discovery = new FakePlaywrightDiscovery(snapshot, settings)

    let currentTime = new Date('2026-03-09T18:00:00.000Z')
    const livePreviewService = new PlaywrightLivePreviewService({
      discoveryService: discovery as unknown as never,
      previewTtlMs: 50,
      cleanupIntervalMs: 1_000,
      now: () => currentTime,
      devtoolsBridge: {
        async startPreviewController() {
          return {
            upstreamControllerUrl: 'ws://127.0.0.1:41000/controller',
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
        headers: {
          'content-type': 'application/json',
          origin: 'http://127.0.0.1:47188',
        },
        body: JSON.stringify({ sessionId: activeSession.id }),
      })
      const startPayload = (await startResponse.json()) as { preview?: { previewId?: string } }
      const previewId = startPayload.preview?.previewId ?? ''
      expect(startResponse.status).toBe(200)
      expect(previewId).toBeTruthy()

      currentTime = new Date(currentTime.getTime() + 1_000)
      livePreviewService.pruneExpiredPreviews()

      const expiredBootstrapResponse = await fetch(
        `http://${config.host}:${config.port}/playwright-live/api/previews/${encodeURIComponent(previewId)}/bootstrap`,
      )
      expect(expiredBootstrapResponse.status).toBe(410)
    } finally {
      await server.stop()
      await livePreviewService.stop()
    }
  })
})
