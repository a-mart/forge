import { createServer, type Server } from 'node:net'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  EXTERNAL_CHROME_DEBUGGER_ATTACH_CONFLICT_DETAILS,
  type BrowserAutomationFailure,
  type BrowserAutomationRequest,
} from '@forge/protocol'
import { AuthenticatedRelayClient } from '../../../../native-messaging-host/src/relay-client.js'
import { NodeSocketConnector } from '../../../../native-messaging-host/src/transport.js'
import { ExternalChromeTargetAdapter } from '../../browser/external-chrome-target-adapter.js'
import { ExternalChromeRelayRuntime, type ExternalChromeCheckpointFaultPhase } from '../relay-runtime.js'

const roots: string[] = []
const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function connectRelayClient(endpoint: string): Promise<AuthenticatedRelayClient> {
  const key = Buffer.alloc(32, 0x44)
  return AuthenticatedRelayClient.connect({
    rendezvous: { read: async () => ({
      schemaVersion: 1, endpoint, epoch: 'epoch_1234567890abcdef', expiresAt: '2030-01-01T00:00:00.000Z',
      keyId: 'key-test', userScope: 'test-user', desktopInstanceId: 'desktop_1234567890abcdef', desktopPid: 42,
      protocolMin: 1, protocolMax: 1,
    }) },
    secrets: { getSecret: async () => Buffer.from(key) }, connector: new NodeSocketConnector(384 * 1_024),
    expectedUserScope: 'test-user', expectedExtensionOrigin: 'chrome-extension://fcchfcnadajoejfbiclihglkmbcfhajd/',
    platform: process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux',
    now: () => Date.parse('2029-01-01T00:00:00.000Z'), maxAttempts: 1,
  })
}

async function sendRuntimeHello(
  client: AuthenticatedRelayClient,
  instanceId: string,
  payloadVersion = 'm4-runtime.1',
  payloadSha256: string | null = 'a'.repeat(64),
  shellAbi = 1,
  reports: Array<{ leaseId: string; leaseEpoch: number; state: 'acquired' | 'released'; tabIds: number[] }> = [],
): Promise<void> {
  await client.send({
    jsonrpc: '2.0', id: 'hello', method: 'forge.runtime.hello', params: {
      protocol: { min: 1, max: 1 }, shellAbi, payloadVersion,
      ...(payloadSha256 === null ? {} : { payloadSha256 }),
      extensionId: 'fcchfcnadajoejfbiclihglkmbcfhajd', extensionInstanceId: instanceId, chromeVersion: '125.0.0.0',
      methods: ['forge.runtime.hello', 'forge.runtime.ping', 'forge.browser.inventory', 'forge.browser.acquire', 'forge.browser.release', 'forge.browser.acknowledgeRelease', 'forge.browser.reveal', 'forge.browser.execute', 'forge.runtime.prepareUpdate', 'forge.runtime.reload', 'browser.cdpEvent', 'browser.detached', 'browser.userControl', 'browser.tabChanged', 'browser.downloadChanged', 'browser.leaseChanged', 'browser.authoritySnapshot', 'runtime.goodbye'],
      maxMessageBytes: 262144,
      operations: ['status', 'open', 'navigate', 'resize', 'snapshot', 'click', 'type', 'press', 'scroll', 'evaluate', 'waitFor', 'recordingStart', 'recordingStop'].map((operation) => ({
        operation, supported: !['resize', 'recordingStart', 'recordingStop'].includes(operation), ...(!['resize', 'recordingStart', 'recordingStop'].includes(operation) ? {} : { reason: 'physical viewport and recording disabled' }),
      })),
      features: { resize: false, recording: false, downloadEvents: false, downloadArtifacts: false, downloadOpen: false, oopif: true, humanInterruption: true },
    },
  })
  await expect(client.receive()).resolves.toMatchObject({ id: 'hello', result: { protocolVersion: 1, requiredShellAbi: 1 } })
  await client.send({
    jsonrpc: '2.0', method: 'browser.authoritySnapshot',
    params: { protocolVersion: 1, snapshotId: `snapshot-${instanceId}`, reports },
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
}

async function connectedRuntime(
  instanceId = 'instance_profile_a',
  now: () => number = () => 1_000,
  expected?: { payloadVersion: string; sha256: string; shellAbi: number },
  helloPayloadSha256: string | null = 'a'.repeat(64),
  helloShellAbi = 1,
  checkpointFault?: (phase: ExternalChromeCheckpointFaultPhase) => void | Promise<void>,
): Promise<{
  runtime: ExternalChromeRelayRuntime
  client: AuthenticatedRelayClient
  root: string
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-relay-runtime-'))
  roots.push(root)
  const endpoint = path.join(root, 'relay.sock')
  const key = Buffer.alloc(32, 0x44)
  const runtime = new ExternalChromeRelayRuntime(path.join(root, 'state', 'leases.json'), now, { checkpointFault })
  if (expected) runtime.configureExpectedRuntime(expected)
  runtime.activate({ epoch: 'epoch_1234567890abcdef', desktopInstanceId: 'desktop_1234567890abcdef', keyId: 'key-test', secret: key })
  const server = createServer((socket) => runtime.accept(socket))
  servers.push(server)
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve) })
  const client = await connectRelayClient(endpoint)
  await sendRuntimeHello(client, instanceId, 'm4-runtime.1', helloPayloadSha256, helloShellAbi)
  expect(runtime.inventory()).toEqual([expect.objectContaining({ extensionInstanceId: instanceId, chromeVersion: '125.0.0.0' })])
  return { runtime, client, root }
}

async function activatedRuntime(
  expected = { payloadVersion: 'm4-runtime.1', sha256: 'a'.repeat(64), shellAbi: 1 },
): Promise<{ runtime: ExternalChromeRelayRuntime; root: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-relay-cold-start-'))
  roots.push(root)
  const endpoint = path.join(root, 'relay.sock')
  const key = Buffer.alloc(32, 0x44)
  const runtime = new ExternalChromeRelayRuntime(path.join(root, 'state', 'leases.json'))
  runtime.configureExpectedRuntime(expected)
  runtime.activate({ epoch: 'epoch_1234567890abcdef', desktopInstanceId: 'desktop_1234567890abcdef', keyId: 'key-test', secret: key })
  const server = createServer((socket) => runtime.accept(socket))
  servers.push(server)
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve) })
  return { runtime, root }
}

function request(operation: BrowserAutomationRequest['operation'], tabId: string | null, input: Record<string, unknown> = {}): BrowserAutomationRequest {
  return {
    requestId: `request-${operation}`, targetAffinity: 'external-chrome', sessionAgentId: 'session-a', profileId: 'profile-a',
    tabId, operation, input, hostId: 'external-host', hostGeneration: 3,
    deadlineAt: new Date(Date.now() + 30_000).toISOString(), artifactDirectory: null,
  } as BrowserAutomationRequest
}

