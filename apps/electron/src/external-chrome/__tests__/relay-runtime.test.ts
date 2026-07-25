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

async function connectedRuntime(instanceId = 'instance_profile_a', now: () => number = () => 1_000): Promise<{
  runtime: ExternalChromeRelayRuntime
  client: AuthenticatedRelayClient
  root: string
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-relay-runtime-'))
  roots.push(root)
  const endpoint = path.join(root, 'relay.sock')
  const key = Buffer.alloc(32, 0x44)
  const runtime = new ExternalChromeRelayRuntime(path.join(root, 'state', 'leases.json'), now)
  runtime.activate({ epoch: 'epoch_1234567890abcdef', desktopInstanceId: 'desktop_1234567890abcdef', keyId: 'key-test', secret: key })
  const server = createServer((socket) => runtime.accept(socket))
  servers.push(server)
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve) })
  const client = await AuthenticatedRelayClient.connect({
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
  await client.send({
    jsonrpc: '2.0', id: 'hello', method: 'forge.runtime.hello', params: {
      protocol: { min: 1, max: 1 }, shellAbi: 1, payloadVersion: 'm3-runtime.1',
      extensionId: 'fcchfcnadajoejfbiclihglkmbcfhajd', extensionInstanceId: instanceId, chromeVersion: '125.0.0.0',
      methods: ['forge.runtime.hello', 'forge.runtime.ping', 'forge.browser.listCandidates', 'forge.browser.claim', 'forge.browser.create', 'forge.browser.release', 'forge.browser.execute', 'forge.browser.turnEnded', 'forge.runtime.prepareUpdate', 'forge.runtime.reload', 'browser.cdpEvent', 'browser.detached', 'browser.userControl', 'browser.tabChanged', 'browser.downloadChanged', 'browser.leaseChanged', 'runtime.goodbye'],
      maxMessageBytes: 262144,
      operations: ['status', 'open', 'navigate', 'resize', 'snapshot', 'click', 'type', 'press', 'scroll', 'evaluate', 'waitFor', 'recordingStart', 'recordingStop'].map((operation) => ({
        operation, supported: ['status', 'open', 'navigate'].includes(operation), ...(['status', 'open', 'navigate'].includes(operation) ? {} : { reason: 'M4 disabled' }),
      })),
      features: { resize: false, recording: false, downloadEvents: false, downloadArtifacts: false, downloadOpen: false, oopif: false, humanInterruption: true, groups: true },
    },
  })
  await expect(client.receive()).resolves.toMatchObject({ id: 'hello', result: { protocolVersion: 1, requiredShellAbi: 1 } })
  expect(runtime.inventory()).toEqual([expect.objectContaining({ extensionInstanceId: instanceId, chromeVersion: '125.0.0.0' })])
  return { runtime, client, root }
}

function request(operation: 'open' | 'navigate' | 'status', tabId: string | null, input: Record<string, unknown> = {}): BrowserAutomationRequest {
  return {
    requestId: `request-${operation}`, hostKind: 'external-chrome', sessionAgentId: 'session-a', profileId: 'profile-a',
    tabId, operation, input, hostId: 'external-host', hostGeneration: 3,
    deadlineAt: new Date(Date.now() + 30_000).toISOString(), artifactDirectory: null,
  } as BrowserAutomationRequest
}

async function fakeExtensionLoop(client: AuthenticatedRelayClient, requests: Array<{ method: string; params: Record<string, unknown> }> = []): Promise<void> {
  while (true) {
    const message = await client.receive()
    if (!message) return
    if (typeof message.id !== 'string' || typeof message.method !== 'string') continue
    const params = message.params as Record<string, unknown>
    requests.push({ method: message.method, params })
    if (message.method === 'forge.browser.claim') {
      await client.send({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: 1, leaseId: params.leaseId, leaseEpoch: params.leaseEpoch, sessionAgentId: params.sessionAgentId,
        extensionInstanceId: 'instance_profile_a', groupId: 9, childPolicy: params.childPolicy,
        tabs: [{ windowId: 2, tabId: 40, groupId: 9, title: 'Selected', url: 'https://selected.invalid/private', origin: 'https://selected.invalid', active: true }],
      } })
    } else if (message.method === 'forge.browser.create') {
      await client.send({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: 1, leaseId: params.leaseId, leaseEpoch: params.leaseEpoch, sessionAgentId: params.sessionAgentId,
        extensionInstanceId: 'instance_profile_a', groupId: 9,
        tab: { windowId: 2, tabId: 41, groupId: 9, title: 'Created', url: 'https://fixture.invalid/', origin: 'https://fixture.invalid', active: true },
      } })
    } else if (message.method === 'forge.browser.release') {
      await client.send({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: 1, leaseId: params.leaseId, leaseEpoch: params.leaseEpoch, releasedTabIds: [40, 41],
      } })
    } else if (message.method === 'forge.browser.execute') {
      const now = new Date(0).toISOString()
      await client.send({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: 1, leaseId: params.leaseId, leaseEpoch: params.leaseEpoch, requestId: params.requestId,
        tabId: params.tabId, operation: 'navigate', ok: true, result: {
          readiness: 'load', tab: {
            hostKind: 'external-chrome', tabId: '41', sessionAgentId: 'session-a', profileId: 'instance_profile_a',
            url: 'https://navigated.invalid/', title: 'Navigated', lifecycle: 'ready', loading: false, live: true,
            canGoBack: false, canGoForward: false, zoomFactor: 1, controller: 'agent', agentCursor: null, recording: null,
            viewportSetting: { mode: 'fill' }, renderedViewport: null, physicalVisible: false, error: null, createdAt: now, updatedAt: now,
          },
        },
      } })
    }
  }
}

