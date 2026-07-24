import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { BrowserAutomationRequest, BrowserAutomationResponse, BrowserHostRegistration, ServerEvent } from '@forge/protocol'
import { BrowserAutomationService } from '../../swarm/browser-automation/browser-automation-service.js'
import { handleBrowserCommand } from '../commands/browser-command-handler.js'
import { parseClientCommand } from '../ws-command-parser.js'
import { BUILDER_COMMAND_ACCESS } from '../builder-command-access.js'
import type { WebSocket } from 'ws'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

function registration(hostId = 'host-1'): BrowserHostRegistration {
  return {
    hostId,
    clientInstanceId: 'client-1',
    capabilities: {
      supportedOperations: ['status', 'open', 'navigate', 'resize', 'snapshot', 'click', 'type', 'press', 'scroll', 'evaluate', 'waitFor', 'recordingStart', 'recordingStop'],
      electronVersion: '37', chromiumVersion: '138', playwrightVersion: '1.60.0', maxResponseBytes: 8 * 1024 * 1024,
      supportsSandboxedWebviews: true, supportsCapturePage: true, supportsRecording: true,
    },
    registeredAt: new Date().toISOString(),
  }
}

describe('browser websocket transport', () => {
  it('rejects malformed host commands and classifies all browser commands as admin-only', () => {
    expect(parseClientCommand(Buffer.from(JSON.stringify({ type: 'browser_host_register', registration: { hostId: '' } })))).toEqual({
      ok: false,
      error: 'registration.capabilities must be an object',
    })
    expect(parseClientCommand(Buffer.from(JSON.stringify({ type: 'browser_host_response', response: { requestId: 1 } }))).ok).toBe(false)
    expect(parseClientCommand(Buffer.from(JSON.stringify({ type: 'browser_host_state_report', hostId: 'host-1', hostGeneration: 1, sessions: [] }))).ok).toBe(false)
    for (const type of [
      'browser_host_register', 'browser_host_hydrate', 'browser_host_focus', 'browser_host_response', 'browser_host_state_report',
      'browser_panel_reveal_acknowledge', 'browser_tab_open', 'browser_tab_activate', 'browser_tab_close', 'browser_tab_resize',
      'browser_recording_start', 'browser_recording_stop',
    ] as const) expect(BUILDER_COMMAND_ACCESS[type]).toBe('admin')
  })

  it('normalizes legacy host payloads to Managed Electron and accepts host-specific External Chrome capabilities', () => {
    const legacy = parseClientCommand(Buffer.from(JSON.stringify({
      type: 'browser_host_register', requestId: 'legacy', registration: registration(),
    })))
    expect(legacy).toMatchObject({
      ok: true,
      command: { registration: { capabilities: {
        hostKind: 'managed-electron', protocolVersions: { minimum: 1, maximum: 1 },
        features: { resize: true, recording: true, capturePage: true },
      } } },
    })
    const external = parseClientCommand(Buffer.from(JSON.stringify({
      type: 'browser_host_register', requestId: 'external', registration: {
        hostId: 'external-host', clientInstanceId: 'external-instance', registeredAt: new Date().toISOString(),
        capabilities: {
          hostKind: 'external-chrome', protocolVersions: { minimum: 1, maximum: 1 },
          supportedOperations: ['status', 'open', 'navigate', 'snapshot', 'click', 'type', 'press', 'scroll', 'evaluate', 'waitFor'],
          maxResponseBytes: 1_000_000,
          features: { resize: false, recording: false, capturePage: true, downloadEvents: false, downloadArtifacts: false, downloadOpen: false },
          runtimeVersions: { chrome: '138', extension: 'm0-fake' },
        },
      },
    })))
    expect(external).toMatchObject({ ok: true, command: { registration: { capabilities: { hostKind: 'external-chrome' } } } })
    const oldResponse = parseClientCommand(Buffer.from(JSON.stringify({
      type: 'browser_host_response', response: {
        requestId: 'old', sessionAgentId: 'session-1', profileId: 'profile-1', tabId: null,
        hostId: 'host-1', hostGeneration: 1, operation: 'status', ok: false, elapsedMs: 0,
        error: { code: 'unavailable-host', message: 'old', retryable: true },
      },
    })))
    expect(oldResponse).toMatchObject({ ok: true, command: { response: { hostKind: 'managed-electron' } } })
  })

  it('recovers independently dropped registration and hydration phases without changing the connection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-browser-handshake-retry-'))
    roots.push(root)
    const service = new BrowserAutomationService({ dataDir: root })
    const socket = {} as WebSocket
    const delivered: ServerEvent[] = []
    let dropRegistration = true
    let dropHydration = true
    const common = {
      socket,
      connectionId: 'same-connection',
      browserAutomationService: service,
      resolveManagerContextAgentId: () => 'session-1',
      resolveProfileIdForAgent: () => 'profile-1',
      send: () => undefined,
      sendCritical: async (_socket: WebSocket, event: ServerEvent) => {
        if (event.type === 'browser_host_connected' && dropRegistration) { dropRegistration = false; return null }
        if (event.type === 'browser_host_hydration_chunk' && dropHydration) { dropHydration = false; return null }
        delivered.push(event)
        return Buffer.byteLength(JSON.stringify(event))
      },
      broadcastToSession: () => undefined,
      hydrateHostSessions: async () => [],
    }

    await handleBrowserCommand({ ...common, command: { type: 'browser_host_register', requestId: 'register-dropped', registration: registration() } })
    expect(delivered).toEqual([])
    await handleBrowserCommand({ ...common, command: { type: 'browser_host_register', requestId: 'register-retry', registration: registration() } })
    const connected = delivered[0] as Extract<ServerEvent, { type: 'browser_host_connected' }>
    expect(connected).toMatchObject({ type: 'browser_host_connected', requestId: 'register-retry', host: { hostGeneration: 2 } })

    await handleBrowserCommand({ ...common, command: { type: 'browser_host_hydrate', requestId: 'hydrate-dropped', hostId: 'host-1', hostGeneration: 2 } })
    expect(delivered).toHaveLength(1)
    await handleBrowserCommand({ ...common, command: { type: 'browser_host_hydrate', requestId: 'hydrate-retry', hostId: 'host-1', hostGeneration: 2 } })
    expect(delivered[1]).toMatchObject({ type: 'browser_host_hydration_chunk', requestId: 'hydrate-retry', hostGeneration: 2, chunkIndex: 0, chunkCount: 1 })
    expect(service.broker.isCurrentConnection('same-connection', 'host-1', 2)).toBe(true)
  })

  it('frames oversized multi-session hydration below the websocket event limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-browser-handshake-chunks-'))
    roots.push(root)
    const service = new BrowserAutomationService({ dataDir: root })
    const socket = {} as WebSocket
    const delivered: ServerEvent[] = []
    const sessions = Array.from({ length: 6 }, (_, index) => ({
      sessionAgentId: `session-${index}`,
      profileId: `profile-${index}`,
      padding: 'x'.repeat(220_000),
    })) as unknown as Awaited<ReturnType<BrowserAutomationService['getSessionSnapshot']>>[]
    const common = {
      socket,
      connectionId: 'connection-1',
      browserAutomationService: service,
      resolveManagerContextAgentId: () => undefined,
      resolveProfileIdForAgent: () => undefined,
      send: () => undefined,
      sendCritical: async (_socket: WebSocket, event: ServerEvent) => {
        delivered.push(event)
        return Buffer.byteLength(JSON.stringify(event))
      },
      broadcastToSession: () => undefined,
      hydrateHostSessions: async () => sessions,
    }
    await handleBrowserCommand({ ...common, command: { type: 'browser_host_register', requestId: 'register-1', registration: registration() } })
    await handleBrowserCommand({ ...common, command: { type: 'browser_host_hydrate', requestId: 'hydrate-1', hostId: 'host-1', hostGeneration: 1 } })
    const chunks = delivered.filter((event): event is Extract<ServerEvent, { type: 'browser_host_hydration_chunk' }> => event.type === 'browser_host_hydration_chunk')
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.map((chunk) => chunk.chunkIndex)).toEqual(chunks.map((_chunk, index) => index))
    expect(chunks.every((chunk) => Buffer.byteLength(JSON.stringify(chunk)) < 1 * 1024 * 1024)).toBe(true)
    const decoded = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.payloadBase64, 'base64')))
    expect(JSON.parse(decoded.toString('utf8'))).toHaveLength(6)
  })

  it('routes human recording through the service and returns a canonical artifact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-browser-ws-recording-'))
    roots.push(root)
    const service = new BrowserAutomationService({ dataDir: root })
    const socket = {} as WebSocket
    const sent: ServerEvent[] = []
    const common = {
      socket,
      connectionId: 'connection-1',
      subscribedAgentId: 'session-1',
      browserAutomationService: service,
      resolveManagerContextAgentId: () => 'session-1',
      resolveProfileIdForAgent: () => 'profile-1',
      send: (_socket: WebSocket, event: ServerEvent) => sent.push(event),
      broadcastToSession: () => undefined,
      hydrateHostSessions: async () => [],
    }
    await handleBrowserCommand({ ...common, command: { type: 'browser_host_register', requestId: 'register-1', registration: registration() } })

    const opening = handleBrowserCommand({
      ...common,
      command: { type: 'browser_tab_open', requestId: 'open-1', sessionAgentId: 'session-1', profileId: 'profile-1' },
    })
    const openRequest = await nextAutomationRequest(sent, 'open')
    const initialTab = tabFor(openRequest, 'tab-1')
    await handleBrowserCommand({ ...common, command: { type: 'browser_host_response', response: {
      ...routing(openRequest), operation: 'open', ok: true, result: { tab: initialTab, created: true, panelRevealRequested: false }, elapsedMs: 1, updatedTab: initialTab,
    } } })
    await opening

    const starting = handleBrowserCommand({
      ...common,
      command: { type: 'browser_recording_start', requestId: 'recording-start-1', sessionAgentId: 'session-1', tabId: 'tab-1' },
    })
    const startRequest = await nextAutomationRequest(sent, 'recordingStart')
    expect(startRequest.artifactDirectory).toBeNull()
    const recordingTab = { ...initialTab, recording: { recordingId: 'recording-1', startedAt: new Date().toISOString(), mimeType: 'video/webm' } }
    await handleBrowserCommand({ ...common, command: { type: 'browser_host_response', response: {
      ...routing(startRequest), operation: 'recordingStart', ok: true,
      result: { recordingId: 'recording-1', tabId: 'tab-1', recording: true, startedAt: recordingTab.recording.startedAt, mimeType: 'video/webm', width: 1000, height: 700 },
      elapsedMs: 2, updatedTab: recordingTab,
    } } })
    await starting

    const stopping = handleBrowserCommand({
      ...common,
      command: { type: 'browser_recording_stop', requestId: 'recording-stop-1', sessionAgentId: 'session-1', tabId: 'tab-1', recordingId: 'recording-1' },
    })
    const stopRequest = await nextAutomationRequest(sent, 'recordingStop')
    const artifactDirectory = service.store.getArtifactsDirectory('profile-1', 'session-1')
    expect(stopRequest.artifactDirectory).toBe(artifactDirectory)
    await mkdir(artifactDirectory, { recursive: true })
    const artifactPath = join(artifactDirectory, 'recording-1.webm')
    await writeFile(artifactPath, Buffer.from('real recording'))
    await handleBrowserCommand({ ...common, command: { type: 'browser_host_response', response: {
      ...routing(stopRequest), operation: 'recordingStop', ok: true,
      result: { recordingId: 'recording-1', tabId: 'tab-1', path: artifactPath, mimeType: 'video/webm', extension: 'webm', sizeBytes: 14, width: 1000, height: 700, createdAt: new Date().toISOString() },
      elapsedMs: 3, updatedTab: { ...recordingTab, recording: null },
    } } })
    await stopping

    const succeeded = sent.find((event): event is Extract<ServerEvent, { type: 'browser_recording_command_succeeded' }> =>
      event.type === 'browser_recording_command_succeeded' && event.commandType === 'browser_recording_stop')
    expect(succeeded?.result.path).toBe(artifactPath)
    expect(await readFile(succeeded!.result.path, 'utf8')).toBe('real recording')
  })

  it('rejects human recording for the wrong session, tab, or host connection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-browser-ws-recording-errors-'))
    roots.push(root)
    const service = new BrowserAutomationService({ dataDir: root })
    const socket = {} as WebSocket
    const sent: ServerEvent[] = []
    const common = {
      socket,
      connectionId: 'connection-1',
      subscribedAgentId: 'session-1',
      browserAutomationService: service,
      resolveManagerContextAgentId: () => 'session-1',
      resolveProfileIdForAgent: () => 'profile-1',
      send: (_socket: WebSocket, event: ServerEvent) => sent.push(event),
      broadcastToSession: () => undefined,
      hydrateHostSessions: async () => [],
    }
    await handleBrowserCommand({ ...common, command: { type: 'browser_host_register', requestId: 'register-1', registration: registration() } })

    await handleBrowserCommand({ ...common, command: { type: 'browser_recording_start', requestId: 'wrong-session', sessionAgentId: 'session-2', tabId: 'tab-1' } })
    await handleBrowserCommand({ ...common, command: { type: 'browser_recording_start', requestId: 'wrong-tab', sessionAgentId: 'session-1', tabId: 'missing-tab' } })
    await handleBrowserCommand({ ...common, connectionId: 'connection-2', command: { type: 'browser_recording_start', requestId: 'wrong-host', sessionAgentId: 'session-1', tabId: 'tab-1' } })

    const errors = sent.filter((event): event is Extract<ServerEvent, { type: 'error' }> => event.type === 'error')
    expect(errors.map((event) => [event.requestId, event.code])).toEqual([
      ['wrong-session', 'BROWSER_RECORDING_START_SUBSCRIPTION_MISMATCH'],
      ['wrong-tab', 'BROWSER_RECORDING_START_TAB_NOT_FOUND'],
      ['wrong-host', 'BROWSER_RECORDING_START_BROWSER_UNAVAILABLE'],
    ])
    expect(sent.filter((event) => event.type === 'browser_automation_request')).toHaveLength(0)
  })

  it('routes an open request only through the registering socket generation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-browser-ws-'))
    roots.push(root)
    const service = new BrowserAutomationService({ dataDir: root })
    const socket = {} as WebSocket
    const sent: ServerEvent[] = []
    const common = {
      socket,
      connectionId: 'connection-1',
      browserAutomationService: service,
      resolveManagerContextAgentId: () => 'session-1',
      resolveProfileIdForAgent: () => 'profile-1',
      send: (_socket: WebSocket, event: ServerEvent) => sent.push(event),
      broadcastToSession: () => undefined,
      hydrateHostSessions: async () => [],
    }

    await handleBrowserCommand({ ...common, command: { type: 'browser_host_register', requestId: 'register-1', registration: registration() } })
    expect(sent).toEqual([expect.objectContaining({ type: 'browser_host_connected', requestId: 'register-1' })])
    await handleBrowserCommand({ ...common, command: { type: 'browser_host_hydrate', requestId: 'hydrate-1', hostId: 'host-1', hostGeneration: 1 } })
    expect(sent.map((event) => event.type)).toEqual(['browser_host_connected', 'browser_host_hydration_chunk'])

    const opening = handleBrowserCommand({
      ...common,
      subscribedAgentId: 'session-1',
      command: { type: 'browser_tab_open', requestId: 'ui-1', sessionAgentId: 'session-1', profileId: 'profile-1', url: 'https://example.com', activate: true },
    })
    await viWaitFor(() => sent.some((event) => event.type === 'browser_automation_request'))
    const request = (sent.find((event) => event.type === 'browser_automation_request') as Extract<ServerEvent, { type: 'browser_automation_request' }>).request
    const tab = tabFor(request, 'tab-1')
    const response: BrowserAutomationResponse = {
      ...routing(request),
      ok: true,
      operation: 'open',
      result: { tab, created: true, panelRevealRequested: false },
      elapsedMs: 2,
      updatedTab: tab,
    }
    await handleBrowserCommand({ ...common, command: { type: 'browser_host_response', response } })
    await opening

    const succeeded = sent.find((event) => event.type === 'browser_tab_command_succeeded') as Extract<ServerEvent, { type: 'browser_tab_command_succeeded' }>
    expect(succeeded.requestId).toBe('ui-1')
    expect(succeeded.snapshot.tabs[0]?.tabId).toBe('tab-1')

    await handleBrowserCommand({ ...common, connectionId: 'connection-2', command: { type: 'browser_host_register', requestId: 'register-1', registration: registration('host-2') } })
    expect(service.acceptHostResponse('connection-1', response)).toBe('duplicate')
    expect(service.unregisterHost('connection-1')).toBe(false)
    expect(service.broker.getConnectionSnapshot().hostId).toBe('host-2')
  })

  it('preserves active and default selection when browser_tab_open sets activate:false', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-browser-ws-activate-'))
    roots.push(root)
    const service = new BrowserAutomationService({ dataDir: root })
    const socket = {} as WebSocket
    const sent: ServerEvent[] = []
    const common = {
      socket,
      connectionId: 'connection-1',
      subscribedAgentId: 'session-1',
      browserAutomationService: service,
      resolveManagerContextAgentId: () => 'session-1',
      resolveProfileIdForAgent: () => 'profile-1',
      send: (_socket: WebSocket, event: ServerEvent) => sent.push(event),
      broadcastToSession: () => undefined,
      hydrateHostSessions: async () => [],
    }
    await handleBrowserCommand({ ...common, command: { type: 'browser_host_register', requestId: 'register-1', registration: registration() } })

    const firstOpen = handleBrowserCommand({
      ...common,
      command: { type: 'browser_tab_open', requestId: 'open-1', sessionAgentId: 'session-1', profileId: 'profile-1', activate: true },
    })
    const firstRequest = await nextAutomationRequest(sent, 'open')
    const firstTab = tabFor(firstRequest, 'tab-1')
    await handleBrowserCommand({ ...common, command: { type: 'browser_host_response', response: {
      ...routing(firstRequest), operation: 'open', ok: true, result: { tab: firstTab, created: true, panelRevealRequested: false }, elapsedMs: 1, updatedTab: firstTab,
    } } })
    await firstOpen

    sent.length = 0
    const secondOpen = handleBrowserCommand({
      ...common,
      command: { type: 'browser_tab_open', requestId: 'open-2', sessionAgentId: 'session-1', profileId: 'profile-1', activate: false },
    })
    const secondRequest = await nextAutomationRequest(sent, 'open')
    const secondTab = tabFor(secondRequest, 'tab-2')
    await handleBrowserCommand({ ...common, command: { type: 'browser_host_response', response: {
      ...routing(secondRequest), operation: 'open', ok: true, result: { tab: secondTab, created: true, panelRevealRequested: false }, elapsedMs: 1, updatedTab: secondTab,
    } } })
    await secondOpen

    const succeeded = sent.find((event): event is Extract<ServerEvent, { type: 'browser_tab_command_succeeded' }> =>
      event.type === 'browser_tab_command_succeeded' && event.requestId === 'open-2')
    expect(succeeded?.snapshot).toMatchObject({
      activeTabId: 'tab-1',
      defaultTabId: 'tab-1',
      tabs: [expect.objectContaining({ tabId: 'tab-1' }), expect.objectContaining({ tabId: 'tab-2' })],
    })
  })

  it('persists reveal acknowledgement only from the selected current host generation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-browser-ws-reveal-ack-'))
    roots.push(root)
    const service = new BrowserAutomationService({ dataDir: root })
    const socket = {} as WebSocket
    const sent: ServerEvent[] = []
    const common = {
      socket,
      connectionId: 'connection-1',
      subscribedAgentId: 'session-1',
      browserAutomationService: service,
      resolveManagerContextAgentId: () => 'session-1',
      resolveProfileIdForAgent: () => 'profile-1',
      send: (_socket: WebSocket, event: ServerEvent) => sent.push(event),
      broadcastToSession: () => undefined,
      hydrateHostSessions: async () => [],
    }
    const canonical = service.store.createEmpty('profile-1', 'session-1')
    canonical.tabs = [tabFor({ sessionAgentId: 'session-1', profileId: 'profile-1' }, 'tab-1')]
    canonical.activeTabId = 'tab-1'
    canonical.defaultTabId = 'tab-1'
    canonical.panelVisible = true
    canonical.panelReveal = { sequence: 4, acknowledgedSequence: 3, tabId: 'tab-1' }
    canonical.revision = 2
    await service.store.save(canonical)
    await handleBrowserCommand({ ...common, command: { type: 'browser_host_register', requestId: 'register-1', registration: registration() } })
    sent.length = 0

    await handleBrowserCommand({ ...common, command: {
      type: 'browser_panel_reveal_acknowledge', requestId: 'ack-1', hostId: 'host-1', hostGeneration: 1,
      sessionAgentId: 'session-1', profileId: 'profile-1', tabId: 'tab-1', sequence: 4,
    } })
    expect(sent.at(-1)).toMatchObject({
      type: 'browser_panel_reveal_acknowledged', requestId: 'ack-1',
      snapshot: { revision: 3, panelReveal: { sequence: 4, acknowledgedSequence: 4 } },
    })
    await expect(service.store.load('profile-1', 'session-1')).resolves.toMatchObject({
      panelReveal: { sequence: 4, acknowledgedSequence: 4 },
    })

    await handleBrowserCommand({ ...common, command: {
      type: 'browser_panel_reveal_acknowledge', requestId: 'stale-ack', hostId: 'host-1', hostGeneration: 2,
      sessionAgentId: 'session-1', profileId: 'profile-1', tabId: 'tab-1', sequence: 4,
    } })
    expect(sent.at(-1)).toMatchObject({ type: 'error', requestId: 'stale-ack', code: expect.stringContaining('STALE_HOST_GENERATION') })
  })

  it('acknowledges accepted reports and returns canonical state for conflicts and stale generations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-browser-ws-report-'))
    roots.push(root)
    const service = new BrowserAutomationService({ dataDir: root })
    const socket = {} as WebSocket
    const sent: ServerEvent[] = []
    const common = {
      socket,
      connectionId: 'connection-1',
      browserAutomationService: service,
      resolveManagerContextAgentId: () => 'session-1',
      resolveProfileIdForAgent: () => 'profile-1',
      send: (_socket: WebSocket, event: ServerEvent) => sent.push(event),
      broadcastToSession: () => undefined,
      hydrateHostSessions: async () => [],
    }
    const canonical = service.store.createEmpty('profile-1', 'session-1')
    canonical.tabs = [tabFor({ sessionAgentId: 'session-1', profileId: 'profile-1' }, 'tab-1')]
    canonical.activeTabId = 'tab-1'
    canonical.defaultTabId = 'tab-1'
    canonical.panelVisible = true
    canonical.revision = 2
    canonical.recentActions = [{ id: 'action-1', operation: 'status', tabId: 'tab-1', status: 'succeeded', startedAt: new Date(0).toISOString() }]
    await service.store.save(canonical)
    await handleBrowserCommand({ ...common, command: { type: 'browser_host_register', requestId: 'register-1', registration: registration() } })
    sent.length = 0

    const runtimeTab = { ...canonical.tabs[0]!, title: 'Runtime title', controller: 'agent' as const }
    await handleBrowserCommand({ ...common, command: {
      type: 'browser_host_state_report', requestId: 'report-conflict', hostId: 'host-1', hostGeneration: 1,
      sessions: [{ sessionAgentId: 'session-1', profileId: 'profile-1', baseRevision: 1, tabs: [runtimeTab] }],
    } })
    expect(sent.at(-1)).toMatchObject({
      type: 'browser_host_state_report_result', requestId: 'report-conflict',
      result: { status: 'processed', sessions: [{ status: 'revision-conflict', snapshot: {
        revision: 2, activeTabId: 'tab-1', panelVisible: true, recentActions: [{ id: 'action-1' }],
      } }] },
    })

    await handleBrowserCommand({ ...common, command: {
      type: 'browser_host_state_report', requestId: 'report-accepted', hostId: 'host-1', hostGeneration: 1,
      sessions: [{ sessionAgentId: 'session-1', profileId: 'profile-1', baseRevision: 2, tabs: [runtimeTab] }],
    } })
    expect(sent.at(-1)).toMatchObject({
      type: 'browser_host_state_report_result', requestId: 'report-accepted',
      result: { status: 'processed', sessions: [{ status: 'accepted', snapshot: {
        revision: 3, activeTabId: 'tab-1', defaultTabId: 'tab-1', panelVisible: true,
        tabs: [{ title: 'Runtime title', controller: 'agent' }], recentActions: [{ id: 'action-1' }],
      } }] },
    })

    await handleBrowserCommand({ ...common, connectionId: 'connection-2', command: { type: 'browser_host_register', requestId: 'register-1', registration: registration('host-2') } })
    await handleBrowserCommand({ ...common, command: {
      type: 'browser_host_state_report', requestId: 'report-stale', hostId: 'host-1', hostGeneration: 1,
      sessions: [{ sessionAgentId: 'session-1', profileId: 'profile-1', baseRevision: 3, tabs: [runtimeTab] }],
    } })
    expect(sent.at(-1)).toEqual({
      type: 'browser_host_state_report_result', requestId: 'report-stale',
      result: { hostKind: 'managed-electron', hostId: 'host-1', hostGeneration: 1, status: 'stale-host-generation', sessions: [] },
    })
  })
})