async function fakeExtensionLoop(
  client: AuthenticatedRelayClient,
  requests: Array<{ method: string; params: Record<string, unknown> }> = [],
  instanceId = 'instance_profile_a',
  inventoryEligible = true,
  executeFailure?: BrowserAutomationFailure,
  releasedTabIdsOverride?: number[],
  inventoryTabsOverride?: Array<{
    tabId: number; windowId: number; title: string; url: string; active: boolean; windowFocused: boolean; lastAccessed: number
  }>,
  enforceExclusiveTabAuthority = false,
): Promise<void> {
  const authorityTabs = new Map<string, number[]>()
  const tabAuthorities = new Map<number, string>()
  while (true) {
    const message = await client.receive()
    if (!message) return
    if (typeof message.id !== 'string' || typeof message.method !== 'string') continue
    const params = message.params as Record<string, unknown>
    requests.push({ method: message.method, params })
    if (message.method === 'forge.browser.inventory') {
      await client.send({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: 1,
        tabs: inventoryTabsOverride ?? (inventoryEligible ? [{
          tabId: 40, windowId: 4, title: 'Selected', url: 'https://selected.invalid/private',
          active: true, windowFocused: false, lastAccessed: 1_000,
        }] : []),
        truncated: false,
      } })
    } else if (message.method === 'forge.browser.acquire') {
      const created = typeof params.tabId !== 'number'
      const tabId = created ? 41 : params.tabId as number
      const leaseId = String(params.leaseId)
      const currentLease = tabAuthorities.get(tabId)
      if (enforceExclusiveTabAuthority && currentLease !== undefined && currentLease !== leaseId) {
        await client.send({ jsonrpc: '2.0', id: message.id, error: {
          code: -32030,
          message: 'tab lease conflict',
          data: {
            code: 'lease-conflict', retryable: false, leaseId: params.leaseId,
            leaseEpoch: params.leaseEpoch, tabId,
          },
        } })
        continue
      }
      authorityTabs.set(leaseId, [tabId])
      tabAuthorities.set(tabId, leaseId)
      await client.send({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: 1, leaseId: params.leaseId, leaseEpoch: params.leaseEpoch, sessionAgentId: params.sessionAgentId,
        extensionInstanceId: instanceId,
        tab: { tabId, title: created ? 'Created' : 'Selected', url: created ? 'https://fixture.invalid/' : 'https://selected.invalid/private', active: true },
        created,
      } })
    } else if (message.method === 'forge.browser.release') {
      const leaseId = String(params.leaseId)
      const releasedTabIds = releasedTabIdsOverride ?? authorityTabs.get(leaseId) ?? [40]
      if (enforceExclusiveTabAuthority) {
        for (const tabId of releasedTabIds) if (tabAuthorities.get(tabId) === leaseId) tabAuthorities.delete(tabId)
      }
      await client.send({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: 1, leaseId: params.leaseId, leaseEpoch: params.leaseEpoch,
        releasedTabIds,
      } })
    } else if (message.method === 'forge.browser.acknowledgeRelease') {
      await client.send({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: 1, leaseId: params.leaseId, leaseEpoch: params.leaseEpoch,
        releasedTabIds: params.releasedTabIds, acknowledged: true,
      } })
    } else if (message.method === 'forge.browser.reveal') {
      await client.send({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: 1, leaseId: params.leaseId, leaseEpoch: params.leaseEpoch,
        tabId: params.tabId, revealed: true,
      } })
    } else if (message.method === 'forge.browser.execute') {
      const now = new Date(0).toISOString()
      const operation = String(params.operation)
      if (executeFailure !== undefined) {
        await client.send({ jsonrpc: '2.0', id: message.id, result: {
          protocolVersion: 1, leaseId: params.leaseId, leaseEpoch: params.leaseEpoch, requestId: params.requestId,
          tabId: params.tabId, operation, ok: false, error: executeFailure,
        } })
        continue
      }
      const result = operation === 'navigate' ? {
        readiness: 'load', tab: {
          targetAffinity: 'external-chrome', tabId: '41', sessionAgentId: 'session-a', profileId: 'instance_profile_a',
          url: 'https://navigated.invalid/', title: 'Navigated', lifecycle: 'ready', loading: false, live: true,
          canGoBack: false, canGoForward: false, zoomFactor: 1, controller: 'agent', agentCursor: null, recording: null,
          viewportSetting: { mode: 'fill' }, renderedViewport: null, physicalVisible: false, error: null, createdAt: now, updatedAt: now,
        },
      } : operation === 'snapshot' ? {
        tabId: String(params.tabId), url: 'https://selected.invalid/private', title: 'Selected private title', loading: false,
        viewportSetting: { mode: 'fill' }, viewport: { width: 900, height: 700, deviceScaleFactor: 1 }, visibleText: 'Large fixture',
        interactiveElements: [], accessibility: { frames: [] }, consoleEntries: [], networkEntries: [], actionTimeline: [],
        compaction: { omitted: { consoleEntries: 200 } }, screenshot: { mimeType: 'image/png', data: 'AA==', width: 1, height: 1 },
      } : operation === 'status' ? {
        available: true,
        host: { connected: true, hostId: null, hostGeneration: null, focused: false, capabilities: null, connectedAt: null },
        panelVisible: false, panelRevealRequested: false, physicalTabVisible: false,
        selectedTab: {
          targetAffinity: 'external-chrome', tabId: String(params.tabId), sessionAgentId: 'session-a', profileId: 'instance_profile_a',
          url: 'https://selected.invalid/private', title: 'Selected private title', lifecycle: 'ready', loading: false, live: true,
          canGoBack: false, canGoForward: false, zoomFactor: 1, controller: 'human', agentCursor: null, recording: null,
          viewportSetting: { mode: 'fill' }, renderedViewport: null, physicalVisible: false, error: null, createdAt: now, updatedAt: now,
        },
        eligibleTabs: [], eligibleTabsTruncated: false,
      } : operation === 'evaluate' ? { tabId: String(params.tabId), value: { answer: 42 }, serializedBytes: 13 }
        : { tabId: String(params.tabId), matched: true, elapsedMs: 2 }
      await client.send({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: 1, leaseId: params.leaseId, leaseEpoch: params.leaseEpoch, requestId: params.requestId,
        tabId: params.tabId, operation, ok: true, result,
      } })
    } else if (message.method === 'forge.runtime.prepareUpdate') {
      await client.send({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: 1, payloadVersion: params.payloadVersion, quiesced: true,
      } })
    } else if (message.method === 'forge.runtime.reload') {
      await client.send({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: 1, payloadVersion: params.payloadVersion, accepted: true,
      } })
    }
  }
}

