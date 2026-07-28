import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:net'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { build } from 'esbuild'
import {
  EXTERNAL_CHROME_EXTENSION_ORIGIN,
  EXTERNAL_CHROME_MAX_NATIVE_INBOUND_FRAME_BYTES,
  EXTERNAL_CHROME_MAX_NATIVE_OUTBOUND_FRAME_BYTES,
} from '@forge/protocol'
import { Runtime } from '../../../../chrome-extension/src/payload/service-worker/index.js'
import { PAYLOAD_VERSION } from '../../../../chrome-extension/src/runtime/identity.js'
import { fakeChrome } from '../../../../chrome-extension/tests/fakes.js'
import { encodeNativeMessage, NativeMessageDecoder } from '../../../../native-messaging-host/src/framing.js'
import { installedUserScope } from '../../../../native-messaging-host/src/installed-discovery.js'
import { ExternalChromeRelayRuntime } from '../relay-runtime.js'

const EXTENSION_INSTANCE_ID = 'extension_instance_process_1234567890'
const PAYLOAD_SHA256 = 'a'.repeat(64)
const SECRET = Buffer.alloc(32, 0x44)
const roots: string[] = []
const children = new Set<ChildProcessWithoutNullStreams>()
const servers = new Set<Server>()

function hostPlatform(): 'darwin' | 'linux' | 'win32' {
  return process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'
}

class NativeProcessPort {
  readonly name = ''
  readonly diagnostics: string[] = []
  readonly onMessage = {
    addListener: (listener: (message: unknown) => void): void => { this.messageListeners.push(listener) },
  }
  readonly onDisconnect = {
    addListener: (listener: () => void): void => { this.disconnectListeners.push(listener) },
  }
  private readonly messageListeners: Array<(message: unknown) => void> = []
  private readonly disconnectListeners: Array<() => void> = []
  private readonly decoder = new NativeMessageDecoder(EXTERNAL_CHROME_MAX_NATIVE_OUTBOUND_FRAME_BYTES)
  private disconnected = false

  constructor(readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on('data', (chunk: Buffer) => {
      for (const message of this.decoder.push(chunk)) {
        for (const listener of this.messageListeners) listener(message)
      }
    })
    child.stderr.on('data', (chunk: Buffer) => this.diagnostics.push(chunk.toString('utf8')))
    child.once('exit', () => this.emitDisconnect())
  }

  postMessage(message: unknown): void {
    this.child.stdin.write(encodeNativeMessage(
      message as Record<string, unknown>,
      EXTERNAL_CHROME_MAX_NATIVE_INBOUND_FRAME_BYTES,
    ))
  }

  disconnect(): void {
    this.child.stdin.end()
  }

  private emitDisconnect(): void {
    if (this.disconnected) return
    this.disconnected = true
    for (const listener of this.disconnectListeners) listener()
  }
}

interface RelayFixture {
  runtime: ExternalChromeRelayRuntime
  server: Server
  endpoint: string
  epoch: string
  desktopInstanceId: string
}

interface ProcessFixture {
  host: string
  startRelay(suffix: string): Promise<RelayFixture>
  publish(relay: RelayFixture): Promise<void>
}

async function createProcessFixture(): Promise<ProcessFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fxh-'))
  roots.push(root)
  const integrationRoot = path.join(root, 'integration')
  const nativeDirectory = path.join(integrationRoot, 'native-host')
  const runDirectory = path.join(integrationRoot, 'run')
  const authDirectory = path.join(integrationRoot, 'auth')
  await Promise.all([
    mkdir(nativeDirectory, { recursive: true }),
    mkdir(runDirectory, { recursive: true }),
    mkdir(authDirectory, { recursive: true }),
  ])
  const host = path.join(nativeDirectory, 'host.cjs')
  await build({
    absWorkingDir: fileURLToPath(new URL('../../../../native-messaging-host/', import.meta.url)),
    bundle: true,
    charset: 'utf8',
    entryPoints: ['src/main.ts'],
    format: 'cjs',
    legalComments: 'none',
    logLevel: 'silent',
    minify: false,
    outfile: host,
    platform: 'node',
    sourcemap: false,
    target: ['node22'],
    treeShaking: true,
  })
  await chmod(host, 0o755)
  const keyId = `key-${createHash('sha256').update(SECRET).digest('base64url').slice(0, 24)}`
  await writeFile(
    path.join(authDirectory, 'native-messaging.key'),
    `${SECRET.toString('base64')}\n`,
    { mode: 0o600 },
  )

  const startRelay = async (suffix: string): Promise<RelayFixture> => {
    const epoch = `epoch_${suffix}_1234567890`
    const desktopInstanceId = `desktop_${suffix}_1234567890`
    const endpoint = process.platform === 'win32'
      ? `\\\\.\\pipe\\forge-native-process-${process.pid}-${suffix}-${randomUUID()}`
      : path.join(root, `${suffix}.sock`)
    const runtime = new ExternalChromeRelayRuntime(path.join(root, `state-${suffix}`, 'leases.json'))
    runtime.configureExpectedRuntime({ payloadVersion: PAYLOAD_VERSION, sha256: PAYLOAD_SHA256, shellAbi: 1 })
    runtime.activate({ epoch, desktopInstanceId, keyId, secret: SECRET })
    const server = createServer((socket) => runtime.accept(socket))
    servers.add(server)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(endpoint, resolve)
    })
    return { runtime, server, endpoint, epoch, desktopInstanceId }
  }

  const publish = async (relay: RelayFixture): Promise<void> => {
    await writeFile(path.join(runDirectory, 'rendezvous.json'), `${JSON.stringify({
      schemaVersion: 1,
      endpoint: relay.endpoint,
      epoch: relay.epoch,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      keyId,
      userScope: installedUserScope(hostPlatform()),
      desktopInstanceId: relay.desktopInstanceId,
      desktopPid: process.pid,
      protocolMin: 1,
      protocolMax: 1,
    })}\n`, { mode: 0o600 })
  }

  return { host, startRelay, publish }
}

