import { describe, expect, expectTypeOf, it } from 'vitest'

import { BROWSER_AUTOMATION_OPERATIONS, type BrowserAutomationOperation } from '../browser-automation.js'
import {
  EXTERNAL_CHROME_CONTRACT_FAILURE_CODES,
  EXTERNAL_CHROME_EXECUTION_ERROR_CODES,
  EXTERNAL_CHROME_EXTENSION_ID,
  EXTERNAL_CHROME_EXTENSION_ORIGIN,
  EXTERNAL_CHROME_JSON_RPC_ERROR_CODES,
  EXTERNAL_CHROME_LEASE_ERROR_CODES,
  EXTERNAL_CHROME_MAX_ARRAY_ITEMS,
  EXTERNAL_CHROME_MAX_CANDIDATE_TABS,
  EXTERNAL_CHROME_MAX_MESSAGE_BYTES,
  EXTERNAL_CHROME_MAX_STRING_LENGTH,
  EXTERNAL_CHROME_METHODS,
  EXTERNAL_CHROME_NATIVE_HOST_NAME,
  EXTERNAL_CHROME_NOTIFICATION_METHODS,
  EXTERNAL_CHROME_PROTOCOL_ERROR_CODES,
  EXTERNAL_CHROME_PROTOCOL_MAX_VERSION,
  EXTERNAL_CHROME_PROTOCOL_MIN_VERSION,
  EXTERNAL_CHROME_PROTOCOL_VERSIONS,
  EXTERNAL_CHROME_REQUEST_METHODS,
  EXTERNAL_CHROME_SUPPORTED_OPERATIONS,
  EXTERNAL_CHROME_TARGET_ERROR_CODES,
  EXTERNAL_CHROME_TRANSPORT_ERROR_CODES,
  EXTERNAL_CHROME_UNSUPPORTED_OPERATIONS,
  ExternalChromeContractError,
  negotiateExternalChromeProtocolVersion,
  parseExternalChromeJsonRpcFrame,
  type ExternalChromeJsonRpcMessage,
  type ExternalChromeNotificationMethod,
  type ExternalChromeRequestMethod,
} from '../external-chrome.js'
import * as rootProtocol from '../index.js'

const operations = BROWSER_AUTOMATION_OPERATIONS.map((operation) => {
  const supported = (EXTERNAL_CHROME_SUPPORTED_OPERATIONS as readonly BrowserAutomationOperation[]).includes(operation)
  return supported ? { operation, supported } : { operation, supported, reason: 'Not qualified in V1' }
})

const hello = {
  jsonrpc: '2.0',
  id: 'hello-1',
  method: 'forge.runtime.hello',
  params: {
    protocol: { min: 1, max: 1 },
    shellAbi: 1,
    payloadVersion: '1.0.0',
    extensionId: EXTERNAL_CHROME_EXTENSION_ID,
    extensionInstanceId: 'extension-instance-1',
    profileAlias: 'Chrome profile 1',
    chromeVersion: '125.0.0.0',
    methods: [...EXTERNAL_CHROME_METHODS],
    maxMessageBytes: EXTERNAL_CHROME_MAX_MESSAGE_BYTES,
    operations,
    features: {
      resize: false,
      recording: false,
      downloadEvents: true,
      downloadArtifacts: false,
      downloadOpen: false,
      oopif: true,
      humanInterruption: true,
      groups: true,
    },
  },
} as const

function parse(value: unknown, options: Parameters<typeof parseExternalChromeJsonRpcFrame>[1] = {}): ExternalChromeJsonRpcMessage {
  return parseExternalChromeJsonRpcFrame(JSON.stringify(value), options)
}

function expectFailure(value: string | unknown, failureCode: ExternalChromeContractError['failureCode']): ExternalChromeContractError {
  try {
    if (typeof value === 'string') parseExternalChromeJsonRpcFrame(value)
    else parse(value)
  } catch (error) {
    expect(error).toBeInstanceOf(ExternalChromeContractError)
    expect((error as ExternalChromeContractError).failureCode).toBe(failureCode)
    return error as ExternalChromeContractError
  }
  throw new Error(`Expected ${failureCode}`)
}

