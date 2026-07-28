import { PassThrough } from 'node:stream'
import { createServer, type Server } from 'node:net'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EXTERNAL_CHROME_EXTENSION_ORIGIN, EXTERNAL_CHROME_MAX_NATIVE_OUTBOUND_FRAME_BYTES } from '@forge/protocol'
import { Runtime } from '../../../../chrome-extension/src/payload/service-worker/index.js'
import { PAYLOAD_VERSION } from '../../../../chrome-extension/src/runtime/identity.js'
import { fakeChrome } from '../../../../chrome-extension/tests/fakes.js'
import { runNativeHost } from '../../../../native-messaging-host/src/host.js'
import { AuthenticatedRelayClient } from '../../../../native-messaging-host/src/relay-client.js'
import { encodeNativeMessage, NativeMessageDecoder } from '../../../../native-messaging-host/src/framing.js'
import { NodeSocketConnector, type RendezvousDocument } from '../../../../native-messaging-host/src/transport.js'
import { ExternalChromeRelayRuntime } from '../relay-runtime.js'

const EXTENSION_ORIGIN = EXTERNAL_CHROME_EXTENSION_ORIGIN
const EXTENSION_INSTANCE_ID = 'extension-instance-epoch-reconnect'
const USER_SCOPE = 'test-user'
const SECRET = Buffer.alloc(32, 0x44)
const roots: string[] = []
const servers: Server[] = []

class NativePort {
  readonly input = new PassThrough()
  readonly output = new PassThrough()
  readonly sent: unknown[] = []
  disconnected = false
  private messageListener: ((message: unknown) => void) | null = null
  private disconnectListener: (() => void) | null = null
  private readonly decoder = new NativeMessageDecoder(EXTERNAL_CHROME_MAX_NATIVE_OUTBOUND_FRAME_BYTES)

  readonly onMessage = { addListener: (listener: (message: unknown) => void): void => { this.messageListener = listener } }
  readonly onDisconnect = { addListener: (listener: () => void): void => { this.disconnectListener = listener } }

  constructor() {
    this.output.on('data', (chunk: Buffer) => {
      for (const message of this.decoder.push(chunk)) this.messageListener?.(message)
    })
  }

  postMessage(message: unknown): void {
    this.sent.push(message)
    this.input.write(encodeNativeMessage(message as Record<string, unknown>, EXTERNAL_CHROME_MAX_NATIVE_OUTBOUND_FRAME_BYTES))
  }

  disconnect(): void {
    if (this.disconnected) return
    this.disconnected = true
    this.input.end()
    this.disconnectListener?.()
  }

  emitDisconnect(): void {
    if (this.disconnected) return
    this.disconnected = true
    this.disconnectListener?.()
  }
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('native relay reconnect across Desktop epoch replacement', () => {
  it('reconnects the extension client through a new native host and rendezvous epoch without UI input', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'forge-native-epoch-reconnect-'))
    roots.push(root)
    const key = Buffer.from(SECRET)
    const old = await startRelay(root, 'old')
    const next = await startRelay(root, 'next')
    let current = old.rendezvous
    const ports: NativePort[] = []
    let attempts = 0
    const connectNative = (): NativePort => {
      const port = new NativePort()
      ports.push(port)
      attempts += 1
      const host = runNativeHost({
        input: port.input,
        output: port.output,
        diagnostic: { write: () => true },
        platform: 'darwin',
        launchArguments: [EXTENSION_ORIGIN],
        connectRelay: () => AuthenticatedRelayClient.connect({
          rendezvous: { read: async () => ({ ...current }) },
          secrets: { getSecret: async () => Buffer.from(key) },
          connector: new NodeSocketConnector(384 * 1_024),
          expectedUserScope: USER_SCOPE,
          expectedExtensionOrigin: EXTENSION_ORIGIN,
          platform: 'darwin',
          maxAttempts: 3,
          retryDelayMs: 10,
          connectBudgetMs: 250,
        }),
      })
      void host.finally(() => port.emitDisconnect())
      return port
    }
    const chrome = fakeChrome()
    await chrome.storage.local.set({ 'forge.externalChrome.instanceId.v1': EXTENSION_INSTANCE_ID })
    chrome.runtime.connectNative = () => connectNative()
    vi.stubGlobal('chrome', chrome)
    vi.stubGlobal('navigator', { userAgent: 'Chrome/125.0.0.0' })
    const runtime = new Runtime()
    const payloadSha256 = 'a'.repeat(64)
    await runtime.initialize({ directory: `${PAYLOAD_VERSION}-${payloadSha256}`, sha256: payloadSha256 })
    await waitForInventory(old.runtime, EXTENSION_INSTANCE_ID, 3_000)
    expect(attempts).toBe(1)

    old.runtime.deactivate()
    // Publish the replacement rendezvous before the old native host's
    // onDisconnect callback can launch its prompt reconnect attempt.
    current = next.rendezvous
    await new Promise<void>((resolve) => old.server.close(() => resolve()))

    // This is the real Runtime -> NativeRpcClient onDisconnect path; no alarm
    // dispatch or direct client reconnect is used here.
    await waitForInventory(next.runtime, EXTENSION_INSTANCE_ID, 3_000)
    expect(attempts).toBe(2)
    expect(next.runtime.inventory()).toEqual([expect.objectContaining({ extensionInstanceId: EXTENSION_INSTANCE_ID })])

    runtime.shutdown()
    next.runtime.deactivate()
    for (const port of ports) port.disconnect()
  }, 15_000)
})

async function startRelay(root: string, suffix: string): Promise<{
  runtime: ExternalChromeRelayRuntime
  server: Server
  rendezvous: RendezvousDocument
}> {
  const runtime = new ExternalChromeRelayRuntime(path.join(root, `state-${suffix}`, 'leases.json'))
  runtime.activate({
    epoch: `epoch_${suffix}_1234567890`,
    desktopInstanceId: `desktop_${suffix}_1234567890`,
    keyId: 'key-test',
    secret: SECRET,
  })
  const endpoint = path.join(root, `${suffix}.sock`)
  const server = createServer((socket) => runtime.accept(socket))
  servers.push(server)
  await mkdir(path.dirname(endpoint), { recursive: true })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve) })
  return {
    runtime,
    server,
    rendezvous: {
      schemaVersion: 1,
      endpoint,
      epoch: `epoch_${suffix}_1234567890`,
      expiresAt: '2030-01-01T00:00:00.000Z',
      keyId: 'key-test',
      userScope: USER_SCOPE,
      desktopInstanceId: `desktop_${suffix}_1234567890`,
      desktopPid: 42,
      protocolMin: 1,
      protocolMax: 1,
    },
  }
}

async function waitForInventory(runtime: ExternalChromeRelayRuntime, extensionInstanceId: string, timeoutMs: number): Promise<void> {
  await withTimeout(new Promise<void>((resolve) => {
    const check = (): void => {
      if (runtime.inventory().some((entry) => entry.extensionInstanceId === extensionInstanceId)) resolve()
      else setTimeout(check, 10)
    }
    check()
  }), timeoutMs, `relay inventory for ${extensionInstanceId}`)
}

async function withTimeout<Value>(promise: Promise<Value>, timeoutMs: number, label: string): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<Value>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs) }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
