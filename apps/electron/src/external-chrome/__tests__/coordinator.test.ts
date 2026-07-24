import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ExternalChromeHostCoordinator } from '../coordinator.js'
import { ExternalChromeDeployer } from '../deployer.js'
import { PosixCurrentUserAccessController } from '../auth-rendezvous.js'
import { resolveExternalChromeDataPaths } from '../data-paths.js'
import type { ExternalChromeEndpointAuthority, ExternalChromeEndpointHandle } from '../endpoint.js'
import type { ExternalChromeNativeRegistration, NativeRegistrationInspection } from '../registration.js'
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
  const payload = 'payload\n'
  const native = Buffer.from('native')
  const payloadSha256 = treeSha256({ 'worker.js': Buffer.from(payload) })
  const payloadDirectory = `1.0.0-${payloadSha256}`
  const shellFiles = {
    'manifest.json': sha256(Buffer.from(manifestJson)),
    'shell/bootstrap.js': sha256(Buffer.from(shell)),
  }
  const payloadFiles = { 'worker.js': sha256(Buffer.from(payload)) }
  await mkdir(path.join(resourcesRoot, 'extension-shell', 'shell'), { recursive: true })
  await mkdir(path.join(resourcesRoot, 'payload', payloadDirectory), { recursive: true })
  await mkdir(path.join(resourcesRoot, 'native-host', 'linux-x64'), { recursive: true })
  await writeFile(path.join(resourcesRoot, 'extension-shell', 'manifest.json'), manifestJson)
  await writeFile(path.join(resourcesRoot, 'extension-shell', 'shell/bootstrap.js'), shell)
  await writeFile(path.join(resourcesRoot, 'payload', payloadDirectory, 'worker.js'), payload)
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
      signature: { scheme: 'packaged-resource-hash', verified: true },
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

const access = new PosixCurrentUserAccessController(process.getuid?.())

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
      canReveal: true,
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
    await writeFile(path.join(paths.payloads, selector.payloadDirectory, 'worker.js'), 'corrupt')
    await assertMismatch()
    await deployer.deploy()
    await writeFile(paths.installState, '{"schemaVersion":1,"unexpected":true}')
    await assertMismatch()
    await deployer.deploy()
    await writeFile(paths.nativeHostExecutable, 'corrupt')
    await assertMismatch()
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
