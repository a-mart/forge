import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExternalChromeDeployer, FileDeploymentLock, type DeployerFileSystem, type DeploymentPhase } from '../deployer.js'
import { resolveExternalChromeDataPaths } from '../data-paths.js'
import { EXTERNAL_CHROME_EXTENSION_ID, EXTERNAL_CHROME_PUBLIC_KEY_SHA256, sha256 } from '../package-manifest.js'

const roots: string[] = []
const publicKey = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAoXYQaeqXPEqEz9pYFXGrV9qijfHvEuVdzt/1KGGvwy9HzyYMFv5e3tJUGpCGmo8Zxnzkbx0n/vjVRa6UPRPRMh/k2SxeF3QR0J1Ck2W69XtilMT0yGrgRmIrZ0oE0vJ7U6NEV1sN+z+rfWo8ue4SlTLBUHx9ZJ9BB++8IXKnwbLul/EOuFRdfTam+CAr8iqmTZzhp2P6TDCbYUwNln/nisLjvIVIs9nU/lFyqLid7LXfV2ax4ObSpYNyp2AjSsWczVEEFtp69CLTAFxVncczmlZQ9sXlIwArt1SVgsVK0wIbTeyAjcJ+GF9rAOQmzE9XCmncqhp0/U8NAR7Z4lT0ywIDAQAB'

function treeSha256(files: Record<string, Buffer>): string {
  const hash = createHash('sha256')
  for (const relative of Object.keys(files).sort()) {
    const bytes = files[relative]!
    hash.update(`${relative}\0${bytes.byteLength}\0`)
    hash.update(bytes)
  }
  return hash.digest('hex')
}

