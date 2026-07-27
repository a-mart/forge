import { createServer, type Server } from 'node:net'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { BrowserAutomationRequest } from '@forge/protocol'
import { AuthenticatedRelayClient } from '../../../../native-messaging-host/src/relay-client.js'
import { NodeSocketConnector } from '../../../../native-messaging-host/src/transport.js'
import { ExternalChromeRelayRuntime } from '../relay-runtime.js'

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
): Promise<void> {
  await client.send({
    jsonrpc: '2.0', id: 'hello', method: 'forge.runtime.hello', params: {
      protocol: { min: 1, max: 1 }, shellAbi, payloadVersion,
      ...(payloadSha256 === null ? {} : { payloadSha256 }),
      extensionId: 'fcchfcnadajoejfbiclihglkmbcfhajd', extensionInstanceId: instanceId, chromeVersion: '125.0.0.0',
      methods: ['forge.runtime.hello', 'forge.runtime.ping', 'forge.browser.listCandidates', 'forge.browser.claim', 'forge.browser.create', 'forge.browser.release', 'forge.browser.execute', 'forge.browser.turnEnded', 'forge.runtime.prepareUpdate', 'forge.runtime.reload', 'browser.cdpEvent', 'browser.detached', 'browser.userControl', 'browser.tabChanged', 'browser.downloadChanged', 'browser.leaseChanged', 'runtime.goodbye'],
      maxMessageBytes: 262144,
      operations: ['status', 'open', 'navigate', 'resize', 'snapshot', 'click', 'type', 'press', 'scroll', 'evaluate', 'waitFor', 'recordingStart', 'recordingStop'].map((operation) => ({
        operation, supported: !['resize', 'recordingStart', 'recordingStop'].includes(operation), ...(!['resize', 'recordingStart', 'recordingStop'].includes(operation) ? {} : { reason: 'physical viewport and recording disabled' }),
      })),
      features: { resize: false, recording: false, downloadEvents: false, downloadArtifacts: false, downloadOpen: false, oopif: true, humanInterruption: true, groups: true },
    },
  })
  await expect(client.receive()).resolves.toMatchObject({ id: 'hello', result: { protocolVersion: 1, requiredShellAbi: 1 } })
}

