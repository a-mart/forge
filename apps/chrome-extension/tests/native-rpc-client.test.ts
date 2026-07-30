import { describe, expect, it } from 'vitest'
import {
  EXTERNAL_CHROME_LATE_RESPONSE_TOMBSTONE_TTL_MS,
  EXTERNAL_CHROME_MAX_MESSAGE_BYTES,
  EXTERNAL_CHROME_MAX_SCREENSHOT_PNG_BYTES,
  externalChromeScreenshotOverflowDetails,
  parseExternalChromeJsonRpcFrame,
} from '@forge/protocol'
import { NativeRpcClient, type NativeRpcScheduler } from '../src/runtime/native-rpc-client.js'
import { FakePort } from './fakes.js'

class FakeScheduler implements NativeRpcScheduler {
  private time = 1_000
  private sequence = 0
  private readonly tasks = new Map<number, { at: number; callback: () => void }>()
  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = ++this.sequence
    this.tasks.set(id, { at: this.time + delayMs, callback })
    return id
  }
  clearTimeout(handle: unknown): void { this.tasks.delete(handle as number) }
  now(): number { return this.time }
  advance(ms: number): void {
    this.time += ms
    let ready = [...this.tasks].filter(([, task]) => task.at <= this.time).sort((left, right) => left[1].at - right[1].at)
    while (ready.length > 0) {
      for (const [id, task] of ready) {
        this.tasks.delete(id)
        task.callback()
      }
      ready = [...this.tasks].filter(([, task]) => task.at <= this.time).sort((left, right) => left[1].at - right[1].at)
    }
  }
}

function welcomePort(
  maxMessageBytes = EXTERNAL_CHROME_MAX_MESSAGE_BYTES,
  requiredShellAbi = 1,
  heartbeatMs = 1_000,
  respondToPing = true,
): FakePort {
  const port = new FakePort()
  port.onPost = (message) => {
    const request = message as { id?: string; method?: string; params?: Record<string, unknown> }
    if (request.method === 'forge.runtime.hello') {
      port.emitMessage({
        jsonrpc: '2.0', id: request.id,
        result: { protocolVersion: 1, desktopInstanceId: 'desktop-fixture', heartbeatMs, maxMessageBytes, requiredShellAbi },
      })
    } else if (request.method === 'forge.runtime.ping' && respondToPing) {
      port.emitMessage({
        jsonrpc: '2.0', id: request.id,
        result: { protocolVersion: 1, nonce: request.params?.nonce, receivedAt: new Date(1_000).toISOString() },
      })
    }
  }
  return port
}