async function fixture(
  version = '1.0.0',
  payloadText = `payload-${version}`,
  platform: NodeJS.Platform = process.platform,
  arch = process.arch,
  shellText = 'shell',
  nativeText = `native-${version}`,
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-external-deploy-'))
  roots.push(root)
  const dataRoot = path.join(root, 'custom-forge-data')
  const resourcesRoot = path.join(root, 'resources')
  const shellFiles: Record<string, string> = {}
  const payloadFiles: Record<string, string> = {}
  const manifestJson = `${JSON.stringify({ manifest_version: 3, key: publicKey })}\n`
  const shell = `${shellText}\n`
  const payload = `${payloadText}\n`
  const native = Buffer.from(nativeText)
  shellFiles['manifest.json'] = sha256(Buffer.from(manifestJson))
  shellFiles['shell/bootstrap.js'] = sha256(Buffer.from(shell))
  payloadFiles['worker.js'] = sha256(Buffer.from(payload))
  const payloadSha256 = treeSha256({ 'worker.js': Buffer.from(payload) })
  const payloadDirectory = `${version}-${payloadSha256}`
  const executable = platform === 'win32' ? 'forge-external-chrome-native-host.exe' : 'forge-external-chrome-native-host'
  await fs.mkdir(path.join(resourcesRoot, 'extension-shell', 'shell'), { recursive: true })
  await fs.mkdir(path.join(resourcesRoot, 'payload', payloadDirectory), { recursive: true })
  await fs.mkdir(path.join(resourcesRoot, 'native-host', `${platform}-${arch}`), { recursive: true })
  await fs.writeFile(path.join(resourcesRoot, 'extension-shell', 'manifest.json'), manifestJson)
  await fs.writeFile(path.join(resourcesRoot, 'extension-shell', 'shell/bootstrap.js'), shell)
  await fs.writeFile(path.join(resourcesRoot, 'payload', payloadDirectory, 'worker.js'), payload)
  await fs.writeFile(path.join(resourcesRoot, 'native-host', `${platform}-${arch}`, executable), native)
  const manifest = {
    schemaVersion: 1,
    packageVersion: version,
    extension: {
      extensionId: EXTERNAL_CHROME_EXTENSION_ID,
      publicKeySha256: EXTERNAL_CHROME_PUBLIC_KEY_SHA256,
      minimumChromeVersion: '125', shellAbi: 1, shellSha256: treeSha256({ 'manifest.json': Buffer.from(manifestJson), 'shell/bootstrap.js': Buffer.from(shell) }),
      payloadVersion: version, payloadSha256, payloadDirectory, shellFiles, payloadFiles,
    },
    nativeHost: {
      protocol: { min: 1, max: 1, maxMessageBytes: 1_048_576 }, version: '1', platform, architecture: arch,
      executable, sha256: sha256(native), required: true,
      signature: { scheme: platform === 'darwin' ? 'developer-id' : platform === 'win32' ? 'authenticode' : 'packaged-resource-hash', verified: true },
    },
    compatibility: { desktop: { min: '0.22.0', max: '0.22.999' }, shellAbi: { min: 1, max: 1 } },
  }
  await fs.writeFile(path.join(resourcesRoot, 'package-manifest.json'), `${JSON.stringify(manifest)}\n`)
  return { root, dataRoot, resourcesRoot, manifest }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe('ExternalChromeDeployer', () => {
  it('uses a custom backend data root, is idempotent, and retains current plus N-1 for rollback', async () => {
    const first = await fixture('1.0.0')
    const deployer = new ExternalChromeDeployer({ dataRoot: first.dataRoot, resourcesRoot: first.resourcesRoot, desktopVersion: '0.22.5' })
    await deployer.deploy()
    await deployer.deploy()
    expect(await deployer.canRollback()).toBe(false)
    const stablePath = deployer.paths.extension

    const second = await fixture('1.1.0', 'payload-1.1.0', process.platform, process.arch, 'shell-v2')
    const upgraded = new ExternalChromeDeployer({ dataRoot: first.dataRoot, resourcesRoot: second.resourcesRoot, desktopVersion: '0.22.5' })
    await upgraded.deploy()
    expect(upgraded.paths.extension).toBe(stablePath)
    expect((await fs.readdir(upgraded.paths.payloads)).sort()).toHaveLength(2)
    expect(await fs.access(path.join(upgraded.paths.integrationRoot, 'extension.previous'))).toBeUndefined()
    const selected = JSON.parse(await fs.readFile(path.join(stablePath, 'current.json'), 'utf8'))
    expect(selected.payloadVersion).toBe('1.1.0')
    expect(await upgraded.canRollback()).toBe(true)

    const rolledBack = await upgraded.rollback()
    expect(rolledBack.payloadVersion).toBe('1.0.0')
    expect(JSON.parse(await fs.readFile(path.join(stablePath, 'current.json'), 'utf8')).payloadVersion).toBe('1.0.0')
    expect(await fs.readFile(upgraded.paths.nativeHostExecutable, 'utf8')).toBe('native-1.0.0')

    await fs.writeFile(path.join(stablePath, 'current.json'), '{corrupt')
    await upgraded.recover()
    expect(JSON.parse(await fs.readFile(path.join(stablePath, 'current.json'), 'utf8')).payloadVersion).toBe('1.0.0')
  })

  it('rejects concurrent deployment locks', async () => {
    const input = await fixture()
    const paths = resolveExternalChromeDataPaths(path.resolve(input.dataRoot))
    const lock = new FileDeploymentLock()
    const release = await lock.acquire(paths.lock)
    await expect(new ExternalChromeDeployer({ dataRoot: path.resolve(input.dataRoot), resourcesRoot: input.resourcesRoot, desktopVersion: '0.22.5' }).deploy())
      .rejects.toThrow('already in progress')
    await release()

    await fs.mkdir(paths.lock, { recursive: true })
    await fs.writeFile(path.join(paths.lock, 'owner-stale.json'), JSON.stringify({ schemaVersion: 1, pid: 99_999_999, token: 'stale' }))
    const staleLock = new FileDeploymentLock(fs, (pid) => pid === process.pid)
    const releaseRecovered = await staleLock.acquire(paths.lock)
    await releaseRecovered()
  })

  it('allows exactly one stale-lock contender and release never removes a replacement owner', async () => {
    const input = await fixture()
    const lockPath = resolveExternalChromeDataPaths(path.resolve(input.dataRoot)).lock
    await fs.mkdir(lockPath, { recursive: true })
    await fs.writeFile(path.join(lockPath, 'owner-stale.json'), JSON.stringify({ schemaVersion: 1, pid: 99_999_999, token: 'stale' }))
    let staleReads = 0
    let releaseStaleReads: (() => void) | undefined
    const bothReadStale = new Promise<void>((resolve) => { releaseStaleReads = resolve })
    const interleavedFs = {
      ...fs,
      readFile: async (...args: Parameters<typeof fs.readFile>) => {
        const result = await fs.readFile(...args)
        if (String(args[0]).endsWith('owner-stale.json')) {
          staleReads += 1
          if (staleReads === 2) releaseStaleReads?.()
          await bothReadStale
        }
        return result
      },
    } as DeployerFileSystem
    const contenders = [
      new FileDeploymentLock(interleavedFs, (pid) => pid === process.pid),
      new FileDeploymentLock(interleavedFs, (pid) => pid === process.pid),
    ]
    const results = await Promise.allSettled(contenders.map((lock) => lock.acquire(lockPath)))
    expect(staleReads).toBe(2)
    const acquired = results.filter((result): result is PromiseFulfilledResult<() => Promise<void>> => result.status === 'fulfilled')
    expect(acquired).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    await acquired[0]!.value()

    const firstRelease = await contenders[0]!.acquire(lockPath)
    const [firstMarker] = await fs.readdir(lockPath)
    await fs.rm(path.join(lockPath, firstMarker!))
    await fs.rmdir(lockPath)
    const replacementRelease = await contenders[1]!.acquire(lockPath)
    await firstRelease()
    await expect(contenders[0]!.acquire(lockPath)).rejects.toThrow('already in progress')
    await replacementRelease()
  })

  it('rejects corrupt input, unknown files, identity mismatches, traversal, and symlinks', async () => {
    const corrupt = await fixture()
    await fs.appendFile(path.join(corrupt.resourcesRoot, 'payload', corrupt.manifest.extension.payloadDirectory, 'worker.js'), 'corrupt')
    await expect(new ExternalChromeDeployer({ dataRoot: path.resolve(corrupt.dataRoot), resourcesRoot: corrupt.resourcesRoot, desktopVersion: '0.22.5' }).deploy())
      .rejects.toThrow('hash mismatch')

    const unknown = await fixture()
    await fs.writeFile(path.join(unknown.resourcesRoot, 'extension-shell', 'unknown'), 'x')
    await expect(new ExternalChromeDeployer({ dataRoot: path.resolve(unknown.dataRoot), resourcesRoot: unknown.resourcesRoot, desktopVersion: '0.22.5' }).deploy())
      .rejects.toThrow('inventory mismatch')

    const identity = await fixture()
    identity.manifest.extension.extensionId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    await fs.writeFile(path.join(identity.resourcesRoot, 'package-manifest.json'), JSON.stringify(identity.manifest))
    await expect(new ExternalChromeDeployer({ dataRoot: path.resolve(identity.dataRoot), resourcesRoot: identity.resourcesRoot, desktopVersion: '0.22.5' }).deploy())
      .rejects.toThrow('identity mismatch')

    const traversal = await fixture()
    traversal.manifest.extension.payloadFiles = { '../escape': '0'.repeat(64) }
    await fs.writeFile(path.join(traversal.resourcesRoot, 'package-manifest.json'), JSON.stringify(traversal.manifest))
    await expect(new ExternalChromeDeployer({ dataRoot: path.resolve(traversal.dataRoot), resourcesRoot: traversal.resourcesRoot, desktopVersion: '0.22.5' }).deploy())
      .rejects.toThrow('safe relative file')

    if (process.platform !== 'win32') {
      const linked = await fixture()
      await fs.symlink(path.join(linked.resourcesRoot, 'extension-shell', 'manifest.json'), path.join(linked.resourcesRoot, 'extension-shell', 'link'))
      await expect(new ExternalChromeDeployer({ dataRoot: path.resolve(linked.dataRoot), resourcesRoot: linked.resourcesRoot, desktopVersion: '0.22.5' }).deploy())
        .rejects.toThrow(/inventory mismatch|symlinks/)

      const destinationLink = await fixture()
      const paths = resolveExternalChromeDataPaths(path.resolve(destinationLink.dataRoot))
      await fs.mkdir(paths.integrationRoot, { recursive: true })
      const outside = path.join(destinationLink.root, 'outside')
      await fs.mkdir(outside)
      await fs.symlink(outside, paths.extension)
      await expect(new ExternalChromeDeployer({ dataRoot: path.resolve(destinationLink.dataRoot), resourcesRoot: destinationLink.resourcesRoot, desktopVersion: '0.22.5' }).deploy())
        .rejects.toThrow('Unsafe External Chrome deployment path')
    }
  })

  it('rejects traversal and malformed current, previous, and install state before outside access', async () => {
    const first = await fixture('1.0.0')
    const deployer = new ExternalChromeDeployer({ dataRoot: path.resolve(first.dataRoot), resourcesRoot: first.resourcesRoot, desktopVersion: '0.22.5' })
    await deployer.deploy()
    const second = await fixture('1.1.0')
    await new ExternalChromeDeployer({ dataRoot: path.resolve(first.dataRoot), resourcesRoot: second.resourcesRoot, desktopVersion: '0.22.5' }).deploy()
    const outside = path.join(first.root, 'outside')
    await fs.mkdir(outside)
    await fs.writeFile(path.join(outside, 'worker.js'), 'outside')
    let outsideTouched = false
    const guardedFs = {
      ...fs,
      readFile: async (target: Parameters<typeof fs.readFile>[0], ...args: unknown[]) => {
        if (path.resolve(String(target)).startsWith(path.resolve(outside))) outsideTouched = true
        return (fs.readFile as (...values: unknown[]) => Promise<Buffer>)(target, ...args)
      },
      lstat: async (target: Parameters<typeof fs.lstat>[0], ...args: unknown[]) => {
        if (path.resolve(String(target)).startsWith(path.resolve(outside))) outsideTouched = true
        return (fs.lstat as (...values: unknown[]) => ReturnType<typeof fs.lstat>)(target, ...args)
      },
      readdir: async (target: Parameters<typeof fs.readdir>[0], ...args: unknown[]) => {
        if (path.resolve(String(target)).startsWith(path.resolve(outside))) outsideTouched = true
        return (fs.readdir as (...values: unknown[]) => Promise<string[]>)(target, ...args)
      },
    } as unknown as DeployerFileSystem
    const guarded = new ExternalChromeDeployer({
      dataRoot: path.resolve(first.dataRoot), resourcesRoot: second.resourcesRoot, desktopVersion: '0.22.5', fs: guardedFs,
    })
    const malicious = {
      schemaVersion: 1, shellAbi: 1, payloadVersion: '1.0.0', payloadSha256: 'a'.repeat(64),
      payloadDirectory: '../../outside', payloadFiles: { 'worker.js': sha256(Buffer.from('outside')) },
    }
    await fs.writeFile(path.join(guarded.paths.extension, 'current.json'), JSON.stringify(malicious))
    expect(await guarded.verifyDeployment()).toEqual({ state: 'mismatch' })
    await guarded.recover()
    expect(outsideTouched).toBe(false)

    await fs.writeFile(guarded.paths.previousState, JSON.stringify(malicious))
    expect(await guarded.canRollback()).toBe(false)
    await expect(guarded.rollback()).rejects.toThrow('No valid')
    expect(outsideTouched).toBe(false)

    const install = JSON.parse(await fs.readFile(guarded.paths.installState, 'utf8'))
    install.payloadDirectory = '../../outside'
    await fs.writeFile(guarded.paths.installState, JSON.stringify(install))
    expect(await guarded.verifyDeployment()).toEqual({ state: 'mismatch' })
    await guarded.recover()
    expect(outsideTouched).toBe(false)
  })

  it('keeps N-1 payload/native metadata paired across A/A/B/B releases and recovery', async () => {
    const releases = [
      await fixture('1.0.0', 'payload-1.0.0', process.platform, process.arch, 'shell', 'native-A'),
      await fixture('1.1.0', 'payload-1.1.0', process.platform, process.arch, 'shell', 'native-A'),
      await fixture('1.2.0', 'payload-1.2.0', process.platform, process.arch, 'shell', 'native-B'),
      await fixture('1.3.0', 'payload-1.3.0', process.platform, process.arch, 'shell', 'native-B'),
    ]
    let deployer: ExternalChromeDeployer | undefined
    for (const release of releases) {
      deployer = new ExternalChromeDeployer({ dataRoot: path.resolve(releases[0]!.dataRoot), resourcesRoot: release.resourcesRoot, desktopVersion: '0.22.5' })
      await deployer.deploy()
    }
    expect(await fs.readFile(`${deployer!.paths.nativeHostExecutable}.previous`, 'utf8')).toBe('native-B')
    const previousInstall = JSON.parse(await fs.readFile(deployer!.paths.previousState, 'utf8')) as { nativeSha256: string }
    expect(previousInstall.nativeSha256).toBe(sha256(Buffer.from('native-B')))
    await expect(deployer!.rollback()).resolves.toMatchObject({ payloadVersion: '1.2.0' })
    expect(await fs.readFile(deployer!.paths.nativeHostExecutable, 'utf8')).toBe('native-B')
    await deployer!.recover()
    expect(await deployer!.verifyDeployment()).toMatchObject({ state: 'ready', install: { payloadVersion: '1.2.0', nativeSha256: sha256(Buffer.from('native-B')) } })
    expect(await fs.readFile(deployer!.paths.nativeHostExecutable, 'utf8')).toBe('native-B')
  })

  it('recovers an atomic valid selector after a restart at every journal phase', async () => {
    const phases: DeploymentPhase[] = ['validated', 'payload-staged', 'payload-installed', 'shell-staged', 'shell-swapped', 'selector-written', 'native-written', 'complete']
    for (const crashPhase of phases) {
      const index = phases.indexOf(crashPhase)
      const base = await fixture(`0.9.${index}`)
      await new ExternalChromeDeployer({ dataRoot: path.resolve(base.dataRoot), resourcesRoot: base.resourcesRoot, desktopVersion: '0.22.5' }).deploy()
      const input = await fixture(`1.0.${index}`, `payload-1.0.${index}`, process.platform, process.arch, `shell-v2-${index}`)
      const crashing = new ExternalChromeDeployer({
        dataRoot: path.resolve(base.dataRoot), resourcesRoot: input.resourcesRoot, desktopVersion: '0.22.5',
        afterPhase: (phase) => { if (phase === crashPhase) throw new Error(`crash:${phase}`) },
      })
      await expect(crashing.deploy()).rejects.toThrow(`crash:${crashPhase}`)
      const restarted = new ExternalChromeDeployer({ dataRoot: path.resolve(base.dataRoot), resourcesRoot: input.resourcesRoot, desktopVersion: '0.22.5' })
      await restarted.deploy()
      const selector = JSON.parse(await fs.readFile(path.join(restarted.paths.extension, 'current.json'), 'utf8'))
      expect(selector.payloadVersion).toBe(`1.0.${index}`)
      await expect(restarted.rollback()).resolves.toMatchObject({ payloadVersion: `0.9.${index}` })
    }
  }, 20_000)

  it('preserves the sole valid payload on ENOSPC and rejects mismatched platform metadata', async () => {
    const input = await fixture('1.0.0')
    const deployed = new ExternalChromeDeployer({ dataRoot: path.resolve(input.dataRoot), resourcesRoot: input.resourcesRoot, desktopVersion: '0.22.5' })
    await deployed.deploy()
    const before = await fs.readdir(deployed.paths.payloads)
    const update = await fixture('1.1.0')
    const failingFs = { ...fs, copyFile: vi.fn(async () => { const error = new Error('full') as NodeJS.ErrnoException; error.code = 'ENOSPC'; throw error }) } as DeployerFileSystem
    await expect(new ExternalChromeDeployer({ dataRoot: path.resolve(input.dataRoot), resourcesRoot: update.resourcesRoot, desktopVersion: '0.22.5', fs: failingFs }).deploy())
      .rejects.toMatchObject({ code: 'ENOSPC' })
    expect(await fs.readdir(deployed.paths.payloads)).toEqual(before)

    const wrong = await fixture('1.0.0', 'payload', process.platform, 'not-this-arch')
    await expect(new ExternalChromeDeployer({ dataRoot: path.resolve(wrong.dataRoot), resourcesRoot: wrong.resourcesRoot, desktopVersion: '0.22.5' }).deploy())
      .rejects.toThrow('not')
  })

  it('uses the bounded Windows sharing retry seam without exposing a partial selector', async () => {
    const input = await fixture('1.0.0', 'payload', 'win32')
    const originalRename = fs.rename.bind(fs)
    let blocked = true
    const injected = {
      ...fs,
      rename: vi.fn(async (source: string, destination: string) => {
        if (blocked && String(destination).endsWith('current.json')) {
          blocked = false
          const error = new Error('sharing') as NodeJS.ErrnoException
          error.code = 'EPERM'
          throw error
        }
        return originalRename(source, destination)
      }),
    } as unknown as DeployerFileSystem
    const sharingRetry = vi.fn(async (operation: () => Promise<void>) => { await operation(); return true })
    const deployer = new ExternalChromeDeployer({
      dataRoot: path.resolve(input.dataRoot), resourcesRoot: input.resourcesRoot, desktopVersion: '0.22.5',
      platform: 'win32', fs: injected, sharingRetry,
    })
    await deployer.deploy()
    expect(sharingRetry).toHaveBeenCalledOnce()
    expect(JSON.parse(await fs.readFile(path.join(deployer.paths.extension, 'current.json'), 'utf8')).schemaVersion).toBe(1)
  })

  it('supports a compatible app downgrade and blocks an incompatible one', async () => {
    const input = await fixture('1.0.0')
    await new ExternalChromeDeployer({ dataRoot: path.resolve(input.dataRoot), resourcesRoot: input.resourcesRoot, desktopVersion: '0.22.9' }).deploy()
    await expect(new ExternalChromeDeployer({ dataRoot: path.resolve(input.dataRoot), resourcesRoot: input.resourcesRoot, desktopVersion: '0.22.1' }).deploy()).resolves.toBeDefined()
    await expect(new ExternalChromeDeployer({ dataRoot: path.resolve(input.dataRoot), resourcesRoot: input.resourcesRoot, desktopVersion: '0.21.9' }).deploy()).rejects.toThrow('incompatible')
  })
})