describe('External Chrome protocol identity and negotiation', () => {
  it('pins Forge identity, host, versions, method families, capabilities, and error families', () => {
    expect(EXTERNAL_CHROME_EXTENSION_ID).toBe('fcchfcnadajoejfbiclihglkmbcfhajd')
    expect(EXTERNAL_CHROME_EXTENSION_ORIGIN).toBe('chrome-extension://fcchfcnadajoejfbiclihglkmbcfhajd/')
    expect(EXTERNAL_CHROME_NATIVE_HOST_NAME).toBe('com.forge.external_chrome')
    expect(EXTERNAL_CHROME_PROTOCOL_VERSIONS).toEqual([1])
    expect([EXTERNAL_CHROME_PROTOCOL_MIN_VERSION, EXTERNAL_CHROME_PROTOCOL_MAX_VERSION]).toEqual([1, 1])
    expect(EXTERNAL_CHROME_REQUEST_METHODS).toHaveLength(10)
    expect(EXTERNAL_CHROME_NOTIFICATION_METHODS).toHaveLength(6)
    expect(EXTERNAL_CHROME_METHODS).toEqual([...EXTERNAL_CHROME_REQUEST_METHODS, ...EXTERNAL_CHROME_NOTIFICATION_METHODS])
    expect(EXTERNAL_CHROME_SUPPORTED_OPERATIONS).toEqual(['status', 'open', 'navigate', 'snapshot', 'click', 'type', 'press', 'scroll', 'evaluate', 'waitFor'])
    expect(EXTERNAL_CHROME_UNSUPPORTED_OPERATIONS).toEqual(['resize', 'recordingStart', 'recordingStop'])
    expect([...EXTERNAL_CHROME_SUPPORTED_OPERATIONS, ...EXTERNAL_CHROME_UNSUPPORTED_OPERATIONS]).toHaveLength(BROWSER_AUTOMATION_OPERATIONS.length)
    expect(EXTERNAL_CHROME_TRANSPORT_ERROR_CODES).toContain('authentication-failed')
    expect(EXTERNAL_CHROME_PROTOCOL_ERROR_CODES).toContain('protocol-version-unsupported')
    expect(EXTERNAL_CHROME_LEASE_ERROR_CODES).toContain('lease-lost')
    expect(EXTERNAL_CHROME_TARGET_ERROR_CODES).toContain('debugger-unavailable')
    expect(EXTERNAL_CHROME_EXECUTION_ERROR_CODES).toContain('unsupported-operation')
    expect(new Set([
      ...EXTERNAL_CHROME_TRANSPORT_ERROR_CODES,
      ...EXTERNAL_CHROME_PROTOCOL_ERROR_CODES,
      ...EXTERNAL_CHROME_LEASE_ERROR_CODES,
      ...EXTERNAL_CHROME_TARGET_ERROR_CODES,
      ...EXTERNAL_CHROME_EXECUTION_ERROR_CODES,
    ]).size).toBe(
      EXTERNAL_CHROME_TRANSPORT_ERROR_CODES.length + EXTERNAL_CHROME_PROTOCOL_ERROR_CODES.length +
      EXTERNAL_CHROME_LEASE_ERROR_CODES.length + EXTERNAL_CHROME_TARGET_ERROR_CODES.length +
      EXTERNAL_CHROME_EXECUTION_ERROR_CODES.length,
    )
    expect(EXTERNAL_CHROME_CONTRACT_FAILURE_CODES).toContain('frame-too-large')
  })

  it('exports the complete contract through the protocol root barrel', () => {
    expect(rootProtocol.EXTERNAL_CHROME_EXTENSION_ID).toBe(EXTERNAL_CHROME_EXTENSION_ID)
    expect(rootProtocol.parseExternalChromeJsonRpcFrame).toBe(parseExternalChromeJsonRpcFrame)
    expectTypeOf<ExternalChromeRequestMethod>().toEqualTypeOf<(typeof EXTERNAL_CHROME_REQUEST_METHODS)[number]>()
    expectTypeOf<ExternalChromeNotificationMethod>().toEqualTypeOf<(typeof EXTERNAL_CHROME_NOTIFICATION_METHODS)[number]>()
  })

  it('selects the highest shared version and rejects reversed or disjoint ranges deterministically', () => {
    expect(negotiateExternalChromeProtocolVersion({ min: 1, max: 1 })).toBe(1)
    expect(() => negotiateExternalChromeProtocolVersion({ min: 2, max: 3 })).toThrow(ExternalChromeContractError)
    expect(() => negotiateExternalChromeProtocolVersion({ min: 2, max: 1 })).toThrow(ExternalChromeContractError)
    try {
      negotiateExternalChromeProtocolVersion({ min: 2, max: 3 })
    } catch (error) {
      expect(error).toMatchObject({ failureCode: 'unsupported-version', jsonRpcCode: EXTERNAL_CHROME_JSON_RPC_ERROR_CODES.protocolOrVersion })
    }
  })

  it('round-trips a bounded hello/welcome negotiation without adding fields', () => {
    expect(parse(hello)).toEqual(hello)
    const welcome = {
      jsonrpc: '2.0',
      id: hello.id,
      result: {
        protocolVersion: 1,
        desktopInstanceId: 'desktop-instance-1',
        heartbeatMs: 5_000,
        maxMessageBytes: 524_288,
        requiredShellAbi: 1,
        update: { payloadVersion: '1.0.1', sha256: 'a'.repeat(64) },
      },
    }
    expect(parse(welcome, { expectedResponseMethod: 'forge.runtime.hello', protocolVersion: 1 })).toEqual(welcome)
  })

  it('rejects a wrong pinned ID, missing capabilities, contradictory features, and incomplete operations', () => {
    expectFailure({ ...hello, params: { ...hello.params, extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } }, 'invalid-params')
    const { groups: _groups, ...missingFeature } = hello.params.features
    expectFailure({ ...hello, params: { ...hello.params, features: missingFeature } }, 'invalid-envelope')
    expectFailure({ ...hello, params: { ...hello.params, features: { ...hello.params.features, resize: true } } }, 'invalid-params')
    expectFailure({ ...hello, params: { ...hello.params, operations: operations.slice(1) } }, 'invalid-params')
    expectFailure({ ...hello, params: { ...hello.params, methods: EXTERNAL_CHROME_METHODS.slice(1) } }, 'invalid-params')
  })
})