async function closeServer(server: Server): Promise<void> {
  if (!servers.delete(server)) return
  server.closeAllConnections?.()
  if (!server.listening) return
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

async function waitFor(assertion: () => boolean, label: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!assertion() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
  if (!assertion()) throw new Error(`${label} timed out`)
}

afterEach(async () => {
  vi.unstubAllGlobals()
  for (const child of children) {
    child.stdin.end()
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  }
  await Promise.all([...children].map((child) => new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve()
    else child.once('exit', () => resolve())
  })))
  children.clear()
  await Promise.all([...servers].map((server) => closeServer(server)))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('spawned native host relay lifecycle', () => {
  it('reconnects after relay epoch replacement and survives a target-local rejection', async () => {
    const fixture = await createProcessFixture()
    const old = await fixture.startRelay('old')
    await fixture.publish(old)
    const ports: NativeProcessPort[] = []
    const exits: Array<{ code: number | null; signal: NodeJS.Signals | null }> = []
    const chrome = fakeChrome()
    await chrome.storage.local.set({ 'forge.externalChrome.instanceId.v1': EXTENSION_INSTANCE_ID })
    chrome.runtime.connectNative = () => {
      const child = spawn(process.execPath, [
        fixture.host,
        EXTERNAL_CHROME_EXTENSION_ORIGIN,
        ...(process.platform === 'win32' ? ['--parent-window=0'] : []),
      ], { stdio: ['pipe', 'pipe', 'pipe'] })
      children.add(child)
      child.once('exit', (code, signal) => {
        exits.push({ code, signal })
        children.delete(child)
      })
      const port = new NativeProcessPort(child)
      ports.push(port)
      return port
    }
    vi.stubGlobal('chrome', chrome)
    vi.stubGlobal('navigator', { userAgent: 'Chrome/125.0.0.0' })
    const extension = new Runtime()
    await extension.initialize({
      directory: `${PAYLOAD_VERSION}-${PAYLOAD_SHA256}`,
      sha256: PAYLOAD_SHA256,
    })
    await waitFor(
      () => old.runtime.inventory().some((entry) => entry.extensionInstanceId === EXTENSION_INSTANCE_ID),
      'old relay inventory',
    )
    expect(ports).toHaveLength(1)

    const next = await fixture.startRelay('next')
    // A restarted Desktop publishes the replacement before closing its old
    // authenticated endpoint. The extension must observe native process exit
    // promptly enough to connectNative against this current epoch.
    await fixture.publish(next)
    old.runtime.deactivate()
    await closeServer(old.server)

    await waitFor(
      () => next.runtime.inventory().some((entry) => entry.extensionInstanceId === EXTENSION_INSTANCE_ID),
      'replacement relay inventory',
    )
    expect(ports).toHaveLength(2)
    await waitFor(() => exits.length >= 1, 'old native host exit')
    expect(exits[0]).toEqual({ code: 0, signal: null })

    const session = { sessionAgentId: 'session-process', profileId: 'profile-process' }
    const acquired = await next.runtime.acquireTarget({
      ...session,
      operation: 'open',
      preferredTabId: null,
      reuseExisting: false,
      createIfNeeded: true,
      ownerEpoch: 101,
      deadlineAt: Date.now() + 3_000,
    })
    expect(acquired).toEqual({
      ok: true,
      authority: { ownerEpoch: 101, tabId: `ext.${EXTENSION_INSTANCE_ID}.1` },
    })
    if (!acquired.ok) throw new Error('fresh relay acquisition failed')
    await next.runtime.releaseAuthority(session, acquired.authority, 'idle')

    // A released sticky logical tab may later disappear while the freshly
    // authenticated runtime remains healthy. Reproduce that target-local
    // rejection, then prove a new tabless acquisition still reaches Chrome.
    await chrome.tabs.remove(1)
    await expect(next.runtime.acquireTarget({
      ...session,
      operation: 'status',
      preferredTabId: acquired.authority.tabId,
      reuseExisting: true,
      createIfNeeded: true,
      ownerEpoch: 102,
      deadlineAt: Date.now() + 3_000,
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'target-not-found' },
      metadata: { fallbackReason: 'no-eligible-target', mutationState: 'not-started' },
    })
    expect(next.runtime.inventory()).toEqual([
      expect.objectContaining({ extensionInstanceId: EXTENSION_INSTANCE_ID }),
    ])
    expect(ports).toHaveLength(2)
    expect(exits).toHaveLength(1)

    const replacement = await next.runtime.acquireTarget({
      ...session,
      operation: 'open',
      preferredTabId: null,
      reuseExisting: false,
      createIfNeeded: true,
      ownerEpoch: 103,
      deadlineAt: Date.now() + 3_000,
    })
    expect(replacement).toEqual({
      ok: true,
      authority: { ownerEpoch: 103, tabId: `ext.${EXTENSION_INSTANCE_ID}.2` },
    })
    if (!replacement.ok) throw new Error('replacement acquisition failed')
    await next.runtime.releaseAuthority(session, replacement.authority, 'idle')

    extension.shutdown()
    next.runtime.deactivate()
    await closeServer(next.server)
  }, 15_000)
})
