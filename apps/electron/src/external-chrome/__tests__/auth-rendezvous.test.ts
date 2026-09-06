import { chmod, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ExternalChromeAuthStore,
  ExternalChromeAuthorityStore,
  createCurrentUserAccessController,
  WindowsCurrentUserAccessController,
  externalChromeUserScope,
  type CurrentUserAccessController,
  type ExternalCommandRunner,
} from '../auth-rendezvous.js'
import { resolveExternalChromeDataPaths } from '../data-paths.js'

const roots: string[] = []
afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function root(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), 'forge-external-auth-'))
  roots.push(value)
  return value
}

const access = createCurrentUserAccessController(process.platform)

describe('External Chrome authentication and authority stores', () => {
  it.skipIf(process.platform === 'win32')('creates and rotates a private 256-bit key without placing it in rendezvous', async () => {
    const dataRoot = await root()
    const store = new ExternalChromeAuthStore(dataRoot, 'darwin', access)
    const first = await store.ensure()
    expect(first.key).toHaveLength(32)
    expect(first.created).toBe(true)
    const paths = resolveExternalChromeDataPaths(dataRoot, 'darwin')
    expect((await stat(paths.authKey)).mode & 0o777).toBe(0o600)
    expect(await store.status()).toBe('secure')

    const second = await store.rotate()
    expect(second.keyId).not.toBe(first.keyId)
    expect(Buffer.from(second.key).toString('base64')).toBe((await readFile(paths.authKey, 'utf8')).trim())
    first.key.fill(0)
    second.key.fill(0)
  }, 60_000)

  it.skipIf(process.platform === 'win32')('detects insecure key permissions and replaces them on ensure', async () => {
    const dataRoot = await root()
    const store = new ExternalChromeAuthStore(dataRoot, 'linux', access)
    const original = await store.ensure()
    const paths = resolveExternalChromeDataPaths(dataRoot, 'linux')
    await chmod(paths.authKey, 0o644)
    expect(await store.status()).toBe('insecure')
    const replacement = await store.ensure()
    expect(replacement.keyId).not.toBe(original.keyId)
    expect((await stat(paths.authKey)).mode & 0o777).toBe(0o600)
  }, 60_000)

  it('isolates Windows ACL commands behind the current-user facade and verifies the protected ACL result', async () => {
    const dataRoot = await root()
    const file = path.join(dataRoot, 'secret.key')
    await writeFile(file, 'fixture')
    const calls: Array<{ file: string; args: string[] }> = []
    const runner: ExternalCommandRunner = {
      run: async (command, args) => {
        calls.push({ file: command, args })
        return command === 'powershell.exe' ? 'secure\n' : ''
      },
    }
    const windowsAccess = new WindowsCurrentUserAccessController(runner)
    await windowsAccess.securePrivateFile(file)
    await windowsAccess.preparePrivateDirectory(path.join(dataRoot, "owner's metadata [1]"))
    expect(await windowsAccess.verifyPrivateFile(file)).toBe('secure')
    expect(calls.map((call) => call.file)).toEqual(['powershell.exe', 'powershell.exe', 'powershell.exe'])
    const fileScript = calls[0]!.args.at(-1)!
    expect(fileScript).toContain('WindowsIdentity]::GetCurrent().User')
    expect(fileScript).toContain('New-Object System.Security.AccessControl.FileSecurity')
    expect(fileScript).toContain('$private.SetAccessRuleProtection($true,$false)')
    expect(fileScript).toContain("($me,'FullControl','None','None','Allow')")
    expect(fileScript).not.toContain('TEST\\user')
    expect(calls[1]!.args.at(-1)).toContain("owner''s metadata [1]")
    expect(calls[1]!.args.at(-1)).toContain("'ContainerInherit, ObjectInherit'")
    const verification = calls[2]!.args.at(-1)!
    expect(verification).toContain('$allowed -notcontains $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value')
    expect(verification).toContain("$allowed=@($me.Value,'S-1-5-18','S-1-5-32-544')")
    expect(verification).toContain('($_.FileSystemRights -band $full) -eq $full')
    expect(verification).not.toContain('Set-Acl')
  }, 60_000)

  it('fails closed on unavailable ACL tooling without confusing it with a missing file', async () => {
    const file = path.join(await root(), 'fixture')
    await writeFile(file, 'fixture')
    const windowsAccess = new WindowsCurrentUserAccessController({
      run: async () => { throw Object.assign(new Error('tool unavailable'), { code: 'ENOENT' }) },
    })
    expect(await windowsAccess.verifyPrivateFile(file)).toBe('insecure')
    expect(await windowsAccess.verifyPrivateFile(`${file}.absent`)).toBe('missing')
    await expect(windowsAccess.securePrivateFile(file)).rejects.toThrow('Check folder ownership and Windows security policy')
  }, 60_000)

  it('secures and verifies empty temporary files before writing or publishing credentials', async () => {
    const dataRoot = await root()
    const paths = resolveExternalChromeDataPaths(dataRoot, process.platform)
    const observed: string[] = []
    let rejectVerification = false
    const checkedAccess: CurrentUserAccessController = {
      preparePrivateDirectory: (directory) => access.preparePrivateDirectory(directory),
      securePrivateFile: async (file, prepareDirectory) => {
        expect(file).toContain('.new-')
        expect((await stat(file)).size).toBe(0)
        expect(prepareDirectory).toBe(true)
        observed.push(file)
        // securePrivateFile's contract includes verification, not just mutation.
        await access.securePrivateFile(file, prepareDirectory)
        if (rejectVerification) throw new Error('fixture permissions could not be verified')
      },
      verifyPrivateFile: (file) => access.verifyPrivateFile(file),
    }
    const store = new ExternalChromeAuthStore(dataRoot, process.platform, checkedAccess)
    const first = await store.ensure()
    const restarted = new ExternalChromeAuthStore(dataRoot, process.platform, checkedAccess)
    const retained = await restarted.ensure()
    expect(retained.created).toBe(false)
    expect(retained.keyId).toBe(first.keyId)
    rejectVerification = true
    await expect(restarted.rotate()).rejects.toThrow('permissions could not be verified')
    expect(await restarted.status()).toBe('secure')
    expect(await readdir(paths.auth)).toEqual([path.basename(paths.authKey)])
    expect(observed).toHaveLength(2)
    first.key.fill(0)
    retained.key.fill(0)
  }, 60_000)

  it('cleans failed initial key and authority writes and permits retry', async () => {
    const dataRoot = await root()
    let fail = true
    const failingAccess: CurrentUserAccessController = {
      preparePrivateDirectory: (directory) => access.preparePrivateDirectory(directory),
      securePrivateFile: async (file, prepareDirectory) => {
        if (fail) throw new Error('fixture ACL failure')
        await access.securePrivateFile(file, prepareDirectory)
      },
      verifyPrivateFile: (file) => access.verifyPrivateFile(file),
    }
    const keyStore = new ExternalChromeAuthStore(dataRoot, process.platform, failingAccess)
    const owner = new ExternalChromeAuthorityStore(dataRoot, process.platform, 'desktop_first_123', 101, failingAccess)
    await expect(keyStore.ensure()).rejects.toThrow('fixture ACL failure')
    expect(await keyStore.status()).toBe('missing')
    await expect(owner.claim(new Date(Date.now() + 10_000).toISOString())).rejects.toThrow('fixture ACL failure')
    expect(await owner.inspect()).toEqual({ state: 'none' })
    const paths = resolveExternalChromeDataPaths(dataRoot, process.platform)
    expect(await readdir(paths.auth)).toEqual([])
    expect(await readdir(paths.run)).toEqual([])
    fail = false
    const key = await keyStore.ensure()
    key.key.fill(0)
    expect((await owner.claim(new Date(Date.now() + 10_000).toISOString())).state).toBe('owned')
  }, 60_000)

  it.each([false, true])('keeps competing complete claims exclusive while ACL setup is paused (failure=%s)', async (fail) => {
    const dataRoot = await root()
    let release!: () => void
    let started!: () => void
    const paused = new Promise<void>((resolve) => { started = resolve })
    const resume = new Promise<void>((resolve) => { release = resolve })
    const slowAccess: CurrentUserAccessController = {
      preparePrivateDirectory: (directory) => access.preparePrivateDirectory(directory),
      securePrivateFile: async (file, prepareDirectory) => {
        started()
        await resume
        if (fail) throw new Error('fixture delayed ACL failure')
        await access.securePrivateFile(file, prepareDirectory)
      },
      verifyPrivateFile: (file) => access.verifyPrivateFile(file),
    }
    const first = new ExternalChromeAuthorityStore(dataRoot, process.platform, 'desktop_first_123', 101, slowAccess, () => true, () => 1_000)
    const second = new ExternalChromeAuthorityStore(dataRoot, process.platform, 'desktop_second_12', 202, access, () => true, () => 1_000)
    const claiming = first.claim(new Date(10_000).toISOString())
    const result = claiming.catch((error: Error) => error)
    await paused
    try {
      // An incomplete first claim is never exposed at the canonical pathname.
      expect(await second.inspect()).toEqual({ state: 'none' })
      expect((await second.claim(new Date(10_000).toISOString())).state).toBe('owned')
    } finally {
      release()
    }
    if (fail) expect(await result).toMatchObject({ message: 'fixture delayed ACL failure' })
    else expect(await result).toMatchObject({ state: 'other-live', owner: { desktopPid: 202 } })
    expect(await second.inspect()).toMatchObject({ state: 'owned', owner: { desktopPid: 202 } })
    expect(await readdir(path.dirname(second.authorityPath))).toEqual(['authority.json'])
  }, 60_000)

  it('bounds each Windows refresh/publish cycle to two ACL processes with directory and inode verification in each', async () => {
    const dataRoot = await root()
    const scripts: string[] = []
    let verified = true
    const windowsAccess = new WindowsCurrentUserAccessController({ run: async (_command, args) => {
      scripts.push(args.at(-1)!)
      return verified ? 'secure' : 'insecure'
    } })
    const owner = new ExternalChromeAuthorityStore(dataRoot, 'win32', 'desktop_first_123', 101, windowsAccess, () => true, () => 1_000)
    await owner.claim(new Date(10_000).toISOString())
    const document = {
      schemaVersion: 1 as const, endpoint: 'fixture-pipe', epoch: 'epoch_1234567890abcdef',
      expiresAt: new Date(10_000).toISOString(), keyId: 'key-fixture', userScope: 'user-fixture',
      desktopInstanceId: 'desktop_first_123', desktopPid: 101, protocolMin: 1, protocolMax: 1,
    }
    for (let index = 0; index < 3; index += 1) {
      scripts.length = 0
      await owner.refresh(document.expiresAt)
      await owner.publish(document)
      expect(scripts).toHaveLength(2)
      for (const script of scripts) {
        expect(script).toContain('New-Object System.Security.AccessControl.DirectorySecurity')
        expect(script).toContain('New-Object System.Security.AccessControl.FileSecurity')
        expect(script.match(/\$acl=Get-Acl/g)).toHaveLength(4)
        expect(script.match(/if \(-not \$acl.AreAccessRulesProtected/g)).toHaveLength(2)
      }
    }
    verified = false
    await expect(owner.publish({ ...document, epoch: 'replacement_must_not_publish' })).rejects.toThrow('private Windows permissions')
    expect(await owner.readRendezvous()).toEqual(document)
    expect((await readdir(path.dirname(owner.rendezvousPath))).sort()).toEqual(['authority.json', 'rendezvous.json'])
  })

  it('enforces one live Desktop authority and permits deterministic stale takeover', async () => {
    const dataRoot = await root()
    let firstAlive = true
    const first = new ExternalChromeAuthorityStore(
      dataRoot, 'linux', 'desktop_first_123', 101, access, (pid) => pid === 101 && firstAlive, () => 1_000,
    )
    const second = new ExternalChromeAuthorityStore(
      dataRoot, 'linux', 'desktop_second_12', 202, access, (pid) => pid === 101 && firstAlive, () => 1_000,
    )
    expect((await first.claim(new Date(10_000).toISOString())).state).toBe('owned')
    expect((await second.claim(new Date(10_000).toISOString())).state).toBe('other-live')
    firstAlive = false
    expect((await second.inspect()).state).toBe('stale')
    expect((await second.claim(new Date(20_000).toISOString())).state).toBe('owned')

    await second.publish({
      schemaVersion: 1,
      endpoint: '/tmp/forge-test.sock',
      epoch: 'epoch_1234567890abcdef',
      expiresAt: new Date(20_000).toISOString(),
      keyId: 'key-test',
      userScope: externalChromeUserScope('linux', 'tester', 501),
      desktopInstanceId: 'desktop_second_12',
      desktopPid: 202,
      protocolMin: 1,
      protocolMax: 1,
    })
    const rendezvous = await second.readRendezvous()
    expect(rendezvous).toMatchObject({ desktopPid: 202, protocolMin: 1, protocolMax: 1 })
    expect(JSON.stringify(rendezvous)).not.toContain('secret')
    expect(JSON.stringify(rendezvous)).not.toContain('base64')
    for (let index = 0; index < 3; index += 1) {
      await second.refresh(new Date(20_000 + index).toISOString())
      await second.publish({ ...rendezvous!, epoch: `epoch_1234567890abcdef_${index}` })
      expect(await access.verifyPrivateFile(second.authorityPath)).toBe('secure')
      expect(await access.verifyPrivateFile(second.rendezvousPath)).toBe('secure')
      expect((await second.readRendezvous())?.epoch).toBe(`epoch_1234567890abcdef_${index}`)
    }
    expect((await readdir(path.dirname(second.rendezvousPath))).sort()).toEqual(['authority.json', 'rendezvous.json'])
  }, 60_000)
})
