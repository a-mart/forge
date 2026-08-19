import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExternalChromeRendezvousDocument } from '@forge/protocol'
import { AuthenticatedRelayClient } from '../../../../native-messaging-host/src/relay-client.js'
import { NodeSocketConnector } from '../../../../native-messaging-host/src/transport.js'
import { ExternalChromeHostCoordinator } from '../coordinator.js'
import { ExternalChromeDeployer } from '../deployer.js'
import { ExternalChromeDeploymentRecovery } from '../recovery.js'
import { ExternalChromeAuthorityStore, PosixCurrentUserAccessController } from '../auth-rendezvous.js'
import { resolveExternalChromeDataPaths } from '../data-paths.js'
import { NodeExternalChromeEndpointAuthority, type ExternalChromeEndpointAuthority, type ExternalChromeEndpointHandle } from '../endpoint.js'
import { PosixNativeRegistration, type ExecutableTrustVerifier, type ExternalChromeNativeRegistration, type ForgeRegistrationConflictEvidence, type NativeRegistrationInspection } from '../registration.js'
import { EXTERNAL_CHROME_EXTENSION_ID, EXTERNAL_CHROME_PUBLIC_KEY_SHA256, sha256 } from '../package-manifest.js'

const roots: string[] = []
function treeSha256(files: Record<string, Buffer>): string {
  const hash = createHash('sha256')
  for (const relative of Object.keys(files).sort()) {
    const bytes = files[relative]!
    hash.update(`${relative}\0${bytes.byteLength}\0`)
    hash.update(bytes)
  }
  return hash.digest('hex')
}
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))
async function root(): Promise<{ dataRoot: string; deployer: ExternalChromeDeployer }> {
  const value = await mkdtemp(path.join(os.tmpdir(), 'forge-external-coordinator-'))
  roots.push(value)
  const dataRoot = path.join(value, 'data')
  const resourcesRoot = path.join(value, 'resources')
  const publicKey = (await readFile(new URL('../../../../chrome-extension/identity/production-public-key.b64', import.meta.url), 'utf8')).trim()
  const manifestJson = `${JSON.stringify({ manifest_version: 3, key: publicKey })}\n`
  const shell = 'shell\n'
  const payloadContents = {
    'content-script.js': Buffer.from('content payload\n'),
    'service-worker.js': Buffer.from('service worker payload\n'),
  }
  const native = Buffer.from('native')
  const payloadSha256 = treeSha256(payloadContents)
  const payloadDirectory = `1.0.0-${payloadSha256}`
  const shellFiles = {
    'manifest.json': sha256(Buffer.from(manifestJson)),
    'shell/bootstrap.js': sha256(Buffer.from(shell)),
  }
  const payloadFiles = Object.fromEntries(Object.entries(payloadContents).map(([file, bytes]) => [file, sha256(bytes)]))
  await mkdir(path.join(resourcesRoot, 'extension-shell', 'shell'), { recursive: true })
  await mkdir(path.join(resourcesRoot, 'payload', payloadDirectory), { recursive: true })
  await mkdir(path.join(resourcesRoot, 'native-host', 'linux-x64'), { recursive: true })
  await writeFile(path.join(resourcesRoot, 'extension-shell', 'manifest.json'), manifestJson)
  await writeFile(path.join(resourcesRoot, 'extension-shell', 'shell/bootstrap.js'), shell)
  await Promise.all(Object.entries(payloadContents).map(([file, bytes]) => writeFile(path.join(resourcesRoot, 'payload', payloadDirectory, file), bytes)))
  await writeFile(path.join(resourcesRoot, 'native-host', 'linux-x64', 'forge-external-chrome-native-host'), native)
  const manifest = {
    schemaVersion: 1, packageVersion: '1.0.0',
    extension: {
      extensionId: EXTERNAL_CHROME_EXTENSION_ID, publicKeySha256: EXTERNAL_CHROME_PUBLIC_KEY_SHA256,
      minimumChromeVersion: '125', shellAbi: 1, shellSha256: treeSha256({ 'manifest.json': Buffer.from(manifestJson), 'shell/bootstrap.js': Buffer.from(shell) }),
      payloadVersion: '1.0.0', payloadSha256, payloadDirectory, shellFiles, payloadFiles,
    },
    nativeHost: {
      protocol: { min: 1, max: 1, maxMessageBytes: 1_048_576 }, version: '1', platform: 'linux', architecture: 'x64',
      executable: 'forge-external-chrome-native-host', sha256: sha256(native), required: true,
      signature: { scheme: 'packaged-resource-hash', mode: 'release', verified: true, signer: null, teamId: null },
    },
    compatibility: { desktop: { min: '0.22.0', max: '0.22.999' }, shellAbi: { min: 1, max: 1 } },
  }
  await writeFile(path.join(resourcesRoot, 'package-manifest.json'), JSON.stringify(manifest))
  const deployer = new ExternalChromeDeployer({ dataRoot: path.resolve(dataRoot), resourcesRoot, desktopVersion: '0.22.5', platform: 'linux', architecture: 'x64' })
  await deployer.deploy()
  return { dataRoot, deployer }
}

class FakeRegistration implements ExternalChromeNativeRegistration {
  registration: NativeRegistrationInspection['registration'] = 'not-registered'
  trust: NativeRegistrationInspection['trust'] = 'trusted'
  repairs = 0
  removes = 0
  inspect(): Promise<NativeRegistrationInspection> { return Promise.resolve({ registration: this.registration, trust: this.trust }) }
  repair(): Promise<NativeRegistrationInspection> {
    this.repairs += 1
    this.registration = 'owned'
    return this.inspect()
  }
  transferForgeOwnedConflict(_evidence: ForgeRegistrationConflictEvidence): Promise<NativeRegistrationInspection> {
    this.registration = 'owned'
    return this.inspect()
  }
  remove(): Promise<NativeRegistrationInspection> {
    this.removes += 1
    this.registration = 'not-registered'
    return this.inspect()
  }
}

