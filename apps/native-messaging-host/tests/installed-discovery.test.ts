import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { InstalledRendezvousProvider, InstalledSecretProvider, resolveInstalledRelayPaths } from '../src/installed-discovery.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

async function deployment(): Promise<{ root: string; executable: string; rendezvous: string; authKey: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-native-discovery-'))
  roots.push(root)
  const executable = path.join(root, 'native-host', 'forge-external-chrome-native-host')
  const { rendezvous, authKey } = resolveInstalledRelayPaths(executable)
  await mkdir(path.dirname(executable), { recursive: true, mode: 0o700 })
  await mkdir(path.dirname(rendezvous), { recursive: true, mode: 0o700 })
  await mkdir(path.dirname(authKey), { recursive: true, mode: 0o700 })
  return { root, executable, rendezvous, authKey }
}

describe('installed native relay discovery', () => {
  it('derives only Forge deployment siblings and validates a matching bounded key', async () => {
    const files = await deployment()
    const key = Buffer.alloc(32, 7)
    const keyId = `key-${createHash('sha256').update(key).digest('base64url').slice(0, 24)}`
    await writeFile(files.authKey, `${key.toString('base64')}\n`, { mode: 0o600 })
    await writeFile(files.rendezvous, JSON.stringify({ marker: true }), { mode: 0o600 })
    expect(resolveInstalledRelayPaths(files.executable).integrationRoot).toBe(files.root)
    expect(await new InstalledSecretProvider(files.authKey).getSecret(keyId)).toEqual(key)
    expect(await new InstalledRendezvousProvider(files.rendezvous).read()).toEqual({ marker: true })
  })

  it('fails closed for an unexpected deployment layout, wrong key id, symlinks, and public permissions', async () => {
    expect(() => resolveInstalledRelayPaths('/tmp/not-forge/host')).toThrow(/deployment layout/u)
    const files = await deployment()
    const key = Buffer.alloc(32, 8)
    await writeFile(files.authKey, `${key.toString('base64')}\n`, { mode: 0o600 })
    await expect(new InstalledSecretProvider(files.authKey).getSecret('key-wrong')).rejects.toThrow(/does not match/u)

    const keyTarget = `${files.authKey}.target`
    await writeFile(keyTarget, `${key.toString('base64')}\n`, { mode: 0o600 })
    await rm(files.authKey)
    await symlink(keyTarget, files.authKey)
    await expect(new InstalledSecretProvider(files.authKey).getSecret('key-wrong')).rejects.toThrow(/regular file/u)

    const rendezvousTarget = `${files.rendezvous}.target`
    await writeFile(rendezvousTarget, JSON.stringify({ marker: true }), { mode: 0o600 })
    await symlink(rendezvousTarget, files.rendezvous)
    await expect(new InstalledRendezvousProvider(files.rendezvous).read()).rejects.toThrow(/regular file/u)

    await rm(files.authKey)
    await writeFile(files.authKey, `${key.toString('base64')}\n`, { mode: 0o600 })
    if (process.platform !== 'win32') {
      await chmod(files.authKey, 0o644)
      await expect(new InstalledSecretProvider(files.authKey).getSecret('key-wrong')).rejects.toThrow(/private/u)
    }
  })
})
