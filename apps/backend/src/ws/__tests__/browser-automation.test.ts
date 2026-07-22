import { mkdtemp, rm } from 'node:fs/promises'
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
    for (const type of [
      'browser_host_register', 'browser_host_focus', 'browser_host_response', 'browser_host_state_report',
      'browser_tab_open', 'browser_tab_activate', 'browser_tab_close', 'browser_tab_resize',
    ] as const) expect(BUILDER_COMMAND_ACCESS[type]).toBe('admin')
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

    await handleBrowserCommand({ ...common, command: { type: 'browser_host_register', registration: registration() } })
    expect(sent.map((event) => event.type)).toEqual(['browser_host_connected', 'browser_host_state_snapshot'])

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

    await handleBrowserCommand({ ...common, connectionId: 'connection-2', command: { type: 'browser_host_register', registration: registration('host-2') } })
    expect(service.acceptHostResponse('connection-1', response)).toBe('duplicate')
    expect(service.unregisterHost('connection-1')).toBe(false)
    expect(service.broker.getConnectionSnapshot().hostId).toBe('host-2')
  })
})

function routing(request: BrowserAutomationRequest) {
  return {
    requestId: request.requestId,
    sessionAgentId: request.sessionAgentId,
    profileId: request.profileId,
    tabId: request.tabId,
    hostId: request.hostId,
    hostGeneration: request.hostGeneration,
  }
}
function tabFor(request: BrowserAutomationRequest, tabId: string) {
  const now = new Date().toISOString()
  return {
    tabId, sessionAgentId: request.sessionAgentId, profileId: request.profileId, url: 'https://example.com/', title: 'Example',
    lifecycle: 'ready' as const, loading: false, live: true, canGoBack: false, canGoForward: false, zoomFactor: 1,
    controller: 'none' as const, agentCursor: null, recording: null, viewportSetting: { mode: 'fill' as const }, renderedViewport: { width: 1000, height: 700, deviceScaleFactor: 1 }, error: null, createdAt: now, updatedAt: now,
  }
}
async function viWaitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  throw new Error('Timed out waiting for event')
}
