import { createHash, randomUUID } from 'node:crypto'
import * as nodeFs from 'node:fs/promises'
import path from 'node:path'
import type { FileHandle } from 'node:fs/promises'
import { assertPathInside, resolveExternalChromeDataPaths, type ExternalChromeDataPaths } from './data-paths.js'
import {
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
  shellAbi: number
  shellSha256: string
  payloadVersion: string
  payloadSha256: string
  payloadDirectory: string
  payloadFiles: Record<string, string>
  nativeVersion?: string
  nativeSha256: string
  platform: string
  architecture: string
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
}

export interface DeploymentLock {
  acquire(path: string): Promise<() => Promise<void>>
}

const fsyncIgnoredCodes = new Set(['EINVAL', 'ENOTSUP', 'EBADF', 'EPERM'])

export class FileDeploymentLock implements DeploymentLock {
  constructor(
    private readonly fs: DeployerFileSystem = nodeFs,
    private readonly isProcessAlive: (pid: number) => boolean = defaultIsProcessAlive,
  ) {}

  async acquire(lockPath: string): Promise<() => Promise<void>> {
    await this.fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 })
    let handle: FileHandle
    try {
      handle = await this.fs.open(lockPath, 'wx', 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const owner = Number.parseInt(await this.fs.readFile(lockPath, 'utf8').catch(() => ''), 10)
      if (Number.isSafeInteger(owner) && owner > 0 && this.isProcessAlive(owner)) {
        throw new Error('External Chrome deployment is already in progress')
      }
      await this.fs.rm(lockPath, { force: true })
      handle = await this.fs.open(lockPath, 'wx', 0o600)
    }
    try {
      await handle.writeFile(`${process.pid}\n`)
      await handle.sync()
    } catch (error) {
      await handle.close().catch(() => undefined)
      await this.fs.rm(lockPath, { force: true })
      throw error
    }
    return async () => {
      await handle.close().catch(() => undefined)
      await this.fs.rm(lockPath, { force: true })
    }
  }
}

export class ExternalChromeDeployer {
  readonly paths: ExternalChromeDataPaths
  private readonly fs: DeployerFileSystem
  private readonly platform: NodeJS.Platform
  private readonly architecture: string
  private readonly lock: DeploymentLock

  constructor(private readonly options: ExternalChromeDeployerOptions) {
    this.fs = options.fs ?? nodeFs
    this.platform = options.platform ?? process.platform
    this.architecture = options.architecture ?? process.arch
    this.paths = resolveExternalChromeDataPaths(options.dataRoot, this.platform)
    this.lock = options.lock ?? new FileDeploymentLock(this.fs)
  }

  async deploy(): Promise<ExternalChromeInstallRecord> {
    const release = await this.lock.acquire(this.paths.lock)
    try {
      await this.recoverUnlocked()
      const manifest = await readExternalChromePackageManifest(path.join(this.options.resourcesRoot, 'package-manifest.json'))
      this.assertCompatible(manifest)
      await this.validatePackagedResources(manifest)
      await this.phase('validated', manifest)

      const oldSelector = await this.readJson<ExternalChromeSelector>(path.join(this.paths.extension, 'current.json'))
      const selector = selectorFromManifest(manifest)
      const stagingPayload = path.join(this.paths.deployment, `.payload-${randomUUID()}`)
      await this.fs.mkdir(this.paths.deployment, { recursive: true, mode: 0o700 })
      await this.copyInventory(
        path.join(this.options.resourcesRoot, 'payload', manifest.extension.payloadDirectory),
        stagingPayload,
        manifest.extension.payloadFiles,
      )
      await this.syncTree(stagingPayload)
      await this.phase('payload-staged', manifest)

      const shellChanged = !(await this.shellMatches(manifest))
      if (shellChanged) {
        await this.installWithShellMigration(manifest, stagingPayload, oldSelector)
      } else {
        await this.installPayload(stagingPayload, selector.payloadDirectory)
      }
      await this.phase('payload-installed', manifest)

      if (oldSelector && oldSelector.payloadDirectory !== selector.payloadDirectory && await this.isValidPayload(oldSelector)) {
        await this.atomicJson(this.paths.previousState, oldSelector)
      }
      if (!shellChanged) await this.atomicJson(path.join(this.paths.extension, 'current.json'), selector)
      await this.phase('selector-written', manifest)

      await this.installNative(manifest)
      await this.phase('native-written', manifest)

      const record = installRecordFromManifest(manifest)
      await this.atomicJson(this.paths.installState, record)
      await this.retainCurrentAndPrevious(selector)
      await this.phase('complete', manifest)
      await this.fs.rm(this.paths.journal, { force: true })
      return record
    } finally {
      await release()
    }
  }

