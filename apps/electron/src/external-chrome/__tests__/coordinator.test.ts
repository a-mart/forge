import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ExternalChromeHostCoordinator } from '../coordinator.js'
import { PosixCurrentUserAccessController } from '../auth-rendezvous.js'
import { resolveExternalChromeDataPaths } from '../data-paths.js'
import type { ExternalChromeEndpointAuthority, ExternalChromeEndpointHandle } from '../endpoint.js'
import type { ExternalChromeNativeRegistration, NativeRegistrationInspection } from '../registration.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))
async function root(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), 'forge-external-coordinator-'))
  roots.push(value)
  return value
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
    const dataRoot = await root()
    const registration = new FakeRegistration()
    const firstEndpoints = new FakeEndpoints()
    const alive = (pid: number): boolean => pid === 101 || pid === 202
    const first = new ExternalChromeHostCoordinator({
      dataRoot, platform: 'linux', pid: 101, username: 'tester', uid: 501,
      instanceId: 'desktop_first_123', access, endpoints: firstEndpoints, registration, isProcessAlive: alive,
    })
    const second = new ExternalChromeHostCoordinator({
      dataRoot, platform: 'linux', pid: 202, username: 'tester', uid: 501,
      instanceId: 'desktop_second_12', access, endpoints: new FakeEndpoints(), registration, isProcessAlive: alive,
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
    const dataRoot = await root()
    const registration = new FakeRegistration()
    const endpoints = new FakeEndpoints()
    const coordinator = new ExternalChromeHostCoordinator({
      dataRoot, platform: 'linux', pid: 303, username: 'tester', uid: 501,
      instanceId: 'desktop_third_123', access, endpoints, registration, isProcessAlive: () => false,
    })
    expect(await coordinator.repair()).toMatchObject({ state: 'disabled', auth: 'secure', registration: 'owned' })
    expect(registration.repairs).toBe(1)
    await coordinator.enable()
    expect(await coordinator.remove()).toMatchObject({ state: 'disabled', auth: 'missing', registration: 'not-registered' })
    expect(registration.removes).toBe(1)
    expect(endpoints.handles[0]?.closed).toBe(true)
  })

  it('queues updater quiesce behind an in-progress enable and closes the newly opened endpoint', async () => {
    const dataRoot = await root()
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
      instanceId: 'desktop_fifth_123', access, endpoints, registration, isProcessAlive: () => false,
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

  it('fails closed when executable trust is missing', async () => {
    const dataRoot = await root()
    const registration = new FakeRegistration()
    registration.trust = 'missing'
    const coordinator = new ExternalChromeHostCoordinator({
      dataRoot, platform: 'linux', pid: 404, username: 'tester', uid: 501,
      instanceId: 'desktop_fourth_12', access, endpoints: new FakeEndpoints(), registration, isProcessAlive: () => false,
    })
    await expect(coordinator.enable()).rejects.toThrow(/not trusted/u)
    expect(await coordinator.status()).toMatchObject({ state: 'disabled', authority: 'none', canEnable: false })
  })
})
