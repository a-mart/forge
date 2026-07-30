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
  BROWSER_AUTOMATION_OPERATIONS,
  EXTERNAL_CHROME_EXTENSION_ORIGIN,
  EXTERNAL_CHROME_MAX_NATIVE_INBOUND_FRAME_BYTES,
  EXTERNAL_CHROME_MAX_NATIVE_OUTBOUND_FRAME_BYTES,
  type BrowserAutomationRequest,
  type BrowserAutomationResponse,
  type BrowserTabSnapshot,
} from '@forge/protocol'
import { Runtime } from '../../../../chrome-extension/src/payload/service-worker/index.js'
import type { ChromeTab } from '../../../../chrome-extension/src/runtime/chrome-api.js'
import { PAYLOAD_VERSION } from '../../../../chrome-extension/src/runtime/identity.js'
import { fakeChrome } from '../../../../chrome-extension/tests/fakes.js'
import { encodeNativeMessage, NativeMessageDecoder } from '../../../../native-messaging-host/src/framing.js'
import { installedUserScope } from '../../../../native-messaging-host/src/installed-discovery.js'
import { AutomaticBrowserHost } from '../../browser/automatic-browser-host.js'
import type { BrowserTargetAdapter } from '../../browser/browser-target-adapter.js'
import { ExternalChromeTargetAdapter } from '../../browser/external-chrome-target-adapter.js'
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

class RejectingManagedAdapter implements BrowserTargetAdapter {
  readonly targetAffinity = 'managed-electron' as const
  readonly requests: BrowserAutomationRequest[] = []
  readonly capabilities = {
    supportedOperations: BROWSER_AUTOMATION_OPERATIONS,
    physicalViewport: true,
    recording: true,
    reveal: false,
  } as const

  async execute(request: BrowserAutomationRequest): Promise<BrowserAutomationResponse> {
    this.requests.push(structuredClone(request))
    if (request.operation === 'status') {
      const selected = managedFallbackTab()
      return {
        requestId: request.requestId, sessionAgentId: request.sessionAgentId, profileId: request.profileId,
        tabId: request.tabId, hostId: request.hostId, hostGeneration: request.hostGeneration,
        operation: 'status', ok: true, elapsedMs: 0, updatedTab: selected,
        result: {
          available: true,
          host: { connected: true, hostId: request.hostId, hostGeneration: request.hostGeneration, focused: true, capabilities: null, connectedAt: new Date(0).toISOString() },
          panelVisible: true, panelRevealRequested: false, physicalTabVisible: true, selectedTab: selected,
          eligibleTabs: [], eligibleTabsTruncated: false,
        },
      }
    }
    throw new Error('integration unexpectedly fell back to Managed Browser')
  }
}

function managedFallbackTab(): BrowserTabSnapshot {
  const now = new Date(0).toISOString()
  return {
    targetAffinity: 'managed-electron', tabId: 'managed-fallback', sessionAgentId: 'session-process', profileId: 'profile-process',
    url: 'about:blank', title: '', lifecycle: 'ready', loading: false, live: true, canGoBack: false, canGoForward: false,
    zoomFactor: 1, controller: 'none', agentCursor: null, recording: null, viewportSetting: { mode: 'fill' }, renderedViewport: null,
    physicalVisible: true, error: null, createdAt: now, updatedAt: now,
  }
}