  async canRollback(): Promise<boolean> {
    const previous = await this.readJson<ExternalChromeSelector>(this.paths.previousState)
    if (!previous) return false
    if (await this.isValidPayload(previous)) return true
    const previousShell = path.join(this.paths.integrationRoot, 'extension.previous')
    const previousShellSelector = await this.readJson<ExternalChromeSelector>(path.join(previousShell, 'current.json'))
    return previousShellSelector?.payloadDirectory === previous.payloadDirectory
      && await this.isValidPayloadAt(previousShellSelector, path.join(previousShell, 'payloads'))
  }

  async rollback(): Promise<ExternalChromeSelector> {
    const release = await this.lock.acquire(this.paths.lock)
    try {
      await this.recoverUnlocked()
      const current = await this.readJson<ExternalChromeSelector>(path.join(this.paths.extension, 'current.json'))
      const previous = await this.readJson<ExternalChromeSelector>(this.paths.previousState)
      if (!previous) throw new Error('No valid External Chrome rollback payload is available')
      const previousShell = path.join(this.paths.integrationRoot, 'extension.previous')
      const previousShellSelector = await this.readJson<ExternalChromeSelector>(path.join(previousShell, 'current.json'))
      if (
        previousShellSelector?.payloadDirectory === previous.payloadDirectory &&
        await this.isValidPayloadAt(previousShellSelector, path.join(previousShell, 'payloads'))
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
        if (current) await this.atomicJson(this.paths.previousState, current)
        await this.rollbackNative()
        await this.updateInstallSelector(previousShellSelector)
        return previousShellSelector
      }
      if (!(await this.isValidPayload(previous))) throw new Error('No valid External Chrome rollback payload is available')
      await this.atomicJson(path.join(this.paths.extension, 'current.json'), previous)
      if (current && await this.isValidPayload(current)) await this.atomicJson(this.paths.previousState, current)
      await this.retainCurrentAndPrevious(previous)
      await this.rollbackNative()
      await this.updateInstallSelector(previous)
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

  private async updateInstallSelector(selector: ExternalChromeSelector): Promise<void> {
    const install = await this.readJson<ExternalChromeInstallRecord>(this.paths.installState)
    if (!install) return
    await this.atomicJson(this.paths.installState, {
      ...install,
      payloadVersion: selector.payloadVersion,
      payloadSha256: selector.payloadSha256,
      payloadDirectory: selector.payloadDirectory,
      payloadFiles: selector.payloadFiles,
    })
  }

  private async recoverUnlocked(): Promise<void> {
    await this.ensureSafeRoot()
    const previousShell = path.join(this.paths.integrationRoot, 'extension.previous')
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

    const current = await this.readJson<ExternalChromeSelector>(path.join(this.paths.extension, 'current.json'))
    if (!current || !(await this.isValidPayload(current))) {
      const installed = await this.readJson<ExternalChromeInstallRecord>(this.paths.installState)
      const installedSelector = installed ? selectorFromInstall(installed) : null
      const previous = await this.readJson<ExternalChromeSelector>(this.paths.previousState)
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
      return true
    } catch {
      return false
    }
  }

  private async validatePackagedResources(manifest: ExternalChromePackageManifest): Promise<void> {
    const shellRoot = path.join(this.options.resourcesRoot, 'extension-shell')
    const payloadRoot = path.join(this.options.resourcesRoot, 'payload', manifest.extension.payloadDirectory)
    const nativeRoot = path.join(this.options.resourcesRoot, 'native-host', `${this.platform}-${this.architecture}`)
    await this.validateInventory(shellRoot, manifest.extension.shellFiles)
    await this.validateInventory(payloadRoot, manifest.extension.payloadFiles)
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
  ): Promise<void> {
    const nextShell = path.join(this.paths.integrationRoot, 'extension.new')
    const previousShell = path.join(this.paths.integrationRoot, 'extension.previous')
    await this.fs.rm(nextShell, { recursive: true, force: true })
    await this.copyInventory(path.join(this.options.resourcesRoot, 'extension-shell'), nextShell, manifest.extension.shellFiles)
    const nextPayloads = path.join(nextShell, 'payloads')
    await this.fs.mkdir(nextPayloads, { recursive: true, mode: 0o755 })
    if (oldSelector && await this.isValidPayload(oldSelector)) {
      await this.copyDirectorySafe(path.join(this.paths.payloads, oldSelector.payloadDirectory), path.join(nextPayloads, oldSelector.payloadDirectory))
    }
    const previousSelector = await this.readJson<ExternalChromeSelector>(this.paths.previousState)
    if (previousSelector && previousSelector.payloadDirectory !== oldSelector?.payloadDirectory && await this.isValidPayload(previousSelector)) {
      await this.copyDirectorySafe(path.join(this.paths.payloads, previousSelector.payloadDirectory), path.join(nextPayloads, previousSelector.payloadDirectory))
    }
    const nextPayload = path.join(nextPayloads, manifest.extension.payloadDirectory)
    if (await exists(this.fs, nextPayload)) {
      await this.validateInventory(nextPayload, manifest.extension.payloadFiles)
      await this.fs.rm(stagingPayload, { recursive: true, force: true })
    } else await this.renameWithRetry(stagingPayload, nextPayload)
    await this.atomicJson(path.join(nextShell, 'current.json'), selectorFromManifest(manifest))
    if (oldSelector && oldSelector.payloadDirectory !== manifest.extension.payloadDirectory) {
      await this.atomicJson(this.paths.previousState, oldSelector)
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
        await this.fs.rm(destination, { recursive: true, force: true })
      }
    }
    await this.renameWithRetry(stagingPayload, destination)
  }

  private async installNative(manifest: ExternalChromePackageManifest): Promise<void> {
    await this.fs.mkdir(this.paths.nativeHost, { recursive: true, mode: 0o700 })
    const source = path.join(
      this.options.resourcesRoot,
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
        return
      }
      const previous = `${this.paths.nativeHostExecutable}.previous`
      await this.fs.rm(previous, { force: true })
      await this.renameWithRetry(this.paths.nativeHostExecutable, previous)
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

  private async rollbackNative(): Promise<void> {
    const previous = `${this.paths.nativeHostExecutable}.previous`
    if (!(await exists(this.fs, previous))) return
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
    const previous = await this.readJson<ExternalChromeSelector>(this.paths.previousState)
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
    if (!selector || selector.schemaVersion !== 1 || !selector.payloadDirectory) return false
    const root = path.join(payloadsRoot, selector.payloadDirectory)
    try {
      await this.validateInventory(root, selector.payloadFiles)
      return true
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
      if (this.platform !== 'win32' || !['EEXIST', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
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
        if (!this.options.sharingRetry || !['EACCES', 'EPERM', 'EBUSY'].includes(fsError.code ?? '')) throw error
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

  private async readJson<T>(file: string): Promise<T | null> {
    try {
      return JSON.parse(await this.fs.readFile(file, 'utf8')) as T
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return null
      throw error
    }
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
    shellAbi: manifest.extension.shellAbi,
    shellSha256: manifest.extension.shellSha256,
    payloadVersion: manifest.extension.payloadVersion,
    payloadSha256: manifest.extension.payloadSha256,
    payloadDirectory: manifest.extension.payloadDirectory,
    payloadFiles: manifest.extension.payloadFiles,
    nativeVersion: manifest.nativeHost.version,
    nativeSha256: manifest.nativeHost.sha256,
    platform: manifest.nativeHost.platform,
    architecture: manifest.nativeHost.architecture,
  }
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

async function exists(fs: DeployerFileSystem, target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}
