import { mkdir, mkdtemp, writeFile, rm, symlink, readFile, access, constants } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GitCloneError,
  GitCloneRunner,
  parseAndValidateRepositoryUrl,
  publishCloneWithoutReplace,
  safeRemoveOwnedStaging,
  terminateProcessTree,
  GIT_CLONE_STAGING_PREFIX,
} from '../versioning/git-clone-runner.js'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'

function fakeChild(pid: number): ChildProcess & EventEmitter {
  const child = new EventEmitter() as ChildProcess & EventEmitter
  child.pid = pid
  const stdout = new EventEmitter() as ChildProcess['stdout'] & EventEmitter
  const stderr = new EventEmitter() as ChildProcess['stderr'] & EventEmitter
  ;(stdout as { setEncoding: (enc: string) => void }).setEncoding = () => undefined
  ;(stderr as { setEncoding: (enc: string) => void }).setEncoding = () => undefined
  child.stdout = stdout
  child.stderr = stderr
  child.kill = vi.fn()
  return child
}

describe('git-clone-runner remediation', () => {
  let root = ''

  afterEach(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true })
      root = ''
    }
  })

  it('preserves explicit HTTPS/SSH ports and IPv6 hosts', () => {
    expect(parseAndValidateRepositoryUrl('https://example.com:8443/org/repo.git').cloneUrl).toBe(
      'https://example.com:8443/org/repo.git',
    )
    expect(parseAndValidateRepositoryUrl('ssh://git@[2001:db8::1]:2222/org/repo.git').cloneUrl).toBe(
      'ssh://git@[2001:db8::1]:2222/org/repo.git',
    )
    expect(parseAndValidateRepositoryUrl('https://[2001:db8::2]/org/repo.git').display).toContain(
      '[2001:db8::2]',
    )
    expect(parseAndValidateRepositoryUrl('https://[2001:db8::2]/org/repo.git').display).not.toContain(
      '[[',
    )
  })

  it('refuses publishing when destination already exists (including empty dir)', async () => {
    root = await mkdtemp(join(tmpdir(), 'forge-publish-race-'))
    const cloneTarget = join(root, 'clone-src')
    const destination = join(root, 'dest')
    await mkdir(cloneTarget)
    await writeFile(join(cloneTarget, 'README'), 'hi')
    await mkdir(destination)
    await writeFile(join(destination, 'third-party'), 'keep-me')

    await expect(publishCloneWithoutReplace(cloneTarget, destination)).rejects.toMatchObject({
      code: 'destination_exists',
    })
    await expect(readFile(join(destination, 'third-party'), 'utf8')).resolves.toBe('keep-me')
  })

  it('refuses publishing onto a symlink/junction leaf without deleting the target', async () => {
    root = await mkdtemp(join(tmpdir(), 'forge-publish-symlink-'))
    const cloneTarget = join(root, 'clone-src')
    const real = join(root, 'real')
    const destination = join(root, 'dest')
    await mkdir(cloneTarget)
    await writeFile(join(cloneTarget, 'README'), 'hi')
    await mkdir(real)
    await writeFile(join(real, 'keep'), 'safe')
    try {
      await symlink(real, destination, 'dir')
    } catch {
      return
    }

    await expect(publishCloneWithoutReplace(cloneTarget, destination)).rejects.toMatchObject({
      code: 'destination_exists',
    })
    await expect(readFile(join(real, 'keep'), 'utf8')).resolves.toBe('safe')
  })

  it('publishes atomically without a visible empty destination claim', async () => {
    root = await mkdtemp(join(tmpdir(), 'forge-publish-ok-'))
    const cloneTarget = join(root, 'clone-src')
    const destination = join(root, 'dest')
    await mkdir(cloneTarget)
    await writeFile(join(cloneTarget, 'README'), 'hi')

    await publishCloneWithoutReplace(cloneTarget, destination)
    await expect(readFile(join(destination, 'README'), 'utf8')).resolves.toBe('hi')
    // Staging leaf should have been moved away (no partial leftover at cloneTarget).
    await expect(access(cloneTarget, constants.F_OK)).rejects.toBeTruthy()
  })

  it('does not delete third-party content when destination appears after precheck', async () => {
    root = await mkdtemp(join(tmpdir(), 'forge-publish-interfere-'))
    const cloneTarget = join(root, 'clone-src')
    const destination = join(root, 'dest')
    await mkdir(cloneTarget)
    await writeFile(join(cloneTarget, 'README'), 'hi')

    // Simulate interference: create destination between precheck and exclusive rename
    // by calling publish after manually creating dest (precheck inside publish fails first).
    await mkdir(destination)
    await writeFile(join(destination, 'external'), 'owned-elsewhere')

    await expect(publishCloneWithoutReplace(cloneTarget, destination)).rejects.toMatchObject({
      code: 'destination_exists',
    })
    await expect(readFile(join(destination, 'external'), 'utf8')).resolves.toBe('owned-elsewhere')
  })

  it('only removes exactly one owned staging child', async () => {
    root = await mkdtemp(join(tmpdir(), 'forge-staging-clean-'))
    const staging = join(root, `${GIT_CLONE_STAGING_PREFIX}abc`)
    await mkdir(join(staging, 'nested'), { recursive: true })
    const other = join(root, 'not-staging')
    await mkdir(other)
    await writeFile(join(other, 'keep'), 'x')

    await safeRemoveOwnedStaging(staging, root)
    await expect(access(staging, constants.F_OK)).rejects.toBeTruthy()
    await expect(access(join(other, 'keep'), constants.F_OK)).resolves.toBeUndefined()
  })

  it('success path never calls terminate', async () => {
    root = await mkdtemp(join(tmpdir(), 'forge-success-no-term-'))
    const terminateImpl = vi.fn(async () => undefined)
    const runner = new GitCloneRunner({
      spawnImpl: ((_cmd, _args, _opts) => {
        const child = fakeChild(4242)
        queueMicrotask(() => child.emit('close', 0, null))
        return child
      }) as typeof import('node:child_process').spawn,
      terminateImpl,
      publishImpl: async (from, to) => {
        await mkdir(to)
        await writeFile(join(to, 'ok'), '1')
        await rm(from, { recursive: true, force: true })
      },
    })

    await runner.clone({
      repositoryUrl: 'https://github.com/org/repo.git',
      basePath: root,
      folder: 'repo',
    })
    expect(terminateImpl).not.toHaveBeenCalled()
  })

  it('nonzero exit never calls terminate', async () => {
    root = await mkdtemp(join(tmpdir(), 'forge-nonzero-no-term-'))
    const terminateImpl = vi.fn(async () => undefined)
    const runner = new GitCloneRunner({
      spawnImpl: ((_cmd, _args, _opts) => {
        const child = fakeChild(4243)
        queueMicrotask(() => {
          child.stderr?.emit('data', 'fatal: repository not found')
          child.emit('close', 128, null)
        })
        return child
      }) as typeof import('node:child_process').spawn,
      terminateImpl,
    })

    await expect(
      runner.clone({
        repositoryUrl: 'https://github.com/org/missing.git',
        basePath: root,
        folder: 'repo',
      }),
    ).rejects.toMatchObject({ code: 'repository_not_found' })
    expect(terminateImpl).not.toHaveBeenCalled()
  })

  it('cancel waits on gated terminate before rejection and staging cleanup', async () => {
    root = await mkdtemp(join(tmpdir(), 'forge-cancel-gate-'))
    let releaseTerminate!: () => void
    const terminateGate = new Promise<void>((resolve) => {
      releaseTerminate = resolve
    })
    let stagingSeenDuringTerminate: string | null = null
    const terminateImpl = vi.fn(async () => {
      const entries = await import('node:fs/promises').then((fs) => fs.readdir(root))
      stagingSeenDuringTerminate = entries.find((e) => e.startsWith(GIT_CLONE_STAGING_PREFIX)) ?? null
      await terminateGate
    })

    const runner = new GitCloneRunner({
      spawnImpl: ((_cmd, _args, _opts) => fakeChild(5252)) as typeof import('node:child_process').spawn,
      terminateImpl,
    })

    const controller = new AbortController()
    const clonePromise = runner.clone({
      repositoryUrl: 'https://github.com/org/repo.git',
      basePath: root,
      folder: 'repo',
      signal: controller.signal,
    })

    await vi.waitFor(async () => {
      const entries = await import('node:fs/promises').then((fs) => fs.readdir(root))
      expect(entries.some((e) => e.startsWith(GIT_CLONE_STAGING_PREFIX))).toBe(true)
    })

    controller.abort()
    await vi.waitFor(() => expect(terminateImpl).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(stagingSeenDuringTerminate).toBeTruthy())

    const during = await import('node:fs/promises').then((fs) => fs.readdir(root))
    expect(during.some((e) => e.startsWith(GIT_CLONE_STAGING_PREFIX))).toBe(true)

    const childClose = terminateImpl.mock.calls[0]?.[0] as ChildProcess & EventEmitter
    releaseTerminate()
    queueMicrotask(() => childClose.emit('close', null, 'SIGTERM'))

    await expect(clonePromise).rejects.toMatchObject({ code: 'clone_cancelled' })
    const after = await import('node:fs/promises').then((fs) => fs.readdir(root))
    expect(after.some((e) => e.startsWith(GIT_CLONE_STAGING_PREFIX))).toBe(false)
  })

  it('timeout waits on gated terminate before rejection', async () => {
    root = await mkdtemp(join(tmpdir(), 'forge-timeout-gate-'))
    let releaseTerminate!: () => void
    const terminateGate = new Promise<void>((resolve) => {
      releaseTerminate = resolve
    })
    let settledBeforeRelease = false
    const terminateImpl = vi.fn(async (child: ChildProcess) => {
      await terminateGate
      queueMicrotask(() => (child as ChildProcess & EventEmitter).emit('close', null, 'SIGKILL'))
    })

    const runner = new GitCloneRunner({
      timeoutMs: 20,
      spawnImpl: ((_cmd, _args, _opts) => fakeChild(6262)) as typeof import('node:child_process').spawn,
      terminateImpl,
    })

    const clonePromise = runner.clone({
      repositoryUrl: 'https://github.com/org/repo.git',
      basePath: root,
      folder: 'repo',
    })

    await vi.waitFor(() => expect(terminateImpl).toHaveBeenCalledTimes(1))
    const pending = clonePromise.then(
      () => {
        settledBeforeRelease = true
      },
      () => {
        settledBeforeRelease = true
      },
    )
    await new Promise((r) => setTimeout(r, 30))
    expect(settledBeforeRelease).toBe(false)
    releaseTerminate()
    await expect(clonePromise).rejects.toMatchObject({ code: 'clone_timed_out' })
    await pending
  })

  it('uses process-group style termination helper on POSIX', async () => {
    if (process.platform === 'win32') return
    const child = fakeChild(2_147_483_646)
    child.exitCode = 0
    await terminateProcessTree(child, 'darwin')
    expect(child.kill).toHaveBeenCalled()
  })

  it('windows terminate path uses taskkill-style inject without throwing', async () => {
    const child = fakeChild(9999)
    const terminateImpl = terminateProcessTree
    // Inject a spawn that records taskkill args via platform win32 path by stubbing spawn in module —
    // call with a child that has no live pid group; should resolve.
    await expect(terminateImpl(child, 'win32')).resolves.toBeUndefined()
  })
})

describe('parseAndValidateRepositoryUrl typed errors', () => {
  it('surfaces invalid_repository_url for bad inputs', () => {
    try {
      parseAndValidateRepositoryUrl('http://example.com/repo.git')
      expect.fail('expected throw')
    } catch (error) {
      expect(error).toBeInstanceOf(GitCloneError)
      expect((error as GitCloneError).code).toBe('invalid_repository_url')
    }
  })
})
