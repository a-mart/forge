import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EXTERNAL_CHROME_EXTENSION_ORIGIN, EXTERNAL_CHROME_NATIVE_HOST_NAME } from '@forge/protocol'
import { resolveExternalChromeDataPaths } from '../data-paths.js'
import {
  PlatformExecutableTrustVerifier,
  PosixNativeRegistration,
  WindowsNativeRegistration,
  buildNativeHostManifest,
  type ExecutableTrustVerifier,
  type NativeProcessFacade,
  type RegistryFacade,
} from '../registration.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))
async function root(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), 'forge-external-registration-'))
  roots.push(value)
  return value
}
const trusted: ExecutableTrustVerifier = { verify: async () => 'trusted' }

async function prepareExecutable(dataRoot: string, platform: 'darwin' | 'win32'): Promise<void> {
  const executable = resolveExternalChromeDataPaths(dataRoot, platform).nativeHostExecutable
  await mkdir(path.dirname(executable), { recursive: true })
  await writeFile(executable, 'fixture', { mode: 0o755 })
}

describe('External Chrome native registration', () => {
  it('builds the exact pinned-origin Chrome manifest and owns POSIX repair/remove', async () => {
    const dataRoot = await root()
    const registrationDirectory = path.join(dataRoot, 'fake-chrome', 'NativeMessagingHosts')
    await prepareExecutable(dataRoot, 'darwin')
    const registration = new PosixNativeRegistration({ platform: 'darwin', dataRoot, registrationDirectory, trustVerifier: trusted })
    expect(await registration.inspect()).toMatchObject({ registration: 'not-registered', trust: 'trusted' })
    expect(await registration.repair()).toMatchObject({ registration: 'owned', trust: 'trusted' })

    const target = path.join(registrationDirectory, `${EXTERNAL_CHROME_NATIVE_HOST_NAME}.json`)
    const manifest = JSON.parse(await readFile(target, 'utf8')) as Record<string, unknown>
    expect(manifest).toEqual(buildNativeHostManifest(resolveExternalChromeDataPaths(dataRoot, 'darwin').nativeHostExecutable))
    expect(manifest.allowed_origins).toEqual([EXTERNAL_CHROME_EXTENSION_ORIGIN])
    expect(Object.keys(manifest).sort()).toEqual(['allowed_origins', 'description', 'name', 'path', 'type'])

    await writeFile(target, JSON.stringify({ ...manifest, allowed_origins: ['chrome-extension://wrong/'] }))
    expect(await registration.inspect()).toMatchObject({ registration: 'needs-repair' })
    await expect(registration.remove()).rejects.toThrow(/drifted/u)
    expect(await registration.repair()).toMatchObject({ registration: 'owned' })
    expect(await registration.remove()).toMatchObject({ registration: 'not-registered' })
  })

  it('refuses to overwrite an unowned registration target', async () => {
    const dataRoot = await root()
    const registrationDirectory = path.join(dataRoot, 'fake-chrome', 'NativeMessagingHosts')
    await mkdir(registrationDirectory, { recursive: true })
    await prepareExecutable(dataRoot, 'darwin')
    await writeFile(path.join(registrationDirectory, `${EXTERNAL_CHROME_NATIVE_HOST_NAME}.json`), JSON.stringify({
      name: EXTERNAL_CHROME_NATIVE_HOST_NAME,
      description: 'other',
      path: '/other/host',
      type: 'stdio',
      allowed_origins: [EXTERNAL_CHROME_EXTENSION_ORIGIN],
    }))
    const registration = new PosixNativeRegistration({ platform: 'darwin', dataRoot, registrationDirectory, trustVerifier: trusted })
    expect(await registration.inspect()).toMatchObject({ registration: 'conflict' })
    await expect(registration.repair()).rejects.toThrow(/another installation/u)
    await expect(registration.remove()).rejects.toThrow(/without Forge ownership/u)
  })

  it('reports deterministic platform signature states through an injected process facade', async () => {
    const dataRoot = await root()
    await prepareExecutable(dataRoot, 'darwin')
    const executable = resolveExternalChromeDataPaths(dataRoot, 'darwin').nativeHostExecutable
    const calls: string[] = []
    const processFacade: NativeProcessFacade = {
      run: async (command) => {
        calls.push(command)
        return { stdout: '', stderr: '', exitCode: command.endsWith('codesign') ? 0 : 1 }
      },
    }
    expect(await new PlatformExecutableTrustVerifier('darwin', processFacade).verify(executable)).toBe('untrusted')
    expect(calls).toEqual(['/usr/bin/codesign', '/usr/sbin/spctl'])
    expect(await new PlatformExecutableTrustVerifier('linux', processFacade).verify(executable)).toBe('unsupported')
  })

  it('uses a current-user Windows registry pointer to the Forge-owned canonical manifest', async () => {
    const dataRoot = await root()
    await prepareExecutable(dataRoot, 'win32')
    class FakeRegistry implements RegistryFacade {
      values = new Map<string, string>()
      readDefault(key: string): Promise<string | null> { return Promise.resolve(this.values.get(key) ?? null) }
      writeDefault(key: string, value: string): Promise<void> { this.values.set(key, value); return Promise.resolve() }
      removeKey(key: string): Promise<void> { this.values.delete(key); return Promise.resolve() }
    }
    const registry = new FakeRegistry()
    const registration = new WindowsNativeRegistration({ dataRoot, registry, trustVerifier: trusted })
    expect(await registration.repair()).toMatchObject({ registration: 'owned' })
    expect([...registry.values.keys()]).toEqual([`HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${EXTERNAL_CHROME_NATIVE_HOST_NAME}`])
    expect([...registry.values.values()]).toEqual([
      path.join(resolveExternalChromeDataPaths(dataRoot, 'win32').nativeHostManifests, `${EXTERNAL_CHROME_NATIVE_HOST_NAME}.json`),
    ])
    expect(await registration.remove()).toMatchObject({ registration: 'not-registered' })
  })
})
