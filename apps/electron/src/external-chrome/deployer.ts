import { createHash, randomUUID } from 'node:crypto'
import * as nodeFs from 'node:fs/promises'
import path from 'node:path'
import type { FileHandle } from 'node:fs/promises'
import { EXTERNAL_CHROME_PROTOCOL_MAX_VERSION, EXTERNAL_CHROME_PROTOCOL_MIN_VERSION } from '@forge/protocol'
import { assertPathInside, resolveExternalChromeDataPaths, type ExternalChromeDataPaths } from './data-paths.js'
import {
  EXTERNAL_CHROME_EXTENSION_ID,
  EXTERNAL_CHROME_PUBLIC_KEY_SHA256,
  readExternalChromePackageManifest,
  sha256,
  type ExternalChromePackageManifest,
} from './package-manifest.js'

export type DeploymentPhase =
  | 'validated'
  | 'payload-staged'
  | 'payload-installed'
  | 'shell-staged'
  | 'shell-swapped'
  | 'selector-written'
  | 'native-written'
  | 'complete'

export interface ExternalChromeInstallRecord {
  schemaVersion: 1
  packageVersion: string
  extensionId: string
  publicKeySha256: string
  shellAbi: number
  shellSha256: string
  shellFiles: Record<string, string>
  payloadVersion: string
  payloadSha256: string
  payloadDirectory: string
  payloadFiles: Record<string, string>
  nativeVersion: string
  nativeSha256: string
  nativeProtocolCompatibility: { min: number; max: number }
  platform: string
  architecture: string
  desktopCompatibility: { min: string; max: string }
  shellAbiCompatibility: { min: number; max: number }
}

export type ExternalChromeDeploymentVerification =
  | { state: 'ready'; install: ExternalChromeInstallRecord }
  | { state: 'missing' | 'mismatch' }

export type ExternalChromeStartupDeploymentVerification =
  | ExternalChromeDeploymentVerification
  | { state: 'desktop-incompatible'; install: ExternalChromeInstallRecord }

export interface ExternalChromeDeploymentVerifier {
  verifyDeployment(): Promise<ExternalChromeDeploymentVerification>
  pendingDeployment?(): Promise<ExternalChromeInstallRecord | null>
  activateStaged?(): Promise<ExternalChromeInstallRecord>
  recoveryState?(): 'manual-extension-reload' | null
}

export interface ExternalChromeSelector {
  schemaVersion: 1
  shellAbi: number
  payloadVersion: string
  payloadSha256: string
  payloadDirectory: string
  payloadFiles: Record<string, string>
}

export interface DeployerFileSystem {
  access: typeof nodeFs.access
  chmod: typeof nodeFs.chmod
  copyFile: typeof nodeFs.copyFile
  lstat: typeof nodeFs.lstat
  mkdir: typeof nodeFs.mkdir
  open: typeof nodeFs.open
  readdir: typeof nodeFs.readdir
  readFile: typeof nodeFs.readFile
  rename: typeof nodeFs.rename
  rm: typeof nodeFs.rm
  rmdir: typeof nodeFs.rmdir
  stat: typeof nodeFs.stat
  writeFile: typeof nodeFs.writeFile
}

export interface ExternalChromeDeployerOptions {
  dataRoot: string
  resourcesRoot: string
  desktopVersion: string
  platform?: NodeJS.Platform
  architecture?: string
  fs?: DeployerFileSystem
  lock?: DeploymentLock
  sharingRetry?: (operation: () => Promise<void>, error: NodeJS.ErrnoException, attempt: number) => Promise<boolean>
  afterPhase?: (phase: DeploymentPhase) => void | Promise<void>
  /** Development-only opt-in for the explicit Node shebang host; release remains the default. */
  allowDevelopmentHost?: boolean
}

export interface DeploymentLock {
  acquire(path: string): Promise<() => Promise<void>>
}

const fsyncIgnoredCodes = new Set(['EINVAL', 'ENOTSUP', 'EBADF', 'EPERM'])

interface DeploymentLockOwner {
  schemaVersion: 1
  pid: number
  token: string
}

/**
 * A directory lock whose owner is a uniquely named marker. Stale contenders may
 * remove only the marker they inspected, then race through atomic rmdir/rename;
 * exactly one prepared claim directory can become the lock. Release likewise
 * removes only its own marker, so it can never unlink a replacement holder.
 */
export class FileDeploymentLock implements DeploymentLock {
  constructor(
    private readonly fs: DeployerFileSystem = nodeFs,
    private readonly isProcessAlive: (pid: number) => boolean = defaultIsProcessAlive,
  ) {}