describe('External Chrome routed request and response contracts', () => {
  const lease = { protocolVersion: 1, leaseId: 'lease-1', leaseEpoch: 4 } as const

  it('round-trips every request family with explicit routing fields', () => {
    const requests = [
      hello,
      { jsonrpc: '2.0', id: 'ping-1', method: 'forge.runtime.ping', params: { protocolVersion: 1, nonce: 'nonce-1', sentAt: '2026-07-24T00:00:00.000Z' } },
      { jsonrpc: '2.0', id: 'list-1', method: 'forge.browser.listCandidates', params: { protocolVersion: 1, sessionAgentId: 'session-1' } },
      { jsonrpc: '2.0', id: 'claim-1', method: 'forge.browser.claim', params: { ...lease, sessionAgentId: 'session-1', tabIds: [12, 13], groupId: 8, childPolicy: 'manual' } },
      { jsonrpc: '2.0', id: 'create-1', method: 'forge.browser.create', params: { ...lease, sessionAgentId: 'session-1', url: 'https://example.test/', groupTitle: 'Forge · Session' } },
      { jsonrpc: '2.0', id: 'release-1', method: 'forge.browser.release', params: { ...lease, reason: 'user-detached' } },
      { jsonrpc: '2.0', id: 'execute-1', method: 'forge.browser.execute', params: { ...lease, requestId: 'request-1', tabId: 12, operation: 'click', input: { locator: 'role=button', timeoutMs: 15_000 }, deadlineAt: '2026-07-24T00:00:15.000Z' } },
      { jsonrpc: '2.0', id: 'turn-1', method: 'forge.browser.turnEnded', params: { ...lease, turnId: 'turn-1', finalTabs: [12], handoffTabs: [13] } },
      { jsonrpc: '2.0', id: 'update-1', method: 'forge.runtime.prepareUpdate', params: { protocolVersion: 1, payloadVersion: '1.0.1', sha256: 'b'.repeat(64), deadlineAt: '2026-07-24T00:00:15.000Z' } },
      { jsonrpc: '2.0', id: 'reload-1', method: 'forge.runtime.reload', params: { protocolVersion: 1, payloadVersion: '1.0.1', sha256: 'b'.repeat(64) } },
    ]
    expect(requests.map((request) => parse(request, { protocolVersion: 1 }))).toEqual(requests)
    expect(requests.map((request) => request.method)).toEqual(EXTERNAL_CHROME_REQUEST_METHODS)
  })

  it('normalizes operation defaults while forbidding duplicated tab/host routing', () => {
    const request = {
      jsonrpc: '2.0', id: 'execute-1', method: 'forge.browser.execute',
      params: { ...lease, requestId: 'request-1', tabId: 12, operation: 'type', input: { text: 'hello' }, deadlineAt: 'soon' },
    }
    expect(parse(request, { protocolVersion: 1 })).toMatchObject({
      params: { requestId: 'request-1', leaseId: 'lease-1', leaseEpoch: 4, tabId: 12, operation: 'type', input: { text: 'hello', clear: false, timeoutMs: 15_000 } },
    })
    expectFailure({ ...request, params: { ...request.params, input: { text: 'hello', tabId: 'duplicate' } } }, 'invalid-params')
    expectFailure({ ...request, params: { ...request.params, operation: 'resize', input: { mode: 'fill' }, unexpected: true } }, 'invalid-envelope')
  })

  it('round-trips candidate/claim/create/release/execute/turn/update result families', () => {
    const selectedTab = { windowId: 2, tabId: 12, groupId: 8, title: 'Synthetic', url: 'https://example.test/path', origin: 'https://example.test', active: true }
    const responses = [
      ['forge.runtime.ping', { protocolVersion: 1, nonce: 'nonce-1', receivedAt: '2026-07-24T00:00:00.100Z' }],
      ['forge.browser.listCandidates', { protocolVersion: 1, extensionInstanceId: 'instance-1', profileAlias: 'Chrome profile 1', windows: [{ windowId: 2, focused: true, groups: [{ groupId: 8, title: 'Forge', collapsed: false }], tabs: [{ windowId: 2, tabId: 12, groupId: 8, title: 'Synthetic', origin: 'https://example.test', active: true, attached: false, restricted: false }] }] }],
      ['forge.browser.claim', { ...lease, sessionAgentId: 'session-1', extensionInstanceId: 'instance-1', groupId: 8, childPolicy: 'manual', tabs: [selectedTab] }],
      ['forge.browser.create', { ...lease, sessionAgentId: 'session-1', extensionInstanceId: 'instance-1', groupId: 8, tab: selectedTab }],
      ['forge.browser.release', { ...lease, releasedTabIds: [12] }],
      ['forge.browser.execute', { ...lease, requestId: 'request-1', tabId: 12, operation: 'click', ok: true, result: { tabId: 'external-tab-12', point: { x: 10, y: 20 } } }],
      ['forge.browser.turnEnded', { ...lease, turnId: 'turn-1', releasedTabs: [12], handoffTabs: [13] }],
      ['forge.runtime.prepareUpdate', { protocolVersion: 1, payloadVersion: '1.0.1', quiesced: true }],
      ['forge.runtime.reload', { protocolVersion: 1, payloadVersion: '1.0.1', accepted: true }],
    ] as const
    for (const [method, result] of responses) {
      const response = { jsonrpc: '2.0', id: `response-${method}`, result }
      expect(parse(response, { expectedResponseMethod: method, protocolVersion: 1 })).toEqual(response)
    }
  })

  it('requires response context and enforces mutually exclusive execute outcomes', () => {
    expectFailure({ jsonrpc: '2.0', id: 'response-1', result: { protocolVersion: 1 } }, 'response-method-required')
    const invalid = { jsonrpc: '2.0', id: 'response-2', result: { ...lease, requestId: 'request-1', tabId: 12, operation: 'click', ok: true, result: {}, error: { code: 'timeout', message: 'x', retryable: true } } }
    try {
      parse(invalid, { expectedResponseMethod: 'forge.browser.execute', protocolVersion: 1 })
    } catch (error) {
      expect(error).toMatchObject({ failureCode: 'invalid-result' })
    }
  })

  it('keeps unselected candidates URL-free and rejects unknown candidate fields', () => {
    const candidate = { windowId: 2, tabId: 12, groupId: null, title: 'Synthetic', origin: 'https://example.test', active: true, attached: false, restricted: false }
    const response = { jsonrpc: '2.0', id: 'list-1', result: { protocolVersion: 1, extensionInstanceId: 'instance-1', windows: [{ windowId: 2, focused: true, groups: [], tabs: [{ ...candidate, url: 'https://example.test/private' }] }] } }
    try {
      parse(response, { expectedResponseMethod: 'forge.browser.listCandidates', protocolVersion: 1 })
    } catch (error) {
      expect(error).toMatchObject({ failureCode: 'invalid-envelope' })
    }
  })
})