function browserRequest(operation: BrowserAutomationRequest['operation'], input: Record<string, unknown>): BrowserAutomationRequest {
  return {
    requestId: `request-${operation}-${randomUUID()}`,
    targetAffinity: 'external-chrome',
    sessionAgentId: 'session-process',
    profileId: 'profile-process',
    tabId: typeof input.tabId === 'string' ? input.tabId : null,
    operation,
    input,
    hostId: 'host-process',
    hostGeneration: 1,
    deadlineAt: new Date(Date.now() + 5_000).toISOString(),
    artifactDirectory: null,
  } as BrowserAutomationRequest
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

function value(result: unknown): Record<string, unknown> {
  return { result: { type: typeof result, value: result } }
}

function pngBase64(width: number, height: number): string {
  const bytes = new Uint8Array(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  const view = new DataView(bytes.buffer)
  view.setUint32(8, 13)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return Buffer.from(bytes).toString('base64')
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
    const tabs: ChromeTab[] = [
      {
        id: 7, windowId: 1, active: true, url: 'https://focused.example.test/private',
        title: 'Focused private tab', status: 'complete', lastAccessed: 2_000,
      },
      {
        id: 8, windowId: 1, active: false, url: 'https://focused.example.test/other',
        title: 'Other private tab', status: 'complete', lastAccessed: 1_000,
      },
    ]
    const windows = [{ id: 1, focused: false, type: 'normal' as const, tabs }]
    const chrome = fakeChrome({ tabs, windows })
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
    const update = chrome.tabs.update.bind(chrome.tabs)
    const updatePreconditions: Array<{ url: string | undefined; active: boolean | undefined }> = []
    let documentSequence = 0
    chrome.tabs.update = async (tabId, properties) => {
      if (properties.url !== undefined) {
        const before = await chrome.tabs.get(tabId)
        updatePreconditions.push({ url: before.url, active: before.active })
      }
      const updated = await update(tabId, properties)
      if (properties.url !== undefined) queueMicrotask(() => {
        const documentId = `native-document-${++documentSequence}`
        const details = { tabId, frameId: 0, documentId, url: properties.url }
        extension.onShellEvent('navigation.committed', [details])
        extension.onShellEvent('navigation.domContentLoaded', [details])
        const tab = tabs.find((candidate) => candidate.id === tabId)
        if (tab) tab.status = 'complete'
        extension.onShellEvent('navigation.completed', [details])
      })
      return updated
    }
    const sendCommand = chrome.debugger.sendCommand.bind(chrome.debugger)
    chrome.debugger.sendCommand = async (target, method, params) => {
      const result = await sendCommand(target, method, params)
      if (method === 'Runtime.evaluate' && String(params?.expression).includes('interactiveElements')) {
        return value({
          url: 'https://focused.example.test/private', title: 'Focused private tab', loading: false,
          visibleText: 'Focused OrthoAR page', interactiveElements: [],
        })
      }
      if (method === 'Runtime.evaluate' && params?.expression === 'window.devicePixelRatio') return value(1)
      if (method === 'Runtime.evaluate' && params?.expression === '2 + 2') return value(4)
      if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { clientWidth: 320, clientHeight: 200, pageX: 0, pageY: 0 } }
      if (method === 'Page.captureScreenshot') return { data: pngBase64(2, 2) }
      if (method === 'Accessibility.getFullAXTree') return { nodes: [] }
      return result
    }
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
    const managed = new RejectingManagedAdapter()
    const host = new AutomaticBrowserHost({
      managedAdapter: managed,
      externalAdapter: new ExternalChromeTargetAdapter(next.runtime),
      authorityBurst: { initialIdleMs: 60_000, incrementMs: 0, maximumIdleMs: 60_000 },
    })
    host.adoptTarget(managedFallbackTab())
    const extensionAuthorities = (extension as unknown as {
      authorities: { all(): Array<{ tabId: number; ownerEpoch: number }> }
    }).authorities
    expect(await next.runtime.leaseCheckpoints()).toEqual([])

    // The replacement relay must expose both ordinary pages while Chrome has
    // no OS focus and the sticky Forge selection is still managed.
    const discovered = await host.perform(browserRequest('status', {}))
    expect(discovered).toMatchObject({
      ok: true,
      result: {
        selectedTab: { targetAffinity: 'managed-electron', tabId: 'managed-fallback' },
        eligibleTabs: [
          { tabId: `ext.${EXTENSION_INSTANCE_ID}.7`, title: 'Focused private tab', active: true, windowFocused: false },
          { tabId: `ext.${EXTENSION_INSTANCE_ID}.8`, title: 'Other private tab', active: false, windowFocused: false },
        ],
        eligibleTabsTruncated: false,
      },
    })
    managed.requests.splice(0)

    // Tabless open reuses the active/most-recent page without restoring Chrome focus.
    const focused = await host.perform(browserRequest('open', { show: false, reuseExistingTab: true }))
    expect(focused).toMatchObject({
      ok: true,
      result: { created: false, tab: { targetAffinity: 'external-chrome', tabId: `ext.${EXTENSION_INSTANCE_ID}.7`, url: 'https://focused.example.test/private' } },
    })
    expect(tabs).toHaveLength(2)
    expect(chrome.updates).toEqual([])
    expect(await next.runtime.leaseCheckpoints()).toMatchObject([{ leaseEpoch: 1, tabIds: [7] }])

    const snapshot = await host.perform(browserRequest('snapshot', {}))
    expect(snapshot).toMatchObject({
      ok: true,
      result: { tabId: `ext.${EXTENSION_INSTANCE_ID}.7`, url: 'https://focused.example.test/private', visibleText: 'Focused OrthoAR page' },
    })
    const sticky = await host.perform(browserRequest('status', {}))
    expect(sticky).toMatchObject({
      ok: true,
      result: { selectedTab: { targetAffinity: 'external-chrome', tabId: `ext.${EXTENSION_INSTANCE_ID}.7` } },
    })
    expect(await next.runtime.leaseCheckpoints()).toMatchObject([{ leaseEpoch: 1, tabIds: [7] }])
    expect(chrome.updates).toEqual([])
    expect(chrome.attached).toEqual(new Set([7]))
    expect(managed.requests).toEqual([])
    const evaluated = await host.perform(browserRequest('evaluate', {
      expression: '2 + 2', awaitPromise: true, returnByValue: true,
    }))
    expect(evaluated).toMatchObject({ ok: true, result: { tabId: `ext.${EXTENSION_INSTANCE_ID}.7`, value: 4 } })
    expect(chrome.attached).toEqual(new Set([7]))
    await host.endTurn(session, 'focused-release')
    expect(chrome.attached).toEqual(new Set())
    expect(await next.runtime.leaseCheckpoints()).toEqual([])
    expect(extensionAuthorities.all()).toEqual([])

    // Passing a different inventory ID explicitly acquires that exact existing page.
    const explicit = await host.perform(browserRequest('open', {
      tabId: `ext.${EXTENSION_INSTANCE_ID}.8`, show: false, reuseExistingTab: true,
    }))
    expect(explicit).toMatchObject({
      ok: true,
      result: { created: false, tab: { tabId: `ext.${EXTENSION_INSTANCE_ID}.8` } },
    })
    await expect(host.perform(browserRequest('snapshot', {}))).resolves.toMatchObject({
      ok: true, result: { tabId: `ext.${EXTENSION_INSTANCE_ID}.8` },
    })
    await host.endTurn(session, 'explicit-release')
    expect(await next.runtime.leaseCheckpoints()).toEqual([])
    expect(extensionAuthorities.all()).toEqual([])
    chrome.commands.splice(0)
    chrome.injections.splice(0)

    // open(reuseExistingTab:false) remains a fresh automatic allocation rather
    // than probing or flapping back to the managed fallback.
    const neutral = await host.perform(browserRequest('open', { show: false, reuseExistingTab: false }))
    expect(neutral).toMatchObject({
      ok: true,
      result: { tab: { targetAffinity: 'external-chrome', tabId: `ext.${EXTENSION_INSTANCE_ID}.9`, url: 'about:blank' } },
    })
    expect(tabs.find((tab) => tab.id === 9)).toMatchObject({ active: false, url: 'about:blank' })
    expect(await next.runtime.leaseCheckpoints()).toMatchObject([{ leaseEpoch: 3, tabIds: [9] }])
    await host.endTurn(session, 'neutral-release')
    expect(await next.runtime.leaseCheckpoints()).toEqual([])
    expect(extensionAuthorities.all()).toEqual([])

    // A URL-bearing open still allocates about:blank in the background. The
    // destination is dispatched once through the authorized initial transition.
    const destination = 'https://destination.example.test/path'
    const opened = await host.perform(browserRequest('open', {
      url: destination, show: false, reuseExistingTab: false,
    }))
    expect(opened).toMatchObject({
      ok: true,
      result: { tab: { targetAffinity: 'external-chrome', tabId: `ext.${EXTENSION_INSTANCE_ID}.10`, url: destination } },
    })
    expect(updatePreconditions).toEqual([{ url: 'about:blank', active: false }])
    expect(chrome.updates).toEqual([{ tabId: 10, properties: { url: destination } }])
    expect(chrome.commands).toEqual([])
    expect(chrome.attached).toEqual(new Set())
    await host.endTurn(session, 'url-open-release')
    expect(await next.runtime.leaseCheckpoints()).toEqual([])
    expect(extensionAuthorities.all()).toEqual([])

    if (!opened.ok || opened.operation !== 'open') throw new Error('URL-bearing host open failed')
    const openedTabId = opened.result.tab.tabId
    // A released sticky logical tab may later disappear while the freshly
    // authenticated runtime remains healthy. Reproduce that target-local
    // rejection. Because RPC delivery crossed the acquisition boundary, Desktop reports possible
    // mutation rather than permitting managed fallback; the complete Extension snapshot clears the
    // exact journal before a new tabless acquisition reaches Chrome.
    await chrome.tabs.remove(10)
    await expect(next.runtime.acquireTarget({
      ...session,
      operation: 'status',
      preferredTabId: openedTabId,
      reuseExisting: true,
      createIfNeeded: true,
      ownerEpoch: 102,
      deadlineAt: Date.now() + 3_000,
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'lease-lost' },
      metadata: { mutationState: 'possible' },
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
      authority: { ownerEpoch: 103, tabId: `ext.${EXTENSION_INSTANCE_ID}.11` },
    })
    if (!replacement.ok) throw new Error('replacement acquisition failed')
    expect(tabs.find((tab) => tab.id === 11)).toMatchObject({ active: false, url: 'about:blank' })
    await next.runtime.releaseAuthority(session, replacement.authority, 'idle')
    await host.destroy()
    expect(managed.requests).toEqual([])
    expect(await next.runtime.leaseCheckpoints()).toEqual([])
    expect(extensionAuthorities.all()).toEqual([])

    extension.shutdown()
    next.runtime.deactivate()
    await closeServer(next.server)
  }, 15_000)
})
