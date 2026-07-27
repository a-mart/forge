import { createServer, type Server } from 'node:net'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
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
      methods: ['forge.runtime.hello', 'forge.runtime.ping', 'forge.browser.focusedEligibility', 'forge.browser.acquire', 'forge.browser.release', 'forge.browser.execute', 'forge.browser.turnEnded', 'forge.runtime.prepareUpdate', 'forge.runtime.reload', 'browser.cdpEvent', 'browser.detached', 'browser.userControl', 'browser.tabChanged', 'browser.downloadChanged', 'browser.leaseChanged', 'runtime.goodbye'],
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
      const tabId = params.reuseFocused === true ? 40 : 41
      authorityTabs.set(String(params.leaseId), [tabId])
      await client.send({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: 1, leaseId: params.leaseId, leaseEpoch: params.leaseEpoch, sessionAgentId: params.sessionAgentId,
        extensionInstanceId: instanceId,
        tab: { tabId, title: tabId === 40 ? 'Selected' : 'Created', url: tabId === 40 ? 'https://selected.invalid/private' : 'https://fixture.invalid/', active: true },
        created: tabId !== 40,
      } })
    } else if (message.method === 'forge.browser.release') {
      await client.send({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: 1, leaseId: params.leaseId, leaseEpoch: params.leaseEpoch, releasedTabIds: authorityTabs.get(String(params.leaseId)) ?? [40],
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
        host: { targetAffinity: 'external-chrome', connected: true, hostId: null, hostGeneration: null, focused: false, capabilities: null, connectedAt: null },
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
    expect(requests.map(({ method }) => method)).toEqual(['forge.browser.focusedEligibility', 'forge.browser.acquire'])
    expect(requests[1]?.params).toMatchObject({ reuseFocused: false })
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

  it('remembers one confirmed ambiguous profile for the current runtime session', async () => {
    const { runtime, client: profileA, root } = await connectedRuntime('instance_profile_a')
    const profileB = await connectRelayClient(path.join(root, 'relay.sock'))
    await sendRuntimeHello(profileB, 'instance_profile_b')
    const requestsA: Array<{ method: string; params: Record<string, unknown> }> = []
    const requestsB: Array<{ method: string; params: Record<string, unknown> }> = []
    const loopA = fakeExtensionLoop(profileA, requestsA, 'instance_profile_a', false)
    const loopB = fakeExtensionLoop(profileB, requestsB, 'instance_profile_b', false)

    runtime.confirmAutomaticInstance('session-a', 'profile-a', 'instance_profile_b')
    await expect(runtime.acquireTarget({
      sessionAgentId: 'session-a', profileId: 'profile-a', operation: 'snapshot', preferredTabId: null,
      reuseExisting: false, createIfNeeded: true, ownerEpoch: 30,
    })).resolves.toEqual({ ok: true, authority: { ownerEpoch: 30, tabId: 'ext.instance_profile_b.41' } })
    expect(requestsA).toEqual([])
    expect(requestsB.map(({ method }) => method)).toEqual(['forge.browser.acquire'])

    runtime.deactivate(); profileA.close(); profileB.close(); await Promise.all([loopA, loopB])
  })

})