describe('authenticated External Chrome Desktop relay runtime', () => {
  it('ignores a valid late response by method tombstone and keeps the authenticated runtime healthy', async () => {
    const { runtime, client } = await connectedRuntime()
    const session = { sessionAgentId: 'session-a', profileId: 'profile-a' }
    const first = runtime.listEligibleTabs(session, Date.now() + 15)
    const timedOutRequest = await client.receive()
    expect(timedOutRequest).toMatchObject({ method: 'forge.browser.inventory' })
    await expect(first).resolves.toMatchObject({ tabs: [], truncated: true })

    await client.send({ jsonrpc: '2.0', id: timedOutRequest!.id, result: {
      protocolVersion: 1,
      tabs: [{
        tabId: 40, windowId: 4, title: 'Late', url: 'https://late.invalid/', active: true,
        windowFocused: false, lastAccessed: 1_000,
      }],
      truncated: false,
    } })
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    expect(runtime.inventory()).toHaveLength(1)

    const second = runtime.listEligibleTabs(session, Date.now() + 1_000)
    const liveRequest = await client.receive()
    await client.send({ jsonrpc: '2.0', id: liveRequest!.id, result: {
      protocolVersion: 1,
      tabs: [{
        tabId: 41, windowId: 4, title: 'Live', url: 'https://live.invalid/', active: true,
        windowFocused: false, lastAccessed: 2_000,
      }],
      truncated: false,
    } })
    await expect(second).resolves.toMatchObject({ tabs: [{ title: 'Live' }], truncated: false })
    runtime.deactivate(); client.close()
  })

  it('fails closed when a late response does not match its tombstoned method contract', async () => {
    const { runtime, client } = await connectedRuntime()
    const listing = runtime.listEligibleTabs({ sessionAgentId: 'session-a', profileId: 'profile-a' }, Date.now() + 15)
    const timedOutRequest = await client.receive()
    await listing
    await client.send({ jsonrpc: '2.0', id: timedOutRequest!.id, result: {
      protocolVersion: 1, nonce: 'wrong-method', receivedAt: new Date().toISOString(),
    } })
    await expect.poll(() => runtime.inventory().length).toBe(0)
    runtime.deactivate(); client.close()
  })

  it('bounds caller-expired cleanup, retains exact intent, and gives later lifecycle cleanup its own budget', async () => {
    const { runtime, client } = await connectedRuntime('instance_profile_a', Date.now)
    const session = { sessionAgentId: 'session-a', profileId: 'profile-a' }
    const acquiring = runtime.acquireTarget({
      ...session,
      operation: 'open',
      preferredTabId: 'ext.instance_profile_a.40',
      reuseExisting: true,
      createIfNeeded: false,
      ownerEpoch: 77,
      deadlineAt: Date.now() + 1_000,
    })
    const acquireRequest = await client.receive()
    await client.send({ jsonrpc: '2.0', id: acquireRequest!.id, result: {
      protocolVersion: 1,
      leaseId: acquireRequest!.params.leaseId,
      leaseEpoch: acquireRequest!.params.leaseEpoch,
      sessionAgentId: acquireRequest!.params.sessionAgentId,
      extensionInstanceId: 'instance_profile_a',
      tab: { tabId: 40, title: 'Selected', url: 'https://selected.invalid/', active: true },
      created: false,
    } })
    const acquired = await acquiring
    expect(acquired).toMatchObject({ ok: true })
    if (!acquired.ok) throw new Error('fixture acquisition failed')

    const started = Date.now()
    const expiredCleanup = runtime.releaseAuthority(session, acquired.authority, 'operation-failed', Date.now() - 1)
    const firstRelease = await client.receive()
    await expect(expiredCleanup).rejects.toThrow('timed out')
    expect(Date.now() - started).toBeLessThan(1_000)

    const lifecycle = runtime.releaseSession(session, 'turn-ended')
    const secondRelease = await client.receive()
    expect(secondRelease).toMatchObject({ method: 'forge.browser.release', params: { reason: 'operation-failed' } })
    await client.send({ jsonrpc: '2.0', id: firstRelease!.id, result: {
      protocolVersion: 1,
      leaseId: firstRelease!.params.leaseId,
      leaseEpoch: firstRelease!.params.leaseEpoch,
      releasedTabIds: [40],
    } })
    await client.send({ jsonrpc: '2.0', id: secondRelease!.id, result: {
      protocolVersion: 1,
      leaseId: secondRelease!.params.leaseId,
      leaseEpoch: secondRelease!.params.leaseEpoch,
      releasedTabIds: [40],
    } })
    const acknowledgement = await client.receive()
    expect(acknowledgement).toMatchObject({ method: 'forge.browser.acknowledgeRelease' })
    await client.send({ jsonrpc: '2.0', id: acknowledgement!.id, result: {
      protocolVersion: 1,
      leaseId: acknowledgement!.params.leaseId,
      leaseEpoch: acknowledgement!.params.leaseEpoch,
      releasedTabIds: [40],
      acknowledged: true,
    } })
    await expect(lifecycle).resolves.toBeUndefined()
    expect(runtime.inventory()).toHaveLength(1)
    runtime.deactivate(); client.close()
  })

  it('closes an authenticated runtime for an unknown response ID', async () => {
    const { runtime, client } = await connectedRuntime()
    await client.send({ jsonrpc: '2.0', id: 'never-requested', result: {
      protocolVersion: 1, tabs: [], truncated: false,
    } })
    await expect.poll(() => runtime.inventory().length).toBe(0)
    runtime.deactivate(); client.close()
  })

  it('waits through a transient extension disconnect before reacquiring automatic authority', async () => {
    const { runtime, client, root } = await connectedRuntime()
    const endpoint = path.join(root, 'relay.sock')
    client.close()
    await new Promise<void>((resolve) => setTimeout(resolve, 10))

    const reacquiring = runtime.acquireTarget({
      sessionAgentId: 'session-a', profileId: 'profile-a', operation: 'open',
      preferredTabId: null, reuseExisting: true, createIfNeeded: true, ownerEpoch: 9,
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
    const reconnected = await connectRelayClient(endpoint)
    await sendRuntimeHello(reconnected, 'instance_profile_a')
    const loop = fakeExtensionLoop(reconnected)
    await expect(reacquiring).resolves.toMatchObject({ ok: true, authority: { tabId: 'ext.instance_profile_a.40' } })
    const acquired = await reacquiring
    if (acquired.ok) await runtime.releaseAuthority({ sessionAgentId: 'session-a', profileId: 'profile-a' }, acquired.authority, 'idle')
    runtime.deactivate(); reconnected.close(); await loop
  })

  it('waits on a freshly activated relay when the extension connects after acquisition begins', async () => {
    const { runtime, root } = await activatedRuntime()
    const reacquiring = runtime.acquireTarget({
      sessionAgentId: 'session-a', profileId: 'profile-a', operation: 'open', preferredTabId: null,
      reuseExisting: true, createIfNeeded: true, ownerEpoch: 12, deadlineAt: Date.now() + 3_000,
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
    const reconnected = await connectRelayClient(path.join(root, 'relay.sock'))
    await sendRuntimeHello(reconnected, 'instance_profile_a')
    const loop = fakeExtensionLoop(reconnected)
    await expect(reacquiring).resolves.toMatchObject({ ok: true, authority: { tabId: 'ext.instance_profile_a.40' } })
    const acquired = await reacquiring
    if (acquired.ok) await runtime.releaseAuthority({ sessionAgentId: 'session-a', profileId: 'profile-a' }, acquired.authority, 'idle')
    runtime.deactivate(); reconnected.close(); await loop
  })

  it('keeps a fresh activated relay bounded when the extension remains absent', async () => {
    const { runtime } = await activatedRuntime()
    const startedAt = Date.now()
    await expect(runtime.acquireTarget({
      sessionAgentId: 'session-a', profileId: 'profile-a', operation: 'open', preferredTabId: null,
      reuseExisting: true, createIfNeeded: true, ownerEpoch: 13, deadlineAt: Date.now() + 20,
    })).resolves.toMatchObject({ ok: false, metadata: { fallbackReason: 'no-eligible-target' } })
    expect(Date.now() - startedAt).toBeLessThan(1_000)
    runtime.deactivate()
  })

  it('cancels a fresh-start readiness waiter when the relay deactivates', async () => {
    const { runtime } = await activatedRuntime()
    const waiting = runtime.acquireTarget({
      sessionAgentId: 'session-a', profileId: 'profile-a', operation: 'open', preferredTabId: null,
      reuseExisting: true, createIfNeeded: true, ownerEpoch: 14,
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    runtime.deactivate()
    await expect(waiting).resolves.toMatchObject({ ok: false, metadata: { fallbackReason: 'runtime-not-ready' } })
  })

  it('does not add reconnect latency when the relay has never been activated', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'forge-relay-no-integration-'))
    roots.push(root)
    const runtime = new ExternalChromeRelayRuntime(path.join(root, 'state', 'leases.json'))
    const startedAt = Date.now()
    await expect(runtime.execute(request('status', null))).resolves.toMatchObject({ ok: true, result: { available: false } })
    expect(Date.now() - startedAt).toBeLessThan(1_000)
    runtime.deactivate()
  })

  it('bounds reconnect waiting by the browser request deadline', async () => {
    const { runtime, client } = await connectedRuntime()
    client.close()
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    const startedAt = Date.now()
    await expect(runtime.acquireTarget({
      sessionAgentId: 'session-a', profileId: 'profile-a', operation: 'open', preferredTabId: null,
      reuseExisting: true, createIfNeeded: true, ownerEpoch: 10, deadlineAt: Date.now() + 20,
    })).resolves.toMatchObject({ ok: false, metadata: { fallbackReason: 'no-eligible-target' } })
    expect(Date.now() - startedAt).toBeLessThan(1_000)
    runtime.deactivate()
  })

  it('cancels reconnect waiters when the relay is deactivated', async () => {
    const { runtime, client } = await connectedRuntime()
    client.close()
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    const waiting = runtime.acquireTarget({
      sessionAgentId: 'session-a', profileId: 'profile-a', operation: 'open', preferredTabId: null,
      reuseExisting: true, createIfNeeded: true, ownerEpoch: 11,
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    runtime.deactivate()
    await expect(waiting).resolves.toMatchObject({ ok: false, metadata: { fallbackReason: 'runtime-not-ready' } })
  })

  it.each([
    ['corrupt JSON', '{not-json'],
    ['invalid schema', JSON.stringify({ schemaVersion: 2, leases: [] })],
    ['invalid record', JSON.stringify({ schemaVersion: 1, leases: [{ extensionInstanceId: 'instance' }] })],
    ['oversized file', 'x'.repeat(1 * 1_024 * 1_024 + 1)],
  ])('keeps %s checkpoints permanently fail-closed across sequential and concurrent loads', async (_name, contents) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'forge-relay-checkpoint-'))
    roots.push(root)
    const sequentialFile = path.join(root, 'sequential', 'leases.json')
    await mkdir(path.dirname(sequentialFile), { recursive: true })
    await writeFile(sequentialFile, contents)
    const sequential = new ExternalChromeRelayRuntime(sequentialFile)
    await expect(sequential.ready()).rejects.toThrow()
    await writeFile(sequentialFile, JSON.stringify({ schemaVersion: 1, leases: [] }))
    await expect(sequential.ready()).rejects.toThrow()
    await expect(sequential.hasActiveLeaseCheckpoints()).rejects.toThrow()

    const concurrentFile = path.join(root, 'concurrent', 'leases.json')
    await mkdir(path.dirname(concurrentFile), { recursive: true })
    await writeFile(concurrentFile, contents)
    const concurrent = new ExternalChromeRelayRuntime(concurrentFile)
    const results = await Promise.allSettled([concurrent.ready(), concurrent.ready(), concurrent.leaseCheckpoints()])
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected', 'rejected'])
    await expect(concurrent.ready()).rejects.toThrow()
  })

  it('fails before RPC delivery when the durable pre-acquisition journal write fails', async () => {
    const phases: ExternalChromeCheckpointFaultPhase[] = []
    const { runtime, client } = await connectedRuntime(
      'instance_profile_a',
      () => 1_000,
      undefined,
      'a'.repeat(64),
      1,
      (phase) => {
        phases.push(phase)
        if (phase === 'journal-write') throw new Error('injected journal write failure')
      },
    )
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    const loop = fakeExtensionLoop(client, requests)

    await expect(runtime.acquireTarget({
      sessionAgentId: 'session-journal-write', profileId: 'profile', operation: 'open',
      preferredTabId: 'ext.instance_profile_a.40', reuseExisting: true, createIfNeeded: false, ownerEpoch: 20,
    })).resolves.toMatchObject({ ok: false, metadata: { mutationState: 'not-started' } })
    expect(phases).toEqual(['journal-write'])
    expect(requests).toEqual([])
    await expect(runtime.hasActiveLeaseCheckpoints()).resolves.toBe(false)

    runtime.deactivate(); client.close(); await loop
  })

  it('retains exact intent across checkpoint-finalize failure and reconciles acquired scope before eventual reacquisition', async () => {
    let failFinalize = true
    const { runtime, client, root } = await connectedRuntime(
      'instance_profile_a',
      () => 1_000,
      undefined,
      'a'.repeat(64),
      1,
      (phase) => {
        if (phase === 'journal-finalize' && failFinalize) throw new Error('injected journal finalize failure')
      },
    )
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    const loop = fakeExtensionLoop(client, requests)
    await expect(runtime.acquireTarget({
      sessionAgentId: 'session-finalize', profileId: 'profile', operation: 'open',
      preferredTabId: 'ext.instance_profile_a.40', reuseExisting: true, createIfNeeded: false, ownerEpoch: 21,
    })).resolves.toMatchObject({ ok: false, metadata: { mutationState: 'possible' } })

    const stateFile = path.join(root, 'state', 'leases.json')
    const retained = JSON.parse(await readFile(stateFile, 'utf8')) as {
      acquisitions: Array<{ leaseId: string; leaseEpoch: number; cleanupReason?: string }>
    }
    expect(retained.acquisitions).toEqual([
      expect.objectContaining({ leaseEpoch: 21, cleanupReason: 'acquisition-interrupted' }),
    ])
    failFinalize = false
    await client.send({
      jsonrpc: '2.0', method: 'browser.authoritySnapshot',
      params: {
        protocolVersion: 1, snapshotId: 'finalize-recovery',
        reports: [{
          leaseId: retained.acquisitions[0]!.leaseId,
          leaseEpoch: 21,
          state: 'acquired',
          tabIds: [40],
        }],
      },
    })
    await waitForCondition(async () => !(await runtime.hasActiveLeaseCheckpoints()))
    expect(requests.map(({ method }) => method)).toContain('forge.browser.release')
    expect(requests.map(({ method }) => method)).toContain('forge.browser.acknowledgeRelease')

    const reacquired = await runtime.acquireTarget({
      sessionAgentId: 'session-finalize', profileId: 'profile', operation: 'open',
      preferredTabId: 'ext.instance_profile_a.40', reuseExisting: true, createIfNeeded: false, ownerEpoch: 22,
    })
    expect(reacquired).toMatchObject({ ok: true })
    if (reacquired.ok) await runtime.releaseAuthority(
      { sessionAgentId: 'session-finalize', profileId: 'profile' }, reacquired.authority, 'turn-ended',
    )

    runtime.deactivate(); client.close(); await loop
  })

  it('retains an interrupted journal when authenticated absence cannot be durably removed', async () => {
    let failRemove = true
    const { runtime, client, root } = await connectedRuntime(
      'instance_profile_a',
      () => 1_000,
      undefined,
      'a'.repeat(64),
      1,
      (phase) => {
        if (phase === 'journal-remove' && failRemove) throw new Error('injected journal remove failure')
      },
    )
    const acquiring = runtime.acquireTarget({
      sessionAgentId: 'session-remove', profileId: 'profile', operation: 'open',
      preferredTabId: 'ext.instance_profile_a.40', reuseExisting: true, createIfNeeded: false, ownerEpoch: 23,
    })
    const request = await client.receive()
    expect(request).toMatchObject({ method: 'forge.browser.acquire' })
    await client.send({ jsonrpc: '2.0', id: request!.id, error: {
      code: -32030, message: 'injected exact conflict', data: { code: 'lease-conflict', retryable: false },
    } })
    await client.send({
      jsonrpc: '2.0', method: 'browser.authoritySnapshot',
      params: { protocolVersion: 1, snapshotId: 'absence-with-remove-fault', reports: [] },
    })
    await expect(acquiring).resolves.toMatchObject({ ok: false, metadata: { mutationState: 'possible' } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const retained = JSON.parse(await readFile(path.join(root, 'state', 'leases.json'), 'utf8')) as { acquisitions: unknown[] }
    expect(retained.acquisitions).toHaveLength(1)
    await expect(runtime.hasActiveLeaseCheckpoints()).resolves.toBe(true)

    failRemove = false
    client.close()
    const reconnected = await connectRelayClient(path.join(root, 'relay.sock'))
    await sendRuntimeHello(reconnected, 'instance_profile_a')
    await waitForCondition(async () => !(await runtime.hasActiveLeaseCheckpoints()))
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    const loop = fakeExtensionLoop(reconnected, requests)
    const reacquired = await runtime.acquireTarget({
      sessionAgentId: 'session-remove', profileId: 'profile', operation: 'open',
      preferredTabId: 'ext.instance_profile_a.40', reuseExisting: true, createIfNeeded: false, ownerEpoch: 24,
    })
    expect(reacquired).toMatchObject({ ok: true })
    if (reacquired.ok) await runtime.releaseAuthority(
      { sessionAgentId: 'session-remove', profileId: 'profile' }, reacquired.authority, 'turn-ended',
    )

    runtime.deactivate(); reconnected.close(); await loop
  })

  it('routes URL-bearing create through neutral acquire then authorized navigate and persists only opaque lease scope', async () => {
    const { runtime, client, root } = await connectedRuntime()
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    const loop = fakeExtensionLoop(client, requests)
    const opened = await runtime.execute(request('open', null, { url: 'https://fixture.invalid/', show: false, reuseExistingTab: false }))
    expect(opened).toMatchObject({ ok: true, result: { created: true, tab: { tabId: 'ext.instance_profile_a.41' } } })
    expect(requests.slice(0, 2).map(({ method }) => method)).toEqual([
      'forge.browser.acquire', 'forge.browser.execute',
    ])
    expect(requests[0]?.params).toMatchObject({ createIfNeeded: true })
    expect(requests[0]?.params).not.toHaveProperty('url')
    expect(requests[1]?.params).toMatchObject({
      operation: 'navigate', tabId: 41, input: { url: 'https://fixture.invalid/', readiness: 'load' },
    })
    const checkpoint = await readFile(path.join(root, 'state', 'leases.json'), 'utf8')
    expect(checkpoint).toContain('instance_profile_a')
    expect(checkpoint).not.toContain('fixture.invalid')
    expect(checkpoint).not.toContain('Created')

    const navigated = await runtime.execute(request('navigate', 'ext.instance_profile_a.41', {
      url: 'https://navigated.invalid/', readiness: 'load', timeoutMs: 1_000,
    }))
    expect(navigated).toMatchObject({ ok: true, result: { tab: { tabId: 'ext.instance_profile_a.41', profileId: 'profile-a' } } })
    await expect(runtime.execute(request('snapshot', 'ext.instance_profile_a.41', {}))).resolves.toMatchObject({
      ok: true, result: { tabId: 'ext.instance_profile_a.41', compaction: { omitted: { consoleEntries: 200 } }, screenshot: { data: 'AA==' } },
    })
    await expect(runtime.execute(request('navigate', 'ext.wrong_instance.41', { url: 'https://x.invalid/', readiness: 'load', timeoutMs: 1_000 })))
      .resolves.toMatchObject({ ok: false, error: { code: 'lease-lost' } })
    runtime.deactivate()
    client.close()
    await loop
  })

  it('passes exact attach-conflict evidence through the relay for private adapter consumption', async () => {
    const { runtime, client } = await connectedRuntime()
    const loop = fakeExtensionLoop(client, [], 'instance_profile_a', true, {
      code: 'debugger-unavailable', message: 'Another debugger is already attached', retryable: true,
      details: EXTERNAL_CHROME_DEBUGGER_ATTACH_CONFLICT_DETAILS,
    })
    const authority = await runtime.acquireTarget({
      sessionAgentId: 'session-a', profileId: 'profile-a', operation: 'click', preferredTabId: null,
      reuseExisting: true, createIfNeeded: true, ownerEpoch: 30,
    })
    if (!authority.ok) throw new Error('fixture acquisition failed')
    const adapter = new ExternalChromeTargetAdapter(runtime)

    const execution = await adapter.executeWithAuthority({
      authority: authority.authority,
      request: request('click', authority.authority.tabId, { x: 1, y: 1, timeoutMs: 1_000 }),
    })
    expect(execution).toMatchObject({
      response: { ok: false, error: { code: 'debugger-unavailable' } },
      failure: { phase: 'acquisition', mutationState: 'not-started', fallbackReason: 'foreign-debugger' },
    })
    expect(execution.response.ok || execution.response.error.details).toBeUndefined()
    runtime.deactivate(); client.close(); await loop
  })

  it('closes malformed attach-conflict evidence at the relay boundary', async () => {
    const { runtime, client } = await connectedRuntime()
    const loop = fakeExtensionLoop(client, [], 'instance_profile_a', true, {
      code: 'debugger-unavailable', message: 'Another debugger is already attached', retryable: true,
      details: { ...EXTERNAL_CHROME_DEBUGGER_ATTACH_CONFLICT_DETAILS, mutationState: 'possible' },
    })
    const authority = await runtime.acquireTarget({
      sessionAgentId: 'session-a', profileId: 'profile-a', operation: 'click', preferredTabId: null,
      reuseExisting: true, createIfNeeded: true, ownerEpoch: 31,
    })
    if (!authority.ok) throw new Error('fixture acquisition failed')
    const adapter = new ExternalChromeTargetAdapter(runtime)

    await expect(adapter.executeWithAuthority({
      authority: authority.authority,
      request: request('click', authority.authority.tabId, { x: 1, y: 1, timeoutMs: 1_000 }),
    })).resolves.toMatchObject({
      response: { ok: false, error: { code: 'host-disconnected' } },
      failure: { phase: 'execution', mutationState: 'possible' },
    })
    runtime.deactivate(); client.close(); await loop
  })

  it('acquires one automatic tab authority and releases that exact owner epoch', async () => {
    const { runtime, client } = await connectedRuntime()
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    const loop = fakeExtensionLoop(client, requests)
    const acquired = await runtime.acquireTarget({
      sessionAgentId: 'session-a', profileId: 'profile-a', operation: 'snapshot', preferredTabId: null,
      reuseExisting: true, createIfNeeded: true, ownerEpoch: 27,
    })
    expect(acquired).toEqual({ ok: true, authority: { ownerEpoch: 27, tabId: 'ext.instance_profile_a.40' } })
    if (!acquired.ok) throw new Error('fixture acquisition failed')
    await runtime.releaseAuthority({ sessionAgentId: 'session-a', profileId: 'profile-a' }, acquired.authority, 'idle')
    expect(requests.map(({ method }) => method)).toEqual([
      'forge.browser.inventory', 'forge.browser.acquire', 'forge.browser.release', 'forge.browser.acknowledgeRelease',
    ])
    expect(requests[1]?.params).toMatchObject({ tabId: 40, createIfNeeded: false })
    expect(await runtime.leaseCheckpoints()).toEqual([])
    runtime.deactivate(); client.close(); await loop
  })

  it('releases an exact recovered tab checkpoint for Take Control without host burst memory', async () => {
    const { runtime, client } = await connectedRuntime()
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    const loop = fakeExtensionLoop(client, requests)
    await expect(runtime.acquireTarget({
      sessionAgentId: 'session-a', profileId: 'profile-a', operation: 'snapshot', preferredTabId: null,
      reuseExisting: true, createIfNeeded: true, ownerEpoch: 28,
    })).resolves.toMatchObject({ ok: true, authority: { tabId: 'ext.instance_profile_a.40' } })

    await expect(runtime.releaseTargetAuthority(
      { sessionAgentId: 'session-a', profileId: 'profile-a' },
      'ext.instance_profile_a.40',
      'take-control',
    )).resolves.toBe(true)
    expect(requests.map(({ method }) => method)).toEqual([
      'forge.browser.inventory', 'forge.browser.acquire', 'forge.browser.release', 'forge.browser.acknowledgeRelease',
    ])
    expect(requests.at(-2)?.params).toMatchObject({ reason: 'take-control' })
    expect(await runtime.leaseCheckpoints()).toEqual([])
    runtime.deactivate(); client.close(); await loop
  })

  it('waits for an admitted acquisition to durably checkpoint before quiesce snapshots and releases it', async () => {
    const { runtime, client } = await connectedRuntime('instance_profile_a', Date.now)
    const acquiring = runtime.acquireTarget({
      sessionAgentId: 'session-a', profileId: 'profile-a', operation: 'open',
      preferredTabId: 'ext.instance_profile_a.40', reuseExisting: true, createIfNeeded: false, ownerEpoch: 30,
    })
    const acquireRequest = await client.receive()
    expect(acquireRequest).toMatchObject({ method: 'forge.browser.acquire', params: { tabId: 40, leaseEpoch: 30 } })

    const quiescing = runtime.quiesce('desktop-update', Date.now() + 5_000)
    await client.send({ jsonrpc: '2.0', id: acquireRequest!.id, result: {
      protocolVersion: 1,
      leaseId: (acquireRequest!.params as Record<string, unknown>).leaseId,
      leaseEpoch: 30,
      sessionAgentId: 'session-a',
      extensionInstanceId: 'instance_profile_a',
      tab: { tabId: 40, title: 'Selected', url: 'https://selected.invalid/', active: true },
      created: false,
    } })
    await expect(acquiring).resolves.toMatchObject({ ok: true, authority: { tabId: 'ext.instance_profile_a.40' } })

    const prepareRequest = await client.receive()
    expect(prepareRequest).toMatchObject({ method: 'forge.runtime.prepareUpdate' })
    await client.send({ jsonrpc: '2.0', id: prepareRequest!.id, result: {
      protocolVersion: 1,
      payloadVersion: (prepareRequest!.params as Record<string, unknown>).payloadVersion,
      quiesced: true,
    } })
    const releaseRequest = await client.receive()
    expect(releaseRequest).toMatchObject({
      method: 'forge.browser.release',
      params: { leaseEpoch: 30, reason: 'desktop-update' },
    })
    await client.send({ jsonrpc: '2.0', id: releaseRequest!.id, result: {
      protocolVersion: 1,
      leaseId: (releaseRequest!.params as Record<string, unknown>).leaseId,
      leaseEpoch: 30,
      releasedTabIds: [40],
    } })
    const acknowledgement = await client.receive()
    expect(acknowledgement).toMatchObject({ method: 'forge.browser.acknowledgeRelease', params: { leaseEpoch: 30, releasedTabIds: [40] } })
    await client.send({ jsonrpc: '2.0', id: acknowledgement!.id, result: {
      protocolVersion: 1,
      leaseId: (acknowledgement!.params as Record<string, unknown>).leaseId,
      leaseEpoch: 30,
      releasedTabIds: [40],
      acknowledged: true,
    } })

    await expect(quiescing).resolves.toBeUndefined()
    await expect(runtime.leaseCheckpoints()).resolves.toEqual([])
    runtime.deactivate(); client.close()
  })

  it('automatically reconciles a pre-restart checkpoint on exact-instance hello', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'forge-relay-restart-cleanup-'))
    roots.push(root)
    const checkpointFile = path.join(root, 'state', 'leases.json')
    await mkdir(path.dirname(checkpointFile), { recursive: true })
    await writeFile(checkpointFile, JSON.stringify({
      schemaVersion: 1,
      leases: [{
        extensionInstanceId: 'instance_profile_a',
        sessionAgentId: 'session-a',
        profileId: 'profile-a',
        leaseId: 'lease-before-desktop-restart',
        leaseEpoch: 31,
        tabIds: [40],
        expiresAt: 8_000_000_000_000_000,
      }],
    }))
    const runtime = new ExternalChromeRelayRuntime(checkpointFile)
    runtime.configureExpectedRuntime({ payloadVersion: 'm4-runtime.1', sha256: 'a'.repeat(64), shellAbi: 1 })
    runtime.activate({
      epoch: 'epoch_1234567890abcdef', desktopInstanceId: 'desktop_1234567890abcdef',
      keyId: 'key-test', secret: Buffer.alloc(32, 0x44),
    })
    const endpoint = path.join(root, 'relay.sock')
    const server = createServer((socket) => runtime.accept(socket))
    servers.push(server)
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve) })
    const client = await connectRelayClient(endpoint)
    await sendRuntimeHello(client, 'instance_profile_a')
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    const loop = fakeExtensionLoop(client, requests)

    await waitForCondition(async () => (await runtime.leaseCheckpoints()).length === 0)
    expect(requests).toContainEqual(expect.objectContaining({
      method: 'forge.browser.release',
      params: expect.objectContaining({
        leaseId: 'lease-before-desktop-restart', leaseEpoch: 31, reason: 'desktop-restart',
      }),
    }))
    await expect(runtime.releaseAuthority(
      { sessionAgentId: 'session-a', profileId: 'profile-a' },
      { ownerEpoch: 31, tabId: 'ext.instance_profile_a.40' },
      'redundant-host-retry',
    )).resolves.toBeUndefined()

    runtime.deactivate(); client.close(); await loop
  })

  it('reconciles a Desktop-restart acquisition journal from the exact authenticated Extension report', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'forge-relay-acquisition-restart-'))
    roots.push(root)
    const checkpointFile = path.join(root, 'state', 'leases.json')
    await mkdir(path.dirname(checkpointFile), { recursive: true })
    await writeFile(checkpointFile, JSON.stringify({
      schemaVersion: 2,
      leases: [],
      acquisitions: [{
        extensionInstanceId: 'instance_profile_a',
        sessionAgentId: 'session-acquire-restart',
        profileId: 'profile-a',
        leaseId: 'lease-acquire-before-restart',
        leaseEpoch: 41,
        requestedTabId: null,
        createIfNeeded: true,
        startedAt: 1_000,
      }],
      releaseAcknowledgements: [],
    }))
    const runtime = new ExternalChromeRelayRuntime(checkpointFile)
    runtime.configureExpectedRuntime({ payloadVersion: 'm4-runtime.1', sha256: 'a'.repeat(64), shellAbi: 1 })
    runtime.activate({
      epoch: 'epoch_1234567890abcdef', desktopInstanceId: 'desktop_1234567890abcdef',
      keyId: 'key-test', secret: Buffer.alloc(32, 0x44),
    })
    const endpoint = path.join(root, 'relay.sock')
    const server = createServer((socket) => runtime.accept(socket))
    servers.push(server)
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve) })
    const client = await connectRelayClient(endpoint)
    await sendRuntimeHello(client, 'instance_profile_a', 'm4-runtime.1', 'a'.repeat(64), 1, [{
      leaseId: 'lease-acquire-before-restart', leaseEpoch: 41, state: 'acquired', tabIds: [77],
    }])
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    const loop = fakeExtensionLoop(client, requests, 'instance_profile_a', true, undefined, [77])

    await waitForCondition(async () => !(await runtime.hasActiveLeaseCheckpoints()))
    expect(requests).toContainEqual(expect.objectContaining({
      method: 'forge.browser.release',
      params: expect.objectContaining({
        leaseId: 'lease-acquire-before-restart', leaseEpoch: 41, reason: 'desktop-restart-acquisition',
      }),
    }))
    expect(requests).toContainEqual(expect.objectContaining({ method: 'forge.browser.acknowledgeRelease' }))

    runtime.deactivate(); client.close(); await loop
  })

  it('turns an extension terminal receipt into proactive exact release acknowledgement', async () => {
    const { runtime, client } = await connectedRuntime()
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    const loop = fakeExtensionLoop(client, requests)
    const session = { sessionAgentId: 'session-a', profileId: 'profile-a' }
    const acquired = await runtime.acquireTarget({
      ...session, operation: 'snapshot', preferredTabId: null,
      reuseExisting: true, createIfNeeded: true, ownerEpoch: 32,
    })
    if (!acquired.ok) throw new Error('fixture acquisition failed')
    const checkpoint = (await runtime.leaseCheckpoints())[0]!
    await client.send({
      jsonrpc: '2.0',
      method: 'browser.leaseChanged',
      params: {
        protocolVersion: 1,
        leaseId: checkpoint.leaseId,
        leaseEpoch: checkpoint.leaseEpoch,
        state: 'released',
        tabIds: checkpoint.tabIds,
      },
    })

    await waitForCondition(async () => (await runtime.leaseCheckpoints()).length === 0)
    expect(requests.filter(({ method }) => method === 'forge.browser.release')).toEqual([
      expect.objectContaining({ params: expect.objectContaining({ reason: 'extension-terminal' }) }),
    ])
    await expect(runtime.releaseAuthority(session, acquired.authority, 'redundant-host-retry')).resolves.toBeUndefined()

    runtime.deactivate(); client.close(); await loop
  })

  it('retains an exact idle-release checkpoint across disconnect and clears it only after retry acknowledgement', async () => {
    const { runtime, client, root } = await connectedRuntime()
    const firstLoop = fakeExtensionLoop(client)
    const acquired = await runtime.acquireTarget({
      sessionAgentId: 'session-a', profileId: 'profile-a', operation: 'snapshot', preferredTabId: null,
      reuseExisting: true, createIfNeeded: true, ownerEpoch: 32,
    })
    if (!acquired.ok) throw new Error('fixture acquisition failed')
    client.close(); await firstLoop
    await expect(runtime.releaseAuthority({ sessionAgentId: 'session-a', profileId: 'profile-a' }, acquired.authority, 'idle')).rejects.toThrow()
    expect(await runtime.leaseCheckpoints()).toHaveLength(1)

    const reconnected = await connectRelayClient(path.join(root, 'relay.sock'))
    await sendRuntimeHello(reconnected, 'instance_profile_a')
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    const retryLoop = fakeExtensionLoop(reconnected, requests)
    await runtime.releaseAuthority({ sessionAgentId: 'session-a', profileId: 'profile-a' }, acquired.authority, 'idle')
    expect(requests.map(({ method }) => method)).toEqual(['forge.browser.release', 'forge.browser.acknowledgeRelease'])
    expect(await runtime.leaseCheckpoints()).toEqual([])
    runtime.deactivate(); reconnected.close(); await retryLoop
  })

  it('retains disconnected delete cleanup and proactively reconciles it on exact-instance reconnect', async () => {
    const { runtime, client, root } = await connectedRuntime()
    const loop = fakeExtensionLoop(client)
    const session = { sessionAgentId: 'session-a', profileId: 'profile-a' }
    const acquired = await runtime.acquireTarget({
      ...session, operation: 'snapshot', preferredTabId: null,
      reuseExisting: true, createIfNeeded: true, ownerEpoch: 33,
    })
    if (!acquired.ok) throw new Error('fixture acquisition failed')
    client.close(); await loop

    await expect(runtime.releaseSession(session, 'delete')).rejects.toThrow('disconnected')
    expect(await runtime.leaseCheckpoints()).toMatchObject([{ cleanupReason: 'delete', tabIds: [40] }])

    const reconnected = await connectRelayClient(path.join(root, 'relay.sock'))
    await sendRuntimeHello(reconnected, 'instance_profile_a')
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    const retryLoop = fakeExtensionLoop(reconnected, requests)
    await waitForCondition(async () => (await runtime.leaseCheckpoints()).length === 0)
    expect(requests).toContainEqual(expect.objectContaining({
      method: 'forge.browser.release', params: expect.objectContaining({ reason: 'delete' }),
    }))

    runtime.deactivate(); reconnected.close(); await retryLoop
  })

  it('removes a relay checkpoint only after the retry acknowledges its exact receipted tab IDs', async () => {
    const { runtime, client, root } = await connectedRuntime()
    const mismatchedLoop = fakeExtensionLoop(client, [], 'instance_profile_a', true, undefined, [999])
    const acquired = await runtime.acquireTarget({
      sessionAgentId: 'session-a', profileId: 'profile-a', operation: 'snapshot', preferredTabId: null,
      reuseExisting: true, createIfNeeded: true, ownerEpoch: 36,
    })
    if (!acquired.ok) throw new Error('fixture acquisition failed')
    await expect(runtime.releaseAuthority({ sessionAgentId: 'session-a', profileId: 'profile-a' }, acquired.authority, 'idle'))
      .rejects.toThrow('exact checkpoint release was not acknowledged')
    expect(await runtime.leaseCheckpoints()).toHaveLength(1)
    client.close(); await mismatchedLoop

    const reconnected = await connectRelayClient(path.join(root, 'relay.sock'))
    await sendRuntimeHello(reconnected, 'instance_profile_a')
    const exactLoop = fakeExtensionLoop(reconnected)
    await runtime.releaseAuthority({ sessionAgentId: 'session-a', profileId: 'profile-a' }, acquired.authority, 'idle')
    expect(await runtime.leaseCheckpoints()).toEqual([])
    runtime.deactivate(); reconnected.close(); await exactLoop
  })

  it('retains the exact checkpoint when durable release settlement fails after the release response', async () => {
    let failSettlement = true
    const { runtime, client } = await connectedRuntime(
      'instance_profile_a', Date.now, undefined, 'a'.repeat(64), 1,
      (phase) => {
        if (phase === 'checkpoint-settle' && failSettlement) throw new Error('injected checkpoint settlement failure')
      },
    )
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    const loop = fakeExtensionLoop(client, requests)
    const session = { sessionAgentId: 'session-settle', profileId: 'profile' }
    const acquired = await runtime.acquireTarget({
      ...session, operation: 'open', preferredTabId: 'ext.instance_profile_a.40',
      reuseExisting: true, createIfNeeded: false, ownerEpoch: 39,
    })
    if (!acquired.ok) throw new Error('fixture acquisition failed')

    await expect(runtime.releaseAuthority(session, acquired.authority, 'turn-ended'))
      .rejects.toThrow('injected checkpoint settlement failure')
    expect(await runtime.leaseCheckpoints()).toHaveLength(1)
    expect(requests.some(({ method }) => method === 'forge.browser.acknowledgeRelease')).toBe(false)

    failSettlement = false
    await expect(runtime.releaseAuthority(session, acquired.authority, 'turn-ended')).resolves.toBeUndefined()
    await expect(runtime.hasActiveLeaseCheckpoints()).resolves.toBe(false)
    runtime.deactivate(); client.close(); await loop
  })

  it('retries an exact durable receipt acknowledgement after its response and Extension connection are lost', async () => {
    const { runtime, client, root } = await connectedRuntime()
    const session = { sessionAgentId: 'session-lost-ack', profileId: 'profile' }
    const acquiring = runtime.acquireTarget({
      ...session, operation: 'open', preferredTabId: 'ext.instance_profile_a.40',
      reuseExisting: true, createIfNeeded: false, ownerEpoch: 42,
    })
    const acquireRequest = await client.receive()
    const acquireParams = acquireRequest!.params as Record<string, unknown>
    await client.send({ jsonrpc: '2.0', id: acquireRequest!.id, result: {
      protocolVersion: 1, leaseId: acquireParams.leaseId, leaseEpoch: 42,
      sessionAgentId: session.sessionAgentId, extensionInstanceId: 'instance_profile_a',
      tab: { tabId: 40, title: '', url: 'https://fixture.invalid/', active: true }, created: false,
    } })
    const acquired = await acquiring
    if (!acquired.ok) throw new Error('fixture acquisition failed')

    const releasing = runtime.releaseAuthority(session, acquired.authority, 'turn-ended')
    const releaseRequest = await client.receive()
    await client.send({ jsonrpc: '2.0', id: releaseRequest!.id, result: {
      protocolVersion: 1, leaseId: acquireParams.leaseId, leaseEpoch: 42, releasedTabIds: [40],
    } })
    const lostAcknowledgement = await client.receive()
    expect(lostAcknowledgement).toMatchObject({ method: 'forge.browser.acknowledgeRelease', params: { releasedTabIds: [40] } })
    client.close()
    await expect(releasing).rejects.toThrow(/disconnect/u)
    expect(await runtime.leaseCheckpoints()).toEqual([])
    await expect(runtime.hasActiveLeaseCheckpoints()).resolves.toBe(true)

    const reconnected = await connectRelayClient(path.join(root, 'relay.sock'))
    await sendRuntimeHello(reconnected, 'instance_profile_a', 'm4-runtime.1', 'a'.repeat(64), 1, [{
      leaseId: String(acquireParams.leaseId), leaseEpoch: 42, state: 'released', tabIds: [40],
    }])
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    const loop = fakeExtensionLoop(reconnected, requests)
    await waitForCondition(async () => !(await runtime.hasActiveLeaseCheckpoints()))
    expect(requests).toContainEqual(expect.objectContaining({
      method: 'forge.browser.acknowledgeRelease',
      params: expect.objectContaining({ leaseId: acquireParams.leaseId, leaseEpoch: 42, releasedTabIds: [40] }),
    }))

    runtime.deactivate(); reconnected.close(); await loop
  })

  it('retains a durable pending acknowledgement when receipt-ack checkpoint removal fails', async () => {
    let failAckRemoval = true
    const { runtime, client } = await connectedRuntime(
      'instance_profile_a', Date.now, undefined, 'a'.repeat(64), 1,
      (phase) => {
        if (phase === 'acknowledgement-remove' && failAckRemoval) throw new Error('injected acknowledgement removal failure')
      },
    )
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    const loop = fakeExtensionLoop(client, requests)
    const session = { sessionAgentId: 'session-ack-remove', profileId: 'profile' }
    const acquired = await runtime.acquireTarget({
      ...session, operation: 'open', preferredTabId: 'ext.instance_profile_a.40',
      reuseExisting: true, createIfNeeded: false, ownerEpoch: 40,
    })
    if (!acquired.ok) throw new Error('fixture acquisition failed')

    await expect(runtime.releaseAuthority(session, acquired.authority, 'turn-ended'))
      .rejects.toThrow('injected acknowledgement removal failure')
    expect(await runtime.leaseCheckpoints()).toEqual([])
    await expect(runtime.hasActiveLeaseCheckpoints()).resolves.toBe(true)

    failAckRemoval = false
    await expect(runtime.releaseAuthority(session, acquired.authority, 'turn-ended')).resolves.toBeUndefined()
    await expect(runtime.hasActiveLeaseCheckpoints()).resolves.toBe(false)
    expect(requests.filter(({ method }) => method === 'forge.browser.acknowledgeRelease').length).toBeGreaterThanOrEqual(2)
    runtime.deactivate(); client.close(); await loop
  })

  it('reacquires, reveals through the dedicated RPC, and releases exact authority after idle cleanup', async () => {
    const { runtime, client } = await connectedRuntime()
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    const loop = fakeExtensionLoop(client, requests)
    const acquired = await runtime.acquireTarget({
      sessionAgentId: 'session-a', profileId: 'profile-a', operation: 'snapshot', preferredTabId: null,
      reuseExisting: true, createIfNeeded: true, ownerEpoch: 33,
    })
    if (!acquired.ok) throw new Error('fixture acquisition failed')
    await runtime.releaseAuthority({ sessionAgentId: 'session-a', profileId: 'profile-a' }, acquired.authority, 'idle')
    await expect(runtime.revealTarget({ sessionAgentId: 'session-a', profileId: 'profile-a' }, acquired.authority.tabId))
      .resolves.toEqual({ revealed: true, tabId: acquired.authority.tabId })
    expect(requests.map(({ method }) => method)).toEqual([
      'forge.browser.inventory', 'forge.browser.acquire', 'forge.browser.release', 'forge.browser.acknowledgeRelease',
      'forge.browser.acquire', 'forge.browser.reveal', 'forge.browser.release', 'forge.browser.acknowledgeRelease',
    ])
    expect(await runtime.leaseCheckpoints()).toEqual([])
    runtime.deactivate(); client.close(); await loop
  })

  it('uses generic endTurn and releaseSession cleanup with no surviving checkpoint', async () => {
    const { runtime, client } = await connectedRuntime()
    const loop = fakeExtensionLoop(client)
    const session = { sessionAgentId: 'session-a', profileId: 'profile-a' }
    const first = await runtime.acquireTarget({ ...session, operation: 'snapshot', preferredTabId: null, reuseExisting: true, createIfNeeded: true, ownerEpoch: 34 })
    if (!first.ok) throw new Error('fixture acquisition failed')
    await runtime.endTurn(session, 'turn-1')
    expect(await runtime.leaseCheckpoints()).toEqual([])
    const second = await runtime.acquireTarget({ ...session, operation: 'snapshot', preferredTabId: null, reuseExisting: true, createIfNeeded: true, ownerEpoch: 35 })
    if (!second.ok) throw new Error('fixture acquisition failed')
    await runtime.releaseSession(session, 'archive')
    expect(await runtime.leaseCheckpoints()).toEqual([])
    runtime.deactivate(); client.close(); await loop
  })

  it('fails closed on a second-session explicit acquire until exact prior authority release', async () => {
    const { runtime, client } = await connectedRuntime()
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    const tabs = [{
      tabId: 40, windowId: 4, title: 'Shared profile tab', url: 'https://selected.invalid/private',
      active: true, windowFocused: false, lastAccessed: 1_000,
    }]
    const loop = fakeExtensionLoop(
      client, requests, 'instance_profile_a', true, undefined, undefined, tabs, true,
    )
    const tabId = 'ext.instance_profile_a.40'
    const sessionA = { sessionAgentId: 'session-a', profileId: 'profile' }
    const sessionB = { sessionAgentId: 'session-b', profileId: 'profile' }

    const first = await runtime.acquireTarget({
      ...sessionA, operation: 'open', preferredTabId: tabId, reuseExisting: true,
      createIfNeeded: false, ownerEpoch: 36,
    })
    if (!first.ok) throw new Error('first session acquisition failed')
    const conflicted = await runtime.acquireTarget({
      ...sessionB, operation: 'open', preferredTabId: tabId, reuseExisting: true,
      createIfNeeded: false, ownerEpoch: 37,
    })
    expect(conflicted).toMatchObject({
      ok: false,
      error: { code: 'lease-lost', retryable: false },
      metadata: { phase: 'acquisition', mutationState: 'possible' },
    })
    if (!conflicted.ok) expect(conflicted.metadata).not.toHaveProperty('fallbackReason')
    const active = (await runtime.leaseCheckpoints())[0]!
    expect(active).toMatchObject({ sessionAgentId: 'session-a', profileId: 'profile', tabIds: [40] })
    await client.send({
      jsonrpc: '2.0', method: 'browser.authoritySnapshot',
      params: {
        protocolVersion: 1, snapshotId: 'post-conflict-snapshot',
        reports: [{ leaseId: active.leaseId, leaseEpoch: active.leaseEpoch, state: 'acquired', tabIds: [40] }],
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 20))

    await runtime.releaseAuthority(sessionA, first.authority, 'turn-ended')
    const second = await runtime.acquireTarget({
      ...sessionB, operation: 'open', preferredTabId: tabId, reuseExisting: true,
      createIfNeeded: false, ownerEpoch: 38,
    })
    expect(second).toEqual({ ok: true, authority: { ownerEpoch: 38, tabId } })
    if (!second.ok) throw new Error('second session acquisition after release failed')
    await runtime.releaseAuthority(sessionB, second.authority, 'turn-ended')
    expect(await runtime.leaseCheckpoints()).toEqual([])
    expect(requests.filter(({ method }) => method === 'forge.browser.acquire')).toHaveLength(3)

    runtime.deactivate(); client.close(); await loop
  })

  it('keeps inventory-only acquisition mutation-free when no eligible tab exists and creation is disabled', async () => {
    const { runtime, client } = await connectedRuntime()
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    const loop = fakeExtensionLoop(client, requests, 'instance_profile_a', false)

    await expect(runtime.acquireTarget({
      sessionAgentId: 'session-a', profileId: 'profile-a', operation: 'open', preferredTabId: null,
      reuseExisting: true, createIfNeeded: false, ownerEpoch: 27,
    })).resolves.toMatchObject({
      ok: false,
      metadata: { phase: 'acquisition', mutationState: 'not-started', fallbackReason: 'no-eligible-target' },
    })
    expect(requests.map(({ method }) => method)).toEqual(['forge.browser.inventory'])
    expect(await runtime.leaseCheckpoints()).toEqual([])
    runtime.deactivate(); client.close(); await loop
  })

  it.each([true, false])('creates only when requested and no reusable inventory exists (reuseExisting=%s)', async (reuseExisting) => {
    const { runtime, client } = await connectedRuntime()
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    const loop = fakeExtensionLoop(client, requests, 'instance_profile_a', false)
    await expect(runtime.acquireTarget({
      sessionAgentId: 'session-a', profileId: 'profile-a', operation: 'snapshot', preferredTabId: null,
      reuseExisting, createIfNeeded: true, ownerEpoch: 28,
    })).resolves.toEqual({ ok: true, authority: { ownerEpoch: 28, tabId: 'ext.instance_profile_a.41' } })
    expect(requests.map(({ method }) => method)).toEqual(reuseExisting
      ? ['forge.browser.inventory', 'forge.browser.acquire']
      : ['forge.browser.acquire'])
    expect(requests.find(({ method }) => method === 'forge.browser.acquire')?.params).toMatchObject({ createIfNeeded: true })
    runtime.deactivate(); client.close(); await loop
  })

  it.each([true, false])('opens one explicitly created tab when inventory is empty (reuseExistingTab=%s)', async (reuseExistingTab) => {
    const { runtime, client } = await connectedRuntime()
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    const loop = fakeExtensionLoop(client, requests, 'instance_profile_a', false)
    await expect(runtime.execute(request('open', null, { show: false, reuseExistingTab }))).resolves.toMatchObject({
      ok: true, result: { created: true, tab: { tabId: 'ext.instance_profile_a.41' } },
    })
    expect(requests.map(({ method }) => method)).toEqual(reuseExistingTab
      ? ['forge.browser.inventory', 'forge.browser.acquire', 'forge.browser.execute', 'forge.browser.inventory']
      : ['forge.browser.acquire', 'forge.browser.execute', 'forge.browser.inventory'])
    const acquire = requests.find(({ method }) => method === 'forge.browser.acquire')
    expect(acquire?.params).toMatchObject({ createIfNeeded: true })
    expect(acquire?.params).not.toHaveProperty('url')
    expect(requests.find(({ method }) => method === 'forge.browser.execute')?.params).toMatchObject({ operation: 'status', tabId: 41 })
    runtime.deactivate(); client.close(); await loop
  })

  it('aggregates every authenticated profile and selects the most-recent tab without confirmation', async () => {
    const { runtime, client: profileA, root } = await connectedRuntime('instance_profile_a')
    const profileB = await connectRelayClient(path.join(root, 'relay.sock'))
    await sendRuntimeHello(profileB, 'instance_profile_b')
    const requestsA: Array<{ method: string; params: Record<string, unknown> }> = []
    const requestsB: Array<{ method: string; params: Record<string, unknown> }> = []
    const tabsA = [{
      tabId: 40, windowId: 4, title: 'Profile A', url: 'https://a.invalid/', active: true,
      windowFocused: false, lastAccessed: 1_000,
    }]
    const tabsB = [
      { tabId: 55, windowId: 5, title: 'Profile B active', url: 'https://b.invalid/active', active: true, windowFocused: false, lastAccessed: 2_000 },
      { tabId: 56, windowId: 5, title: 'Profile B other', url: 'https://b.invalid/other', active: false, windowFocused: false, lastAccessed: 3_000 },
    ]
    const loopA = fakeExtensionLoop(profileA, requestsA, 'instance_profile_a', true, undefined, undefined, tabsA)
    const loopB = fakeExtensionLoop(profileB, requestsB, 'instance_profile_b', true, undefined, undefined, tabsB)
    const session = { sessionAgentId: 'session-a', profileId: 'profile-a' }

    await expect(runtime.listEligibleTabs(session)).resolves.toMatchObject({
      tabs: [
        { tabId: 'ext.instance_profile_b.55', browserProfileId: 'ext-profile.instance_profile_b', active: true, windowFocused: false },
        { tabId: 'ext.instance_profile_a.40', browserProfileId: 'ext-profile.instance_profile_a', active: true, windowFocused: false },
        { tabId: 'ext.instance_profile_b.56', active: false, windowFocused: false },
      ],
      truncated: false,
    })
    const selected = await runtime.acquireTarget({
      ...session, operation: 'open', preferredTabId: null, reuseExisting: true, createIfNeeded: true, ownerEpoch: 29,
    })
    expect(selected).toEqual({ ok: true, authority: { ownerEpoch: 29, tabId: 'ext.instance_profile_b.55' } })
    if (!selected.ok) throw new Error('fixture selection failed')
    await runtime.releaseAuthority(session, selected.authority, 'idle')

    const explicit = await runtime.acquireTarget({
      ...session, operation: 'open', preferredTabId: 'ext.instance_profile_b.56', reuseExisting: true,
      createIfNeeded: false, ownerEpoch: 30,
    })
    expect(explicit).toEqual({ ok: true, authority: { ownerEpoch: 30, tabId: 'ext.instance_profile_b.56' } })
    if (!explicit.ok) throw new Error('fixture explicit selection failed')
    await runtime.releaseAuthority(session, explicit.authority, 'idle')
    const acquisitions = [...requestsA, ...requestsB].filter(({ method }) => method === 'forge.browser.acquire')
    expect(acquisitions).toHaveLength(2)
    expect(acquisitions.every(({ params }) => params.createIfNeeded === false)).toBe(true)

    profileA.close(); await loopA
    const newerProfileA = await connectRelayClient(path.join(root, 'relay.sock'))
    await sendRuntimeHello(newerProfileA, 'instance_profile_a')
    const newerLoopA = fakeExtensionLoop(newerProfileA, requestsA, 'instance_profile_a', true, undefined, undefined, tabsA)

    await runtime.releaseSession(session, 'delete')
    const recreated = await runtime.acquireTarget({
      ...session, operation: 'open', preferredTabId: null,
      reuseExisting: false, createIfNeeded: true, ownerEpoch: 31,
    })
    expect(recreated).toEqual({ ok: true, authority: { ownerEpoch: 31, tabId: 'ext.instance_profile_a.41' } })
    if (!recreated.ok) throw new Error('fixture recreated session acquisition failed')
    await runtime.releaseAuthority(session, recreated.authority, 'idle')

    runtime.deactivate(); newerProfileA.close(); profileB.close(); await Promise.all([newerLoopA, loopB])
  })

  it('restores the same canonical inventory IDs after an automatic runtime reconnect', async () => {
    const { runtime, client, root } = await connectedRuntime('instance_profile_a')
    const tabs = [{
      tabId: 40, windowId: 4, title: 'Stable', url: 'https://stable.invalid/', active: true,
      windowFocused: false, lastAccessed: 1_000,
    }]
    const firstLoop = fakeExtensionLoop(client, [], 'instance_profile_a', true, undefined, undefined, tabs)
    const session = { sessionAgentId: 'session-a', profileId: 'profile-a' }
    const before = await runtime.listEligibleTabs(session)
    expect(before.tabs[0]?.tabId).toBe('ext.instance_profile_a.40')
    client.close()
    await firstLoop
    await waitForCondition(() => runtime.inventory().length === 0)

    const reconnected = await connectRelayClient(path.join(root, 'relay.sock'))
    await sendRuntimeHello(reconnected, 'instance_profile_a')
    const secondLoop = fakeExtensionLoop(reconnected, [], 'instance_profile_a', true, undefined, undefined, tabs)
    await expect(runtime.listEligibleTabs(session)).resolves.toMatchObject({
      tabs: [{ tabId: 'ext.instance_profile_a.40', url: 'https://stable.invalid/' }],
    })
    const acquired = await runtime.acquireTarget({
      ...session, operation: 'snapshot', preferredTabId: 'ext.instance_profile_a.40', reuseExisting: true,
      createIfNeeded: false, ownerEpoch: 31,
    })
    if (!acquired.ok) throw new Error('fixture reconnect acquisition failed')
    await runtime.releaseAuthority(session, acquired.authority, 'idle')

    runtime.deactivate(); reconnected.close(); await secondLoop
  })

})

async function waitForCondition(assertion: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await assertion()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error('condition did not settle')
}
