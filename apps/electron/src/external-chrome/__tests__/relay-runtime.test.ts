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
      methods: ['forge.runtime.hello', 'forge.runtime.ping', 'forge.browser.focusedEligibility', 'forge.browser.acquire', 'forge.browser.release', 'forge.browser.reveal', 'forge.browser.execute', 'forge.runtime.prepareUpdate', 'forge.runtime.reload', 'browser.cdpEvent', 'browser.detached', 'browser.userControl', 'browser.tabChanged', 'browser.downloadChanged', 'browser.leaseChanged', 'runtime.goodbye'],
      maxMessageBytes: 262144,
      operations: ['status', 'open', 'navigate', 'resize', 'snapshot', 'click', 'type', 'press', 'scroll', 'evaluate', 'waitFor', 'recordingStart', 'recordingStop'].map((operation) => ({
        operation, supported: !['resize', 'recordingStart', 'recordingStop'].includes(operation), ...(!['resize', 'recordingStart', 'recordingStop'].includes(operation) ? {} : { reason: 'physical viewport and recording disabled' }),
      })),
      features: { resize: false, recording: false, downloadEvents: false, downloadArtifacts: false, downloadOpen: false, oopif: true, humanInterruption: true },
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
  focusedEligible = true,
  executeFailure?: BrowserAutomationFailure,
  releasedTabIdsOverride?: number[],
): Promise<void> {
  const authorityTabs = new Map<string, number[]>()
  while (true) {
    const message = await client.receive()
    if (!message) return
    if (typeof message.id !== 'string' || typeof message.method !== 'string') continue
    const params = message.params as Record<string, unknown>
    requests.push({ method: message.method, params })
    if (message.method === 'forge.browser.focusedEligibility') {
      await client.send({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: 1, eligible: focusedEligible,
      } })
    } else if (message.method === 'forge.browser.acquire') {
      const tabId = typeof params.tabId === 'number' ? params.tabId : params.reuseFocused === true ? 40 : 41
      authorityTabs.set(String(params.leaseId), [tabId])
      await client.send({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: 1, leaseId: params.leaseId, leaseEpoch: params.leaseEpoch, sessionAgentId: params.sessionAgentId,
        extensionInstanceId: instanceId,
        tab: { tabId, title: tabId === 40 ? 'Selected' : 'Created', url: tabId === 40 ? 'https://selected.invalid/private' : 'https://fixture.invalid/', active: true },
        created: tabId !== 40,
      } })
    } else if (message.method === 'forge.browser.release') {
      await client.send({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: 1, leaseId: params.leaseId, leaseEpoch: params.leaseEpoch,
        releasedTabIds: releasedTabIdsOverride ?? authorityTabs.get(String(params.leaseId)) ?? [40],
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
    await expect(waiting).resolves.toMatchObject({ ok: false, metadata: { fallbackReason: 'no-eligible-target' } })
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
    await expect(waiting).resolves.toMatchObject({ ok: false, metadata: { fallbackReason: 'no-eligible-target' } })
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

  it('routes URL-bearing create through neutral acquire then authorized navigate and persists only opaque lease scope', async () => {
    const { runtime, client, root } = await connectedRuntime()
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    const loop = fakeExtensionLoop(client, requests)
    const opened = await runtime.execute(request('open', null, { url: 'https://fixture.invalid/', show: false, reuseExistingTab: false }))
    expect(opened).toMatchObject({ ok: true, result: { created: true, tab: { tabId: 'ext.instance_profile_a.41' } } })
    expect(requests.slice(0, 3).map(({ method }) => method)).toEqual([
      'forge.browser.focusedEligibility', 'forge.browser.acquire', 'forge.browser.execute',
    ])
    expect(requests[1]?.params).not.toHaveProperty('url')
    expect(requests[2]?.params).toMatchObject({
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
      'forge.browser.focusedEligibility', 'forge.browser.acquire', 'forge.browser.release',
    ])
    expect(requests[1]?.params).toMatchObject({ reuseFocused: true })
    expect(await runtime.leaseCheckpoints()).toEqual([])
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
    expect(requests.map(({ method }) => method)).toEqual(['forge.browser.release'])
    expect(await runtime.leaseCheckpoints()).toEqual([])
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
      'forge.browser.focusedEligibility', 'forge.browser.acquire', 'forge.browser.release',
      'forge.browser.acquire', 'forge.browser.reveal', 'forge.browser.release',
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

  it.each([true, false])('acquires a dedicated tab from the sole ready profile without focus when reuseExisting is %s', async (reuseExisting) => {
    const { runtime, client } = await connectedRuntime()
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    const loop = fakeExtensionLoop(client, requests, 'instance_profile_a', false)
    await expect(runtime.acquireTarget({
      sessionAgentId: 'session-a', profileId: 'profile-a', operation: 'snapshot', preferredTabId: null,
      reuseExisting, createIfNeeded: true, ownerEpoch: 28,
    })).resolves.toEqual({ ok: true, authority: { ownerEpoch: 28, tabId: 'ext.instance_profile_a.41' } })
    expect(requests.map(({ method }) => method)).toEqual(['forge.browser.focusedEligibility', 'forge.browser.acquire'])
    expect(requests[1]?.params).toMatchObject({ reuseFocused: false })
    runtime.deactivate(); client.close(); await loop
  })

  it.each([true, false])('opens a dedicated tab in the sole ready profile without focus when reuseExistingTab is %s', async (reuseExistingTab) => {
    const { runtime, client } = await connectedRuntime()
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    const loop = fakeExtensionLoop(client, requests, 'instance_profile_a', false)
    await expect(runtime.execute(request('open', null, { show: false, reuseExistingTab }))).resolves.toMatchObject({
      ok: true, result: { created: true, tab: { tabId: 'ext.instance_profile_a.41' } },
    })
    expect(requests.map(({ method }) => method)).toEqual([
      'forge.browser.focusedEligibility', 'forge.browser.acquire', 'forge.browser.execute',
    ])
    expect(requests[1]?.params).toMatchObject({ reuseFocused: false })
    expect(requests[1]?.params).not.toHaveProperty('url')
    expect(requests[2]?.params).toMatchObject({ operation: 'status', tabId: 41 })
    runtime.deactivate(); client.close(); await loop
  })

  it('returns bounded ambiguity only when multiple ready profiles have no unique focused eligible tab', async () => {
    const { runtime, client: profileA, root } = await connectedRuntime('instance_profile_a')
    const profileB = await connectRelayClient(path.join(root, 'relay.sock'))
    await sendRuntimeHello(profileB, 'instance_profile_b')
    const loopA = fakeExtensionLoop(profileA, [], 'instance_profile_a', false)
    const loopB = fakeExtensionLoop(profileB, [], 'instance_profile_b', false)

    await expect(runtime.acquireTarget({
      sessionAgentId: 'session-a', profileId: 'profile-a', operation: 'snapshot', preferredTabId: null,
      reuseExisting: true, createIfNeeded: true, ownerEpoch: 29,
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'target-not-found', details: { choiceKind: 'ambiguous-profile', optionCount: 2 } },
      metadata: { phase: 'discovery', mutationState: 'not-started', fallbackReason: 'ambiguous-instance' },
    })
    await expect(runtime.execute(request('open', null, { show: false, reuseExistingTab: true }))).resolves.toMatchObject({
      ok: false, error: { code: 'target-not-found', details: { choiceKind: 'ambiguous-profile', optionCount: 2 } },
    })

    runtime.deactivate(); profileA.close(); profileB.close(); await Promise.all([loopA, loopB])
  })

  it('rejects an opaque choice token when its exact ready runtime reconnects before confirmation', async () => {
    const { runtime, client: profileA, root } = await connectedRuntime('instance_profile_a')
    const profileB = await connectRelayClient(path.join(root, 'relay.sock'))
    await sendRuntimeHello(profileB, 'instance_profile_b')
    const loopA = fakeExtensionLoop(profileA, [], 'instance_profile_a', false)
    const choices = runtime.automaticProfileChoices('session-a', 'profile-a')
    expect(choices).toHaveLength(2)
    const stale = choices[1]!

    profileB.close()
    await waitForCondition(() => runtime.inventory().every((item) => item.extensionInstanceId !== 'instance_profile_b'))
    const reconnected = await connectRelayClient(path.join(root, 'relay.sock'))
    await sendRuntimeHello(reconnected, 'instance_profile_b')
    const loopB = fakeExtensionLoop(reconnected, [], 'instance_profile_b', false)
    expect(runtime.confirmAutomaticChoice('session-a', 'profile-a', stale.token)).toBe(false)

    runtime.deactivate(); profileA.close(); reconnected.close(); await Promise.all([loopA, loopB])
  })

  it('scopes concurrent prompts per Forge session and refreshes only the requesting session', async () => {
    const { runtime, client: profileA, root } = await connectedRuntime('instance_profile_a')
    const profileB = await connectRelayClient(path.join(root, 'relay.sock'))
    await sendRuntimeHello(profileB, 'instance_profile_b')
    const loopA = fakeExtensionLoop(profileA, [], 'instance_profile_a', false)
    const loopB = fakeExtensionLoop(profileB, [], 'instance_profile_b', false)

    const firstA = runtime.automaticProfileChoices('session-a', 'profile-a')
    const firstB = runtime.automaticProfileChoices('session-b', 'profile-b')
    const refreshedA = runtime.automaticProfileChoices('session-a', 'profile-a')
    expect(runtime.confirmAutomaticChoice('session-a', 'profile-a', firstA[0]!.token)).toBe(false)
    expect(runtime.confirmAutomaticChoice('wrong-session', 'profile-b', firstB[1]!.token)).toBe(false)
    expect(runtime.confirmAutomaticChoice('session-b', 'profile-b', firstB[1]!.token)).toBe(true)
    expect(runtime.confirmAutomaticChoice('session-a', 'profile-a', refreshedA[0]!.token)).toBe(true)

    runtime.deactivate(); profileA.close(); profileB.close(); await Promise.all([loopA, loopB])
  })

  it('bounds outstanding prompt sessions and evicts the oldest token set', async () => {
    const { runtime, client } = await connectedRuntime('instance_profile_a')
    const loop = fakeExtensionLoop(client, [], 'instance_profile_a', false)
    const oldest = runtime.automaticProfileChoices('session-0', 'profile')[0]!
    let newest = oldest
    for (let index = 1; index <= 64; index += 1) newest = runtime.automaticProfileChoices(`session-${index}`, 'profile')[0]!
    expect(runtime.confirmAutomaticChoice('session-0', 'profile', oldest.token)).toBe(false)
    expect(runtime.confirmAutomaticChoice('session-64', 'profile', newest.token)).toBe(true)

    runtime.deactivate(); client.close(); await loop
  })

  it('remembers one confirmed ambiguous profile for the current runtime session', async () => {
    const { runtime, client: profileA, root } = await connectedRuntime('instance_profile_a')
    const profileB = await connectRelayClient(path.join(root, 'relay.sock'))
    await sendRuntimeHello(profileB, 'instance_profile_b')
    const requestsA: Array<{ method: string; params: Record<string, unknown> }> = []
    const requestsB: Array<{ method: string; params: Record<string, unknown> }> = []
    const loopA = fakeExtensionLoop(profileA, requestsA, 'instance_profile_a', false)
    const loopB = fakeExtensionLoop(profileB, requestsB, 'instance_profile_b', false)

    const choice = runtime.automaticProfileChoices('session-a', 'profile-a')[1]
    if (!choice) throw new Error('fixture choice missing')
    expect(runtime.confirmAutomaticChoice('session-a', 'profile-a', choice.token)).toBe(true)
    await expect(runtime.acquireTarget({
      sessionAgentId: 'session-a', profileId: 'profile-a', operation: 'snapshot', preferredTabId: null,
      reuseExisting: false, createIfNeeded: true, ownerEpoch: 30,
    })).resolves.toEqual({ ok: true, authority: { ownerEpoch: 30, tabId: 'ext.instance_profile_b.41' } })
    expect(requestsA).toEqual([])
    expect(requestsB.map(({ method }) => method)).toEqual(['forge.browser.acquire'])

    runtime.deactivate(); profileA.close(); profileB.close(); await Promise.all([loopA, loopB])
  })

})

async function waitForCondition(assertion: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (assertion()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error('condition did not settle')
}
