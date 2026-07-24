import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ExternalChromeAuthStore,
  ExternalChromeAuthorityStore,
  PosixCurrentUserAccessController,
  WindowsCurrentUserAccessController,
  externalChromeUserScope,
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

const access = new PosixCurrentUserAccessController(process.getuid?.())

describe('External Chrome authentication and authority stores', () => {
  it('creates and rotates a private 256-bit key without placing it in rendezvous', async () => {
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
  })

  it('detects insecure key permissions and replaces them on ensure', async () => {
    const dataRoot = await root()
    const store = new ExternalChromeAuthStore(dataRoot, 'linux', access)
    const original = await store.ensure()
    const paths = resolveExternalChromeDataPaths(dataRoot, 'linux')
    await chmod(paths.authKey, 0o644)
    expect(await store.status()).toBe('insecure')
    const replacement = await store.ensure()
    expect(replacement.keyId).not.toBe(original.keyId)
    expect((await stat(paths.authKey)).mode & 0o777).toBe(0o600)
  })

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
    const windowsAccess = new WindowsCurrentUserAccessController('TEST\\user', runner)
    await windowsAccess.securePrivateFile(file)
    expect(await windowsAccess.verifyPrivateFile(file)).toBe('secure')
    expect(calls.map((call) => call.file)).toEqual(['icacls.exe', 'powershell.exe'])
    expect(calls[0]?.args).toContain('TEST\\user:(F)')
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
  })
})