function routing(request: BrowserAutomationRequest) {
  return {
    requestId: request.requestId,
    hostKind: request.hostKind,
    sessionAgentId: request.sessionAgentId,
    profileId: request.profileId,
    tabId: request.tabId,
    hostId: request.hostId,
    hostGeneration: request.hostGeneration,
  }
}
function tabFor(request: Pick<BrowserAutomationRequest, 'hostKind' | 'sessionAgentId' | 'profileId'>, tabId: string) {
  const now = new Date().toISOString()
  return {
    hostKind: request.hostKind, tabId, sessionAgentId: request.sessionAgentId, profileId: request.profileId, url: 'https://example.com/', title: 'Example',
    lifecycle: 'ready' as const, loading: false, live: true, canGoBack: false, canGoForward: false, zoomFactor: 1,
    controller: 'none' as const, agentCursor: null, recording: null, viewportSetting: { mode: 'fill' as const }, renderedViewport: { width: 1000, height: 700, deviceScaleFactor: 1 }, error: null, createdAt: now, updatedAt: now,
  }
}
async function nextAutomationRequest(sent: ServerEvent[], operation: BrowserAutomationRequest['operation']): Promise<BrowserAutomationRequest> {
  await viWaitFor(() => sent.some((event) => event.type === 'browser_automation_request' && event.request.operation === operation))
  return (sent.find((event) => event.type === 'browser_automation_request' && event.request.operation === operation) as Extract<ServerEvent, { type: 'browser_automation_request' }>).request
}

async function viWaitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  throw new Error('Timed out waiting for event')
}
