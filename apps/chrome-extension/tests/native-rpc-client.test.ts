import { describe, expect, it } from 'vitest'
import { EXTERNAL_CHROME_MAX_MESSAGE_BYTES } from '@forge/protocol'
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

function welcomePort(maxMessageBytes = EXTERNAL_CHROME_MAX_MESSAGE_BYTES, requiredShellAbi = 1): FakePort {
  const port = new FakePort()
  port.onPost = (message) => {
    const request = message as { id?: string; method?: string; params?: Record<string, unknown> }
    if (request.method === 'forge.runtime.hello') {
      port.emitMessage({
        jsonrpc: '2.0', id: request.id,
        result: { protocolVersion: 1, desktopInstanceId: 'desktop-fixture', heartbeatMs: 1_000, maxMessageBytes, requiredShellAbi },
      })
    } else if (request.method === 'forge.runtime.ping') {
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
      features: { resize: false, recording: false, downloadArtifacts: false, downloadOpen: false, oopif: false, humanInterruption: true, groups: true },
    })
    expect((hello.params.operations as Array<{ operation: string; supported: boolean }>).filter((entry) => entry.supported).map((entry) => entry.operation)).toEqual(['status', 'open', 'navigate'])
    scheduler.advance(1_000)
    await Promise.resolve()
    expect(port.sent).toHaveLength(2)
    expect(port.sent[1]).toMatchObject({ method: 'forge.runtime.ping', params: { protocolVersion: 1 } })
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