class FakeEndpoints implements ExternalChromeEndpointAuthority {
  handles: Array<ExternalChromeEndpointHandle & { closed: boolean }> = []
  listen(input: { runDirectory: string; platform: NodeJS.Platform; userScope: string; epoch: string }): Promise<ExternalChromeEndpointHandle> {
    const handle = {
      endpoint: input.platform === 'win32' ? `\\\\.\\pipe\\${input.epoch}` : path.join(input.runDirectory, `${input.epoch}.sock`),
      accessPosture: input.platform === 'win32' ? 'windows-current-user-authenticated' as const : 'posix-mode-0600' as const,
      closed: false,
      close: async () => { handle.closed = true },
    }
    this.handles.push(handle)
    return Promise.resolve(handle)
  }
}

class TrackingRelayEndpoints implements ExternalChromeEndpointAuthority {
  handles: Array<ExternalChromeEndpointHandle & { closed: boolean }> = []
  accept: (socket: Socket) => void = (socket) => socket.destroy()

  async listen(input: { runDirectory: string; platform: NodeJS.Platform; userScope: string; epoch: string }): Promise<ExternalChromeEndpointHandle> {
    const delegate = new NodeExternalChromeEndpointAuthority(access, { accept: (socket) => this.accept(socket) })
    const opened = await delegate.listen(input)
    const handle = {
      ...opened,
      closed: false,
      close: async () => {
        if (handle.closed) return
        handle.closed = true
        await opened.close()
      },
    }
    this.handles.push(handle)
    return handle
  }
}

const access = new PosixCurrentUserAccessController(process.getuid?.())
const noSchedule = (() => ({ unref: () => undefined })) as unknown as typeof setInterval
const noUnschedule = (() => undefined) as unknown as typeof clearInterval

async function connectToCoordinator(dataRoot: string): Promise<AuthenticatedRelayClient> {
  const paths = resolveExternalChromeDataPaths(dataRoot, 'linux')
  const rendezvous = JSON.parse(await readFile(paths.rendezvous, 'utf8')) as ExternalChromeRendezvousDocument
  const secret = Buffer.from((await readFile(paths.authKey, 'utf8')).trim(), 'base64')
  return AuthenticatedRelayClient.connect({
    rendezvous: { read: async () => rendezvous },
    secrets: { getSecret: async () => Buffer.from(secret) },
    connector: new NodeSocketConnector(384 * 1_024),
    expectedUserScope: rendezvous.userScope,
    expectedExtensionOrigin: 'chrome-extension://fcchfcnadajoejfbiclihglkmbcfhajd/',
    platform: 'linux', now: Date.now, maxAttempts: 1,
  })
}

async function sendCoordinatorRuntimeHello(
  client: AuthenticatedRelayClient,
  extensionInstanceId: string,
  payloadVersion: string,
  payloadSha256: string,
): Promise<void> {
  await client.send({
    jsonrpc: '2.0', id: 'hello', method: 'forge.runtime.hello', params: {
      protocol: { min: 1, max: 1 }, shellAbi: 1, payloadVersion, payloadSha256,
      extensionId: EXTERNAL_CHROME_EXTENSION_ID, extensionInstanceId, chromeVersion: '125.0.0.0',
      methods: ['forge.runtime.hello', 'forge.runtime.ping', 'forge.browser.inventory', 'forge.browser.acquire', 'forge.browser.release', 'forge.browser.acknowledgeRelease', 'forge.browser.reveal', 'forge.browser.execute', 'forge.runtime.prepareUpdate', 'forge.runtime.reload', 'browser.cdpEvent', 'browser.detached', 'browser.userControl', 'browser.tabChanged', 'browser.downloadChanged', 'browser.leaseChanged', 'browser.authoritySnapshot', 'runtime.goodbye'],
      maxMessageBytes: 262144,
      operations: ['status', 'open', 'navigate', 'resize', 'snapshot', 'click', 'type', 'press', 'scroll', 'evaluate', 'waitFor', 'recordingStart', 'recordingStop'].map((operation) => ({
        operation, supported: !['resize', 'recordingStart', 'recordingStop'].includes(operation), ...(!['resize', 'recordingStart', 'recordingStop'].includes(operation) ? {} : { reason: 'physical viewport and recording disabled' }),
      })),
      features: { resize: false, recording: false, downloadEvents: false, downloadArtifacts: false, downloadOpen: false, oopif: true, humanInterruption: true },
    },
  })
  await expect(client.receive()).resolves.toMatchObject({ id: 'hello', result: { protocolVersion: 1 } })
  await client.send({
    jsonrpc: '2.0', method: 'browser.authoritySnapshot',
    params: { protocolVersion: 1, snapshotId: `snapshot-${extensionInstanceId}`, reports: [] },
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
}

async function lifecycleExtensionLoop(
  client: AuthenticatedRelayClient,
  requests: Array<{ method: string; params: Record<string, unknown> }>,
  extensionInstanceId: string,
): Promise<void> {
  while (true) {
    const message = await client.receive()
    if (!message) return
    if (typeof message.id !== 'string' || typeof message.method !== 'string') continue
    const params = message.params as Record<string, unknown>
    requests.push({ method: message.method, params })
    if (message.method === 'forge.browser.inventory') {
      await client.send({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: 1,
        tabs: [{ tabId: 40, windowId: 1, title: '', url: 'https://fixture.invalid/', active: true, windowFocused: false, lastAccessed: 1_000 }],
        truncated: false,
      } })
    } else if (message.method === 'forge.browser.acquire') {
      await client.send({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: 1, leaseId: params.leaseId, leaseEpoch: params.leaseEpoch, sessionAgentId: params.sessionAgentId,
        extensionInstanceId, tab: { tabId: 40, title: '', url: 'https://fixture.invalid/', active: true }, created: false,
      } })
    } else if (message.method === 'forge.runtime.prepareUpdate') {
      await client.send({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: 1, payloadVersion: params.payloadVersion, quiesced: true,
      } })
    } else if (message.method === 'forge.browser.release') {
      await client.send({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: 1, leaseId: params.leaseId, leaseEpoch: params.leaseEpoch, releasedTabIds: [40],
      } })
    } else if (message.method === 'forge.browser.acknowledgeRelease') {
      await client.send({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: 1, leaseId: params.leaseId, leaseEpoch: params.leaseEpoch,
        releasedTabIds: params.releasedTabIds, acknowledged: true,
      } })
    }
  }
}