async function connectedRuntime(
  instanceId = 'instance_profile_a',
  now: () => number = () => 1_000,
  expected?: { payloadVersion: string; sha256: string; shellAbi: number },
  helloPayloadSha256: string | null = 'a'.repeat(64),
  helloShellAbi = 1,
): Promise<{
  runtime: ExternalChromeRelayRuntime
  client: AuthenticatedRelayClient
  root: string
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-relay-runtime-'))
  roots.push(root)
  const endpoint = path.join(root, 'relay.sock')
  const key = Buffer.alloc(32, 0x44)
  const runtime = new ExternalChromeRelayRuntime(path.join(root, 'state', 'leases.json'), now)
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

function request(operation: BrowserAutomationRequest['operation'], tabId: string | null, input: Record<string, unknown> = {}): BrowserAutomationRequest {
  return {
    requestId: `request-${operation}`, hostKind: 'external-chrome', sessionAgentId: 'session-a', profileId: 'profile-a',
    tabId, operation, input, hostId: 'external-host', hostGeneration: 3,
    deadlineAt: new Date(Date.now() + 30_000).toISOString(), artifactDirectory: null,
  } as BrowserAutomationRequest
}

async function fakeExtensionLoop(
  client: AuthenticatedRelayClient,
  requests: Array<{ method: string; params: Record<string, unknown> }> = [],
  instanceId = 'instance_profile_a',
): Promise<void> {
  const authorityTabs = new Map<string, number[]>()
  while (true) {
    const message = await client.receive()
    if (!message) return
    if (typeof message.id !== 'string' || typeof message.method !== 'string') continue
    const params = message.params as Record<string, unknown>
    requests.push({ method: message.method, params })
    if (message.method === 'forge.browser.listCandidates') {
      await client.send({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: 1, extensionInstanceId: instanceId, windows: [{ windowId: 2, focused: true, groups: [], tabs: [] }],
      } })
    } else if (message.method === 'forge.browser.claim') {
      authorityTabs.set(String(params.leaseId), [40])
      await client.send({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: 1, leaseId: params.leaseId, leaseEpoch: params.leaseEpoch, sessionAgentId: params.sessionAgentId,
        extensionInstanceId: instanceId, groupId: 9, childPolicy: params.childPolicy,
        tabs: [{ windowId: 2, tabId: 40, groupId: 9, title: 'Selected', url: 'https://selected.invalid/private', origin: 'https://selected.invalid', active: true }],
      } })
    } else if (message.method === 'forge.browser.create') {
      authorityTabs.set(String(params.leaseId), [41])
      await client.send({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: 1, leaseId: params.leaseId, leaseEpoch: params.leaseEpoch, sessionAgentId: params.sessionAgentId,
        extensionInstanceId: instanceId, groupId: 9,
        tab: { windowId: 2, tabId: 41, groupId: 9, title: 'Created', url: 'https://fixture.invalid/', origin: 'https://fixture.invalid', active: true },
      } })
    } else if (message.method === 'forge.browser.release') {
      await client.send({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: 1, leaseId: params.leaseId, leaseEpoch: params.leaseEpoch, releasedTabIds: authorityTabs.get(String(params.leaseId)) ?? [40],
      } })
    } else if (message.method === 'forge.browser.execute') {
      const now = new Date(0).toISOString()
      const operation = String(params.operation)
      const result = operation === 'navigate' ? {
        readiness: 'load', tab: {
          hostKind: 'external-chrome', tabId: '41', sessionAgentId: 'session-a', profileId: 'instance_profile_a',
          url: 'https://navigated.invalid/', title: 'Navigated', lifecycle: 'ready', loading: false, live: true,
          canGoBack: false, canGoForward: false, zoomFactor: 1, controller: 'agent', agentCursor: null, recording: null,
          viewportSetting: { mode: 'fill' }, renderedViewport: null, physicalVisible: false, error: null, createdAt: now, updatedAt: now,
        },
      } : operation === 'status' ? {
        available: true,
        host: { hostKind: 'external-chrome', connected: true, hostId: null, hostGeneration: null, focused: false, capabilities: null, connectedAt: null },
        panelVisible: false, panelRevealRequested: false, physicalTabVisible: false,
        selectedTab: {
          hostKind: 'external-chrome', tabId: String(params.tabId), sessionAgentId: 'session-a', profileId: 'instance_profile_a',
          url: 'https://selected.invalid/private', title: 'Selected private title', lifecycle: 'ready', loading: false, live: true,
          canGoBack: false, canGoForward: false, zoomFactor: 1, controller: 'human', agentCursor: null, recording: null,
          viewportSetting: { mode: 'fill' }, renderedViewport: null, physicalVisible: false, error: null, createdAt: now, updatedAt: now,
        },
      } : operation === 'evaluate' ? { tabId: String(params.tabId), value: { answer: 42 }, serializedBytes: 13 }
        : { tabId: String(params.tabId), matched: true, elapsedMs: 2 }
      await client.send({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: 1, leaseId: params.leaseId, leaseEpoch: params.leaseEpoch, requestId: params.requestId,
        tabId: params.tabId, operation, ok: true, result,
      } })
    } else if (message.method === 'forge.browser.turnEnded') {
      await client.send({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: 1, leaseId: params.leaseId, leaseEpoch: params.leaseEpoch, turnId: params.turnId,
        releasedTabs: params.finalTabs, handoffTabs: params.handoffTabs,
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
  it('routes create and navigate through the real adapter transport and persists only opaque lease scope', async () => {
    const { runtime, client, root } = await connectedRuntime()
    const loop = fakeExtensionLoop(client)
    const opened = await runtime.execute(request('open', null, { url: 'https://fixture.invalid/', show: false, reuseExistingTab: false }))
    expect(opened).toMatchObject({ ok: true, result: { created: true, tab: { tabId: 'ext.instance_profile_a.41' } } })
    const checkpoint = await readFile(path.join(root, 'state', 'leases.json'), 'utf8')
    expect(checkpoint).toContain('instance_profile_a')
    expect(checkpoint).not.toContain('fixture.invalid')
    expect(checkpoint).not.toContain('Created')

    const navigated = await runtime.execute(request('navigate', 'ext.instance_profile_a.41', {
      url: 'https://navigated.invalid/', readiness: 'load', timeoutMs: 1_000,
    }))
    expect(navigated).toMatchObject({ ok: true, result: { tab: { tabId: 'ext.instance_profile_a.41', profileId: 'profile-a' } } })
    await expect(runtime.execute(request('status', 'ext.instance_profile_a.41'))).resolves.toMatchObject({
      ok: true, result: { selectedTab: { tabId: 'ext.instance_profile_a.41', profileId: 'profile-a', url: 'https://selected.invalid/private', title: 'Selected private title' } },
    })
    await expect(runtime.execute(request('navigate', 'ext.wrong_instance.41', { url: 'https://x.invalid/', readiness: 'load', timeoutMs: 1_000 })))
      .resolves.toMatchObject({ ok: false, error: { code: 'lease-lost' } })
    runtime.deactivate()
    client.close()
    await loop
  })

  it('acquires one automatic tab authority and releases that exact owner epoch', async () => {
    const { runtime, client } = await connectedRuntime()
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    const loop = fakeExtensionLoop(client, requests)
    const acquired = await runtime.acquireTarget({
      sessionAgentId: 'session-a', profileId: 'profile-a', operation: 'snapshot', preferredTabId: null,
      reuseExisting: true, createIfNeeded: true, ownerEpoch: 27,
    })
    expect(acquired).toEqual({ ok: true, authority: { ownerEpoch: 27, tabId: 'ext.instance_profile_a.41' } })
    if (!acquired.ok) throw new Error('fixture acquisition failed')
    await runtime.releaseAuthority({ sessionAgentId: 'session-a', profileId: 'profile-a' }, acquired.authority, 'idle')
    expect(requests.map(({ method }) => method)).toEqual([
      'forge.browser.listCandidates', 'forge.browser.create', 'forge.browser.release',
    ])
    expect(await runtime.leaseCheckpoints()).toEqual([])
    runtime.deactivate(); client.close(); await loop
  })

  it('routes M4 functional results and exact bounded turn dispositions without persisting page data', async () => {
    const { runtime, client, root } = await connectedRuntime()
    const loop = fakeExtensionLoop(client)
    await runtime.claim({
      extensionInstanceId: 'instance_profile_a', sessionAgentId: 'session-a', profileId: 'profile-a',
      leaseId: 'lease-m4', leaseEpoch: 12, tabIds: [40], groupId: 9, childPolicy: 'manual',
    })
    await expect(runtime.execute(request('evaluate', 'ext.instance_profile_a.40', {
      expression: 'Promise.resolve({answer: 42})', awaitPromise: true, returnByValue: true,
    }))).resolves.toMatchObject({ ok: true, result: { tabId: 'ext.instance_profile_a.40', value: { answer: 42 } } })
    await expect(runtime.handoffSessionAtTurnEnd({
      extensionInstanceId: 'instance_profile_a', sessionAgentId: 'session-a', profileId: 'profile-a', tabId: 40, turnId: 'turn-12',
    })).resolves.toBeUndefined()
    await expect(runtime.handoffSessionAtTurnEnd({
      extensionInstanceId: 'instance_profile_a', sessionAgentId: 'session-a', profileId: 'profile-a', tabId: 40, turnId: 'turn-12',
    })).resolves.toBeUndefined()
    await expect(runtime.turnEnded({
      extensionInstanceId: 'instance_profile_a', leaseId: 'lease-m4', leaseEpoch: 12, turnId: 'stale-turn', finalTabs: [], handoffTabs: [40],
    })).rejects.toThrow(/stale|out of order/u)
    const checkpoint = await readFile(path.join(root, 'state', 'leases.json'), 'utf8')
    expect(checkpoint).not.toContain('Promise.resolve')
    expect(JSON.parse(checkpoint).leases[0]).toMatchObject({ tabIds: [40], leaseId: 'lease-m4', handoffTurnId: 'turn-12' })
    // The next exact-lease execute resumes HANDOFF and permits a newer disposition.
    await expect(runtime.execute(request('evaluate', 'ext.instance_profile_a.40', {
      expression: '1', awaitPromise: true, returnByValue: true,
    }))).resolves.toMatchObject({ ok: true })
    await expect(runtime.turnEnded({
      extensionInstanceId: 'instance_profile_a', leaseId: 'lease-m4', leaseEpoch: 12, turnId: 'turn-final', finalTabs: [40], handoffTabs: [],
    })).resolves.toMatchObject({ releasedTabs: [40], handoffTabs: [] })
    expect(JSON.parse(await readFile(path.join(root, 'state', 'leases.json'), 'utf8')).leases).toEqual([])
    runtime.deactivate(); client.close(); await loop
  })

  it('reloads durable lease authority before a restarted Desktop accepts reconciliation', async () => {
    const { runtime, client, root } = await connectedRuntime()
    const loop = fakeExtensionLoop(client)
    await runtime.claim({
      extensionInstanceId: 'instance_profile_a', sessionAgentId: 'session-a', profileId: 'profile-a',
      leaseId: 'lease-restart', leaseEpoch: 5, tabIds: [40], groupId: 9, childPolicy: 'manual',
    })
    runtime.deactivate(); client.close(); await loop
    const restarted = new ExternalChromeRelayRuntime(path.join(root, 'state', 'leases.json'), () => 2_000)
    await restarted.ready()
    await expect(restarted.leaseCheckpoints()).resolves.toEqual([expect.objectContaining({
      extensionInstanceId: 'instance_profile_a', sessionAgentId: 'session-a', profileId: 'profile-a', leaseId: 'lease-restart', tabIds: [40],
    })])
  })

  it('creates reuseExistingTab:false children inside the matching lease without a conflicting root claim', async () => {
    const { runtime, client, root } = await connectedRuntime()
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    const loop = fakeExtensionLoop(client, requests)
    await runtime.claim({
      extensionInstanceId: 'instance_profile_a', sessionAgentId: 'session-a', profileId: 'profile-a',
      leaseId: 'lease-existing', leaseEpoch: 9, tabIds: [40], groupId: 9, childPolicy: 'manual',
    })
    await expect(runtime.execute(request('open', null, { show: false, reuseExistingTab: false, url: 'https://child.invalid/' })))
      .resolves.toMatchObject({ ok: true, result: { created: true, tab: { tabId: 'ext.instance_profile_a.41' } } })
    expect(requests.find((entry) => entry.method === 'forge.browser.create')?.params).toMatchObject({ leaseId: 'lease-existing', leaseEpoch: 9 })
    const checkpoint = await readFile(path.join(root, 'state', 'leases.json'), 'utf8')
    expect(JSON.parse(checkpoint).leases[0].tabIds).toEqual([40, 41])
    runtime.deactivate(); client.close(); await loop
  })

  it('retains acknowledged expiry routing until backend lifecycle release', async () => {
    let now = 1_000
    const { runtime, client, root } = await connectedRuntime('instance_profile_a', () => now)
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    const loop = fakeExtensionLoop(client, requests)
    await runtime.claim({
      extensionInstanceId: 'instance_profile_a', sessionAgentId: 'session-a', profileId: 'profile-a',
      leaseId: 'lease-expiring', leaseEpoch: 1, tabIds: [40], groupId: 9, childPolicy: 'manual',
    })
    now += 15 * 60_000 + 1
    expect(await runtime.leaseCheckpoints()).toEqual([expect.objectContaining({ leaseId: 'lease-expiring', leaseEpoch: 1, releasedAt: now })])
    expect(requests.find((entry) => entry.method === 'forge.browser.release')?.params).toMatchObject({ leaseId: 'lease-expiring', reason: 'lease-expired' })
    expect(await readFile(path.join(root, 'state', 'leases.json'), 'utf8')).toContain('lease-expiring')
    await runtime.leaseCheckpoints()
    expect(requests.filter((entry) => entry.method === 'forge.browser.release')).toHaveLength(1)
    await runtime.release('instance_profile_a', 'lease-expiring', 1, 'lifecycle-detach')
    expect(await readFile(path.join(root, 'state', 'leases.json'), 'utf8')).not.toContain('lease-expiring')
    runtime.deactivate(); client.close(); await loop
  })

  it('retains exact prepared authority across restart and finalizes only its tombstone beside a concurrent new lease', async () => {
    const { runtime, client, root } = await connectedRuntime()
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    const loop = fakeExtensionLoop(client, requests)
    await runtime.claim({
      extensionInstanceId: 'instance_profile_a', sessionAgentId: 'session-a', profileId: 'profile-a',
      leaseId: 'lease-old', leaseEpoch: 10, tabIds: [40], groupId: 9, childPolicy: 'manual',
    })
    const transaction = {
      extensionInstanceId: 'instance_profile_a', sessionAgentId: 'session-a', profileId: 'profile-a', tabId: 40,
      lifecycleReleaseId: 'release-exact', originalHostId: 'external-host', originalHostGeneration: 7,
    }
    await runtime.prepareLifecycleRelease({ ...transaction, reason: 'lifecycle-delete' })
    await runtime.prepareLifecycleRelease({ ...transaction, reason: 'lifecycle-delete' })
    expect(requests.filter((entry) => entry.method === 'forge.browser.release')).toHaveLength(1)
    expect(await runtime.leaseCheckpoints()).toEqual([expect.objectContaining({
      leaseId: 'lease-old', leaseEpoch: 10, lifecycleReleaseId: 'release-exact', releasedAt: 1_000,
    })])

    await runtime.claim({
      extensionInstanceId: 'instance_profile_a', sessionAgentId: 'session-a', profileId: 'profile-a',
      leaseId: 'lease-old', leaseEpoch: 11, tabIds: [40], groupId: 9, childPolicy: 'manual',
    })
    runtime.deactivate(); client.close(); await loop
    const restarted = new ExternalChromeRelayRuntime(path.join(root, 'state', 'leases.json'), () => 2_000)
    await restarted.ready()
    await expect(restarted.finalizeLifecycleRelease({ ...transaction, lifecycleReleaseId: 'stale-token' })).rejects.toThrow(/stale/u)
    expect((await restarted.leaseCheckpoints()).map((entry) => entry.leaseEpoch).sort()).toEqual([10, 11])
    await restarted.finalizeLifecycleRelease(transaction)
    await restarted.finalizeLifecycleRelease(transaction) // duplicate commit acknowledgement is harmless
    await expect(restarted.leaseCheckpoints()).resolves.toEqual([expect.objectContaining({ leaseId: 'lease-old', leaseEpoch: 11 })])
    expect((await restarted.leaseCheckpoints())[0]).not.toHaveProperty('releasedAt')
    const checkpoint = JSON.parse(await readFile(path.join(root, 'state', 'leases.json'), 'utf8'))
    expect(checkpoint.leases).not.toEqual(expect.arrayContaining([expect.objectContaining({ lifecycleReleaseId: 'release-exact' })]))
    expect(checkpoint.leases).toEqual([expect.objectContaining({ leaseEpoch: 11 })])
    expect(checkpoint.finalizedReleaseIds).toContain('release-exact')
  })

  it('never adopts extension-originated side-panel authority', async () => {
    const { runtime, client, root } = await connectedRuntime()
    const loop = fakeExtensionLoop(client)
    await client.send({ jsonrpc: '2.0', method: 'browser.leaseChanged', params: {
      protocolVersion: 1, leaseId: 'obsolete-side-panel-lease', leaseEpoch: 7, state: 'claimed',
      tabIds: [73], groupId: 4, childPolicy: 'manual',
    } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    await expect(readFile(path.join(root, 'state', 'leases.json'), 'utf8')).rejects.toThrow()
    const opened = await runtime.execute(request('open', null, { show: false, reuseExistingTab: true }))
    expect(opened).toMatchObject({ ok: true, result: { created: false, tab: { tabId: 'ext.instance_profile_a.41' } } })
    expect(await readFile(path.join(root, 'state', 'leases.json'), 'utf8')).not.toContain('obsolete-side-panel-lease')
    runtime.deactivate()
    client.close()
    await loop
  })

  it('rejects reconnect lease proof that expands exact durable tab membership', async () => {
    const { runtime, client, root } = await connectedRuntime()
    const loop = fakeExtensionLoop(client)
    await runtime.claim({
      extensionInstanceId: 'instance_profile_a', sessionAgentId: 'session-a', profileId: 'profile-a',
      leaseId: 'lease-reconnect', leaseEpoch: 14, tabIds: [40], groupId: 9, childPolicy: 'manual',
    })
    client.close()
    await loop
    const reconnected = await connectRelayClient(path.join(root, 'relay.sock'))
    await sendRuntimeHello(reconnected, 'instance_profile_a')
    await reconnected.send({ jsonrpc: '2.0', method: 'browser.leaseChanged', params: {
      protocolVersion: 1, leaseId: 'lease-reconnect', leaseEpoch: 14, state: 'claimed',
      tabIds: [40, 41], groupId: 9, childPolicy: 'manual',
    } })
    for (let attempt = 0; attempt < 20 && runtime.inventory().length > 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 2))
    expect(await runtime.leaseCheckpoints()).toEqual([expect.objectContaining({ leaseId: 'lease-reconnect', tabIds: [40] })])
    expect(runtime.inventory()).toEqual([])
    runtime.deactivate(); reconnected.close()
  })

  it('routes two Chrome profiles concurrently with isolated namespaced tab authority', async () => {
    const { runtime, client: profileA, root } = await connectedRuntime('instance_profile_a')
    const profileB = await connectRelayClient(path.join(root, 'relay.sock'))
    await sendRuntimeHello(profileB, 'instance_profile_b')
    const loopA = fakeExtensionLoop(profileA, [], 'instance_profile_a')
    const loopB = fakeExtensionLoop(profileB, [], 'instance_profile_b')
    await Promise.all([
      runtime.claim({ extensionInstanceId: 'instance_profile_a', sessionAgentId: 'session-a', profileId: 'forge-a', leaseId: 'lease-a', leaseEpoch: 1, tabIds: [40], groupId: 9, childPolicy: 'manual' }),
      runtime.claim({ extensionInstanceId: 'instance_profile_b', sessionAgentId: 'session-b', profileId: 'forge-b', leaseId: 'lease-b', leaseEpoch: 1, tabIds: [40], groupId: 9, childPolicy: 'manual' }),
    ])
    expect(runtime.inventory().map((entry) => entry.extensionInstanceId)).toEqual(['instance_profile_a', 'instance_profile_b'])
    const checkpoints = await runtime.leaseCheckpoints()
    expect(checkpoints).toEqual(expect.arrayContaining([
      expect.objectContaining({ extensionInstanceId: 'instance_profile_a', sessionAgentId: 'session-a', profileId: 'forge-a', tabIds: [40] }),
      expect.objectContaining({ extensionInstanceId: 'instance_profile_b', sessionAgentId: 'session-b', profileId: 'forge-b', tabIds: [40] }),
    ]))
    await expect(runtime.execute({
      ...request('evaluate', 'ext.instance_profile_a.40', { expression: '1', awaitPromise: true, returnByValue: true }),
      sessionAgentId: 'session-b', profileId: 'forge-b',
    })).resolves.toMatchObject({ ok: false, error: { code: 'lease-lost' } })
    runtime.deactivate(); profileA.close(); profileB.close(); await Promise.all([loopA, loopB])
  })

  it('quiesces through prepareUpdate and exact release before closing capability authority', async () => {
    const { runtime, client, root } = await connectedRuntime()
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    const loop = fakeExtensionLoop(client, requests)
    await runtime.claim({
      extensionInstanceId: 'instance_profile_a', sessionAgentId: 'session-a', profileId: 'profile-a',
      leaseId: 'lease-update', leaseEpoch: 21, tabIds: [40], groupId: 9, childPolicy: 'manual',
    })
    await expect(runtime.quiesce('desktop-update', Date.now() + 2_000)).resolves.toBeUndefined()
    expect(requests.map((entry) => entry.method)).toEqual([
      'forge.browser.claim', 'forge.runtime.prepareUpdate', 'forge.browser.release',
    ])
    expect(await runtime.leaseCheckpoints()).toEqual([])
    await expect(runtime.claim({
      extensionInstanceId: 'instance_profile_a', sessionAgentId: 'new-session', profileId: 'new-profile',
      leaseId: 'lease-after-update', leaseEpoch: 22, tabIds: [41], groupId: 9, childPolicy: 'manual',
    })).rejects.toThrow('extension-update-required')
    const marker = await readFile(path.join(root, 'state', 'leases.json'), 'utf8')
    expect(marker).not.toContain('selected.invalid')
    runtime.deactivate(); client.close(); await loop
  })

  it('retains a disconnected durable checkpoint and retries the exact barrier after authenticated reconnect', async () => {
    const { runtime, client, root } = await connectedRuntime()
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    const loop = fakeExtensionLoop(client, requests)
    await runtime.claim({
      extensionInstanceId: 'instance_profile_a', sessionAgentId: 'session-a', profileId: 'profile-a',
      leaseId: 'lease-reconnect-release', leaseEpoch: 41, tabIds: [40], groupId: 9, childPolicy: 'manual',
    })
    client.close()
    await loop
    for (let attempt = 0; attempt < 20 && runtime.inventory().length > 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 2))

    await expect(runtime.quiesce('integration-remove', 3_000)).rejects.toThrow(/could not prove release/u)
    expect(runtime.recoveryStatus()).toBe('manual-extension-reload')
    await expect(runtime.leaseCheckpoints()).resolves.toEqual([expect.objectContaining({
      extensionInstanceId: 'instance_profile_a', leaseId: 'lease-reconnect-release', leaseEpoch: 41,
    })])
    await expect(runtime.claim({
      extensionInstanceId: 'instance_profile_a', sessionAgentId: 'new-session', profileId: 'new-profile',
      leaseId: 'lease-blocked', leaseEpoch: 42, tabIds: [41], groupId: 9, childPolicy: 'manual',
    })).rejects.toThrow('extension-update-required')

    const reconnected = await connectRelayClient(path.join(root, 'relay.sock'))
    await sendRuntimeHello(reconnected, 'instance_profile_a')
    const retriedRequests: Array<{ method: string; params: Record<string, unknown> }> = []
    const retriedLoop = fakeExtensionLoop(reconnected, retriedRequests)
    await expect(runtime.quiesce('integration-remove', 3_000)).resolves.toBeUndefined()
    expect(retriedRequests.map((entry) => entry.method)).toEqual(['forge.runtime.prepareUpdate', 'forge.browser.release'])
    expect(retriedRequests[1]?.params).toMatchObject({ leaseId: 'lease-reconnect-release', leaseEpoch: 41, reason: 'integration-remove' })
    await expect(runtime.leaseCheckpoints()).resolves.toEqual([])
    runtime.deactivate(); reconnected.close(); await retriedLoop
  })

  it('rejects a mismatched exact release acknowledgement and retains durable recovery authority', async () => {
    const { runtime, client } = await connectedRuntime()
    const loop = (async () => {
      while (true) {
        const message = await client.receive()
        if (!message) return
        if (typeof message.id !== 'string' || typeof message.method !== 'string') continue
        const params = message.params as Record<string, unknown>
        if (message.method === 'forge.browser.claim') {
          await client.send({ jsonrpc: '2.0', id: message.id, result: {
            protocolVersion: 1, leaseId: params.leaseId, leaseEpoch: params.leaseEpoch, sessionAgentId: params.sessionAgentId,
            extensionInstanceId: 'instance_profile_a', groupId: 9, childPolicy: params.childPolicy,
            tabs: [{ windowId: 1, tabId: 40, groupId: 9, title: '', url: 'https://fixture.invalid/', origin: 'https://fixture.invalid', active: true }],
          } })
        } else if (message.method === 'forge.runtime.prepareUpdate') {
          await client.send({ jsonrpc: '2.0', id: message.id, result: {
            protocolVersion: 1, payloadVersion: params.payloadVersion, quiesced: true,
          } })
        } else if (message.method === 'forge.browser.release') {
          await client.send({ jsonrpc: '2.0', id: message.id, result: {
            protocolVersion: 1, leaseId: params.leaseId, leaseEpoch: Number(params.leaseEpoch) + 1, releasedTabIds: [40],
          } })
        }
      }
    })()
    await runtime.claim({
      extensionInstanceId: 'instance_profile_a', sessionAgentId: 'session-a', profileId: 'profile-a',
      leaseId: 'lease-mismatched-ack', leaseEpoch: 51, tabIds: [40], groupId: 9, childPolicy: 'manual',
    })
    await expect(runtime.quiesce('auth-rotation', 3_000)).rejects.toThrow(/could not prove release/u)
    expect(runtime.recoveryStatus()).toBe('manual-extension-reload')
    await expect(runtime.leaseCheckpoints()).resolves.toEqual([expect.objectContaining({
      extensionInstanceId: 'instance_profile_a', leaseId: 'lease-mismatched-ack', leaseEpoch: 51,
    })])
    runtime.deactivate(); client.close(); await loop
  })

  it('fails closed on a dropped prepare acknowledgement even when exact release later settles', async () => {
    const { runtime, client } = await connectedRuntime()
    let dropPrepare = false
    const loop = (async () => {
      while (true) {
        const message = await client.receive()
        if (!message) return
        if (typeof message.id !== 'string' || typeof message.method !== 'string') continue
        const params = message.params as Record<string, unknown>
        if (message.method === 'forge.browser.claim') {
          await client.send({ jsonrpc: '2.0', id: message.id, result: {
            protocolVersion: 1, leaseId: params.leaseId, leaseEpoch: params.leaseEpoch, sessionAgentId: params.sessionAgentId,
            extensionInstanceId: 'instance_profile_a', groupId: 9, childPolicy: params.childPolicy,
            tabs: [{ windowId: 1, tabId: 40, groupId: 9, title: '', url: 'https://fixture.invalid/', origin: 'https://fixture.invalid', active: true }],
          } })
        } else if (message.method === 'forge.runtime.prepareUpdate') {
          dropPrepare = true
          // Deliberately drop the acknowledgement; the release request still follows the bounded timeout.
        } else if (message.method === 'forge.browser.release') {
          await client.send({ jsonrpc: '2.0', id: message.id, result: {
            protocolVersion: 1, leaseId: params.leaseId, leaseEpoch: params.leaseEpoch, releasedTabIds: [40],
          } })
        }
      }
    })()
    await runtime.claim({
      extensionInstanceId: 'instance_profile_a', sessionAgentId: 'session-a', profileId: 'profile-a',
      leaseId: 'lease-dropped-ack', leaseEpoch: 31, tabIds: [40], groupId: 9, childPolicy: 'manual',
    })
    await expect(runtime.quiesce('desktop-update', 1_025)).rejects.toThrow(/could not prove release/u)
    expect(dropPrepare).toBe(true)
    expect(await runtime.leaseCheckpoints()).toEqual([])
    await expect(runtime.listCandidates('instance_profile_a', 'session-a')).rejects.toThrow('extension-update-required')
    runtime.deactivate(); client.close(); await loop
  })

  it('keeps operations detached until prepare/reload is followed by a new authenticated hello', async () => {
    const expected = { payloadVersion: 'm5-runtime.1', sha256: 'b'.repeat(64), shellAbi: 1 }
    const { runtime, client, root } = await connectedRuntime('instance_profile_a', () => 1_000, expected)
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    const loop = fakeExtensionLoop(client, requests)
    for (let attempt = 0; attempt < 50 && requests.length < 2; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 2))
    expect(requests.map((entry) => entry.method)).toEqual(['forge.runtime.prepareUpdate', 'forge.runtime.reload'])
    expect(requests[0]?.params).toMatchObject({ payloadVersion: expected.payloadVersion, sha256: expected.sha256 })
    expect(runtime.recoveryStatus()).toBe('reconnecting')
    await expect(runtime.listCandidates('instance_profile_a', 'session-a')).rejects.toThrow('extension-update-required')
    client.close()
    await loop

    const reloaded = await connectRelayClient(path.join(root, 'relay.sock'))
    await sendRuntimeHello(reloaded, 'instance_profile_a', expected.payloadVersion, expected.sha256)
    expect(runtime.recoveryStatus()).toBe('ready')
    const reloadedLoop = fakeExtensionLoop(reloaded)
    await expect(runtime.listCandidates('instance_profile_a', 'session-a')).resolves.toMatchObject({ extensionInstanceId: 'instance_profile_a' })
    runtime.deactivate(); reloaded.close(); await reloadedLoop
  })

  it('accepts the actual prior V1 hello only for bounded update/manual recovery and never readiness', async () => {
    const expected = { payloadVersion: 'm5-runtime.1', sha256: 'b'.repeat(64), shellAbi: 1 }
    const { runtime, client } = await connectedRuntime('instance_legacy', () => Date.now(), expected, null)
    expect(runtime.inventory()).toEqual([expect.objectContaining({ extensionInstanceId: 'instance_legacy', payloadVersion: 'm4-runtime.1' })])
    expect(runtime.inventory()[0]).not.toHaveProperty('payloadSha256')
    const prepare = await client.receive()
    expect(prepare).toMatchObject({ method: 'forge.runtime.prepareUpdate', params: { payloadVersion: expected.payloadVersion, sha256: expected.sha256 } })
    await client.send({ jsonrpc: '2.0', id: prepare!.id, error: { code: -32601, message: 'prior runtime has no automatic update handler' } })
    for (let attempt = 0; attempt < 20 && runtime.recoveryStatus() !== 'manual-extension-reload'; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 2))
    expect(runtime.recoveryStatus()).toBe('manual-extension-reload')
    await expect(runtime.listCandidates('instance_legacy', 'session-a')).rejects.toThrow('extension-update-required')
    runtime.deactivate(); client.close()
  })

  it('never treats a legacy hello without immutable identity as ready when no target is configured', async () => {
    const { runtime, client } = await connectedRuntime('instance_legacy_without_target', () => Date.now(), undefined, null)
    expect(runtime.recoveryStatus()).toBe('manual-extension-reload')
    await expect(runtime.listCandidates('instance_legacy_without_target', 'session-a')).rejects.toThrow('extension-update-required')
    runtime.deactivate(); client.close()
  })

  it('reports authenticated shell ABI skew as incompatible and never attempts payload reload', async () => {
    const expected = { payloadVersion: 'm5-runtime.1', sha256: 'b'.repeat(64), shellAbi: 1 }
    const { runtime, client } = await connectedRuntime('instance_shell_skew', () => Date.now(), expected, 'a'.repeat(64), 2)
    expect(runtime.recoveryStatus()).toBe('incompatible-payload')
    await expect(runtime.listCandidates('instance_shell_skew', 'session-a')).rejects.toThrow('extension-update-required')
    const raced = await Promise.race([
      client.receive().then(() => 'message'),
      new Promise<string>((resolve) => setTimeout(() => resolve('none'), 10)),
    ])
    expect(raced).toBe('none')
    runtime.deactivate(); client.close()
  })

  it('updates every stale profile independently and aggregates mixed generations safely', async () => {
    const expected = { payloadVersion: 'm5-runtime.1', sha256: 'b'.repeat(64), shellAbi: 1 }
    const { runtime, client: oldA, root } = await connectedRuntime('instance_profile_a', () => Date.now(), expected)
    const oldB = await connectRelayClient(path.join(root, 'relay.sock'))
    await sendRuntimeHello(oldB, 'instance_profile_b')
    const requestsA: Array<{ method: string; params: Record<string, unknown> }> = []
    const requestsB: Array<{ method: string; params: Record<string, unknown> }> = []
    const loopA = fakeExtensionLoop(oldA, requestsA, 'instance_profile_a')
    const loopB = fakeExtensionLoop(oldB, requestsB, 'instance_profile_b')
    for (let attempt = 0; attempt < 50 && (requestsA.length < 2 || requestsB.length < 2); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 2))
    expect(requestsA.map((entry) => entry.method)).toEqual(['forge.runtime.prepareUpdate', 'forge.runtime.reload'])
    expect(requestsB.map((entry) => entry.method)).toEqual(['forge.runtime.prepareUpdate', 'forge.runtime.reload'])
    expect(runtime.recoveryStatus()).toBe('reconnecting')

    const exactA = await connectRelayClient(path.join(root, 'relay.sock'))
    await sendRuntimeHello(exactA, 'instance_profile_a', expected.payloadVersion, expected.sha256)
    const exactLoopA = fakeExtensionLoop(exactA, [], 'instance_profile_a')
    expect(runtime.recoveryStatus()).toBe('reconnecting')
    await expect(runtime.listCandidates('instance_profile_a', 'session-a')).resolves.toMatchObject({ extensionInstanceId: 'instance_profile_a' })
    await expect(runtime.listCandidates('instance_profile_b', 'session-b')).rejects.toThrow('extension-update-required')
    const exactB = await connectRelayClient(path.join(root, 'relay.sock'))
    await sendRuntimeHello(exactB, 'instance_profile_b', expected.payloadVersion, expected.sha256)
    expect(runtime.recoveryStatus()).toBe('ready')
    const exactLoopB = fakeExtensionLoop(exactB, [], 'instance_profile_b')
    await expect(runtime.listCandidates('instance_profile_a', 'session-a')).resolves.toMatchObject({ extensionInstanceId: 'instance_profile_a' })
    exactA.close()
    for (let attempt = 0; attempt < 20 && runtime.inventory().some((entry) => entry.extensionInstanceId === 'instance_profile_a'); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 2))
    expect(runtime.recoveryStatus()).toBe('ready')
    runtime.deactivate(); oldA.close(); oldB.close(); exactB.close()
    await Promise.all([loopA, loopB, exactLoopA, exactLoopB])
  })

  it.each(['new-hello-before-old-rejection', 'old-rejection-before-new-hello'] as const)('keeps exact readiness when reload settlement order is %s', async (order) => {
    const expected = { payloadVersion: 'm5-runtime.1', sha256: 'b'.repeat(64), shellAbi: 1 }
    const activationOrder: string[] = []
    const { runtime, client: old, root } = await connectedRuntime('instance_generation', () => Date.now(), expected)
    runtime.configureExpectedRuntime(expected, async () => { activationOrder.push('activate') })
    const prepare = await old.receive()
    activationOrder.push('prepare')
    await old.send({ jsonrpc: '2.0', id: prepare!.id, result: { protocolVersion: 1, payloadVersion: expected.payloadVersion, quiesced: true } })
    const reload = await old.receive()
    activationOrder.push('reload')
    expect(activationOrder).toEqual(['prepare', 'activate', 'reload'])
    let exact: AuthenticatedRelayClient
    if (order === 'old-rejection-before-new-hello') {
      old.close()
      for (let attempt = 0; attempt < 20 && runtime.inventory().length > 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 2))
      exact = await connectRelayClient(path.join(root, 'relay.sock'))
      await sendRuntimeHello(exact, 'instance_generation', expected.payloadVersion, expected.sha256)
    } else {
      exact = await connectRelayClient(path.join(root, 'relay.sock'))
      await sendRuntimeHello(exact, 'instance_generation', expected.payloadVersion, expected.sha256)
      old.close()
    }
    expect(reload).toMatchObject({ method: 'forge.runtime.reload' })
    for (let attempt = 0; attempt < 20 && runtime.recoveryStatus() !== 'ready'; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 2))
    expect(runtime.recoveryStatus()).toBe('ready')
    runtime.deactivate(); exact.close(); old.close()
  })

  it('accepts explicit instance-scoped claims but never arbitrary pre-existing tabs', async () => {
    const { runtime, client, root } = await connectedRuntime()
    const loop = fakeExtensionLoop(client)
    await expect(runtime.claim({
      extensionInstanceId: 'wrong-instance', sessionAgentId: 'session-a', profileId: 'profile-a',
      leaseId: 'lease-a', leaseEpoch: 4, tabIds: [40], groupId: 9, childPolicy: 'manual',
    })).rejects.toThrow(/disconnected/u)
    await expect(runtime.claim({
      extensionInstanceId: 'instance_profile_a', sessionAgentId: 'session-a', profileId: 'profile-a',
      leaseId: 'lease-a', leaseEpoch: 4, tabIds: [40], groupId: 9, childPolicy: 'manual',
    })).resolves.toMatchObject({ leaseEpoch: 4, tabs: [{ tabId: 40 }] })
    const checkpoint = await readFile(path.join(root, 'state', 'leases.json'), 'utf8')
    expect(checkpoint).not.toContain('selected.invalid')
    expect(checkpoint).not.toContain('Selected')
    await expect(runtime.execute(request('open', 'ext.instance_profile_a.40', { show: false, reuseExistingTab: true })))
      .resolves.toMatchObject({ ok: true, result: { created: false } })
    await expect(runtime.execute(request('open', 'ext.instance_profile_a.99', { show: false, reuseExistingTab: true })))
      .resolves.toMatchObject({ ok: false, error: { code: 'attachment-required', retryable: false } })
    runtime.deactivate()
    client.close()
    await loop
  })
})
