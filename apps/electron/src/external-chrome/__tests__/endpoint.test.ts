import { mkdtemp, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PosixCurrentUserAccessController } from '../auth-rendezvous.js'
import { NodeExternalChromeEndpointAuthority, endpointName } from '../endpoint.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

describe('External Chrome local endpoint authority', () => {
  it('uses per-launch pipe names with no TCP surface', () => {
    const first = endpointName({ runDirectory: '/tmp/forge', platform: 'win32', userScope: 'user_1234567890abcdef', epoch: 'epoch_1234567890abcdef' })
    const second = endpointName({ runDirectory: '/tmp/forge', platform: 'win32', userScope: 'user_1234567890abcdef', epoch: 'epoch_fedcba0987654321' })
    expect(first).toMatch(/^\\\\\.\\pipe\\forge-external-chrome-/u)
    expect(second).not.toBe(first)
    expect(first).not.toContain('://')
  })

  it('binds a private per-launch POSIX socket before publishing it', async () => {
    const runDirectory = await mkdtemp(path.join(os.tmpdir(), 'forge-external-endpoint-'))
    roots.push(runDirectory)
    const authority = new NodeExternalChromeEndpointAuthority(new PosixCurrentUserAccessController(process.getuid?.()))
    const handle = await authority.listen({
      runDirectory,
      platform: 'linux',
      userScope: 'user_1234567890abcdef',
      epoch: 'epoch_1234567890abcdef',
    })
    expect(handle.endpoint).toMatch(/\.sock$/u)
    expect(handle.accessPosture).toBe('posix-mode-0600')
    expect((await stat(handle.endpoint)).mode & 0o777).toBe(0o600)
    await handle.close()
    await expect(stat(handle.endpoint)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