describe('External Chrome notification and JSON-RPC error contracts', () => {
  const lease = { protocolVersion: 1, leaseId: 'lease-1', leaseEpoch: 4, tabId: 12 } as const

  it('round-trips every bounded notification family without IDs', () => {
    const notifications = [
      { jsonrpc: '2.0', method: 'browser.cdpEvent', params: { ...lease, targetId: 'target-1', sessionId: 'session-1', method: 'Runtime.consoleAPICalled', params: { type: 'log' } } },
      { jsonrpc: '2.0', method: 'browser.detached', params: { ...lease, reason: 'debugger-replaced' } },
      { jsonrpc: '2.0', method: 'browser.userControl', params: { ...lease, controlEpoch: 3, event: 'pointer', at: '2026-07-24T00:00:00.000Z' } },
      { jsonrpc: '2.0', method: 'browser.tabChanged', params: { ...lease, change: { title: 'Changed', active: true } } },
      { jsonrpc: '2.0', method: 'browser.downloadChanged', params: { ...lease, downloadId: 7, state: 'complete', danger: 'safe', filename: 'synthetic.txt', bytesReceived: 10, totalBytes: 10 } },
      { jsonrpc: '2.0', method: 'runtime.goodbye', params: { protocolVersion: 1, reason: 'desktop-quit' } },
    ]
    expect(notifications.map((notification) => parse(notification, { protocolVersion: 1 }))).toEqual(notifications)
    expect(notifications.map((notification) => notification.method)).toEqual(EXTERNAL_CHROME_NOTIFICATION_METHODS)
    for (const notification of notifications) expect(notification).not.toHaveProperty('id')
  })

  it('rejects notification IDs and empty tab changes', () => {
    expectFailure({ jsonrpc: '2.0', id: 'not-allowed', method: 'browser.detached', params: { ...lease, reason: 'x' } }, 'invalid-envelope')
    expectFailure({ jsonrpc: '2.0', method: 'browser.tabChanged', params: { ...lease, change: {} } }, 'invalid-params')
  })

  it('validates standard errors and exact custom error families with safe routing data', () => {
    const standard = { jsonrpc: '2.0', id: 'request-1', error: { code: -32601, message: 'Unknown method' } }
    const custom = { jsonrpc: '2.0', id: 'request-2', error: { code: -32030, message: 'Lease lost', data: { code: 'lease-lost', retryable: true, requestId: 'request-2', leaseId: 'lease-1', leaseEpoch: 4, tabId: 12, detail: 'Lease expired' } } }
    expect(parse(standard)).toEqual(standard)
    expect(parse(custom)).toEqual(custom)
    expectFailure({ ...custom, error: { ...custom.error, code: -32050 } }, 'invalid-result')
    expectFailure({ ...custom, error: { ...custom.error, data: { ...custom.error.data, secret: 'forbidden' } } }, 'invalid-envelope')
  })
})