  async acquire(lockPath: string): Promise<() => Promise<void>> {
    await this.fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 })
    const token = randomUUID()
    const markerName = `owner-${token}.json`
    const claimPath = `${lockPath}.claim-${token}`
    const owner: DeploymentLockOwner = { schemaVersion: 1, pid: process.pid, token }
    await this.fs.mkdir(claimPath, { mode: 0o700 })
    await this.fs.writeFile(path.join(claimPath, markerName), `${stableJson(owner)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })

    try {
      for (;;) {
        try {
          await this.fs.rename(claimPath, lockPath)
          break
        } catch (error) {
          if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
        }

        const observed = await this.inspectOwner(lockPath)
        if (!observed) {
          if (!(await exists(this.fs, lockPath))) continue
          throw new Error('External Chrome deployment is already in progress')
        }
        if (this.isProcessAlive(observed.pid)) throw new Error('External Chrome deployment is already in progress')
        // The marker name contains an unguessable generation. Removing this
        // exact entry cannot remove a replacement owner's differently named marker.
        await this.fs.rm(path.join(lockPath, `owner-${observed.token}.json`), { force: true })
        try {
          await this.fs.rmdir(lockPath)
        } catch (error) {
          if (!['ENOENT', 'ENOTEMPTY', 'EEXIST', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
        }
      }
    } catch (error) {
      await this.fs.rm(claimPath, { recursive: true, force: true })
      throw error
    }

    let released = false
    return async () => {
      if (released) return
      released = true
      await this.fs.rm(path.join(lockPath, markerName), { force: true })
      await this.fs.rmdir(lockPath).catch((error) => {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      })
    }
  }

  private async inspectOwner(lockPath: string): Promise<DeploymentLockOwner | null> {
    let entries: string[]
    try {
      const info = await this.fs.lstat(lockPath)
      if (!info.isDirectory() || info.isSymbolicLink()) return null
      entries = (await this.fs.readdir(lockPath)).filter((entry) => entry.startsWith('owner-') && entry.endsWith('.json'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    if (entries.length !== 1) return null
    try {
      const markerPath = path.join(lockPath, entries[0]!)
      if ((await this.fs.stat(markerPath)).size > 1_024) return null
      const value = JSON.parse(await this.fs.readFile(markerPath, 'utf8')) as unknown
      if (!isExactObject(value, ['schemaVersion', 'pid', 'token'])) return null
      if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.pid) || (value.pid as number) < 1) return null
      if (typeof value.token !== 'string' || entries[0] !== `owner-${value.token}.json`) return null
      return value as unknown as DeploymentLockOwner
    } catch {
      return null
    }
  }
}

export class ExternalChromeDeployer {
  readonly paths: ExternalChromeDataPaths
  private readonly fs: DeployerFileSystem
  private readonly platform: NodeJS.Platform
  private readonly architecture: string
  private readonly lock: DeploymentLock
  private manualRetry = false

  constructor(private readonly options: ExternalChromeDeployerOptions) {
    this.fs = options.fs ?? nodeFs
    this.platform = options.platform ?? process.platform
    this.architecture = options.architecture ?? process.arch
    this.paths = resolveExternalChromeDataPaths(options.dataRoot, this.platform)
    this.lock = options.lock ?? new FileDeploymentLock(this.fs)
  }

  async deploy(): Promise<ExternalChromeInstallRecord> {
    await this.stage()
    return this.activateStaged()
  }

  /** Validate and copy an immutable package without changing selector/native authority. */
  async stage(): Promise<ExternalChromeInstallRecord> {
    const release = await this.lock.acquire(this.paths.lock)
    try {
      await this.recoverUnlocked()
      const manifest = await this.readPackageManifest(path.join(this.options.resourcesRoot, 'package-manifest.json'))
      this.assertCompatible(manifest)
      await this.validatePackagedResources(manifest, this.options.resourcesRoot)
      await this.assertSameVersionContentPolicy(manifest)
      const record = installRecordFromManifest(manifest)
      const directory = `staged-${manifest.extension.shellSha256.slice(0, 16)}-${manifest.extension.payloadSha256.slice(0, 16)}-${manifest.nativeHost.sha256.slice(0, 16)}`
      const destination = path.join(this.paths.deployment, directory)
      assertPathInside(this.paths.deployment, destination)
      if (!(await exists(this.fs, destination))) {
        const temporary = path.join(this.paths.deployment, `.stage-${randomUUID()}`)
        await this.fs.mkdir(temporary, { recursive: true, mode: 0o700 })
        try {
          await this.copyInventory(path.join(this.options.resourcesRoot, 'extension-shell'), path.join(temporary, 'extension-shell'), manifest.extension.shellFiles)
          await this.copyInventory(
            path.join(this.options.resourcesRoot, 'payload', manifest.extension.payloadDirectory),
            path.join(temporary, 'payload', manifest.extension.payloadDirectory),
            manifest.extension.payloadFiles,
          )
          const nativeDirectory = path.join(temporary, 'native-host', `${this.platform}-${this.architecture}`)
          await this.copyInventory(
            path.join(this.options.resourcesRoot, 'native-host', `${this.platform}-${this.architecture}`),
            nativeDirectory,
            { [manifest.nativeHost.executable]: manifest.nativeHost.sha256 },
          )
          await this.fs.copyFile(path.join(this.options.resourcesRoot, 'package-manifest.json'), path.join(temporary, 'package-manifest.json'))
          await this.fs.chmod(path.join(temporary, 'package-manifest.json'), 0o600)
          await this.syncTree(temporary)
          await this.renameWithRetry(temporary, destination)
        } catch (error) {
          await this.fs.rm(temporary, { recursive: true, force: true })
          throw error
        }
      }
      await this.validatePackagedResources(manifest, destination)
      await this.atomicJson(path.join(this.paths.state, 'staged-deployment.json'), {
        schemaVersion: 1, directory, payloadSha256: manifest.extension.payloadSha256, nativeSha256: manifest.nativeHost.sha256,
      })
      return record
    } finally {
      await release()
    }
  }

  async pendingDeployment(): Promise<ExternalChromeInstallRecord | null> {
    const staged = await this.readStagedDeployment()
    return staged ? installRecordFromManifest(staged.manifest) : null
  }

  /** Activate only the exact previously validated staged package. */
  async activateStaged(): Promise<ExternalChromeInstallRecord> {
    const staged = await this.readStagedDeployment()
    if (staged) return this.deployFromResources(staged.root)
    // Multiple stale profiles may acknowledge prepare independently. Once one
    // generation atomically activates the exact package, later acknowledgements
    // observe the verified selection and may safely continue to reload.
    const active = await this.verifyDeployment()
    if (active.state === 'ready') return active.install
    throw new Error('No validated External Chrome deployment is staged')
  }

  private async deployFromResources(resourcesRoot: string): Promise<ExternalChromeInstallRecord> {
    const release = await this.lock.acquire(this.paths.lock)
    try {
      await this.recoverUnlocked()
      const manifest = await this.readPackageManifest(path.join(resourcesRoot, 'package-manifest.json'))
      this.assertCompatible(manifest)
      await this.validatePackagedResources(manifest, resourcesRoot)
      await this.assertSameVersionContentPolicy(manifest)
      await this.phase('validated', manifest)

      const oldSelector = await this.readSelector(path.join(this.paths.extension, 'current.json'))
      const oldInstall = await this.readInstall(this.paths.installState)
      const rollbackInstall = oldSelector && oldInstall && selectorMatchesInstall(oldSelector, oldInstall)
        && await this.isValidRecoveryAt(oldInstall, this.paths.extension)
        && await fileHasHash(this.fs, this.paths.nativeHostExecutable, oldInstall.nativeSha256) ? oldInstall : null
      const record = installRecordFromManifest(manifest)
      const rollbackInstallToRetain = rollbackInstall && stableJson(rollbackInstall) !== stableJson(record)
        ? rollbackInstall : null
      if (rollbackInstallToRetain) await this.atomicJson(path.join(this.paths.state, 'activation-backup.json'), rollbackInstallToRetain)
      const selector = selectorFromManifest(manifest)
      const stagingPayload = path.join(this.paths.deployment, `.payload-${randomUUID()}`)
      await this.fs.mkdir(this.paths.deployment, { recursive: true, mode: 0o700 })
      await this.copyInventory(
        path.join(resourcesRoot, 'payload', manifest.extension.payloadDirectory),
        stagingPayload,
        manifest.extension.payloadFiles,
      )
      await this.syncTree(stagingPayload)
      await this.phase('payload-staged', manifest)

      const shellChanged = !(await this.shellMatches(manifest))
      if (shellChanged) await this.installWithShellMigration(manifest, stagingPayload, oldSelector, rollbackInstallToRetain, resourcesRoot)
      else await this.installPayload(stagingPayload, selector.payloadDirectory)
      await this.phase('payload-installed', manifest)

      if (rollbackInstallToRetain) await this.atomicJson(this.paths.previousState, rollbackInstallToRetain)
      if (!shellChanged) await this.atomicJson(path.join(this.paths.extension, 'current.json'), selector)
      await this.phase('selector-written', manifest)

      await this.installNative(manifest, rollbackInstallToRetain?.nativeSha256, resourcesRoot)
      await this.phase('native-written', manifest)

      await this.atomicJson(this.paths.installState, record)
      await this.retainCurrentAndPrevious(selector)
      await this.phase('complete', manifest)
      this.manualRetry = false
      await this.fs.rm(this.paths.journal, { force: true })
      await this.fs.rm(path.join(this.paths.state, 'activation-backup.json'), { force: true })
      await this.fs.rm(path.join(this.paths.state, 'staged-deployment.json'), { force: true })
      return record
    } finally {
      await release()
    }
  }

  recoveryState(): 'manual-extension-reload' | null {
    return this.manualRetry ? 'manual-extension-reload' : null
  }

  async canRollback(): Promise<boolean> {
    const previous = await this.readInstall(this.paths.previousState)
    if (!previous || !(await this.nativeAvailable(previous.nativeSha256))) return false
    const selector = selectorFromInstall(previous)
    if (await this.isValidRollbackAt(previous, this.paths.extension)) return true
    const previousShell = path.join(this.paths.integrationRoot, 'extension.previous')
    const previousShellSelector = await this.readSelector(path.join(previousShell, 'current.json'))
    return !!previousShellSelector && selectorEquals(previousShellSelector, selector)
      && await this.isValidRollbackAt(previous, previousShell)
  }

  async verifyDeployment(): Promise<ExternalChromeDeploymentVerification> {
    const verification = await this.verifyDeploymentForStartup()
    return verification.state === 'desktop-incompatible' ? { state: 'mismatch' } : verification
  }

  /**
   * Startup may replace an old deployment only after its complete installed
   * inventory is proven and only when Desktop-version compatibility is the
   * remaining failure. The public setup surface continues to project this as a
   * generic mismatch.
   */
  async verifyDeploymentForStartup(): Promise<ExternalChromeStartupDeploymentVerification> {
    try {
      const selector = await this.readSelector(path.join(this.paths.extension, 'current.json'))
      const install = await this.readInstall(this.paths.installState)
      if (!selector || !install) {
        const extensionExists = await exists(this.fs, this.paths.extension)
        const installExists = await exists(this.fs, this.paths.installState)
        const nativeExists = await exists(this.fs, this.paths.nativeHostExecutable)
        return { state: extensionExists || installExists || nativeExists ? 'mismatch' : 'missing' }
      }
      if (!selectorMatchesInstall(selector, install)) return { state: 'mismatch' }
      await this.assertSafeDeploymentDirectories()
      await this.validateShellAt(this.paths.extension, install.shellFiles, install.shellSha256)
      if (!(await this.isValidPayload(selector))) return { state: 'mismatch' }
      if (!(await this.hasExpectedExtensionIdentityAt(this.paths.extension, install))) return { state: 'mismatch' }
      const nativeHash = sha256(await this.fs.readFile(this.safeInside(this.paths.nativeHost, path.basename(this.paths.nativeHostExecutable))))
      if (nativeHash !== install.nativeSha256) return { state: 'mismatch' }
      this.assertInstallNonDesktopCompatible(install)
      if (!this.isInstallDesktopCompatible(install)) return { state: 'desktop-incompatible', install }
      return { state: 'ready', install }
    } catch {
      return { state: 'mismatch' }
    }
  }

  async rollback(): Promise<ExternalChromeSelector> {
    const release = await this.lock.acquire(this.paths.lock)
    try {
      await this.recoverUnlocked()
      const current = await this.readSelector(path.join(this.paths.extension, 'current.json'))
      const currentInstall = await this.readInstall(this.paths.installState)
      const previousInstall = await this.readInstall(this.paths.previousState)
      if (!previousInstall || !(await this.nativeAvailable(previousInstall.nativeSha256))) throw new Error('No valid External Chrome rollback payload is available')
      const previous = selectorFromInstall(previousInstall)
      const previousShell = path.join(this.paths.integrationRoot, 'extension.previous')
      const previousShellSelector = await this.readSelector(path.join(previousShell, 'current.json'))
      if (
        previousShellSelector && selectorEquals(previousShellSelector, previous) &&
        await this.isValidRollbackAt(previousInstall, previousShell)
      ) {
        const rollbackShell = path.join(this.paths.integrationRoot, 'extension.rollback-new')
        await this.fs.rm(rollbackShell, { recursive: true, force: true })
        await this.renameWithRetry(this.paths.extension, rollbackShell)
        try {
          await this.renameWithRetry(previousShell, this.paths.extension)
          await this.renameWithRetry(rollbackShell, previousShell)
        } catch (error) {
          if (!(await exists(this.fs, this.paths.extension)) && await exists(this.fs, rollbackShell)) {
            await this.renameWithRetry(rollbackShell, this.paths.extension)
          }
          throw error
        }
        await this.selectNative(previousInstall.nativeSha256)
        if (current && currentInstall && selectorMatchesInstall(current, currentInstall)) await this.atomicJson(this.paths.previousState, currentInstall)
        await this.atomicJson(this.paths.installState, previousInstall)
        return previousShellSelector
      }
      if (!(await this.isValidRollbackAt(previousInstall, this.paths.extension))) throw new Error('No valid External Chrome rollback payload is available')
      await this.selectNative(previousInstall.nativeSha256)
      await this.atomicJson(path.join(this.paths.extension, 'current.json'), previous)
      if (current && currentInstall && selectorMatchesInstall(current, currentInstall)) await this.atomicJson(this.paths.previousState, currentInstall)
      await this.retainCurrentAndPrevious(previous)
      await this.atomicJson(this.paths.installState, previousInstall)
      return previous
    } finally {
      await release()
    }
  }

  async recover(): Promise<void> {
    const release = await this.lock.acquire(this.paths.lock)
    try {
      await this.recoverUnlocked()
    } finally {
      await release()
    }
  }

  private async recoverUnlocked(): Promise<void> {
    await this.ensureSafeRoot()
    const previousShell = path.join(this.paths.integrationRoot, 'extension.previous')
    const activationBackupPath = path.join(this.paths.state, 'activation-backup.json')
    const activationBackup = await this.readInstall(activationBackupPath)
    if (activationBackup) {
      const backupSelector = selectorFromInstall(activationBackup)
      if (await exists(this.fs, previousShell) && await this.isValidRecoveryAt(activationBackup, previousShell)) {
        const interruptedShell = path.join(this.paths.integrationRoot, `extension.interrupted-${randomUUID()}`)
        if (await exists(this.fs, this.paths.extension)) await this.renameWithRetry(this.paths.extension, interruptedShell)
        await this.renameWithRetry(previousShell, this.paths.extension)
        await this.fs.rm(interruptedShell, { recursive: true, force: true })
      } else if (await this.isValidPayload(backupSelector)) {
        await this.atomicJson(path.join(this.paths.extension, 'current.json'), backupSelector)
      }
      if (await this.nativeAvailable(activationBackup.nativeSha256)) await this.selectNative(activationBackup.nativeSha256)
      if (await this.isValidRecoveryAt(activationBackup, this.paths.extension) && await fileHasHash(this.fs, this.paths.nativeHostExecutable, activationBackup.nativeSha256)) {
        await this.atomicJson(this.paths.installState, activationBackup)
        await this.fs.rm(activationBackupPath, { force: true })
        await this.fs.rm(this.paths.journal, { force: true })
      } else {
        this.manualRetry = true
      }
    }
    const nextShell = path.join(this.paths.integrationRoot, 'extension.new')
    const rollbackShell = path.join(this.paths.integrationRoot, 'extension.rollback-new')
    if (!(await exists(this.fs, this.paths.extension))) {
      if (await exists(this.fs, previousShell)) await this.renameWithRetry(previousShell, this.paths.extension)
      else if (await exists(this.fs, rollbackShell)) await this.renameWithRetry(rollbackShell, this.paths.extension)
    }
    if (await exists(this.fs, rollbackShell)) {
      if (!(await exists(this.fs, previousShell))) await this.renameWithRetry(rollbackShell, previousShell)
      else await this.fs.rm(rollbackShell, { recursive: true, force: true })
    }
    if (await exists(this.fs, nextShell)) await this.fs.rm(nextShell, { recursive: true, force: true })
    const previousNative = `${this.paths.nativeHostExecutable}.previous`
    const rollbackNative = `${this.paths.nativeHostExecutable}.rollback-new`
    if (!(await exists(this.fs, this.paths.nativeHostExecutable))) {
      if (await exists(this.fs, previousNative)) await this.renameWithRetry(previousNative, this.paths.nativeHostExecutable)
      else if (await exists(this.fs, rollbackNative)) await this.renameWithRetry(rollbackNative, this.paths.nativeHostExecutable)
    }
    if (await exists(this.fs, rollbackNative)) {
      if (!(await exists(this.fs, previousNative))) await this.renameWithRetry(rollbackNative, previousNative)
      else await this.fs.rm(rollbackNative, { force: true })
    }
    if (await exists(this.fs, this.paths.nativeHost)) {
      for (const entry of await this.fs.readdir(this.paths.nativeHost)) {
        if (entry.includes('.new-')) await this.fs.rm(path.join(this.paths.nativeHost, entry), { force: true })
      }
    }

    const current = await this.readSelector(path.join(this.paths.extension, 'current.json'))
    if (!current || !(await this.isValidPayload(current))) {
      const installed = await this.readInstall(this.paths.installState)
      const installedSelector = installed ? selectorFromInstall(installed) : null
      const previousInstall = await this.readInstall(this.paths.previousState)
      const previous = previousInstall ? selectorFromInstall(previousInstall) : null
      if (installedSelector && await this.isValidPayload(installedSelector)) {
        await this.atomicJson(path.join(this.paths.extension, 'current.json'), installedSelector)
      } else if (previous && await this.isValidPayload(previous)) {
        await this.atomicJson(path.join(this.paths.extension, 'current.json'), previous)
      }
    }

    if (await exists(this.fs, this.paths.deployment)) {
      for (const entry of await this.fs.readdir(this.paths.deployment)) {
        if (entry.startsWith('.payload-') || entry.startsWith('.atomic-')) {
          await this.fs.rm(path.join(this.paths.deployment, entry), { recursive: true, force: true })
        }
      }
    }
  }

  private async shellMatches(manifest: ExternalChromePackageManifest): Promise<boolean> {
    try {
      const files = (await this.walkSafeFiles(this.paths.extension))
        .filter((file) => file !== 'current.json' && !file.startsWith('payloads/'))
      const expected = Object.keys(manifest.extension.shellFiles).sort()
      if (files.join('\0') !== expected.join('\0')) return false
      for (const file of files) {
        if (sha256(await this.fs.readFile(path.join(this.paths.extension, file))) !== manifest.extension.shellFiles[file]) return false
      }
      return await this.inventoryTreeHash(this.paths.extension, files) === manifest.extension.shellSha256
    } catch {
      return false
    }
  }

  private readPackageManifest(file: string): Promise<ExternalChromePackageManifest> {
    return readExternalChromePackageManifest(file, { allowDevelopmentHost: this.options.allowDevelopmentHost })
  }

  private async assertSameVersionContentPolicy(manifest: ExternalChromePackageManifest): Promise<void> {
    if (this.options.allowDevelopmentHost === true) return
    const installed = await this.readInstall(this.paths.installState)
    if (
      installed?.packageVersion === manifest.packageVersion
      && !deploymentContentEquals(installed, installRecordFromManifest(manifest))
    ) {
      throw new Error('External Chrome release policy rejects changed content for an installed package version')
    }
  }

  private async validatePackagedResources(manifest: ExternalChromePackageManifest, resourcesRoot: string): Promise<void> {
    const shellRoot = path.join(resourcesRoot, 'extension-shell')
    const payloadRoot = path.join(resourcesRoot, 'payload', manifest.extension.payloadDirectory)
    const nativeRoot = path.join(resourcesRoot, 'native-host', `${this.platform}-${this.architecture}`)
    await this.validateInventory(shellRoot, manifest.extension.shellFiles)
    await this.validateInventory(payloadRoot, manifest.extension.payloadFiles)
    if (await this.inventoryTreeHash(shellRoot, Object.keys(manifest.extension.shellFiles).sort()) !== manifest.extension.shellSha256) {
      throw new Error('External Chrome packaged shell tree hash mismatch')
    }
    if (await this.inventoryTreeHash(payloadRoot, Object.keys(manifest.extension.payloadFiles).sort()) !== manifest.extension.payloadSha256) {
      throw new Error('External Chrome packaged payload tree hash mismatch')
    }
    await this.validateInventory(nativeRoot, { [manifest.nativeHost.executable]: manifest.nativeHost.sha256 })
    const chromeManifest = JSON.parse(await this.fs.readFile(path.join(shellRoot, 'manifest.json'), 'utf8')) as { key?: unknown }
    if (typeof chromeManifest.key !== 'string') throw new Error('External Chrome shell manifest has no public identity')
    const publicKey = Buffer.from(chromeManifest.key, 'base64')
    const publicKeyHash = createHash('sha256').update(publicKey).digest('hex')
    const extensionId = publicKeyHash.slice(0, 32).replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)))
    if (publicKeyHash !== manifest.extension.publicKeySha256 || extensionId !== manifest.extension.extensionId) {
      throw new Error('External Chrome shell public identity mismatch')
    }
  }

  private async validateInventory(root: string, inventory: Record<string, string>): Promise<void> {
    const files = await this.walkSafeFiles(root)
    const expected = Object.keys(inventory).sort()
    if (files.join('\0') !== expected.join('\0')) throw new Error(`External Chrome packaged resource inventory mismatch at ${root}`)
    for (const file of files) {
      const bytes = await this.fs.readFile(path.join(root, file))
      if (sha256(bytes) !== inventory[file]) throw new Error(`External Chrome packaged resource hash mismatch: ${file}`)
    }
  }

  private async walkSafeFiles(root: string): Promise<string[]> {
    const found: string[] = []
    const visit = async (directory: string): Promise<void> => {
      assertPathInside(root, directory)
      const entries = await this.fs.readdir(directory, { withFileTypes: true })
      entries.sort((left, right) => left.name.localeCompare(right.name))
      for (const entry of entries) {
        const absolute = path.join(directory, entry.name)
        assertPathInside(root, absolute)
        const info = await this.fs.lstat(absolute)
        if (info.isSymbolicLink()) throw new Error(`External Chrome packaged resources must not contain symlinks: ${absolute}`)
        if (info.isDirectory()) await visit(absolute)
        else if (info.isFile()) found.push(path.relative(root, absolute).split(path.sep).join('/'))
        else throw new Error(`External Chrome packaged resources contain an unsupported file: ${absolute}`)
      }
    }
    const rootInfo = await this.fs.lstat(root)
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error(`External Chrome packaged resource root is unsafe: ${root}`)
    await visit(root)
    return found.sort()
  }

  private async installWithShellMigration(
    manifest: ExternalChromePackageManifest,
    stagingPayload: string,
    oldSelector: ExternalChromeSelector | null,
    rollbackInstall: ExternalChromeInstallRecord | null,
    resourcesRoot: string,
  ): Promise<void> {
    const nextShell = path.join(this.paths.integrationRoot, 'extension.new')
    const previousShell = path.join(this.paths.integrationRoot, 'extension.previous')
    await this.fs.rm(nextShell, { recursive: true, force: true })
    await this.copyInventory(path.join(resourcesRoot, 'extension-shell'), nextShell, manifest.extension.shellFiles)
    const nextPayloads = path.join(nextShell, 'payloads')
    await this.fs.mkdir(nextPayloads, { recursive: true, mode: 0o755 })
    if (oldSelector && await this.isValidPayload(oldSelector)) {
      await this.copyDirectorySafe(this.payloadPath(this.paths.payloads, oldSelector), this.payloadPath(nextPayloads, oldSelector))
    }
    const previousInstall = await this.readInstall(this.paths.previousState)
    const previousSelector = previousInstall ? selectorFromInstall(previousInstall) : null
    if (previousSelector && previousSelector.payloadDirectory !== oldSelector?.payloadDirectory && await this.isValidPayload(previousSelector)) {
      await this.copyDirectorySafe(this.payloadPath(this.paths.payloads, previousSelector), this.payloadPath(nextPayloads, previousSelector))
    }
    const nextPayload = path.join(nextPayloads, manifest.extension.payloadDirectory)
    if (await exists(this.fs, nextPayload)) {
      await this.validateInventory(nextPayload, manifest.extension.payloadFiles)
      await this.fs.rm(stagingPayload, { recursive: true, force: true })
    } else await this.renameWithRetry(stagingPayload, nextPayload)
    await this.atomicJson(path.join(nextShell, 'current.json'), selectorFromManifest(manifest))
    if (rollbackInstall) {
      await this.atomicJson(this.paths.previousState, rollbackInstall)
    }
    await this.syncTree(nextShell)
    await this.phase('shell-staged', manifest)

    await this.fs.rm(previousShell, { recursive: true, force: true })
    if (await exists(this.fs, this.paths.extension)) await this.renameWithRetry(this.paths.extension, previousShell)
    try {
      await this.renameWithRetry(nextShell, this.paths.extension)
    } catch (error) {
      if (!(await exists(this.fs, this.paths.extension)) && await exists(this.fs, previousShell)) {
        await this.renameWithRetry(previousShell, this.paths.extension)
      }
      throw error
    }
    await this.phase('shell-swapped', manifest)
  }

  private async installPayload(stagingPayload: string, directory: string): Promise<void> {
    await this.fs.mkdir(this.paths.payloads, { recursive: true, mode: 0o755 })
    const destination = path.join(this.paths.payloads, directory)
    if (await exists(this.fs, destination)) {
      try {
        await this.validateInventory(destination, await inventoryFor(this.fs, stagingPayload))
        await this.fs.rm(stagingPayload, { recursive: true, force: true })
        return
      } catch (error) {
        const info = await this.fs.lstat(destination)
        if (info.isSymbolicLink()) throw error
        // Never overwrite files inside an immutable payload. Move the entire corrupt
        // directory aside, install the fully fsynced sibling, then remove quarantine.
        const quarantine = `${destination}.corrupt-${randomUUID()}`
        await this.renameWithRetry(destination, quarantine)
        try {
          await this.renameWithRetry(stagingPayload, destination)
          await this.fs.rm(quarantine, { recursive: true, force: true })
          return
        } catch (replaceError) {
          if (!(await exists(this.fs, destination))) await this.renameWithRetry(quarantine, destination)
          throw replaceError
        }
      }
    }
    await this.renameWithRetry(stagingPayload, destination)
  }

  private async installNative(manifest: ExternalChromePackageManifest, rollbackNativeSha256: string | undefined, resourcesRoot: string): Promise<void> {
    await this.fs.mkdir(this.paths.nativeHost, { recursive: true, mode: 0o700 })
    const source = path.join(
      resourcesRoot,
      'native-host',
      `${this.platform}-${this.architecture}`,
      manifest.nativeHost.executable,
    )
    const temporary = `${this.paths.nativeHostExecutable}.new-${randomUUID()}`
    await this.fs.copyFile(source, temporary)
    if (this.platform !== 'win32') await this.fs.chmod(temporary, 0o755)
    await this.syncFile(temporary)
    if (await exists(this.fs, this.paths.nativeHostExecutable)) {
      const existingHash = sha256(await this.fs.readFile(this.paths.nativeHostExecutable))
      if (existingHash === manifest.nativeHost.sha256) {
        await this.fs.rm(temporary, { force: true })
        if (rollbackNativeSha256) await this.ensurePreviousNativeAssociation(rollbackNativeSha256, existingHash)
        return
      }
      const previous = `${this.paths.nativeHostExecutable}.previous`
      await this.fs.rm(previous, { force: true })
      await this.renameWithRetry(this.paths.nativeHostExecutable, previous)
      if (rollbackNativeSha256 && !(await fileHasHash(this.fs, previous, rollbackNativeSha256))) {
        throw new Error('External Chrome rollback native host association mismatch')
      }
      try {
        await this.renameWithRetry(temporary, this.paths.nativeHostExecutable)
      } catch (error) {
        if (!(await exists(this.fs, this.paths.nativeHostExecutable))) await this.renameWithRetry(previous, this.paths.nativeHostExecutable)
        throw error
      }
      return
    }
    await this.renameWithRetry(temporary, this.paths.nativeHostExecutable)
  }

  private async ensurePreviousNativeAssociation(expectedHash: string, currentHash: string): Promise<void> {
    const previous = `${this.paths.nativeHostExecutable}.previous`
    if (await fileHasHash(this.fs, previous, expectedHash)) return
    if (currentHash !== expectedHash) throw new Error('External Chrome rollback native host association mismatch')
    const temporary = `${previous}.new-${randomUUID()}`
    await this.fs.copyFile(this.paths.nativeHostExecutable, temporary)
    if (this.platform !== 'win32') await this.fs.chmod(temporary, 0o755)
    await this.syncFile(temporary)
    await this.renameReplace(temporary, previous)
    if (!(await fileHasHash(this.fs, previous, expectedHash))) throw new Error('External Chrome rollback native host association mismatch')
  }

  private async nativeAvailable(expectedHash: string): Promise<boolean> {
    for (const candidate of [this.paths.nativeHostExecutable, `${this.paths.nativeHostExecutable}.previous`]) {
      try {
        if (sha256(await this.fs.readFile(candidate)) === expectedHash) return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return false
  }

  private async selectNative(expectedHash: string): Promise<void> {
    if (await fileHasHash(this.fs, this.paths.nativeHostExecutable, expectedHash)) return
    const previous = `${this.paths.nativeHostExecutable}.previous`
    if (!(await fileHasHash(this.fs, previous, expectedHash))) {
      throw new Error('Validated External Chrome rollback native host is unavailable')
    }
    const rollbackCurrent = `${this.paths.nativeHostExecutable}.rollback-new`
    await this.fs.rm(rollbackCurrent, { force: true })
    if (await exists(this.fs, this.paths.nativeHostExecutable)) await this.renameWithRetry(this.paths.nativeHostExecutable, rollbackCurrent)
    try {
      await this.renameWithRetry(previous, this.paths.nativeHostExecutable)
      if (await exists(this.fs, rollbackCurrent)) await this.renameWithRetry(rollbackCurrent, previous)
    } catch (error) {
      if (!(await exists(this.fs, this.paths.nativeHostExecutable)) && await exists(this.fs, rollbackCurrent)) {
        await this.renameWithRetry(rollbackCurrent, this.paths.nativeHostExecutable)
      }
      throw error
    }
  }

  private async retainCurrentAndPrevious(current: ExternalChromeSelector): Promise<void> {
    if (!(await exists(this.fs, this.paths.payloads))) return
    const previousInstall = await this.readInstall(this.paths.previousState)
    const previous = previousInstall ? selectorFromInstall(previousInstall) : null
    const retain = new Set([current.payloadDirectory])
    if (previous && await this.isValidPayload(previous)) retain.add(previous.payloadDirectory)
    for (const entry of await this.fs.readdir(this.paths.payloads)) {
      if (!retain.has(entry) && retain.size > 0) await this.fs.rm(path.join(this.paths.payloads, entry), { recursive: true, force: true })
    }
  }

  private async isValidPayload(selector: ExternalChromeSelector): Promise<boolean> {
    return this.isValidPayloadAt(selector, this.paths.payloads)
  }

  private async isValidPayloadAt(selector: ExternalChromeSelector, payloadsRoot: string): Promise<boolean> {
    try {
      const root = this.payloadPath(payloadsRoot, selector)
      await this.validateInventory(root, selector.payloadFiles)
      return await this.inventoryTreeHash(root, Object.keys(selector.payloadFiles).sort()) === selector.payloadSha256
    } catch {
      return false
    }
  }

  private payloadPath(payloadsRoot: string, selector: ExternalChromeSelector): string {
    const root = path.join(payloadsRoot, selector.payloadDirectory)
    assertPathInside(payloadsRoot, root)
    return root
  }

  private safeInside(root: string, relative: string): string {
    const target = path.join(root, ...relative.split('/'))
    assertPathInside(root, target)
    return target
  }

  private async inventoryTreeHash(root: string, files: string[]): Promise<string> {
    const hash = createHash('sha256')
    for (const file of files) {
      const bytes = await this.fs.readFile(this.safeInside(root, file))
      hash.update(`${file}\0${bytes.byteLength}\0`)
      hash.update(bytes)
    }
    return hash.digest('hex')
  }

  private async validateShellAt(shellRoot: string, inventory: Record<string, string>, expectedTreeHash: string): Promise<void> {
    const files = (await this.walkSafeFiles(shellRoot))
      .filter((file) => file !== 'current.json' && !file.startsWith('payloads/'))
    const expected = Object.keys(inventory).sort()
    if (files.join('\0') !== expected.join('\0')) throw new Error('External Chrome deployed shell inventory mismatch')
    for (const file of files) {
      if (sha256(await this.fs.readFile(this.safeInside(shellRoot, file))) !== inventory[file]) {
        throw new Error(`External Chrome deployed shell hash mismatch: ${file}`)
      }
    }
    if (await this.inventoryTreeHash(shellRoot, files) !== expectedTreeHash) {
      throw new Error('External Chrome deployed shell tree hash mismatch')
    }
  }

  private async hasExpectedExtensionIdentityAt(shellRoot: string, install: ExternalChromeInstallRecord): Promise<boolean> {
    const manifest = JSON.parse(await this.fs.readFile(this.safeInside(shellRoot, 'manifest.json'), 'utf8')) as unknown
    if (!isExactObject(manifest, ['manifest_version', 'key']) && !isManifestWithKey(manifest)) return false
    const key = (manifest as { key?: unknown }).key
    if (typeof key !== 'string') return false
    const publicKeyHash = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex')
    return install.extensionId === EXTERNAL_CHROME_EXTENSION_ID
      && install.publicKeySha256 === EXTERNAL_CHROME_PUBLIC_KEY_SHA256
      && publicKeyHash === install.publicKeySha256
      && extensionIdFromPublicKeyHash(publicKeyHash) === install.extensionId
  }

  private async isValidRollbackAt(install: ExternalChromeInstallRecord, shellRoot: string): Promise<boolean> {
    try {
      this.assertInstallCompatible(install)
      await this.validateShellAt(shellRoot, install.shellFiles, install.shellSha256)
      return await this.isValidPayloadAt(selectorFromInstall(install), path.join(shellRoot, 'payloads'))
    } catch {
      return false
    }
  }

  private async isValidRecoveryAt(install: ExternalChromeInstallRecord, shellRoot: string): Promise<boolean> {
    try {
      this.assertInstallNonDesktopCompatible(install)
      await this.validateShellAt(shellRoot, install.shellFiles, install.shellSha256)
      if (!(await this.hasExpectedExtensionIdentityAt(shellRoot, install))) return false
      return await this.isValidPayloadAt(selectorFromInstall(install), path.join(shellRoot, 'payloads'))
    } catch {
      return false
    }
  }

  private async copyInventory(source: string, destination: string, inventory: Record<string, string>): Promise<void> {
    await this.fs.rm(destination, { recursive: true, force: true })
    await this.fs.mkdir(destination, { recursive: true, mode: 0o755 })
    for (const relative of Object.keys(inventory).sort()) {
      const sourceFile = path.join(source, ...relative.split('/'))
      const destinationFile = path.join(destination, ...relative.split('/'))
      assertPathInside(source, sourceFile)
      assertPathInside(destination, destinationFile)
      const info = await this.fs.lstat(sourceFile)
      if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Unsafe External Chrome package file: ${relative}`)
      await this.fs.mkdir(path.dirname(destinationFile), { recursive: true, mode: 0o755 })
      await this.fs.copyFile(sourceFile, destinationFile)
      await this.fs.chmod(destinationFile, 0o644)
    }
  }

  private async copyDirectorySafe(source: string, destination: string): Promise<void> {
    const files = await this.walkSafeFiles(source)
    const inventory: Record<string, string> = {}
    for (const file of files) inventory[file] = sha256(await this.fs.readFile(path.join(source, file)))
    await this.copyInventory(source, destination, inventory)
  }

  private async atomicJson(destination: string, value: unknown): Promise<void> {
    await this.fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
    const temporary = path.join(path.dirname(destination), `.atomic-${path.basename(destination)}-${randomUUID()}`)
    await this.fs.writeFile(temporary, `${stableJson(value)}\n`, { encoding: 'utf8', mode: 0o600 })
    await this.syncFile(temporary)
    await this.renameReplace(temporary, destination)
    await this.syncDirectory(path.dirname(destination))
  }

  private async renameReplace(source: string, destination: string): Promise<void> {
    try {
      await this.renameWithRetry(source, destination)
    } catch (error) {
      // EPERM/EACCES/EBUSY are sharing/AV locks, not replace collisions. Moving
      // the selected file aside after such an error would violate fail-safe rollback.
      if (this.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const backup = `${destination}.replace-${randomUUID()}`
      if (await exists(this.fs, destination)) await this.renameWithRetry(destination, backup)
      try {
        await this.renameWithRetry(source, destination)
        await this.fs.rm(backup, { force: true })
      } catch (replaceError) {
        if (!(await exists(this.fs, destination)) && await exists(this.fs, backup)) await this.renameWithRetry(backup, destination)
        throw replaceError
      }
    }
  }

  private async renameWithRetry(source: string, destination: string): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.fs.rename(source, destination)
        return
      } catch (error) {
        const fsError = error as NodeJS.ErrnoException
        if (!['EACCES', 'EPERM', 'EBUSY'].includes(fsError.code ?? '')) throw error
        if (this.platform === 'win32') this.manualRetry = true
        if (!this.options.sharingRetry) throw error
        if (await this.options.sharingRetry(() => this.fs.rename(source, destination), fsError, attempt)) return
        throw error
      }
    }
  }

  private async ensureSafeRoot(): Promise<void> {
    await this.fs.mkdir(this.paths.integrationRoot, { recursive: true, mode: 0o700 })
    let current = this.paths.dataRoot
    for (const segment of ['integrations', 'external-chrome']) {
      current = path.join(current, segment)
      const info = await this.fs.lstat(current)
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Unsafe External Chrome deployment path: ${current}`)
    }
    for (const stableDirectory of [
      this.paths.extension, this.paths.nativeHost, this.paths.nativeHostManifests,
      this.paths.state, this.paths.auth, this.paths.run, this.paths.deployment,
    ]) {
      if (!(await exists(this.fs, stableDirectory))) continue
      const info = await this.fs.lstat(stableDirectory)
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Unsafe External Chrome deployment path: ${stableDirectory}`)
    }
    if (await exists(this.fs, this.paths.extension)) await this.walkSafeFiles(this.paths.extension)
  }

  private async syncTree(root: string): Promise<void> {
    for (const file of await this.walkSafeFiles(root)) await this.syncFile(path.join(root, file))
    await this.syncDirectory(root)
  }

  private async syncFile(file: string): Promise<void> {
    const handle = await this.fs.open(file, 'r')
    try {
      await handle.sync()
    } catch (error) {
      if (!fsyncIgnoredCodes.has((error as NodeJS.ErrnoException).code ?? '')) throw error
    } finally {
      await handle.close()
    }
  }

  private async syncDirectory(directory: string): Promise<void> {
    let handle: FileHandle | undefined
    try {
      handle = await this.fs.open(directory, 'r')
      await handle.sync()
    } catch (error) {
      if (!fsyncIgnoredCodes.has((error as NodeJS.ErrnoException).code ?? '')) throw error
    } finally {
      await handle?.close()
    }
  }

  private async phase(phase: DeploymentPhase, manifest: ExternalChromePackageManifest): Promise<void> {
    await this.atomicJson(this.paths.journal, { schemaVersion: 1, phase, packageVersion: manifest.packageVersion })
    await this.options.afterPhase?.(phase)
  }

  private async readStagedDeployment(): Promise<{ root: string; manifest: ExternalChromePackageManifest } | null> {
    try {
      const markerPath = path.join(this.paths.state, 'staged-deployment.json')
      if ((await this.fs.stat(markerPath)).size > 1_024) return null
      const value = JSON.parse(await this.fs.readFile(markerPath, 'utf8')) as unknown
      if (!isExactObject(value, ['schemaVersion', 'directory', 'payloadSha256', 'nativeSha256']) || value.schemaVersion !== 1 ||
        typeof value.directory !== 'string' || !/^staged-[a-f0-9]{16}-[a-f0-9]{16}-[a-f0-9]{16}$/u.test(value.directory) ||
        typeof value.payloadSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.payloadSha256) ||
        typeof value.nativeSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.nativeSha256)) return null
      const root = path.join(this.paths.deployment, value.directory)
      assertPathInside(this.paths.deployment, root)
      const manifest = await this.readPackageManifest(path.join(root, 'package-manifest.json'))
      if (manifest.extension.payloadSha256 !== value.payloadSha256 || manifest.nativeHost.sha256 !== value.nativeSha256) return null
      this.assertCompatible(manifest)
      await this.validatePackagedResources(manifest, root)
      await this.assertSameVersionContentPolicy(manifest)
      return { root, manifest }
    } catch {
      return null
    }
  }

  private async readSelector(file: string): Promise<ExternalChromeSelector | null> {
    return this.readPersisted(file, parseSelector)
  }

  private async readInstall(file: string): Promise<ExternalChromeInstallRecord | null> {
    return this.readPersisted(file, parseInstallRecord)
  }

  private async readPersisted<T>(file: string, parse: (value: unknown) => T): Promise<T | null> {
    try {
      if ((await this.fs.stat(file)).size > MAX_PERSISTED_STATE_BYTES) return null
      return parse(JSON.parse(await this.fs.readFile(file, 'utf8')) as unknown)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError || error instanceof PersistedStateError) return null
      throw error
    }
  }

  private async assertSafeDeploymentDirectories(): Promise<void> {
    for (const directory of [
      this.paths.dataRoot,
      path.join(this.paths.dataRoot, 'integrations'),
      this.paths.integrationRoot,
      this.paths.extension,
      this.paths.payloads,
      this.paths.nativeHost,
      this.paths.state,
    ]) {
      const info = await this.fs.lstat(directory)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe External Chrome deployment path: ${directory}`)
    }
  }

  private assertInstallCompatible(install: ExternalChromeInstallRecord): void {
    this.assertInstallNonDesktopCompatible(install)
    if (!this.isInstallDesktopCompatible(install)) {
      throw new Error('External Chrome deployment is incompatible with this Desktop version')
    }
  }

  private assertInstallNonDesktopCompatible(install: ExternalChromeInstallRecord): void {
    if (install.platform !== this.platform || install.architecture !== this.architecture) {
      throw new Error('External Chrome deployed native host targets another platform')
    }
    if (install.shellAbi < install.shellAbiCompatibility.min || install.shellAbi > install.shellAbiCompatibility.max) {
      throw new Error('External Chrome deployed shell ABI is incompatible')
    }
    if (install.nativeProtocolCompatibility.max < EXTERNAL_CHROME_PROTOCOL_MIN_VERSION || install.nativeProtocolCompatibility.min > EXTERNAL_CHROME_PROTOCOL_MAX_VERSION) {
      throw new Error('External Chrome deployed native protocol is incompatible')
    }
  }

  private isInstallDesktopCompatible(install: ExternalChromeInstallRecord): boolean {
    return versionInRange(this.options.desktopVersion, install.desktopCompatibility.min, install.desktopCompatibility.max)
  }

  private assertCompatible(manifest: ExternalChromePackageManifest): void {
    if (manifest.nativeHost.platform !== this.platform || manifest.nativeHost.architecture !== this.architecture) {
      throw new Error(`External Chrome native host targets ${manifest.nativeHost.platform}/${manifest.nativeHost.architecture}, not ${this.platform}/${this.architecture}`)
    }
    if (!versionInRange(this.options.desktopVersion, manifest.compatibility.desktop.min, manifest.compatibility.desktop.max)) {
      throw new Error(`External Chrome package is incompatible with Desktop ${this.options.desktopVersion}`)
    }
    if (manifest.extension.shellAbi < manifest.compatibility.shellAbi.min || manifest.extension.shellAbi > manifest.compatibility.shellAbi.max) {
      throw new Error('External Chrome shell ABI is outside its declared compatibility range')
    }
    if (manifest.nativeHost.protocol.max < EXTERNAL_CHROME_PROTOCOL_MIN_VERSION || manifest.nativeHost.protocol.min > EXTERNAL_CHROME_PROTOCOL_MAX_VERSION) {
      throw new Error('External Chrome native host protocol is incompatible with this Desktop')
    }
  }
}

function selectorFromManifest(manifest: ExternalChromePackageManifest): ExternalChromeSelector {
  return {
    schemaVersion: 1,
    shellAbi: manifest.extension.shellAbi,
    payloadVersion: manifest.extension.payloadVersion,
    payloadSha256: manifest.extension.payloadSha256,
    payloadDirectory: manifest.extension.payloadDirectory,
    payloadFiles: manifest.extension.payloadFiles,
  }
}

function installRecordFromManifest(manifest: ExternalChromePackageManifest): ExternalChromeInstallRecord {
  return {
    schemaVersion: 1,
    packageVersion: manifest.packageVersion,
    extensionId: manifest.extension.extensionId,
    publicKeySha256: manifest.extension.publicKeySha256,
    shellAbi: manifest.extension.shellAbi,
    shellSha256: manifest.extension.shellSha256,
    shellFiles: manifest.extension.shellFiles,
    payloadVersion: manifest.extension.payloadVersion,
    payloadSha256: manifest.extension.payloadSha256,
    payloadDirectory: manifest.extension.payloadDirectory,
    payloadFiles: manifest.extension.payloadFiles,
    nativeVersion: manifest.nativeHost.version,
    nativeSha256: manifest.nativeHost.sha256,
    nativeProtocolCompatibility: { min: manifest.nativeHost.protocol.min, max: manifest.nativeHost.protocol.max },
    platform: manifest.nativeHost.platform,
    architecture: manifest.nativeHost.architecture,
    desktopCompatibility: { ...manifest.compatibility.desktop },
    shellAbiCompatibility: { ...manifest.compatibility.shellAbi },
  }
}

export function deploymentContentEquals(
  left: Pick<ExternalChromeInstallRecord, 'shellSha256' | 'payloadSha256' | 'nativeSha256'>,
  right: Pick<ExternalChromeInstallRecord, 'shellSha256' | 'payloadSha256' | 'nativeSha256'>,
): boolean {
  return left.shellSha256 === right.shellSha256
    && left.payloadSha256 === right.payloadSha256
    && left.nativeSha256 === right.nativeSha256
}

function selectorFromInstall(install: ExternalChromeInstallRecord): ExternalChromeSelector {
  return {
    schemaVersion: 1,
    shellAbi: install.shellAbi,
    payloadVersion: install.payloadVersion,
    payloadSha256: install.payloadSha256,
    payloadDirectory: install.payloadDirectory,
    payloadFiles: install.payloadFiles,
  }
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const SAFE_VERSION_PATTERN = /^[A-Za-z0-9._+-]{1,128}$/u
const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9._+-]{1,256}$/u
const SAFE_RELATIVE_FILE_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._+/-]{1,512}$/u
const MAX_INVENTORY_FILES = 4_096
const MAX_PERSISTED_STATE_BYTES = 4 * 1_024 * 1_024
const MAX_ABI = 1_000_000

class PersistedStateError extends Error {}

function parseSelector(value: unknown): ExternalChromeSelector {
  if (!isExactObject(value, [
    'schemaVersion', 'shellAbi', 'payloadVersion', 'payloadSha256', 'payloadDirectory', 'payloadFiles',
  ])) throw new PersistedStateError('External Chrome selector fields are invalid')
  if (value.schemaVersion !== 1) throw new PersistedStateError('External Chrome selector schema is invalid')
  const shellAbi = boundedPositiveInteger(value.shellAbi, 'selector.shellAbi')
  const payloadVersion = safeVersion(value.payloadVersion, 'selector.payloadVersion')
  const payloadSha256 = persistedHash(value.payloadSha256, 'selector.payloadSha256')
  const payloadDirectory = safePayloadDirectory(value.payloadDirectory, payloadVersion, payloadSha256)
  const payloadFiles = persistedInventory(value.payloadFiles, 'selector.payloadFiles')
  return { schemaVersion: 1, shellAbi, payloadVersion, payloadSha256, payloadDirectory, payloadFiles }
}

function parseInstallRecord(value: unknown): ExternalChromeInstallRecord {
  if (!isExactObject(value, [
    'schemaVersion', 'packageVersion', 'extensionId', 'publicKeySha256', 'shellAbi', 'shellSha256', 'shellFiles',
    'payloadVersion', 'payloadSha256', 'payloadDirectory', 'payloadFiles', 'nativeVersion', 'nativeSha256', 'nativeProtocolCompatibility',
    'platform', 'architecture', 'desktopCompatibility', 'shellAbiCompatibility',
  ])) throw new PersistedStateError('External Chrome install fields are invalid')
  if (value.schemaVersion !== 1) throw new PersistedStateError('External Chrome install schema is invalid')
  const packageVersion = safeVersion(value.packageVersion, 'install.packageVersion')
  if (typeof value.extensionId !== 'string' || !/^[a-p]{32}$/u.test(value.extensionId)) throw new PersistedStateError('install.extensionId is invalid')
  const extensionId = value.extensionId
  const publicKeySha256 = persistedHash(value.publicKeySha256, 'install.publicKeySha256')
  const shellAbi = boundedPositiveInteger(value.shellAbi, 'install.shellAbi')
  const shellSha256 = persistedHash(value.shellSha256, 'install.shellSha256')
  const shellFiles = persistedInventory(value.shellFiles, 'install.shellFiles')
  const payloadVersion = safeVersion(value.payloadVersion, 'install.payloadVersion')
  const payloadSha256 = persistedHash(value.payloadSha256, 'install.payloadSha256')
  const payloadDirectory = safePayloadDirectory(value.payloadDirectory, payloadVersion, payloadSha256)
  const payloadFiles = persistedInventory(value.payloadFiles, 'install.payloadFiles')
  const nativeVersion = safeVersion(value.nativeVersion, 'install.nativeVersion')
  const nativeSha256 = persistedHash(value.nativeSha256, 'install.nativeSha256')
  const nativeProtocolCompatibility = parseIntegerRange(value.nativeProtocolCompatibility, 'install.nativeProtocolCompatibility')
  if (value.platform !== 'darwin' && value.platform !== 'linux' && value.platform !== 'win32') throw new PersistedStateError('install.platform is invalid')
  const platform = value.platform
  const architecture = safeVersion(value.architecture, 'install.architecture')
  const desktopCompatibility = parseVersionRange(value.desktopCompatibility, 'install.desktopCompatibility')
  const shellAbiCompatibility = parseIntegerRange(value.shellAbiCompatibility, 'install.shellAbiCompatibility')
  return {
    schemaVersion: 1, packageVersion, extensionId, publicKeySha256, shellAbi, shellSha256, shellFiles,
    payloadVersion, payloadSha256, payloadDirectory, payloadFiles, nativeVersion, nativeSha256, nativeProtocolCompatibility,
    platform, architecture, desktopCompatibility, shellAbiCompatibility,
  }
}

function parseVersionRange(value: unknown, label: string): { min: string; max: string } {
  if (!isExactObject(value, ['min', 'max'])) throw new PersistedStateError(`${label} fields are invalid`)
  const min = safeVersion(value.min, `${label}.min`)
  const max = safeVersion(value.max, `${label}.max`)
  if (compareVersion(min, max) > 0) throw new PersistedStateError(`${label} is invalid`)
  return { min, max }
}

function parseIntegerRange(value: unknown, label: string): { min: number; max: number } {
  if (!isExactObject(value, ['min', 'max'])) throw new PersistedStateError(`${label} fields are invalid`)
  const min = boundedPositiveInteger(value.min, `${label}.min`)
  const max = boundedPositiveInteger(value.max, `${label}.max`)
  if (min > max) throw new PersistedStateError(`${label} is invalid`)
  return { min, max }
}

function persistedInventory(value: unknown, label: string): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PersistedStateError(`${label} is invalid`)
  const entries = Object.entries(value)
  if (entries.length < 1 || entries.length > MAX_INVENTORY_FILES) throw new PersistedStateError(`${label} size is invalid`)
  const inventory: Record<string, string> = Object.create(null) as Record<string, string>
  for (const [relative, digest] of entries) {
    if (
      !SAFE_RELATIVE_FILE_PATTERN.test(relative)
      || relative.includes('\\')
      || relative.split('/').includes('.')
      || path.posix.normalize(relative) !== relative
    ) {
      throw new PersistedStateError(`${label} contains an unsafe relative file`)
    }
    inventory[relative] = persistedHash(digest, `${label}.${relative}`)
  }
  return inventory
}

function safePayloadDirectory(value: unknown, version: string, digest: string): string {
  if (typeof value !== 'string' || !SAFE_SEGMENT_PATTERN.test(value) || value === '.' || value === '..' || value.includes('/') || value.includes('\\')) {
    throw new PersistedStateError('selector payloadDirectory is invalid')
  }
  if (value !== `${version}-${digest}`) throw new PersistedStateError('selector payloadDirectory identity is invalid')
  return value
}

function safeVersion(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SAFE_VERSION_PATTERN.test(value)) throw new PersistedStateError(`${label} is invalid`)
  return value
}

function persistedHash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) throw new PersistedStateError(`${label} is invalid`)
  return value
}

function boundedPositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_ABI) throw new PersistedStateError(`${label} is invalid`)
  return value as number
}

function isExactObject(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const actual = Object.keys(value).sort()
  return actual.join('\0') === [...keys].sort().join('\0')
}

function selectorEquals(left: ExternalChromeSelector, right: ExternalChromeSelector): boolean {
  return stableJson(left) === stableJson(right)
}

function selectorMatchesInstall(selector: ExternalChromeSelector, install: ExternalChromeInstallRecord): boolean {
  return selectorEquals(selector, selectorFromInstall(install))
}

function extensionIdFromPublicKeyHash(hash: string): string {
  return hash.slice(0, 32).replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)))
}

function isManifestWithKey(value: unknown): value is { key: string } {
  return !!value && typeof value === 'object' && !Array.isArray(value) && typeof (value as { key?: unknown }).key === 'string'
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
}

function versionInRange(version: string, min: string, max: string): boolean {
  return compareVersion(version, min) >= 0 && compareVersion(version, max) <= 0
}

function compareVersion(left: string, right: string): number {
  const parse = (value: string): number[] => (value.match(/\d+/g) ?? []).slice(0, 4).map(Number)
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return Math.sign(difference)
  }
  return 0
}

async function inventoryFor(fs: DeployerFileSystem, root: string): Promise<Record<string, string>> {
  const inventory: Record<string, string> = {}
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      const info = await fs.lstat(absolute)
      if (info.isSymbolicLink()) throw new Error(`External Chrome payload staging contains a symlink: ${absolute}`)
      if (info.isDirectory()) await visit(absolute)
      else if (info.isFile()) inventory[path.relative(root, absolute).split(path.sep).join('/')] = sha256(await fs.readFile(absolute))
    }
  }
  await visit(root)
  return inventory
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function fileHasHash(fs: DeployerFileSystem, target: string, expectedHash: string): Promise<boolean> {
  try {
    return sha256(await fs.readFile(target)) === expectedHash
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function exists(fs: DeployerFileSystem, target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}
