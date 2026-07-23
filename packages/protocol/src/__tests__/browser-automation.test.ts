import { describe, expect, expectTypeOf, it } from 'vitest'

import type { ClientCommand } from '../client-commands.js'
import type { ServerEvent } from '../server-events.js'
import {
  BROWSER_AUTOMATION_DEFAULT_TIMEOUT_MS,
  BROWSER_AUTOMATION_MAX_EVALUATE_BYTES,
  BROWSER_AUTOMATION_MAX_TIMEOUT_MS,
  BROWSER_AUTOMATION_MAX_URL_LENGTH,
  BROWSER_AUTOMATION_OPERATIONS,
  BROWSER_VIEWPORT_MAX_AREA,
  BROWSER_VIEWPORT_PRESETS,
  BrowserAutomationContractError,
  type BrowserAutomationInputByOperation,
  type BrowserAutomationOperation,
  type BrowserAutomationRequest,
  type BrowserAutomationResponse,
  type BrowserAutomationResultByOperation,
  type BrowserHostRegistration,
  type BrowserSessionSnapshot,
  isBrowserAutomationOperation,
  parseBrowserAutomationInput,
  resolveBrowserViewportPreset,
} from '../browser-automation.js'
import { getWsRequestContract } from '../ws-request-contract.js'

const validInputs = {
  status: {},
  open: {},
  navigate: { url: 'localhost:5173' },
  resize: { mode: 'fill' },
  snapshot: {},
  click: { locator: "role=button[name='Save']" },
  type: { selector: '#message', text: 'hello' },
  press: { key: 'Enter', modifiers: ['Meta'] },
  scroll: { deltaY: 400 },
  evaluate: { expression: 'Promise.resolve(document.title)' },
  waitFor: { text: 'Ready' },
  recordingStart: {},
  recordingStop: {},
} as const

describe('browser automation operation contract', () => {
  it('exports all 13 operations and operation-indexed inputs/results', () => {
    expect(BROWSER_AUTOMATION_OPERATIONS).toEqual([
      'status',
      'open',
      'navigate',
      'resize',
      'snapshot',
      'click',
      'type',
      'press',
      'scroll',
      'evaluate',
      'waitFor',
      'recordingStart',
      'recordingStop',
    ])
    expectTypeOf<keyof BrowserAutomationInputByOperation>().toEqualTypeOf<BrowserAutomationOperation>()
    expectTypeOf<keyof BrowserAutomationResultByOperation>().toEqualTypeOf<BrowserAutomationOperation>()

    for (const operation of BROWSER_AUTOMATION_OPERATIONS) {
      expect(isBrowserAutomationOperation(operation)).toBe(true)
      expect(() => parseBrowserAutomationInput(operation, validInputs[operation])).not.toThrow()
    }
    expect(isBrowserAutomationOperation('launch')).toBe(false)
  })

  it('applies T3-compatible defaults', () => {
    expect(parseBrowserAutomationInput('open', {})).toEqual({
      show: true,
      reuseExistingTab: true,
    })
    expect(parseBrowserAutomationInput('navigate', { environmentPort: 3_000 })).toEqual({
      environmentPort: 3_000,
      readiness: 'load',
      timeoutMs: BROWSER_AUTOMATION_DEFAULT_TIMEOUT_MS,
    })
    expect(parseBrowserAutomationInput('type', { text: '' })).toEqual({
      text: '',
      clear: false,
      timeoutMs: BROWSER_AUTOMATION_DEFAULT_TIMEOUT_MS,
    })
    expect(parseBrowserAutomationInput('evaluate', { expression: '1 + 1' })).toEqual({
      expression: '1 + 1',
      awaitPromise: true,
      returnByValue: true,
    })
  })

  it('retains T3 viewport presets and resolves orientation', () => {
    expect(Object.keys(BROWSER_VIEWPORT_PRESETS)).toHaveLength(17)
    expect(resolveBrowserViewportPreset('iphone-se')).toEqual({
      mode: 'preset',
      presetId: 'iphone-se',
      orientation: 'portrait',
      width: 375,
      height: 667,
    })
    expect(resolveBrowserViewportPreset('iphone-se', 'landscape')).toEqual({
      mode: 'preset',
      presetId: 'iphone-se',
      orientation: 'landscape',
      width: 667,
      height: 375,
    })
  })

  it.each([
    ['open', { tabId: 'tab-1', reuseExistingTab: false }],
    ['navigate', {}],
    ['navigate', { url: 'https://forge.example', environmentPort: 4_000 }],
    ['navigate', { url: 'https://forge.example', environmentProtocol: 'https' }],
    ['resize', { mode: 'fill', width: 800 }],
    ['resize', { mode: 'freeform', width: 1_000 }],
    ['resize', { mode: 'freeform', width: 3_840, height: 3_840 }],
    ['resize', { mode: 'preset', presetId: 'not-a-device' }],
    ['click', { locator: 'text=Save', selector: '#save' }],
    ['click', { x: 1 }],
    ['type', { text: 'x', locator: 'text=A', selector: '#a' }],
    ['scroll', {}],
    ['scroll', { deltaY: 1, locator: 'text=A', selector: '#a' }],
    ['waitFor', {}],
    ['waitFor', { locator: 'text=A', selector: '#a' }],
    ['snapshot', { extra: true }],
  ] as const)('rejects invalid %s discriminated input %#', (operation, input) => {
    expect(() => parseBrowserAutomationInput(operation, input)).toThrow(BrowserAutomationContractError)
  })

  it('enforces timeout, URL, expression, viewport, and finite-number bounds', () => {
    expect(() => parseBrowserAutomationInput('navigate', { url: 'x', timeoutMs: 0 })).toThrow()
    expect(() => parseBrowserAutomationInput('navigate', { url: 'x', timeoutMs: BROWSER_AUTOMATION_MAX_TIMEOUT_MS + 1 })).toThrow()
    expect(parseBrowserAutomationInput('navigate', { url: 'x', timeoutMs: BROWSER_AUTOMATION_MAX_TIMEOUT_MS }).timeoutMs).toBe(BROWSER_AUTOMATION_MAX_TIMEOUT_MS)
    expect(() => parseBrowserAutomationInput('open', { url: 'x'.repeat(BROWSER_AUTOMATION_MAX_URL_LENGTH + 1) })).toThrow()
    expect(() => parseBrowserAutomationInput('evaluate', { expression: 'x'.repeat(BROWSER_AUTOMATION_MAX_EVALUATE_BYTES + 1) })).toThrow()
    expect(() => parseBrowserAutomationInput('resize', { mode: 'freeform', width: 239, height: 800 })).toThrow()
    expect(() => parseBrowserAutomationInput('click', { x: Number.NaN, y: 1 })).toThrow()
    expect(BROWSER_VIEWPORT_MAX_AREA).toBe(3_840 * 2_160)
  })
})