describe('bounded native JSON-RPC negotiation and reconnect', () => {
  it('negotiates honest capabilities using the shared strict contract', async () => {
    const scheduler = new FakeScheduler()
    const port = welcomePort()
    let connected = false
    const client = new NativeRpcClient({
      connect: (name) => { expect(name).toBe('com.forge.external_chrome'); return port },
      extensionInstanceId: 'extension-instance-fixture', chromeVersion: '125.0.0.0', scheduler, randomId: () => 'fixed',
      onConnected: () => { connected = true },
    })
    client.start()
    await Promise.resolve()
    expect(connected).toBe(true)
    const hello = port.sent[0] as { params: Record<string, unknown> }
    expect(hello.params).toMatchObject({
      extensionId: 'fcchfcnadajoejfbiclihglkmbcfhajd',
      features: { resize: false, recording: false, downloadArtifacts: false, downloadOpen: false, oopif: true, humanInterruption: true },
    })
    expect(hello.params.methods).toContain('forge.browser.focusedEligibility')
    expect(hello.params.methods).not.toContain('forge.browser.inventory')
    expect((hello.params.operations as Array<{ operation: string; supported: boolean }>).filter((entry) => entry.supported).map((entry) => entry.operation)).toEqual(['status', 'open', 'navigate', 'snapshot', 'click', 'type', 'press', 'scroll', 'evaluate', 'waitFor'])
    scheduler.advance(1_000)
    await Promise.resolve()
    expect(port.sent).toHaveLength(2)
    expect(port.sent[1]).toMatchObject({ method: 'forge.runtime.ping', params: { protocolVersion: 1 } })
    client.stop()
  })

  it('compacts a large snapshot before native JSON-RPC delivery', async () => {
    const scheduler = new FakeScheduler()
    const port = welcomePort(256 * 1_024)
    const client = new NativeRpcClient({
      connect: () => port,
      extensionInstanceId: 'instance', chromeVersion: '125', scheduler,
      onRequest: async () => ({
        protocolVersion: 1, requestId: 'request-snapshot', leaseId: 'lease-snapshot', leaseEpoch: 1,
        tabId: 7, operation: 'snapshot', ok: true,
        result: {
          tabId: '7', url: 'https://fixture.test/', title: 'Fixture', loading: false,
          viewportSetting: { mode: 'fill' }, viewport: { width: 900, height: 700, deviceScaleFactor: 1 }, visibleText: 'text',
          interactiveElements: Array.from({ length: 200 }, (_, index) => ({ tag: 'button', role: 'button', name: `Action ${index}`, selector: `#action-${index}-${'x'.repeat(1_000)}`, x: 1, y: 1, width: 10, height: 10 })),
          accessibility: { frames: [{ targetId: 'target-7', nodes: [] }] }, consoleEntries: [], networkEntries: [], actionTimeline: [],
          screenshot: { mimeType: 'image/png', data: 'A'.repeat(48_000), width: 900, height: 700 },
        },
      }),
    })
    client.start()
    await Promise.resolve()
    port.emitMessage({
      jsonrpc: '2.0', id: 'desktop-snapshot-1', method: 'forge.browser.execute',
      params: {
        protocolVersion: 1, requestId: 'request-snapshot', leaseId: 'lease-snapshot', leaseEpoch: 1, tabId: 7,
        operation: 'snapshot', input: {}, deadlineAt: new Date(Date.now() + 5_000).toISOString(),
      },
    })
    await Promise.resolve()
    await Promise.resolve()
    const response = parseExternalChromeJsonRpcFrame(JSON.stringify(port.sent.at(-1)), { expectedResponseMethod: 'forge.browser.execute', protocolVersion: 1 })
    expect(response).toMatchObject({ result: { ok: true, result: { compaction: { omitted: { interactiveElements: expect.any(Number) } } } } })
    expect(new TextEncoder().encode(JSON.stringify(port.sent.at(-1))).byteLength).toBeLessThanOrEqual(256 * 1_024 - 16 * 1_024)
    client.stop()
  })

  it('delivers bounded canonical screenshot overflow failures through the shared parser', async () => {
    const scheduler = new FakeScheduler()
    const port = welcomePort()
    const client = new NativeRpcClient({
      connect: () => port,
      extensionInstanceId: 'instance', chromeVersion: '125', scheduler,
      onRequest: async () => ({
        protocolVersion: 1, requestId: 'request-snapshot', leaseId: 'lease-snapshot', leaseEpoch: 1,
        tabId: 7, operation: 'snapshot', ok: false as const,
        error: {
          code: 'response-too-large' as const,
          message: 'External Chrome screenshot exceeds the decoded PNG byte limit.', retryable: false,
          details: externalChromeScreenshotOverflowDetails(
            24 + EXTERNAL_CHROME_MAX_SCREENSHOT_PNG_BYTES,
            'decoded-png', EXTERNAL_CHROME_MAX_SCREENSHOT_PNG_BYTES, 'decoded-png',
          ),
        },
      }),
    })
    client.start()
    await Promise.resolve()
    port.emitMessage({
      jsonrpc: '2.0', id: 'desktop-snapshot-overflow', method: 'forge.browser.execute',
      params: {
        protocolVersion: 1, requestId: 'request-snapshot', leaseId: 'lease-snapshot', leaseEpoch: 1, tabId: 7,
        operation: 'snapshot', input: {}, deadlineAt: new Date(Date.now() + 5_000).toISOString(),
      },
    })
    await Promise.resolve()
    await Promise.resolve()
    const response = parseExternalChromeJsonRpcFrame(JSON.stringify(port.sent.at(-1)), {
      expectedResponseMethod: 'forge.browser.execute', protocolVersion: 1,
    })
    expect(response).toMatchObject({
      id: 'desktop-snapshot-overflow',
      result: {
        ok: false, operation: 'snapshot',
        error: {
          code: 'response-too-large', retryable: false,
          details: {
            limitation: 'screenshot-only-envelope-overflow', screenshotByteUnit: 'decoded-png',
            screenshotBytes: 24 + EXTERNAL_CHROME_MAX_SCREENSHOT_PNG_BYTES,
            maximumBytes: EXTERNAL_CHROME_MAX_SCREENSHOT_PNG_BYTES, maximumByteUnit: 'decoded-png',
          },
        },
      },
    })
    expect(new TextEncoder().encode(JSON.stringify(port.sent.at(-1))).byteLength).toBeLessThanOrEqual(EXTERNAL_CHROME_MAX_MESSAGE_BYTES)
    expect(port.disconnected).toBe(false)
    client.stop()
  })

  it('never sends a slow response from a disconnected request on a replacement native port', async () => {
    const scheduler = new FakeScheduler()
    const oldPort = welcomePort()
    const replacementPort = welcomePort()
    const ports = [oldPort, replacementPort]
    let resolveRequest!: (value: unknown) => void
    const pendingRequest = new Promise<unknown>((resolve) => { resolveRequest = resolve })
    const client = new NativeRpcClient({
      connect: () => ports.shift()!,
      extensionInstanceId: 'instance', chromeVersion: '125', scheduler,
      onRequest: () => pendingRequest,
    })
    client.start()
    await Promise.resolve()
    oldPort.emitMessage({
      jsonrpc: '2.0', id: 'desktop-stale-handler', method: 'forge.browser.acquire',
      params: {
        protocolVersion: 1, sessionAgentId: 'session', leaseId: 'lease', leaseEpoch: 1,
        tabId: 7, createIfNeeded: false,
      },
    })
    await Promise.resolve()

    oldPort.emitDisconnect()
    scheduler.advance(250)
    await Promise.resolve()
    resolveRequest({
      protocolVersion: 1, sessionAgentId: 'session', leaseId: 'lease', leaseEpoch: 1,
      extensionInstanceId: 'instance',
      tab: { tabId: 7, title: 'Fixture', url: 'https://fixture.test/', active: true },
      created: false,
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(oldPort.sent.some((message) => (message as { id?: string }).id === 'desktop-stale-handler')).toBe(false)
    expect(replacementPort.sent.some((message) => (message as { id?: string }).id === 'desktop-stale-handler')).toBe(false)
    expect(replacementPort.disconnected).toBe(false)
    client.stop()
  })

  it('returns contract-valid typed failures without disconnecting the native port', async () => {
    const scheduler = new FakeScheduler()
    const port = welcomePort()
    const client = new NativeRpcClient({
      connect: () => port,
      extensionInstanceId: 'instance',
      chromeVersion: '125',
      scheduler,
      onRequest: async () => {
        throw Object.assign(new Error('tab no longer exists'), { code: 'target-not-found' })
      },
    })
    client.start()
    await Promise.resolve()

    port.emitMessage({
      jsonrpc: '2.0',
      id: 'desktop-acquire-1',
      method: 'forge.browser.acquire',
      params: {
        protocolVersion: 1,
        sessionAgentId: 'session-fixture',
        leaseId: 'lease-fixture',
        leaseEpoch: 1,
        tabId: 7,
        createIfNeeded: false,
      },
    })
    await Promise.resolve()
    await Promise.resolve()

    const response = port.sent.at(-1)
    expect(parseExternalChromeJsonRpcFrame(JSON.stringify(response))).toMatchObject({
      id: 'desktop-acquire-1',
      error: {
        code: -32040,
        data: { code: 'target-not-found', retryable: true },
      },
    })
    expect(port.disconnected).toBe(false)
    client.stop()
  })

  it('ignores a contract-valid late response by its timed-out method tombstone without disconnecting', async () => {
    const scheduler = new FakeScheduler()
    const port = welcomePort(EXTERNAL_CHROME_MAX_MESSAGE_BYTES, 1, 60_000, false)
    const client = new NativeRpcClient({
      connect: () => port, extensionInstanceId: 'instance', chromeVersion: '125', scheduler, randomId: () => 'fixed',
    })
    client.start()
    await Promise.resolve()
    const request = (client as unknown as {
      request(method: 'forge.runtime.ping', params: Record<string, unknown>): Promise<unknown>
    }).request.bind(client)
    const timedOut = request('forge.runtime.ping', {
      protocolVersion: 1, nonce: 'late-nonce', sentAt: new Date(scheduler.now()).toISOString(),
    }).then(() => null, (error: unknown) => error)
    const id = (port.sent.at(-1) as { id: string }).id

    scheduler.advance(10_000)
    port.emitMessage({
      jsonrpc: '2.0', id,
      result: { protocolVersion: 1, nonce: 'late-nonce', receivedAt: new Date(scheduler.now()).toISOString() },
    })
    expect(await timedOut).toBeInstanceOf(Error)
    expect(port.disconnected).toBe(false)
    expect(() => client.sendNotification('runtime.goodbye', { protocolVersion: 1, reason: 'still-healthy' })).not.toThrow()
    client.stop()
  })

  it('fails closed for malformed or unknown late response IDs', async () => {
    const scheduler = new FakeScheduler()
    const port = welcomePort(EXTERNAL_CHROME_MAX_MESSAGE_BYTES, 1, 60_000, false)
    const reasons: string[] = []
    const client = new NativeRpcClient({
      connect: () => port, extensionInstanceId: 'instance', chromeVersion: '125', scheduler, randomId: () => 'fixed',
      onDisconnected: (reason) => reasons.push(reason),
    })
    client.start()
    await Promise.resolve()
    const request = (client as unknown as {
      request(method: 'forge.runtime.ping', params: Record<string, unknown>): Promise<unknown>
    }).request.bind(client)
    const timedOut = request('forge.runtime.ping', {
      protocolVersion: 1, nonce: 'late-nonce', sentAt: new Date(scheduler.now()).toISOString(),
    }).catch(() => undefined)
    const id = (port.sent.at(-1) as { id: string }).id
    scheduler.advance(10_000)
    await timedOut
    port.emitMessage({
      jsonrpc: '2.0', id,
      result: { protocolVersion: 1, desktopInstanceId: 'wrong-method', heartbeatMs: 1_000, maxMessageBytes: 1_024, requiredShellAbi: 1 },
    })
    expect(reasons).toEqual(['native message failed JSON-RPC validation'])
    client.stop()

    const unknownPort = welcomePort(EXTERNAL_CHROME_MAX_MESSAGE_BYTES, 1, 60_000)
    const unknownReasons: string[] = []
    const unknown = new NativeRpcClient({
      connect: () => unknownPort, extensionInstanceId: 'instance-2', chromeVersion: '125', scheduler: new FakeScheduler(),
      onDisconnected: (reason) => unknownReasons.push(reason),
    })
    unknown.start()
    await Promise.resolve()
    unknownPort.emitMessage({
      jsonrpc: '2.0', id: 'never-requested',
      result: { protocolVersion: 1, nonce: 'unknown', receivedAt: new Date().toISOString() },
    })
    expect(unknownReasons).toEqual(['native response ID is unknown or expired'])
    unknown.stop()

    const expiryScheduler = new FakeScheduler()
    const expiryPort = welcomePort(EXTERNAL_CHROME_MAX_MESSAGE_BYTES, 1, 60_000, false)
    const expiryReasons: string[] = []
    const expiry = new NativeRpcClient({
      connect: () => expiryPort, extensionInstanceId: 'instance-3', chromeVersion: '125', scheduler: expiryScheduler,
      onDisconnected: (reason) => expiryReasons.push(reason),
    })
    expiry.start()
    await Promise.resolve()
    const expiryRequest = (expiry as unknown as {
      request(method: 'forge.runtime.ping', params: Record<string, unknown>): Promise<unknown>
    }).request.bind(expiry)
    const expired = expiryRequest('forge.runtime.ping', {
      protocolVersion: 1, nonce: 'expired', sentAt: new Date(expiryScheduler.now()).toISOString(),
    }).catch(() => undefined)
    const expiredId = (expiryPort.sent.at(-1) as { id: string }).id
    expiryScheduler.advance(10_000)
    await expired
    expiryScheduler.advance(EXTERNAL_CHROME_LATE_RESPONSE_TOMBSTONE_TTL_MS)
    expiryPort.emitMessage({
      jsonrpc: '2.0', id: expiredId,
      result: { protocolVersion: 1, nonce: 'expired', receivedAt: new Date(expiryScheduler.now()).toISOString() },
    })
    expect(expiryReasons).toEqual(['native response ID is unknown or expired'])
    expiry.stop()
  })

  it('turns cyclic or contract-invalid local results into typed errors without dropping a healthy relay', async () => {
    const scheduler = new FakeScheduler()
    const port = welcomePort()
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const client = new NativeRpcClient({
      connect: () => port, extensionInstanceId: 'instance', chromeVersion: '125', scheduler,
      onRequest: async () => cyclic,
    })
    client.start()
    await Promise.resolve()
    port.emitMessage({
      jsonrpc: '2.0', id: 'desktop-cyclic', method: 'forge.browser.acquire',
      params: {
        protocolVersion: 1, sessionAgentId: 'session', leaseId: 'lease', leaseEpoch: 1,
        tabId: 7, createIfNeeded: false,
      },
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(parseExternalChromeJsonRpcFrame(JSON.stringify(port.sent.at(-1)), {
      expectedResponseMethod: 'forge.browser.acquire', protocolVersion: 1,
    })).toMatchObject({
      id: 'desktop-cyclic', error: { data: { code: 'execution-failed', retryable: true } },
    })
    expect(port.disconnected).toBe(false)
    client.stop()
  })

  it('rejects outbound payloads above the Forge limit before native transport', () => {
    const port = new FakePort()
    const client = new NativeRpcClient({ connect: () => port, extensionInstanceId: 'instance', chromeVersion: '125', randomId: () => 'fixed' })
    client.start()
    expect(() => client.sendNotification('runtime.goodbye', { reason: 'x'.repeat(EXTERNAL_CHROME_MAX_MESSAGE_BYTES) })).toThrow('negotiated bound')
    client.stop()
  })

  it('enforces the negotiated outbound byte limit at the exact UTF-8 boundary', async () => {
    const limit = 512
    const port = welcomePort(limit)
    const client = new NativeRpcClient({ connect: () => port, extensionInstanceId: 'instance', chromeVersion: '125', randomId: () => 'fixed' })
    client.start()
    await Promise.resolve()
    const envelope = { jsonrpc: '2.0', method: 'test.boundary', params: { value: '' } }
    const overhead = new TextEncoder().encode(JSON.stringify(envelope)).byteLength
    expect(overhead).toBeLessThan(limit)
    expect(() => client.sendNotification('test.boundary', { value: 'x'.repeat(limit - overhead) })).not.toThrow()
    expect(() => client.sendNotification('test.boundary', { value: 'x'.repeat(limit - overhead + 1) })).toThrow('negotiated bound')
    client.stop()
  })

  it('enforces the negotiated inbound byte limit at the exact UTF-8 boundary', async () => {
    const limit = 512
    const port = welcomePort(limit)
    const reasons: string[] = []
    const received: unknown[] = []
    const client = new NativeRpcClient({
      connect: () => port, extensionInstanceId: 'instance', chromeVersion: '125', randomId: () => 'fixed',
      onDisconnected: (reason) => reasons.push(reason), onRequest: (message) => received.push(message),
    })
    client.start()
    await Promise.resolve()
    const base = { jsonrpc: '2.0', method: 'runtime.goodbye', params: { protocolVersion: 1, reason: '' } }
    const overhead = new TextEncoder().encode(JSON.stringify(base)).byteLength
    port.emitMessage({ ...base, params: { ...base.params, reason: 'x'.repeat(limit - overhead) } })
    expect(received).toHaveLength(1)
    port.emitMessage({ ...base, params: { ...base.params, reason: 'x'.repeat(limit - overhead + 1) } })
    expect(reasons).toEqual(['malformed or oversized native message'])
    client.stop()
  })

  it('rejects a welcome requiring a different compiled shell ABI', async () => {
    const scheduler = new FakeScheduler()
    const port = welcomePort(EXTERNAL_CHROME_MAX_MESSAGE_BYTES, 2)
    let connected = false
    const client = new NativeRpcClient({
      connect: () => port, extensionInstanceId: 'instance', chromeVersion: '125', scheduler,
      onConnected: () => { connected = true },
    })
    client.start()
    await Promise.resolve()
    await Promise.resolve()
    expect(connected).toBe(false)
    expect(port.disconnected).toBe(true)
    client.stop()
  })

  it('resets negotiated limits before reconnecting', async () => {
    const scheduler = new FakeScheduler()
    const first = welcomePort(512)
    const second = new FakePort()
    let attempts = 0
    const client = new NativeRpcClient({
      connect: () => (++attempts === 1 ? first : second), extensionInstanceId: 'instance', chromeVersion: '125', scheduler,
    })
    client.start()
    await Promise.resolve()
    first.emitDisconnect()
    scheduler.advance(250)
    expect(attempts).toBe(2)
    expect(() => client.sendNotification('test.pre-welcome', { value: 'x'.repeat(600) })).not.toThrow()
    client.stop()
  })

  it('reconnects with deterministic bounded backoff after worker/native loss', async () => {
    const scheduler = new FakeScheduler()
    const port = welcomePort()
    let attempts = 0
    let connected = 0
    const client = new NativeRpcClient({
      connect: () => { attempts += 1; if (attempts === 1) throw new Error('host absent'); return port },
      extensionInstanceId: 'instance', chromeVersion: '125', scheduler, randomId: () => 'fixed',
      onConnected: () => { connected += 1 },
    })
    client.start()
    expect(attempts).toBe(1)
    scheduler.advance(249)
    expect(attempts).toBe(1)
    scheduler.advance(1)
    await Promise.resolve()
    expect(attempts).toBe(2)
    expect(connected).toBe(1)
    port.emitDisconnect()
    scheduler.advance(250)
    await Promise.resolve()
    expect(attempts).toBe(3)
    expect(connected).toBe(2)
    client.stop()
  })

  it('disconnects malformed oversized inbound frames without dispatching them', () => {
    const scheduler = new FakeScheduler()
    const port = new FakePort()
    const reasons: string[] = []
    const client = new NativeRpcClient({
      connect: () => port, extensionInstanceId: 'instance', chromeVersion: '125', scheduler,
      onDisconnected: (reason) => reasons.push(reason),
    })
    client.start()
    port.emitMessage({ junk: 'x'.repeat(EXTERNAL_CHROME_MAX_MESSAGE_BYTES) })
    expect(reasons).toEqual(['malformed or oversized native message'])
    client.stop()
  })
})
