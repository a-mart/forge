import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EXTERNAL_CHROME_EXTENSION_ORIGIN, EXTERNAL_CHROME_NATIVE_HOST_NAME } from '@forge/protocol'
import { resolveExternalChromeDataPaths } from '../data-paths.js'
import { sha256 } from '../package-manifest.js'
import {
  DevelopmentExecutableTrustVerifier,
  PlatformExecutableTrustVerifier,
  PosixNativeRegistration,
  WindowsHashPinnedExecutableTrustVerifier,
  WindowsRegistryFacade,
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

  it('transfers only exact Forge-owned registration records between data roots', async () => {
    const firstDataRoot = await root()
    const secondDataRoot = await root()
    const registrationDirectory = path.join(await root(), 'shared', 'NativeMessagingHosts')
    await prepareExecutable(firstDataRoot, 'darwin')
    await prepareExecutable(secondDataRoot, 'darwin')
    const first = new PosixNativeRegistration({ platform: 'darwin', dataRoot: firstDataRoot, registrationDirectory, trustVerifier: trusted })
    const second = new PosixNativeRegistration({ platform: 'darwin', dataRoot: secondDataRoot, registrationDirectory, trustVerifier: trusted })
    await first.repair()
    const conflict = await second.inspect()
    expect(conflict).toMatchObject({
      registration: 'conflict',
      forgeConflict: { identity: expect.stringMatching(/^[a-f0-9]{64}$/u), dataDirHash: expect.stringMatching(/^[a-f0-9]{16}$/u) },
    })
    await expect(second.transferForgeOwnedConflict({ identity: '0'.repeat(64), dataDirHash: conflict.forgeConflict!.dataDirHash }))
      .rejects.toThrow(/stale/u)
    await expect(second.transferForgeOwnedConflict(conflict.forgeConflict!)).resolves.toMatchObject({
      registration: 'owned', completedForgeTransfer: conflict.forgeConflict,
    })
    // A restart retry after the global target moved is idempotent until normal
    // repair clears the durable transfer transaction.
    await expect(second.transferForgeOwnedConflict(conflict.forgeConflict!)).resolves.toMatchObject({
      registration: 'owned', completedForgeTransfer: conflict.forgeConflict,
    })
    expect(await second.repair()).toMatchObject({ registration: 'owned' })
    expect(await second.inspect()).not.toHaveProperty('completedForgeTransfer')
    expect(await first.inspect()).toMatchObject({ registration: 'conflict' })
    await expect(readFile(path.join(resolveExternalChromeDataPaths(firstDataRoot, 'darwin').state, 'registration.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('blocks a drifted global target even when an exact transfer transaction survives', async () => {
    const firstDataRoot = await root()
    const secondDataRoot = await root()
    const registrationDirectory = path.join(await root(), 'shared', 'NativeMessagingHosts')
    await prepareExecutable(firstDataRoot, 'darwin')
    await prepareExecutable(secondDataRoot, 'darwin')
    const first = new PosixNativeRegistration({ platform: 'darwin', dataRoot: firstDataRoot, registrationDirectory, trustVerifier: trusted })
    const second = new PosixNativeRegistration({ platform: 'darwin', dataRoot: secondDataRoot, registrationDirectory, trustVerifier: trusted })
    await first.repair()
    const conflict = (await second.inspect()).forgeConflict!
    await second.transferForgeOwnedConflict(conflict)
    await writeFile(path.join(registrationDirectory, `${EXTERNAL_CHROME_NATIVE_HOST_NAME}.json`), JSON.stringify({
      name: EXTERNAL_CHROME_NATIVE_HOST_NAME,
      description: 'foreign drift after transfer',
      path: '/foreign/host',
      type: 'stdio',
      allowed_origins: [EXTERNAL_CHROME_EXTENSION_ORIGIN],
    }))
    expect(await second.inspect()).toMatchObject({ registration: 'needs-repair' })
    expect(await second.inspect()).not.toHaveProperty('completedForgeTransfer')
    await expect(second.transferForgeOwnedConflict(conflict)).rejects.toThrow(/stale/u)
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

  it('trusts an unsigned development host only when it is a user-owned executable regular file', async () => {
    const dataRoot = await root()
    await prepareExecutable(dataRoot, 'darwin')
    const executable = resolveExternalChromeDataPaths(dataRoot, 'darwin').nativeHostExecutable
    const uid = process.getuid?.()
    const verifier = new DevelopmentExecutableTrustVerifier('darwin', uid)
    expect(await verifier.verify(executable)).toBe('trusted')
    await chmod(executable, 0o644)
    expect(await verifier.verify(executable)).toBe('untrusted')
    await chmod(executable, 0o755)
    if (uid !== undefined) {
      expect(await new DevelopmentExecutableTrustVerifier('darwin', uid + 1).verify(executable)).toBe('untrusted')
    }
    expect(await verifier.verify(`${executable}.missing`)).toBe('missing')
  })

  it('trusts an unsigned Windows release host only while its deployed SHA-256 stays pinned', async () => {
    const dataRoot = await root()
    await prepareExecutable(dataRoot, 'win32')
    const paths = resolveExternalChromeDataPaths(dataRoot, 'win32')
    await mkdir(paths.state, { recursive: true })
    await writeFile(paths.installState, JSON.stringify({ nativeSha256: sha256(await readFile(paths.nativeHostExecutable)) }))
    const verifier = new WindowsHashPinnedExecutableTrustVerifier(dataRoot)
    expect(await verifier.verify(paths.nativeHostExecutable)).toBe('trusted')
    await writeFile(paths.nativeHostExecutable, 'tampered')
    expect(await verifier.verify(paths.nativeHostExecutable)).toBe('untrusted')
    expect(await verifier.verify(`${paths.nativeHostExecutable}.other`)).toBe('untrusted')
  })

  it('confines unsigned Windows trust to the dev SEA executable policy', async () => {
    const dataRoot = await root()
    await prepareExecutable(dataRoot, 'win32')
    const executable = resolveExternalChromeDataPaths(dataRoot, 'win32').nativeHostExecutable
    const verifier = new DevelopmentExecutableTrustVerifier('win32')
    expect(await verifier.verify(executable)).toBe('trusted')
    await writeFile(`${executable}.cmd`, 'not a SEA executable')
    expect(await verifier.verify(`${executable}.cmd`)).toBe('untrusted')
    expect(await new PlatformExecutableTrustVerifier('win32', {
      run: async () => ({ stdout: 'NotSigned', stderr: '', exitCode: 0 }),
    }).verify(executable)).toBe('untrusted')
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

  it('passes Windows registry paths as literal arguments and escapes Authenticode PowerShell paths', async () => {
    const calls: Array<{ command: string; args: string[] }> = []
    const processFacade: NativeProcessFacade = {
      run: async (command, args) => {
        calls.push({ command, args })
        if (command === 'reg.exe' && args[0] === 'query') return { stdout: '    (Default)    REG_SZ    C:\\Forge Dev\\host.json\n', stderr: '', exitCode: 0 }
        if (command === 'powershell.exe') return { stdout: 'Valid\n', stderr: '', exitCode: 0 }
        return { stdout: '', stderr: '', exitCode: 0 }
      },
    }
    const key = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${EXTERNAL_CHROME_NATIVE_HOST_NAME}`
    const manifestPath = 'C:\\Forge Dev\\native-host-manifests\\host.json'
    const registry = new WindowsRegistryFacade(processFacade)
    await registry.writeDefault(key, manifestPath)
    await expect(registry.readDefault(key)).resolves.toBe('C:\\Forge Dev\\host.json')
    await registry.removeKey(key)
    expect(calls.slice(0, 3)).toEqual([
      { command: 'reg.exe', args: ['add', key, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'] },
      { command: 'reg.exe', args: ['query', key, '/ve'] },
      { command: 'reg.exe', args: ['delete', key, '/f'] },
    ])

    const executable = path.join(await root(), "host's validation.exe")
    await writeFile(executable, 'fixture')
    expect(await new PlatformExecutableTrustVerifier('win32', processFacade).verify(executable)).toBe('trusted')
    const authenticodeCall = calls.at(-1)!
    expect(authenticodeCall.command).toBe('powershell.exe')
    expect(authenticodeCall.args.at(-1)).toContain(`-LiteralPath '${executable.replaceAll("'", "''")}'`)
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
