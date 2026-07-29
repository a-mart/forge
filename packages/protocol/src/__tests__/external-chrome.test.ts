import { describe, expect, it } from 'vitest'
import {
  BROWSER_AUTOMATION_OPERATIONS,
  EXTERNAL_CHROME_DEBUGGER_ATTACH_CONFLICT_DETAILS,
  EXTERNAL_CHROME_EXTENSION_ID,
  EXTERNAL_CHROME_EXTENSION_ORIGIN,
  EXTERNAL_CHROME_MAX_MESSAGE_BYTES,
  EXTERNAL_CHROME_METHODS,
  EXTERNAL_CHROME_NATIVE_HOST_NAME,
  EXTERNAL_CHROME_NOTIFICATION_METHODS,
  EXTERNAL_CHROME_PROTOCOL_VERSIONS,
  EXTERNAL_CHROME_REQUEST_METHODS,
  ExternalChromeContractError,
  negotiateExternalChromeProtocolVersion,
  parseExternalChromeJsonRpcFrame,
  type ExternalChromeRequestMethod,
} from '../index.js'

const operations = BROWSER_AUTOMATION_OPERATIONS.map((operation) => ({
  operation,
  supported: !['resize', 'recordingStart', 'recordingStop'].includes(operation),
  ...(['resize', 'recordingStart', 'recordingStop'].includes(operation) ? { reason: 'unsupported' } : {}),
}))
const hello = {
  jsonrpc: '2.0' as const,
  id: 'hello-1',
  method: 'forge.runtime.hello' as const,
  params: {
    protocol: { min: 1, max: 1 },
    shellAbi: 1,
    payloadVersion: 'runtime-1',
    payloadSha256: 'a'.repeat(64),
    extensionId: EXTERNAL_CHROME_EXTENSION_ID,
    extensionInstanceId: 'instance-1',
    chromeVersion: '125.0.0.0',
    methods: [...EXTERNAL_CHROME_METHODS],
    maxMessageBytes: EXTERNAL_CHROME_MAX_MESSAGE_BYTES,
    operations,
    features: {
      resize: false,
      recording: false,
      downloadEvents: false,
      downloadArtifacts: false,
      downloadOpen: false,
      oopif: true,
      humanInterruption: true,
    },
  },
}
const lease = { protocolVersion: 1 as const, leaseId: 'lease-1', leaseEpoch: 2 }
const acquiredTab = { tabId: 17, title: 'Page', url: 'https://example.test/', active: true }

function parse(value: unknown, expectedResponseMethod?: ExternalChromeRequestMethod) {
  return parseExternalChromeJsonRpcFrame(JSON.stringify(value), {
    protocolVersion: 1,
    ...(expectedResponseMethod ? { expectedResponseMethod } : {}),
  })
}

function expectContractFailure(value: unknown): void {
  expect(() => parse(value)).toThrow(ExternalChromeContractError)
}