async function waitForCheckpoint(root: string, predicate: (contents: string) => boolean): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const contents = await readFile(path.join(root, 'state', 'leases.json'), 'utf8')
      if (predicate(contents)) return contents
    } catch { /* relay callback has not persisted yet */ }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('checkpoint did not reach expected state')
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
    await expect(runtime.execute(request('navigate', 'ext.wrong_instance.41', { url: 'https://x.invalid/', readiness: 'load', timeoutMs: 1_000 })))
      .resolves.toMatchObject({ ok: false, error: { code: 'lease-lost' } })
    runtime.deactivate()
    client.close()
    await loop
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

  it('adopts only authenticated side-panel leases without persisting candidate tab metadata', async () => {
    const { runtime, client, root } = await connectedRuntime()
    await client.send({ jsonrpc: '2.0', method: 'browser.leaseChanged', params: {
      protocolVersion: 1, leaseId: 'side-panel-local-lease', leaseEpoch: 7, state: 'claimed',
      tabIds: [73], groupId: 4, childPolicy: 'manual',
    } })
    const checkpoint = await waitForCheckpoint(root, (contents) => contents.includes('side-panel-local-lease'))
    expect(checkpoint).toContain('"sessionAgentId":"__local_pending__"')
    const opened = await runtime.execute(request('open', null, { show: false, reuseExistingTab: true }))
    expect(opened).toMatchObject({ ok: true, result: { created: false, tab: { tabId: 'ext.instance_profile_a.73' } } })
    await client.send({ jsonrpc: '2.0', method: 'browser.leaseChanged', params: {
      protocolVersion: 1, leaseId: 'side-panel-local-lease', leaseEpoch: 7, state: 'released',
      tabIds: [73], groupId: 4, childPolicy: 'manual',
    } })
    const tombstone = await waitForCheckpoint(root, (contents) => contents.includes('side-panel-local-lease') && contents.includes('releasedAt'))
    expect(tombstone).toContain('"sessionAgentId":"session-a"')
    runtime.deactivate()
    client.close()
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