describe('ExternalChromeHostCoordinator', () => {
  it('publishes a non-secret bounded rendezvous, quiesces, and permits clean takeover', async () => {
    const { dataRoot, deployer } = await root()
    const registration = new FakeRegistration()
    const firstEndpoints = new FakeEndpoints()
    const alive = (pid: number): boolean => pid === 101 || pid === 202
    const first = new ExternalChromeHostCoordinator({
      dataRoot, platform: 'linux', pid: 101, username: 'tester', uid: 501,
      instanceId: 'desktop_first_123', access, endpoints: firstEndpoints, registration, isProcessAlive: alive, deploymentVerifier: deployer,
    })
    const second = new ExternalChromeHostCoordinator({
      dataRoot, platform: 'linux', pid: 202, username: 'tester', uid: 501,
      instanceId: 'desktop_second_12', access, endpoints: new FakeEndpoints(), registration, isProcessAlive: alive, deploymentVerifier: deployer,
    })

    expect(await first.enable()).toMatchObject({ state: 'online', authority: 'owned', auth: 'secure', registration: 'owned' })
    const paths = resolveExternalChromeDataPaths(dataRoot, 'linux')
    const rendezvousText = await readFile(paths.rendezvous, 'utf8')
    const rendezvous = JSON.parse(rendezvousText) as Record<string, unknown>
    expect(rendezvous).toMatchObject({
      schemaVersion: 1,
      desktopInstanceId: 'desktop_first_123',
      desktopPid: 101,
      protocolMin: 1,
      protocolMax: 1,
    })
    expect(Object.keys(rendezvous).sort()).toEqual([
      'desktopInstanceId', 'desktopPid', 'endpoint', 'epoch', 'expiresAt', 'keyId',
      'protocolMax', 'protocolMin', 'schemaVersion', 'userScope',
    ])
    const authText = (await readFile(paths.authKey, 'utf8')).trim()
    expect(rendezvousText).not.toContain(authText)
    expect(await second.status()).toMatchObject({ state: 'other-instance', authority: 'other-live', canEnable: false })
    expect(await second.enable()).toMatchObject({ state: 'other-instance' })

    await first.quiesce('desktop-update')
    expect(firstEndpoints.handles[0]?.closed).toBe(true)
    expect(await first.status()).toMatchObject({ state: 'quiesced', authority: 'none' })
    expect(await second.status()).toMatchObject({ state: 'offline', authority: 'none' })
    await second.resumeIfEnabled()
    expect(await second.status()).toMatchObject({ state: 'online', authority: 'owned' })
    await second.disable()
  })

  it('restarts into an authenticated recovery listener and releases the exact durable lease on remove retry', async () => {
    const { dataRoot, deployer } = await root()
    const registration = new FakeRegistration()
    const livePids = new Set([611])
    const isProcessAlive = (pid: number): boolean => livePids.has(pid)
    const authorityPath = path.join(dataRoot, '..', 'restart-authority.json')
    const firstEndpoints = new TrackingRelayEndpoints()
    const first = new ExternalChromeHostCoordinator({
      dataRoot, platform: 'linux', pid: 611, username: 'restart-user', uid: 611,
      instanceId: 'desktop_restart_first', access,
      authority: new ExternalChromeAuthorityStore(dataRoot, 'linux', 'desktop_restart_first', 611, access, isProcessAlive, Date.now, authorityPath),
      endpoints: firstEndpoints, registration, isProcessAlive,
      deploymentVerifier: deployer, setInterval: noSchedule, clearInterval: noUnschedule,
    })
    firstEndpoints.accept = (socket) => first.transport().accept(socket)
    await first.enable()
    const deployed = await deployer.verifyDeployment()
    if (deployed.state !== 'ready') throw new Error('fixture deployment is not ready')
    const firstAuth = await readFile(resolveExternalChromeDataPaths(dataRoot, 'linux').authKey, 'utf8')
    const originalClient = await connectToCoordinator(dataRoot)
    await sendCoordinatorRuntimeHello(
      originalClient, 'instance_restart_exact', deployed.install.payloadVersion, deployed.install.payloadSha256,
    )
    const originalRequests: Array<{ method: string; params: Record<string, unknown> }> = []
    const originalLoop = lifecycleExtensionLoop(originalClient, originalRequests, 'instance_restart_exact')
    await expect(first.transport().acquireTarget({
      sessionAgentId: 'session-restart', profileId: 'profile-restart', operation: 'snapshot', preferredTabId: null,
      reuseExisting: true, createIfNeeded: true, ownerEpoch: 17,
    })).resolves.toMatchObject({ ok: true, authority: { ownerEpoch: 17, tabId: 'ext.instance_restart_exact.40' } })
    const [durableLease] = await first.transport().leaseCheckpoints()
    expect(durableLease).toMatchObject({ extensionInstanceId: 'instance_restart_exact', leaseEpoch: 17, tabIds: [40] })

    // Simulate an involuntary process loss: transport and listener disappear,
    // while desired-enabled, stale same-data-dir authority, auth, and checkpoint
    // files survive exactly as they would across a Desktop crash.
    await firstEndpoints.handles[0]!.close()
    first.transport().deactivate()
    livePids.delete(611)
    await originalLoop

    const restartedEndpoints = new TrackingRelayEndpoints()
    const restarted = new ExternalChromeHostCoordinator({
      dataRoot, platform: 'linux', pid: 612, username: 'restart-user', uid: 611,
      instanceId: 'desktop_restart_second', access,
      authority: new ExternalChromeAuthorityStore(dataRoot, 'linux', 'desktop_restart_second', 612, access, isProcessAlive, Date.now, authorityPath),
      endpoints: restartedEndpoints, registration, isProcessAlive,
      deploymentVerifier: deployer, setInterval: noSchedule, clearInterval: noUnschedule,
    })
    restartedEndpoints.accept = (socket) => restarted.transport().accept(socket)
    expect(await restarted.status()).toMatchObject({ state: 'offline', authority: 'stale', canEnable: true })
    await expect(restarted.resumeIfEnabled()).resolves.toBeUndefined()
    expect(await restarted.status()).toMatchObject({ state: 'online', authority: 'owned', recovery: 'reconnecting' })
    expect(await readFile(resolveExternalChromeDataPaths(dataRoot, 'linux').authKey, 'utf8')).not.toBe(firstAuth)
    expect(await restarted.transport().leaseCheckpoints()).toEqual([expect.objectContaining({
      extensionInstanceId: 'instance_restart_exact', leaseId: durableLease!.leaseId, leaseEpoch: 17,
    })])

    const reconnected = await connectToCoordinator(dataRoot)
    await sendCoordinatorRuntimeHello(
      reconnected, 'instance_restart_exact', deployed.install.payloadVersion, deployed.install.payloadSha256,
    )
    await reconnected.send({ jsonrpc: '2.0', method: 'browser.leaseChanged', params: {
      protocolVersion: 1, leaseId: durableLease!.leaseId, leaseEpoch: 17, state: 'acquired', tabIds: [40],
    } })
    const retryRequests: Array<{ method: string; params: Record<string, unknown> }> = []
    const retryLoop = lifecycleExtensionLoop(reconnected, retryRequests, 'instance_restart_exact')
    await expect(restarted.remove()).resolves.toMatchObject({
      state: 'disabled', auth: 'missing', registration: 'not-registered', recovery: 'ready',
    })
    expect(retryRequests.map((request) => request.method)).toEqual(expect.arrayContaining([
      'forge.runtime.prepareUpdate', 'forge.browser.release', 'forge.browser.acknowledgeRelease',
    ]))
    expect(retryRequests.find((request) => request.method === 'forge.browser.release')?.params).toMatchObject({
      leaseId: durableLease!.leaseId, leaseEpoch: 17, reason: 'desktop-restart',
    })
    expect(await restarted.transport().leaseCheckpoints()).toEqual([])
    await retryLoop
  })

  it('persists exact Forge registration conflict evidence and transfers it only after quiesce', async () => {
    const firstRoot = await root()
    const secondRoot = await root()
    const registrationDirectory = path.join(firstRoot.dataRoot, '..', 'shared-native-registration')
    const trusted: ExecutableTrustVerifier = { verify: async () => 'trusted' }
    const firstRegistration = new PosixNativeRegistration({
      platform: 'linux', dataRoot: firstRoot.dataRoot, registrationDirectory, trustVerifier: trusted,
    })
    const secondRegistration = new PosixNativeRegistration({
      platform: 'linux', dataRoot: secondRoot.dataRoot, registrationDirectory, trustVerifier: trusted,
    })
    const alive = (pid: number): boolean => pid === 811 || pid === 812
    const authorityFile = path.join(firstRoot.dataRoot, '..', 'shared-authority.json')
    const firstAuthority = new ExternalChromeAuthorityStore(firstRoot.dataRoot, 'linux', 'desktop_takeover_first', 811, access, alive, Date.now, authorityFile)
    const secondAuthority = new ExternalChromeAuthorityStore(secondRoot.dataRoot, 'linux', 'desktop_takeover_second', 812, access, alive, Date.now, authorityFile)
    const first = new ExternalChromeHostCoordinator({
      dataRoot: firstRoot.dataRoot, platform: 'linux', pid: 811, username: 'takeover-user', uid: 902,
      instanceId: 'desktop_takeover_first', access, authority: firstAuthority, endpoints: new FakeEndpoints(), registration: firstRegistration,
      isProcessAlive: alive, deploymentVerifier: firstRoot.deployer,
    })
    let second = new ExternalChromeHostCoordinator({
      dataRoot: secondRoot.dataRoot, platform: 'linux', pid: 812, username: 'takeover-user', uid: 902,
      instanceId: 'desktop_takeover_second', access, authority: secondAuthority, endpoints: new FakeEndpoints(), registration: secondRegistration,
      isProcessAlive: alive, deploymentVerifier: secondRoot.deployer,
    })
    await first.enable()
    expect(await second.status()).toMatchObject({
      state: 'other-instance', authority: 'other-live', recovery: 'authority-owned-by-other-data-dir',
      canEnable: false, canTakeover: false, ownerDataDirHash: expect.stringMatching(/^[a-f0-9]{16}$/u),
      registration: 'conflict',
    })
    await expect(second.takeover()).rejects.toThrow(/must be quiesced/u)
    await first.quiesce('desktop-update')
    const secondPaths = resolveExternalChromeDataPaths(secondRoot.dataRoot, 'linux')
    const authorizationPath = path.join(secondPaths.state, 'takeover-authorization.json')
    const transferPath = path.join(secondPaths.state, 'registration-transfer.json')

    // A failed transfer never consumes the exact durable authorization, so a
    // fresh coordinator can retry after the process exits before mutation.
    let failBeforeTransfer = true
    const failingRegistration: ExternalChromeNativeRegistration = {
      inspect: () => secondRegistration.inspect(),
      repair: () => secondRegistration.repair(),
      remove: () => secondRegistration.remove(),
      transferForgeOwnedConflict: async (evidence) => {
        if (failBeforeTransfer) {
          failBeforeTransfer = false
          throw new Error('synthetic failure before registration transfer')
        }
        return secondRegistration.transferForgeOwnedConflict(evidence)
      },
    }
    second = new ExternalChromeHostCoordinator({
      dataRoot: secondRoot.dataRoot, platform: 'linux', pid: 812, username: 'takeover-user', uid: 902,
      instanceId: 'desktop_takeover_second_failed', access,
      authority: new ExternalChromeAuthorityStore(secondRoot.dataRoot, 'linux', 'desktop_takeover_second_failed', 812, access, alive, Date.now, authorityFile),
      endpoints: new FakeEndpoints(), registration: failingRegistration,
      isProcessAlive: alive, deploymentVerifier: secondRoot.deployer,
    })
    expect(await second.status()).toMatchObject({ authority: 'none', canEnable: false, canTakeover: true, registration: 'conflict' })
    await expect(second.takeover()).rejects.toThrow(/synthetic failure before/u)
    await expect(readFile(authorizationPath, 'utf8')).resolves.toContain('registrationIdentity')
    expect(await secondRegistration.inspect()).toMatchObject({ registration: 'conflict' })

    // A crash after the exact global transfer but before authorization cleanup
    // leaves a self-identifying transaction that the next process can finish.
    second = new ExternalChromeHostCoordinator({
      dataRoot: secondRoot.dataRoot, platform: 'linux', pid: 812, username: 'takeover-user', uid: 902,
      instanceId: 'desktop_takeover_second_crash', access,
      authority: new ExternalChromeAuthorityStore(secondRoot.dataRoot, 'linux', 'desktop_takeover_second_crash', 812, access, alive, Date.now, authorityFile),
      endpoints: new FakeEndpoints(), registration: secondRegistration,
      isProcessAlive: alive, deploymentVerifier: secondRoot.deployer,
      afterTakeoverTransfer: () => { throw new Error('synthetic crash after transfer') },
    })
    await expect(second.takeover()).rejects.toThrow(/synthetic crash after/u)
    await expect(readFile(authorizationPath, 'utf8')).resolves.toContain('registrationIdentity')
    await expect(readFile(transferPath, 'utf8')).resolves.toContain('ownershipPath')
    expect(await secondRegistration.inspect()).toMatchObject({
      registration: 'owned', completedForgeTransfer: { identity: expect.stringMatching(/^[a-f0-9]{64}$/u) },
    })

    second = new ExternalChromeHostCoordinator({
      dataRoot: secondRoot.dataRoot, platform: 'linux', pid: 812, username: 'takeover-user', uid: 902,
      instanceId: 'desktop_takeover_second_restart', access,
      authority: new ExternalChromeAuthorityStore(secondRoot.dataRoot, 'linux', 'desktop_takeover_second_restart', 812, access, alive, Date.now, authorityFile),
      endpoints: new FakeEndpoints(), registration: secondRegistration,
      isProcessAlive: alive, deploymentVerifier: secondRoot.deployer,
    })
    expect(await second.status()).toMatchObject({ authority: 'none', canEnable: false, canTakeover: true, registration: 'owned' })
    const takeoverBarrier = vi.spyOn(second.transport(), 'quiesce')
    expect(await second.takeover()).toMatchObject({ state: 'online', authority: 'owned', registration: 'owned' })
    expect(takeoverBarrier).not.toHaveBeenCalled()
    await expect(readFile(authorizationPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(transferPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(second.takeover()).rejects.toThrow(/quiesced|authorization/u)
    await second.disable()
  })

  it('repairs insecure authentication state and removal keeps foreign files untouched by facade policy', async () => {
    const { dataRoot, deployer } = await root()
    const registration = new FakeRegistration()
    const endpoints = new FakeEndpoints()
    let deploymentRepairs = 0
    const coordinator = new ExternalChromeHostCoordinator({
      dataRoot, platform: 'linux', pid: 303, username: 'tester', uid: 501,
      instanceId: 'desktop_third_123', access, endpoints, registration, isProcessAlive: () => false,
      repairDeployment: async () => { deploymentRepairs += 1 }, deploymentVerifier: deployer,
    })
    expect(await coordinator.repair()).toMatchObject({ state: 'disabled', auth: 'secure', registration: 'owned' })
    expect(registration.repairs).toBe(1)
    expect(deploymentRepairs).toBe(1)
    await coordinator.enable()
    expect(await coordinator.remove()).toMatchObject({ state: 'disabled', auth: 'missing', registration: 'not-registered' })
    expect(registration.removes).toBe(1)
    expect(endpoints.handles[0]?.closed).toBe(true)
  })

  it('repairs a real deployment mismatch and resumes a previously enabled coordinator', async () => {
    const { dataRoot, deployer } = await root()
    const registration = new FakeRegistration()
    const endpoints = new FakeEndpoints()
    const coordinator = new ExternalChromeHostCoordinator({
      dataRoot, platform: 'linux', pid: 304, username: 'repair-runtime-tester', uid: 501,
      instanceId: 'desktop_repair_runtime', access, endpoints, registration, isProcessAlive: () => false,
      repairDeployment: () => new ExternalChromeDeploymentRecovery(deployer).repair(), deploymentVerifier: deployer,
    })
    await coordinator.enable()
    const selector = JSON.parse(await readFile(path.join(deployer.paths.extension, 'current.json'), 'utf8')) as { payloadDirectory: string }
    await writeFile(path.join(deployer.paths.payloads, selector.payloadDirectory, 'service-worker.js'), 'tampered')
    expect(await coordinator.status()).toMatchObject({ state: 'online', setup: { pathState: 'mismatch' } })

    const barrier = vi.spyOn(coordinator.transport(), 'quiesce')
    await expect(coordinator.repair()).resolves.toMatchObject({ state: 'online', setup: { pathState: 'ready' } })
    expect(barrier).toHaveBeenCalledWith('deployment-repair', expect.any(Number))
    expect(endpoints.handles[0]?.closed).toBe(true)
    expect(endpoints.handles.at(-1)?.closed).toBe(false)
    expect(await deployer.verifyDeployment()).toMatchObject({ state: 'ready' })
    await coordinator.disable()
  })

  it('uses offline repair to restore a recovery listener without deleting active checkpoint evidence', async () => {
    const { dataRoot, deployer } = await root()
    const paths = resolveExternalChromeDataPaths(dataRoot, 'linux')
    await mkdir(paths.state, { recursive: true })
    await writeFile(path.join(paths.state, 'enabled.json'), `${JSON.stringify({ schemaVersion: 1, enabled: true })}\n`, { mode: 0o600 })
    await writeFile(path.join(paths.state, 'leases.json'), `${JSON.stringify({
      schemaVersion: 1,
      leases: [{
        extensionInstanceId: 'instance_offline_repair', sessionAgentId: 'session-repair', profileId: 'profile-repair',
        leaseId: 'lease-offline-repair', leaseEpoch: 8, tabIds: [52],
        expiresAt: Date.now() + 60_000,
      }],
    })}\n`, { mode: 0o600 })
    const endpoints = new FakeEndpoints()
    const registration = new FakeRegistration()
    let deploymentRepairs = 0
    const coordinator = new ExternalChromeHostCoordinator({
      dataRoot, platform: 'linux', pid: 513, username: 'offline-repair-user', uid: 513,
      instanceId: 'desktop_offline_repair', access, endpoints, registration, isProcessAlive: () => false,
      repairDeployment: async () => { deploymentRepairs += 1 }, deploymentVerifier: deployer,
      setInterval: noSchedule, clearInterval: noUnschedule,
    })
    const barrier = vi.spyOn(coordinator.transport(), 'quiesce')
    await expect(coordinator.repair()).resolves.toMatchObject({
      state: 'online', authority: 'owned', auth: 'secure', recovery: 'reconnecting',
    })
    expect(barrier).not.toHaveBeenCalled()
    expect(deploymentRepairs).toBe(0)
    expect(await coordinator.transport().leaseCheckpoints()).toEqual([expect.objectContaining({
      extensionInstanceId: 'instance_offline_repair', leaseId: 'lease-offline-repair', leaseEpoch: 8,
    })])

    // Once the listener exists, an explicit retry must cross the normal exact
    // barrier before staging and activating a deployment.
    barrier.mockResolvedValueOnce(undefined)
    await expect(coordinator.repair()).resolves.toMatchObject({ state: 'online' })
    expect(barrier).toHaveBeenCalledWith('deployment-repair', expect.any(Number))
    expect(deploymentRepairs).toBe(1)
    barrier.mockResolvedValueOnce(undefined)
    await coordinator.disable()
  })

  it('fails user lifecycle mutations closed before registration, auth, deployment, or authority changes and permits retry', async () => {
    const { dataRoot, deployer } = await root()
    const registration = new FakeRegistration()
    const endpoints = new FakeEndpoints()
    let deploymentRepairs = 0
    const coordinator = new ExternalChromeHostCoordinator({
      dataRoot, platform: 'linux', pid: 514, username: `barrier-user-${path.basename(dataRoot)}`, uid: 514,
      instanceId: 'desktop_barrier_test', access, endpoints, registration, isProcessAlive: () => false,
      repairDeployment: async () => { deploymentRepairs += 1 }, deploymentVerifier: deployer,
    })
    await coordinator.enable()
    const paths = resolveExternalChromeDataPaths(dataRoot, 'linux')
    const originalAuth = await readFile(paths.authKey, 'utf8')
    const barrier = vi.spyOn(coordinator.transport(), 'quiesce')

    barrier.mockRejectedValueOnce(new Error('synthetic disconnected checkpoint'))
    await expect(coordinator.disable()).rejects.toThrow(/disconnected checkpoint/u)
    expect(await coordinator.status()).toMatchObject({ state: 'quiesced', authority: 'owned', recovery: 'manual-extension-reload' })
    expect(endpoints.handles[0]?.closed).toBe(false)
    expect(registration).toMatchObject({ registration: 'owned', removes: 0 })
    expect(await readFile(paths.authKey, 'utf8')).toBe(originalAuth)
    expect(JSON.parse(await readFile(path.join(paths.state, 'enabled.json'), 'utf8'))).toMatchObject({ enabled: true })

    barrier.mockResolvedValueOnce(undefined)
    await expect(coordinator.disable()).resolves.toMatchObject({ state: 'disabled', recovery: 'ready' })
    await coordinator.enable()

    barrier.mockRejectedValueOnce(new Error('synthetic dropped prepare acknowledgement'))
    await expect(coordinator.repair()).rejects.toThrow(/dropped prepare/u)
    expect(deploymentRepairs).toBe(0)
    expect(await readFile(paths.authKey, 'utf8')).toBe(originalAuth)
    expect(registration.repairs).toBe(2) // the two successful enables only

    barrier.mockResolvedValueOnce(undefined)
    await expect(coordinator.repair()).resolves.toMatchObject({ state: 'online', recovery: 'reconnecting' })
    expect(deploymentRepairs).toBe(1)

    const authBeforeRotation = await readFile(paths.authKey, 'utf8')
    barrier.mockRejectedValueOnce(new Error('synthetic mismatched release acknowledgement'))
    await expect(coordinator.rotateAuthKey()).rejects.toThrow(/mismatched release/u)
    expect(await readFile(paths.authKey, 'utf8')).toBe(authBeforeRotation)
    expect(endpoints.handles.at(-1)?.closed).toBe(false)

    barrier.mockResolvedValueOnce(undefined)
    await coordinator.rotateAuthKey()
    expect(await readFile(paths.authKey, 'utf8')).not.toBe(authBeforeRotation)

    const authBeforeRemove = await readFile(paths.authKey, 'utf8')
    barrier.mockRejectedValueOnce(new Error('synthetic remove timeout'))
    await expect(coordinator.remove()).rejects.toThrow(/remove timeout/u)
    expect(registration.removes).toBe(0)
    expect(await readFile(paths.authKey, 'utf8')).toBe(authBeforeRemove)
    expect(endpoints.handles.at(-1)?.closed).toBe(false)

    barrier.mockResolvedValueOnce(undefined)
    await expect(coordinator.remove()).resolves.toMatchObject({ state: 'disabled', auth: 'missing', registration: 'not-registered', recovery: 'ready' })
    expect(registration.removes).toBe(1)
  })

  it('fails update quiesce closed and writes only an opaque recovery marker when release is unproven', async () => {
    const { dataRoot, deployer } = await root()
    const registration = new FakeRegistration()
    const endpoints = new FakeEndpoints()
    const paths = resolveExternalChromeDataPaths(dataRoot, 'linux')
    await mkdir(paths.state, { recursive: true })
    await mkdir(path.dirname(paths.authKey), { recursive: true })
    await writeFile(paths.authKey, `${Buffer.alloc(32, 0x55).toString('base64')}\n`, { mode: 0o600 })
    await writeFile(path.join(paths.state, 'leases.json'), `${JSON.stringify({
      schemaVersion: 1,
      leases: [{
        extensionInstanceId: 'profile_opaque', sessionAgentId: 'session_opaque', profileId: 'profile_opaque',
        leaseId: 'lease_opaque', leaseEpoch: 4, tabIds: [17], expiresAt: Date.now() + 60_000,
      }],
    })}\n`)
    const coordinator = new ExternalChromeHostCoordinator({
      dataRoot, platform: 'linux', pid: 515, username: 'marker-user', uid: 516,
      instanceId: 'desktop_marker_test', access, endpoints, registration, isProcessAlive: () => false, deploymentVerifier: deployer,
      authority: new ExternalChromeAuthorityStore(
        dataRoot, 'linux', 'desktop_marker_test', 515, access, () => false, Date.now,
        path.join(dataRoot, '..', 'marker-authority.json'),
      ),
    })
    await coordinator.enable()
    const authBeforeRemove = await readFile(paths.authKey, 'utf8')
    await expect(coordinator.remove()).rejects.toThrow(/could not prove release/u)
    expect(endpoints.handles[0]?.closed).toBe(false)
    expect(registration).toMatchObject({ registration: 'owned', removes: 0 })
    expect(await readFile(paths.authKey, 'utf8')).toBe(authBeforeRemove)
    expect(await coordinator.status()).toMatchObject({ state: 'quiesced', authority: 'owned', recovery: 'manual-extension-reload' })
    expect(JSON.parse(await readFile(path.join(paths.state, 'recovery-marker.json'), 'utf8'))).toMatchObject({
      schemaVersion: 1, reason: 'integration-remove', status: 'release-unproven', at: expect.any(String),
    })

    await expect(coordinator.quiesce('desktop-update')).rejects.toThrow(/could not prove release/u)
    expect(endpoints.handles[0]?.closed).toBe(true)
    expect(await coordinator.status()).toMatchObject({ state: 'quiesced', recovery: 'manual-extension-reload' })
    const marker = await readFile(path.join(paths.state, 'recovery-marker.json'), 'utf8')
    expect(JSON.parse(marker)).toEqual(expect.objectContaining({
      schemaVersion: 1, reason: 'desktop-update', status: 'release-unproven', at: expect.any(String),
    }))
    expect(marker).not.toMatch(/https?:|title|content|evaluate|screenshot|secret/iu)
  })

  it('queues updater quiesce behind an in-progress enable and closes the newly opened endpoint', async () => {
    const { dataRoot, deployer } = await root()
    const registration = new FakeRegistration()
    let releaseListen: (() => void) | null = null
    const listenGate = new Promise<void>((resolve) => { releaseListen = resolve })
    let closed = false
    const endpoints: ExternalChromeEndpointAuthority = {
      listen: async (input) => {
        await listenGate
        return {
          endpoint: path.join(input.runDirectory, 'queued.sock'),
          accessPosture: 'posix-mode-0600',
          close: async () => { closed = true },
        }
      },
    }
    const coordinator = new ExternalChromeHostCoordinator({
      dataRoot, platform: 'linux', pid: 505, username: 'tester', uid: 501,
      instanceId: 'desktop_fifth_123', access, endpoints, registration, isProcessAlive: () => false, deploymentVerifier: deployer,
    })
    const enabling = coordinator.enable()
    const quiescing = coordinator.quiesce('desktop-update')
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(closed).toBe(false)
    releaseListen?.()
    await enabling
    await quiescing
    expect(closed).toBe(true)
    expect(await coordinator.status()).toMatchObject({ state: 'quiesced', authority: 'none' })
  })

  it('projects only the exact identity-validated unpacked path and disables it after selector tampering', async () => {
    const { dataRoot, deployer } = await root()
    const registration = new FakeRegistration()
    const paths = resolveExternalChromeDataPaths(dataRoot, 'linux')
    const coordinator = new ExternalChromeHostCoordinator({
      dataRoot, platform: 'linux', pid: 606, username: 'tester', uid: 501,
      instanceId: 'desktop_sixth_123', access, endpoints: new FakeEndpoints(), registration, isProcessAlive: () => false, deploymentVerifier: deployer,
    })

    expect(await coordinator.status()).toMatchObject({
      state: 'disabled', auth: 'missing', registration: 'not-registered',
      canEnable: true, canRepair: false, canReveal: true,
      setup: { pathState: 'ready', loadUnpackedPath: paths.extension, extensionId: 'fcchfcnadajoejfbiclihglkmbcfhajd' },
    })
    expect(await coordinator.validatedLoadUnpackedPath()).toBe(paths.extension)

    await writeFile(path.join(paths.extension, 'current.json'), JSON.stringify({
      schemaVersion: 1,
      shellAbi: 1,
      payloadVersion: '1.0.0',
      payloadSha256: 'a'.repeat(64),
      payloadDirectory: '../../attacker-controlled',
      payloadFiles: {},
    }))
    expect(await coordinator.status()).toMatchObject({ canEnable: false, canReveal: false, setup: { pathState: 'mismatch' } })
    expect(await coordinator.validatedLoadUnpackedPath()).toBeNull()
  })

  it('offers repair only once native registration or deployment evidence exists', async () => {
    const { dataRoot, deployer } = await root()
    const registration = new FakeRegistration()
    const coordinator = new ExternalChromeHostCoordinator({
      dataRoot, platform: 'linux', pid: 608, username: 'repair-state-tester', uid: 501,
      instanceId: 'desktop_repair_state', access, endpoints: new FakeEndpoints(), registration,
      isProcessAlive: () => false, deploymentVerifier: deployer, repairDeployment: () => deployer.stage(),
    })

    expect(await coordinator.status()).toMatchObject({
      state: 'disabled', auth: 'missing', registration: 'not-registered', canRepair: false,
    })
    registration.registration = 'needs-repair'
    registration.trust = 'missing'
    expect(await coordinator.status()).toMatchObject({
      registration: 'needs-repair', canEnable: false, canRepair: true,
    })
  })

  it('fails closed on corrupt shell, payload, install manifest, and native host content', async () => {
    const { dataRoot, deployer } = await root()
    const registration = new FakeRegistration()
    const coordinator = new ExternalChromeHostCoordinator({
      dataRoot, platform: 'linux', pid: 707, username: 'tester', uid: 501,
      instanceId: 'desktop_seventh_1', access, endpoints: new FakeEndpoints(), registration,
      isProcessAlive: () => false, deploymentVerifier: deployer,
    })
    const paths = resolveExternalChromeDataPaths(dataRoot, 'linux')
    const assertMismatch = async (): Promise<void> => {
      expect(await coordinator.status()).toMatchObject({
        canEnable: false, canReveal: false, setup: { pathState: 'mismatch' },
      })
      expect((await coordinator.status()).setup.deployed).toBeUndefined()
      await expect(coordinator.enable()).rejects.toThrow(/missing or invalid/u)
    }

    await writeFile(path.join(paths.extension, 'shell/bootstrap.js'), 'corrupt')
    await assertMismatch()
    await deployer.deploy()
    const selector = JSON.parse(await readFile(path.join(paths.extension, 'current.json'), 'utf8')) as { payloadDirectory: string }
    await writeFile(path.join(paths.payloads, selector.payloadDirectory, 'service-worker.js'), 'corrupt')
    await assertMismatch()
    await deployer.deploy()
    await writeFile(paths.installState, '{"schemaVersion":1,"unexpected":true}')
    await assertMismatch()
    await deployer.deploy()
    await writeFile(paths.nativeHostExecutable, 'corrupt')
    await assertMismatch()
  })

  it('keeps rollback failures visible and lets active recovery outrank the receipt', async () => {
    const failedRoot = await root()
    const failed = new ExternalChromeHostCoordinator({
      dataRoot: failedRoot.dataRoot, platform: 'linux', pid: 909, username: 'rollback-failed', uid: 909,
      instanceId: 'desktop_rollback_failed', access, endpoints: new FakeEndpoints(), registration: new FakeRegistration(),
      isProcessAlive: () => false, deploymentVerifier: failedRoot.deployer,
      rollbackController: { canRollback: async () => true, rollback: async () => { throw new Error('synthetic rollback failure') } },
    })
    await failed.enable()
    await expect(failed.rollback()).rejects.toThrow(/synthetic rollback failure/u)
    expect(await failed.status()).toMatchObject({ recovery: 'manual-extension-reload' })

    const activeRoot = await root()
    const active = new ExternalChromeHostCoordinator({
      dataRoot: activeRoot.dataRoot, platform: 'linux', pid: 910, username: 'rollback-active', uid: 910,
      instanceId: 'desktop_rollback_active', access, endpoints: new FakeEndpoints(), registration: new FakeRegistration(),
      isProcessAlive: () => false,
      deploymentVerifier: {
        verifyDeployment: () => activeRoot.deployer.verifyDeployment(),
        recoveryState: () => 'manual-extension-reload',
      },
      rollbackController: { canRollback: async () => true, rollback: async () => undefined },
    })
    expect(await active.rollback()).toMatchObject({ recovery: 'manual-extension-reload' })
  })

  it('fails closed when executable trust is missing', async () => {
    const { dataRoot, deployer } = await root()
    const registration = new FakeRegistration()
    registration.trust = 'missing'
    const coordinator = new ExternalChromeHostCoordinator({
      dataRoot, platform: 'linux', pid: 404, username: 'tester', uid: 501,
      instanceId: 'desktop_fourth_12', access, endpoints: new FakeEndpoints(), registration, isProcessAlive: () => false, deploymentVerifier: deployer,
    })
    await expect(coordinator.enable()).rejects.toThrow(/not trusted/u)
    expect(await coordinator.status()).toMatchObject({ state: 'disabled', authority: 'none', canEnable: false })
  })
})