describe('External Chrome automatic transport contract', () => {
  it('pins identity and exposes only automatic request families', () => {
    expect(EXTERNAL_CHROME_EXTENSION_ID).toBe('fcchfcnadajoejfbiclihglkmbcfhajd')
    expect(EXTERNAL_CHROME_EXTENSION_ORIGIN).toBe(`chrome-extension://${EXTERNAL_CHROME_EXTENSION_ID}/`)
    expect(EXTERNAL_CHROME_NATIVE_HOST_NAME).toBe('com.forge.external_chrome')
    expect(EXTERNAL_CHROME_PROTOCOL_VERSIONS).toEqual([1])
    expect(EXTERNAL_CHROME_REQUEST_METHODS).toEqual([
      'forge.runtime.hello',
      'forge.runtime.ping',
      'forge.browser.inventory',
      'forge.browser.acquire',
      'forge.browser.release',
      'forge.browser.reveal',
      'forge.browser.execute',
      'forge.runtime.prepareUpdate',
      'forge.runtime.reload',
    ])
    expect(EXTERNAL_CHROME_NOTIFICATION_METHODS).toHaveLength(7)
    expect(EXTERNAL_CHROME_METHODS).toEqual([...EXTERNAL_CHROME_REQUEST_METHODS, ...EXTERNAL_CHROME_NOTIFICATION_METHODS])
  })

  it('negotiates the sole supported version', () => {
    expect(negotiateExternalChromeProtocolVersion({ min: 1, max: 1 })).toBe(1)
    expect(() => negotiateExternalChromeProtocolVersion({ min: 2, max: 2 })).toThrow(ExternalChromeContractError)
  })

  it('round-trips strict hello without profile display metadata', () => {
    expect(parse(hello)).toEqual(hello)
    expectContractFailure({ ...hello, params: { ...hello.params, unexpectedMetadata: 'obsolete' } })
    expectContractFailure({ ...hello, params: { ...hello.params, extensionId: 'wrong' } })
    expectContractFailure({ ...hello, params: { ...hello.params, extensionInstanceId: 'not.canonical' } })
    expectContractFailure({ ...hello, params: { ...hello.params, methods: EXTERNAL_CHROME_METHODS.slice(1) } })
  })

  it('normalizes the previous hello method generation only for immutable-payload update recovery', () => {
    const legacyMethods = EXTERNAL_CHROME_METHODS.map((method) => method === 'forge.browser.inventory'
      ? 'forge.browser.focusedEligibility'
      : method)
    expect(parse({ ...hello, params: { ...hello.params, payloadVersion: 'm5-runtime.1', methods: legacyMethods } }))
      .toMatchObject({ params: { payloadVersion: 'm5-runtime.1', methods: EXTERNAL_CHROME_METHODS } })
  })

  it('round-trips profile inventory and explicit one-tab acquisition requests', () => {
    const inventory = { jsonrpc: '2.0', id: 'inventory-1', method: 'forge.browser.inventory', params: { protocolVersion: 1, sessionAgentId: 'session-1' } }
    const acquire = {
      jsonrpc: '2.0', id: 'acquire-1', method: 'forge.browser.acquire',
      params: { ...lease, sessionAgentId: 'session-1', tabId: 17, createIfNeeded: false },
    }
    const create = {
      jsonrpc: '2.0', id: 'create-1', method: 'forge.browser.acquire',
      params: { ...lease, sessionAgentId: 'session-1', createIfNeeded: true },
    }
    expect(parse(inventory)).toEqual(inventory)
    expect(parse(acquire)).toEqual(acquire)
    expect(parse(create)).toEqual(create)
    expectContractFailure({ ...acquire, params: { ...acquire.params, createIfNeeded: true } })
    expectContractFailure({ ...create, params: { ...create.params, createIfNeeded: false } })
    expectContractFailure({ ...acquire, params: { ...acquire.params, reuseFocused: true } })
    expectContractFailure({ ...acquire, params: { ...acquire.params, url: 'https://example.test/' } })
  })

  it('round-trips bounded inventory and acquisition responses with exact schemas', () => {
    const inventoryTab = {
      tabId: 17, windowId: 3, title: 'Page', url: 'https://example.test/', active: true,
      windowFocused: false, lastAccessed: 123_456,
    }
    const inventory = { jsonrpc: '2.0', id: 'inventory-1', result: { protocolVersion: 1, tabs: [inventoryTab], truncated: false } }
    const acquire = {
      jsonrpc: '2.0', id: 'acquire-1',
      result: { ...lease, sessionAgentId: 'session-1', extensionInstanceId: 'instance-1', tab: acquiredTab, created: false },
    }
    expect(parse(inventory, 'forge.browser.inventory')).toEqual(inventory)
    expect(() => parse({ ...inventory, result: { ...inventory.result, tabs: [inventoryTab, inventoryTab] } }, 'forge.browser.inventory')).toThrow(ExternalChromeContractError)
    expect(parse(acquire, 'forge.browser.acquire')).toEqual(acquire)
    expect(() => parse({ ...acquire, result: { ...acquire.result, windows: [] } }, 'forge.browser.acquire')).toThrow(ExternalChromeContractError)
  })

  it('round-trips the dedicated non-CDP reveal RPC', () => {
    const request = { jsonrpc: '2.0', id: 'reveal-1', method: 'forge.browser.reveal', params: { ...lease, tabId: 17 } }
    const response = { jsonrpc: '2.0', id: 'reveal-1', result: { ...lease, tabId: 17, revealed: true } }
    expect(parse(request)).toEqual(request)
    expect(parse(response, 'forge.browser.reveal')).toEqual(response)
    expect(() => parse({ ...response, result: { ...response.result, revealed: false } }, 'forge.browser.reveal')).toThrow(ExternalChromeContractError)
  })

  it('forbids duplicate tab routing inside execute input', () => {
    const request = {
      jsonrpc: '2.0', id: 'execute-1', method: 'forge.browser.execute',
      params: {
        ...lease, requestId: 'request-1', tabId: 17, operation: 'navigate',
        input: { url: 'https://example.test/', readiness: 'load', timeoutMs: 1_000 },
        deadlineAt: new Date(Date.now() + 1_000).toISOString(),
      },
    }
    expect(parse(request)).toEqual(request)
    expectContractFailure({ ...request, params: { ...request.params, input: { ...request.params.input, tabId: 'duplicate' } } })
  })

  it('validates target-affinity browser snapshots in operation results', () => {
    const now = new Date(0).toISOString()
    const tab = {
      targetAffinity: 'external-chrome', tabId: '17', sessionAgentId: 'session-1', profileId: 'profile-1',
      url: 'https://example.test/', title: 'Page', lifecycle: 'ready', loading: false, live: true,
      canGoBack: false, canGoForward: false, zoomFactor: 1, controller: 'human', agentCursor: null,
      recording: null, viewportSetting: { mode: 'fill' }, renderedViewport: null, physicalVisible: false,
      error: null, createdAt: now, updatedAt: now,
    }
    const response = {
      jsonrpc: '2.0', id: 'execute-1',
      result: { ...lease, requestId: 'request-1', tabId: 17, operation: 'navigate', ok: true, result: { tab, readiness: 'load' } },
    }
    expect(parse(response, 'forge.browser.execute')).toEqual(response)
    const obsolete = structuredClone(response) as any
    delete obsolete.result.result.tab.targetAffinity
    obsolete.result.result.tab.unexpectedAffinity = 'external-chrome'
    expect(() => parse(obsolete, 'forge.browser.execute')).toThrow(ExternalChromeContractError)
  })

  it('accepts only exact debugger attach-conflict safety evidence', () => {
    const response = {
      jsonrpc: '2.0', id: 'execute-conflict',
      result: {
        ...lease, requestId: 'request-conflict', tabId: 17, operation: 'click', ok: false,
        error: {
          code: 'debugger-unavailable', message: 'Another debugger is already attached', retryable: true,
          details: EXTERNAL_CHROME_DEBUGGER_ATTACH_CONFLICT_DETAILS,
        },
      },
    }
    expect(parse(response, 'forge.browser.execute')).toEqual(response)
    expect(() => parse({
      ...response,
      result: { ...response.result, error: { ...response.result.error, details: { ...response.result.error.details, mutationState: 'possible' } } },
    }, 'forge.browser.execute')).toThrow(ExternalChromeContractError)
    expect(() => parse({
      ...response,
      result: { ...response.result, error: { ...response.result.error, details: { ...response.result.error.details, unexpected: true } } },
    }, 'forge.browser.execute')).toThrow(ExternalChromeContractError)
    expect(() => parse({
      ...response,
      result: { ...response.result, error: { ...response.result.error, code: 'execution-failed' } },
    }, 'forge.browser.execute')).toThrow(ExternalChromeContractError)
  })

  it('round-trips exact authority notifications without display or grouping fields', () => {
    const notification = {
      jsonrpc: '2.0', method: 'browser.leaseChanged',
      params: { ...lease, state: 'acquired', tabIds: [17] },
    }
    expect(parse(notification)).toEqual(notification)
    expectContractFailure({ ...notification, params: { ...notification.params, unexpectedScope: 1 } })
  })

  it('rejects unknown methods, IDs on notifications, oversized frames, and non-JSON', () => {
    expectContractFailure({ jsonrpc: '2.0', id: 'x', method: 'forge.browser.enumerate', params: { protocolVersion: 1 } })
    expectContractFailure({ jsonrpc: '2.0', id: 'x', method: 'browser.leaseChanged', params: { ...lease, state: 'released', tabIds: [] } })
    expect(() => parseExternalChromeJsonRpcFrame('{', {})).toThrow(ExternalChromeContractError)
    expect(() => parseExternalChromeJsonRpcFrame(JSON.stringify({ value: 'x'.repeat(EXTERNAL_CHROME_MAX_MESSAGE_BYTES) }), {})).toThrow(ExternalChromeContractError)
  })
})