describe('browser host, session, and routing wire contract', () => {
  const host: BrowserHostRegistration = {
    hostId: 'desktop-host',
    clientInstanceId: 'desktop-installation',
    registeredAt: '2026-07-22T00:00:00.000Z',
    capabilities: {
      supportedOperations: [...BROWSER_AUTOMATION_OPERATIONS],
      electronVersion: '37.10.3',
      chromiumVersion: '138.0.7204.251',
      playwrightVersion: '1.60.0',
      maxResponseBytes: 8_000_000,
      supportsSandboxedWebviews: true,
      supportsCapturePage: true,
      supportsRecording: true,
    },
  }

  const session: BrowserSessionSnapshot = {
    schemaVersion: 1,
    sessionAgentId: 'session-1',
    profileId: 'profile-1',
    hostingState: 'hosted',
    tabs: [],
    activeTabId: null,
    defaultTabId: null,
    panelVisible: false,
    panelReveal: { sequence: 0, acknowledgedSequence: 0, tabId: null },
    recentActions: [],
    revision: 1,
    createdAt: '2026-07-22T00:00:00.000Z',
    updatedAt: '2026-07-22T00:00:00.000Z',
  }

  it('requires request, session, profile, tab, host, generation, deadline, and artifact routing', () => {
    const request: BrowserAutomationRequest = {
      requestId: 'request-1',
      sessionAgentId: 'session-1',
      profileId: 'profile-1',
      tabId: null,
      hostId: 'desktop-host',
      hostGeneration: 4,
      deadlineAt: '2026-07-22T00:00:15.000Z',
      artifactDirectory: null,
      operation: 'status',
      input: {},
    }
    expect(JSON.parse(JSON.stringify(request))).toEqual(request)
  })

  it('serializes mutually exclusive success and typed failure responses', () => {
    const success: BrowserAutomationResponse = {
      requestId: 'request-1',
      sessionAgentId: 'session-1',
      profileId: 'profile-1',
      tabId: null,
      hostId: 'desktop-host',
      hostGeneration: 4,
      elapsedMs: 8,
      operation: 'status',
      ok: true,
      result: {
        available: true,
        host: {
          connected: true,
          hostId: host.hostId,
          hostGeneration: 4,
          focused: true,
          capabilities: host.capabilities,
          connectedAt: host.registeredAt,
        },
        panelVisible: false,
        panelRevealRequested: false,
        physicalTabVisible: false,
        selectedTab: null,
      },
    }
    const failure: BrowserAutomationResponse = {
      requestId: 'request-2',
      sessionAgentId: 'session-1',
      profileId: 'profile-1',
      tabId: 'tab-1',
      hostId: 'desktop-host',
      hostGeneration: 4,
      elapsedMs: 15_000,
      operation: 'click',
      ok: false,
      error: { code: 'timeout', message: 'Timed out', retryable: true },
    }
    expect(JSON.parse(JSON.stringify([success, failure]))).toEqual([success, failure])
    expect('error' in success).toBe(false)
    expect('result' in failure).toBe(false)
  })

  it('exports every browser client command and server event through the unions', () => {
    const routedRequest = {
      requestId: 'request-1',
      sessionAgentId: 'session-1',
      profileId: 'profile-1',
      tabId: null,
      hostId: host.hostId,
      hostGeneration: 4,
      deadlineAt: '2026-07-22T00:00:15.000Z',
      artifactDirectory: null,
      operation: 'status',
      input: {},
    } as const satisfies BrowserAutomationRequest
    const routedResponse = {
      requestId: routedRequest.requestId,
      sessionAgentId: routedRequest.sessionAgentId,
      profileId: routedRequest.profileId,
      tabId: null,
      hostId: host.hostId,
      hostGeneration: 4,
      elapsedMs: 1,
      operation: 'status',
      ok: false,
      error: { code: 'unavailable-host', message: 'Unavailable', retryable: true },
    } as const satisfies BrowserAutomationResponse
    const commands = [
      { type: 'browser_host_register', registration: host },
      { type: 'browser_host_focus', hostId: host.hostId, hostGeneration: 4, focused: true },
      { type: 'browser_host_response', response: routedResponse },
      { type: 'browser_host_state_report', requestId: 'state-1', hostId: host.hostId, hostGeneration: 4, sessions: [{
        sessionAgentId: session.sessionAgentId,
        profileId: session.profileId,
        baseRevision: session.revision,
        tabs: session.tabs,
      }] },
      { type: 'browser_panel_reveal_acknowledge', requestId: 'reveal-1', hostId: host.hostId, hostGeneration: 4, sessionAgentId: 'session-1', profileId: 'profile-1', tabId: 'tab-1', sequence: 1 },
      { type: 'browser_tab_open', requestId: '1', sessionAgentId: 'session-1', profileId: 'profile-1' },
      { type: 'browser_tab_activate', requestId: '2', sessionAgentId: 'session-1', tabId: 'tab-1' },
      { type: 'browser_tab_close', requestId: '3', sessionAgentId: 'session-1', tabId: 'tab-1' },
      { type: 'browser_tab_resize', requestId: '4', sessionAgentId: 'session-1', tabId: 'tab-1', viewport: { mode: 'fill' } },
      { type: 'browser_recording_start', requestId: '5', sessionAgentId: 'session-1', tabId: 'tab-1' },
      { type: 'browser_recording_stop', requestId: '6', sessionAgentId: 'session-1', tabId: 'tab-1', recordingId: 'recording-1' },
    ] satisfies ClientCommand[]
    const events = [
      { type: 'browser_host_connected', host: { connected: true, hostId: host.hostId, hostGeneration: 4, focused: true, capabilities: host.capabilities, connectedAt: host.registeredAt } },
      { type: 'browser_host_state_snapshot', hostId: host.hostId, hostGeneration: 4, sessions: [session] },
      { type: 'browser_host_state_report_result', requestId: 'state-1', result: { hostId: host.hostId, hostGeneration: 4, status: 'processed', sessions: [{ sessionAgentId: session.sessionAgentId, profileId: session.profileId, status: 'accepted', snapshot: session }] } },
      { type: 'browser_automation_request', request: routedRequest },
      { type: 'browser_session_snapshot', snapshot: session },
      { type: 'browser_session_changed', snapshot: session, reason: 'recovery' },
      { type: 'browser_panel_reveal_acknowledged', requestId: 'reveal-1', snapshot: session },
      { type: 'browser_tab_command_succeeded', requestId: '1', commandType: 'browser_tab_open', snapshot: session },
      { type: 'browser_recording_command_succeeded', requestId: '5', commandType: 'browser_recording_start', result: { recordingId: 'recording-1', tabId: 'tab-1', recording: true, startedAt: host.registeredAt, mimeType: 'video/webm', width: 1000, height: 700 }, snapshot: session },
    ] satisfies ServerEvent[]
    expect(commands).toHaveLength(11)
    expect(events).toHaveLength(9)
  })

  it('makes browser state reports and human tab mutations required wire requests', () => {
    for (const commandType of ['browser_host_state_report', 'browser_panel_reveal_acknowledge', 'browser_tab_open', 'browser_tab_activate', 'browser_tab_close', 'browser_tab_resize', 'browser_recording_start', 'browser_recording_stop'] as const) {
      expect(getWsRequestContract(commandType)).toMatchObject({
        commandType,
        requestId: { ui: 'required', wire: 'required' },
        successEvents: [commandType === 'browser_host_state_report'
          ? 'browser_host_state_report_result'
          : commandType === 'browser_panel_reveal_acknowledge'
            ? 'browser_panel_reveal_acknowledged'
            : commandType.startsWith('browser_recording_')
            ? 'browser_recording_command_succeeded'
            : 'browser_tab_command_succeeded'],
      })
    }
  })
})