describe('External Chrome deterministic bounds and malformed-input behavior', () => {
  it('fails malformed, non-object, invalid-envelope, unknown-method, and wrong-version fixtures predictably', () => {
    const fixtures = [
      ['{', 'malformed-json'],
      ['null', 'invalid-envelope'],
      [JSON.stringify([]), 'invalid-envelope'],
      [JSON.stringify({ jsonrpc: '1.0', id: 'x', method: 'forge.runtime.ping', params: {} }), 'invalid-envelope'],
      [JSON.stringify({ jsonrpc: '2.0', id: 'x', method: 'forge.runtime.nope', params: {} }), 'unknown-method'],
      [JSON.stringify({ jsonrpc: '2.0', id: 'x', method: 'forge.runtime.ping', params: { protocolVersion: 2, nonce: 'n', sentAt: 'now' } }), 'unsupported-version'],
      [JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'forge.runtime.ping', params: { protocolVersion: 1, nonce: 'n', sentAt: 'now' } }), 'invalid-envelope'],
    ] as const
    for (const [frame, failureCode] of fixtures) {
      expectFailure(frame, failureCode)
      expectFailure(frame, failureCode)
    }
  })

  it('checks UTF-8 frame bytes before parsing', () => {
    const oversized = '😀'.repeat(Math.floor(EXTERNAL_CHROME_MAX_MESSAGE_BYTES / 4) + 1)
    const error = expectFailure(oversized, 'frame-too-large')
    expect(error.jsonRpcCode).toBe(EXTERNAL_CHROME_JSON_RPC_ERROR_CODES.transportOrAuthentication)
  })

  it('enforces generic string, array, candidate-total, and nested JSON bounds', () => {
    const tooLong = 'x'.repeat(EXTERNAL_CHROME_MAX_STRING_LENGTH + 1)
    expectFailure({ jsonrpc: '2.0', method: 'browser.cdpEvent', params: { protocolVersion: 1, leaseId: 'lease-1', leaseEpoch: 1, tabId: 1, targetId: 'target-1', method: 'Runtime.event', params: { value: tooLong } } }, 'invalid-envelope')

    const tooMany = Array.from({ length: EXTERNAL_CHROME_MAX_ARRAY_ITEMS + 1 }, (_, index) => index)
    expectFailure({ jsonrpc: '2.0', method: 'browser.cdpEvent', params: { protocolVersion: 1, leaseId: 'lease-1', leaseEpoch: 1, tabId: 1, targetId: 'target-1', method: 'Runtime.event', params: { values: tooMany } } }, 'invalid-envelope')

    const tabs = Array.from({ length: EXTERNAL_CHROME_MAX_CANDIDATE_TABS + 1 }, (_, tabId) => ({ windowId: 1, tabId, groupId: null, title: '', origin: 'https://example.test', active: false, attached: false, restricted: false }))
    const response = { jsonrpc: '2.0', id: 'list-1', result: { protocolVersion: 1, extensionInstanceId: 'instance-1', windows: [{ windowId: 1, focused: true, groups: [], tabs }] } }
    try {
      parse(response, { expectedResponseMethod: 'forge.browser.listCandidates', protocolVersion: 1 })
    } catch (error) {
      expect(error).toMatchObject({ failureCode: 'invalid-envelope' })
    }
  })

  it('rejects non-JSON fuzz values, unknown fields, duplicates, and non-finite values without leaking parser errors', () => {
    const fuzzValues: unknown[] = [undefined, true, 1, Number.NaN, Number.POSITIVE_INFINITY, () => undefined, Symbol('x')]
    for (const value of fuzzValues) {
      expect(() => parseExternalChromeJsonRpcFrame(value as string)).toThrow(ExternalChromeContractError)
    }
    expectFailure({ ...hello, unexpected: true }, 'invalid-envelope')
    expectFailure({ ...hello, params: { ...hello.params, methods: [...hello.params.methods, hello.params.methods[0]] } }, 'invalid-envelope')
    expectFailure({ jsonrpc: '2.0', method: 'browser.downloadChanged', params: { protocolVersion: 1, leaseId: 'lease-1', leaseEpoch: 1, tabId: 1, downloadId: 1, state: 'complete', danger: 'safe', bytesReceived: Number.NaN, totalBytes: 1 } }, 'invalid-envelope')
  })
})
