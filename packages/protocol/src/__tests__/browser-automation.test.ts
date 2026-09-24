import { describe, expect, expectTypeOf, it } from 'vitest'

import {
  BROWSER_AUTOMATION_DEFAULT_TIMEOUT_MS,
  BROWSER_AUTOMATION_MAX_EVALUATE_BYTES,
  BROWSER_AUTOMATION_MAX_TIMEOUT_MS,
  BROWSER_AUTOMATION_MAX_URL_LENGTH,
  BROWSER_AUTOMATION_OPERATIONS,
  BROWSER_HOST_PROTOCOL_VERSION,
  BROWSER_VIEWPORT_MAX_AREA,
  BrowserAutomationContractError,
  type BrowserAutomationInputByOperation,
  type BrowserAutomationOperation,
  type BrowserAutomationResultByOperation,
  isBrowserAutomationOperation,
  isBrowserHostProtocolCompatible,
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
  it('parses every operation input and rejects unknown operations', () => {
    expectTypeOf<keyof BrowserAutomationInputByOperation>().toEqualTypeOf<BrowserAutomationOperation>()
    expectTypeOf<keyof BrowserAutomationResultByOperation>().toEqualTypeOf<BrowserAutomationOperation>()

    for (const operation of BROWSER_AUTOMATION_OPERATIONS) {
      expect(isBrowserAutomationOperation(operation)).toBe(true)
      expect(() => parseBrowserAutomationInput(operation, validInputs[operation])).not.toThrow()
    }
    expect(isBrowserAutomationOperation('launch')).toBe(false)
  })

  it('negotiates host protocol compatibility across overlapping and disjoint ranges', () => {
    expect(isBrowserHostProtocolCompatible({ minimum: 1, maximum: BROWSER_HOST_PROTOCOL_VERSION })).toBe(true)
    expect(isBrowserHostProtocolCompatible({ minimum: BROWSER_HOST_PROTOCOL_VERSION, maximum: BROWSER_HOST_PROTOCOL_VERSION + 1 })).toBe(true)
    expect(isBrowserHostProtocolCompatible({ minimum: 1, maximum: 1 })).toBe(false)
    expect(isBrowserHostProtocolCompatible({ minimum: BROWSER_HOST_PROTOCOL_VERSION + 1, maximum: BROWSER_HOST_PROTOCOL_VERSION + 1 })).toBe(false)
    expect(parseBrowserAutomationInput('status', {})).toEqual({})
  })

  it('applies T3-compatible defaults', () => {
    expect(parseBrowserAutomationInput('open', {})).toEqual({
      show: true,
      reuseExistingTab: true,
    })
    expect(parseBrowserAutomationInput('navigate', { environmentPort: 3_000 })).toEqual({
      environmentPort: 3_000,
      path: '/',
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

  it('resolves viewport preset orientation by swapping width and height', () => {
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
    ['navigate', { environmentPort: 4_000, path: '@evil.test/' }],
    ['navigate', { environmentPort: 4_000, path: '//evil.test/' }],
    ['navigate', { environmentPort: 4_000, path: '/\\evil.test/' }],
    ['navigate', { environmentPort: 4_000, path: '/%2f%2fevil.test/' }],
    ['navigate', { environmentPort: 4_000, path: '/%5cevil.test/' }],
    ['navigate', { environmentPort: 4_000, path: '/%40evil.test/' }],
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
    expect(() => parseBrowserAutomationInput('resize', { mode: 'freeform', width: 3_840, height: Math.floor(BROWSER_VIEWPORT_MAX_AREA / 3_840) + 1 })).toThrow()
  })
})

describe('browser host, session, and routing wire contract', () => {
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
