import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  EXTERNAL_CHROME_EXTENSION_ORIGIN,
  EXTERNAL_CHROME_NATIVE_HOST_NAME,
  type ExternalChromeRegistrationState,
  type ExternalChromeTrustState,
} from '@forge/protocol'
import { dataDirectoryHash } from './auth-rendezvous.js'
import { resolveExternalChromeDataPaths } from './data-paths.js'

const execFileAsync = promisify(execFile)
const HOST_DESCRIPTION = 'Forge External Chrome bridge'

export interface NativeHostManifest {
  name: typeof EXTERNAL_CHROME_NATIVE_HOST_NAME
  description: typeof HOST_DESCRIPTION
  path: string
  type: 'stdio'
  allowed_origins: [typeof EXTERNAL_CHROME_EXTENSION_ORIGIN]
}

interface RegistrationOwnership {
  schemaVersion: 1
  platform: 'darwin' | 'linux' | 'win32'
  registrationTarget: string
  manifestPath: string
}

interface RegistrationTransferTransaction {
  schemaVersion: 1
  identity: string
  dataDirHash: string
  ownershipPath: string
  canonicalManifest: string
}

export interface ForgeRegistrationConflictEvidence {
  /** Opaque digest of the exact global target, old canonical manifest, and ownership record. */
  identity: string
  dataDirHash: string
}

export interface NativeRegistrationInspection {
  registration: ExternalChromeRegistrationState
  trust: ExternalChromeTrustState
  detail?: string
  /** Present only when the conflicting record is proven to be Forge-owned. */
  forgeConflict?: ForgeRegistrationConflictEvidence
  /** Exact durable transaction proving the global target already moved here. */
  completedForgeTransfer?: ForgeRegistrationConflictEvidence
}

export interface ExternalChromeNativeRegistration {
  inspect(): Promise<NativeRegistrationInspection>
  repair(): Promise<NativeRegistrationInspection>
  transferForgeOwnedConflict(evidence: ForgeRegistrationConflictEvidence): Promise<NativeRegistrationInspection>
  remove(): Promise<NativeRegistrationInspection>
}

export function buildNativeHostManifest(executable: string): NativeHostManifest {
  if (!path.isAbsolute(executable)) throw new Error('Native messaging host executable path must be absolute')
  return {
    name: EXTERNAL_CHROME_NATIVE_HOST_NAME,
    description: HOST_DESCRIPTION,
    path: path.normalize(executable),
    type: 'stdio',
    allowed_origins: [EXTERNAL_CHROME_EXTENSION_ORIGIN],
  }
}

export interface ExecutableTrustVerifier {
  verify(executable: string): Promise<ExternalChromeTrustState>
}

export interface NativeProcessResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface NativeProcessFacade {
  run(file: string, args: string[]): Promise<NativeProcessResult>
}

export class NodeNativeProcessFacade implements NativeProcessFacade {
  async run(file: string, args: string[]): Promise<NativeProcessResult> {
    try {
      const result = await execFileAsync(file, args, { windowsHide: true })
      return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 }
    } catch (error) {
      const value = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number }
      return {
        stdout: value.stdout ?? '',
        stderr: value.stderr ?? value.message,
        exitCode: typeof value.code === 'number' ? value.code : 1,
      }
    }
  }
}

export class PlatformExecutableTrustVerifier implements ExecutableTrustVerifier {
  constructor(
    private readonly platform: NodeJS.Platform,
    private readonly processFacade: NativeProcessFacade = new NodeNativeProcessFacade(),
  ) {}

  async verify(executable: string): Promise<ExternalChromeTrustState> {
    try {
      const stat = await fs.stat(executable)
      if (!stat.isFile()) return 'missing'
      if (this.platform !== 'win32' && (stat.mode & 0o111) === 0) return 'untrusted'
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
      return 'untrusted'
    }
    if (this.platform === 'linux') return 'unsupported'
    if (this.platform === 'darwin') {
      const codeSign = await this.processFacade.run('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', executable])
      if (codeSign.exitCode !== 0) return 'untrusted'
      const gatekeeper = await this.processFacade.run('/usr/sbin/spctl', ['--assess', '--type', 'execute', executable])
      return gatekeeper.exitCode === 0 ? 'trusted' : 'untrusted'
    }
    if (this.platform === 'win32') {
      const escaped = executable.replaceAll("'", "''")
      const result = await this.processFacade.run('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `(Get-AuthenticodeSignature -LiteralPath '${escaped}').Status`,
      ])
      return result.exitCode === 0 && result.stdout.trim() === 'Valid' ? 'trusted' : 'untrusted'
    }
    return 'unsupported'
  }
}

interface RegistrationPaths {
  canonicalManifest: string
  ownership: string
  transfer: string
  executable: string
}

abstract class OwnedNativeRegistration implements ExternalChromeNativeRegistration {
  protected readonly manifest: NativeHostManifest

  constructor(
    protected readonly platform: 'darwin' | 'linux' | 'win32',
    protected readonly paths: RegistrationPaths,
    protected readonly registrationTarget: string,
    protected readonly trustVerifier: ExecutableTrustVerifier,
  ) {
    this.manifest = buildNativeHostManifest(paths.executable)
  }

  async inspect(): Promise<NativeRegistrationInspection> {
    const [current, currentExists, owner, trust] = await Promise.all([
      this.readCurrent(),
      this.currentExists(),
      readJson<RegistrationOwnership>(this.paths.ownership),
      this.trustVerifier.verify(this.paths.executable),
    ])
    const ownershipMatches = this.ownershipMatches(owner)
    if (!current) {
      if (currentExists) {
        return {
          registration: ownershipMatches ? 'needs-repair' : 'conflict',
          trust,
          detail: ownershipMatches ? 'Forge-owned native registration is malformed' : 'Registration target is owned by another installation',
        }
      }
      return { registration: ownershipMatches ? 'needs-repair' : 'not-registered', trust }
    }
    if (manifestEquals(current, this.manifest)) {
      const transfer = await this.readTransferTransaction()
      return {
        registration: ownershipMatches ? 'owned' : 'needs-repair',
        trust,
        ...(transfer ? { completedForgeTransfer: transferEvidence(transfer) } : {}),
      }
    }
    const forgeConflict = ownershipMatches ? null : await this.proveForgeConflict(current)
    return {
      registration: ownershipMatches ? 'needs-repair' : 'conflict',
      trust,
      detail: ownershipMatches ? 'Forge-owned native registration drifted' : forgeConflict
        ? 'Registration target belongs to another Forge data directory'
        : 'Registration target is owned by another installation',
      ...(forgeConflict ? { forgeConflict } : {}),
    }
  }

  async repair(): Promise<NativeRegistrationInspection> {
    const before = await this.inspect()
    if (before.registration === 'conflict') throw new Error(before.detail ?? 'External Chrome registration conflicts with another owner')
    await writeJsonAtomic(this.paths.canonicalManifest, this.manifest)
    await this.writeCurrent(this.manifest)
    await writeJsonAtomic(this.paths.ownership, {
      schemaVersion: 1,
      platform: this.platform,
      registrationTarget: this.registrationTarget,
      manifestPath: this.paths.canonicalManifest,
    } satisfies RegistrationOwnership)
    await fs.rm(this.paths.transfer, { force: true })
    return this.inspect()
  }

  async transferForgeOwnedConflict(evidence: ForgeRegistrationConflictEvidence): Promise<NativeRegistrationInspection> {
    let transaction = await this.readTransferTransaction()
    const current = await this.readCurrent()
    if (transaction) {
      if (!evidenceEquals(transferEvidence(transaction), evidence)) {
        throw new Error('External Chrome registration transfer authorization is stale')
      }
      if (!current || (!manifestEquals(current, this.manifest) &&
        !evidenceEquals((await this.proveForgeConflictRecord(current))?.evidence, evidence))) {
        throw new Error('External Chrome registration transfer authorization is stale')
      }
    } else {
      const before = await this.inspect()
      if (before.registration !== 'conflict' || !evidenceEquals(before.forgeConflict, evidence)) {
        throw new Error('External Chrome registration transfer authorization is stale')
      }
      const old = current ? await this.proveForgeConflictRecord(current) : null
      if (!old || !evidenceEquals(old.evidence, evidence)) {
        throw new Error('External Chrome registration transfer authorization is stale')
      }
      transaction = {
        schemaVersion: 1,
        identity: evidence.identity,
        dataDirHash: evidence.dataDirHash,
        ownershipPath: old.ownershipPath,
        canonicalManifest: old.canonicalManifest,
      }
      // Persist exact retry authority before changing either the global target or
      // its new ownership record. Every partial transfer is then resumable.
      await writeJsonAtomic(this.paths.transfer, transaction)
    }

    await writeJsonAtomic(this.paths.canonicalManifest, this.manifest)
    await this.writeCurrent(this.manifest)
    await writeJsonAtomic(this.paths.ownership, {
      schemaVersion: 1,
      platform: this.platform,
      registrationTarget: this.registrationTarget,
      manifestPath: this.paths.canonicalManifest,
    } satisfies RegistrationOwnership)
    // Remove only the exact old records captured before the global transfer.
    if (transaction.ownershipPath !== this.paths.ownership) await fs.rm(transaction.ownershipPath, { force: true })
    if (transaction.canonicalManifest !== this.paths.canonicalManifest) await fs.rm(transaction.canonicalManifest, { force: true })
    return this.inspect()
  }

  async remove(): Promise<NativeRegistrationInspection> {
    const before = await this.inspect()
    const owner = await readJson<RegistrationOwnership>(this.paths.ownership)
    if (!this.ownershipMatches(owner)) {
      if (before.registration === 'not-registered') return before
      throw new Error('Refusing to remove an External Chrome registration without Forge ownership')
    }
    if (before.registration === 'conflict') throw new Error('Refusing to remove an External Chrome registration owned by another installation')
    if (before.registration === 'needs-repair' && await this.hasDriftedCurrent()) {
      throw new Error('Refusing to remove a drifted External Chrome registration')
    }
    await this.removeCurrent()
    await fs.rm(this.paths.canonicalManifest, { force: true })
    await fs.rm(this.paths.ownership, { force: true })
    await fs.rm(this.paths.transfer, { force: true })
    return this.inspect()
  }

  protected abstract readCurrent(): Promise<NativeHostManifest | null>
  protected abstract currentExists(): Promise<boolean>
  protected abstract writeCurrent(manifest: NativeHostManifest): Promise<void>
  protected abstract removeCurrent(): Promise<void>

  private ownershipMatches(owner: RegistrationOwnership | null): boolean {
    return owner?.schemaVersion === 1
      && owner.platform === this.platform
      && owner.registrationTarget === this.registrationTarget
      && owner.manifestPath === this.paths.canonicalManifest
  }

  private async hasDriftedCurrent(): Promise<boolean> {
    const current = await this.readCurrent()
    return current !== null && !manifestEquals(current, this.manifest)
  }

  private async readTransferTransaction(): Promise<RegistrationTransferTransaction | null> {
    const value = await readJson<RegistrationTransferTransaction>(this.paths.transfer)
    if (!value || value.schemaVersion !== 1 || !/^[a-f0-9]{64}$/u.test(value.identity) ||
      !/^[a-f0-9]{16}$/u.test(value.dataDirHash) || !path.isAbsolute(value.ownershipPath) ||
      !path.isAbsolute(value.canonicalManifest) || Object.keys(value).sort().join(',') !==
      'canonicalManifest,dataDirHash,identity,ownershipPath,schemaVersion') return null
    const marker = `${path.sep}integrations${path.sep}external-chrome${path.sep}native-host-manifests${path.sep}`
    const normalizedManifest = path.normalize(value.canonicalManifest)
    const markerIndex = normalizedManifest.lastIndexOf(marker)
    if (markerIndex <= 0) return null
    const oldDataRoot = normalizedManifest.slice(0, markerIndex)
    const oldPaths = resolveExternalChromeDataPaths(oldDataRoot, this.platform)
    if (normalizedManifest !== path.join(oldPaths.nativeHostManifests, `${EXTERNAL_CHROME_NATIVE_HOST_NAME}.json`) ||
      path.normalize(value.ownershipPath) !== path.join(oldPaths.state, 'registration.json') ||
      dataDirectoryHash(oldDataRoot) !== value.dataDirHash) return null
    return value
  }

  private async proveForgeConflict(current: NativeHostManifest): Promise<ForgeRegistrationConflictEvidence | null> {
    return (await this.proveForgeConflictRecord(current))?.evidence ?? null
  }

  private async proveForgeConflictRecord(current: NativeHostManifest): Promise<{
    evidence: ForgeRegistrationConflictEvidence
    ownershipPath: string
    canonicalManifest: string
  } | null> {
    if (current.name !== EXTERNAL_CHROME_NATIVE_HOST_NAME || current.description !== HOST_DESCRIPTION ||
      current.type !== 'stdio' || current.allowed_origins?.length !== 1 ||
      current.allowed_origins[0] !== EXTERNAL_CHROME_EXTENSION_ORIGIN || !path.isAbsolute(current.path)) return null
    const marker = `${path.sep}integrations${path.sep}external-chrome${path.sep}native-host${path.sep}`
    const markerIndex = path.normalize(current.path).lastIndexOf(marker)
    if (markerIndex <= 0) return null
    const oldDataRoot = path.normalize(current.path).slice(0, markerIndex)
    const oldPaths = resolveExternalChromeDataPaths(oldDataRoot, this.platform)
    if (path.normalize(current.path) !== path.normalize(oldPaths.nativeHostExecutable)) return null
    const canonicalManifest = path.join(oldPaths.nativeHostManifests, `${EXTERNAL_CHROME_NATIVE_HOST_NAME}.json`)
    const ownershipPath = path.join(oldPaths.state, 'registration.json')
    const [canonicalManifestValue, owner] = await Promise.all([
      readJson<NativeHostManifest>(canonicalManifest),
      readJson<RegistrationOwnership>(ownershipPath),
    ])
    if (!canonicalManifestValue || !manifestEquals(canonicalManifestValue, current) || owner?.schemaVersion !== 1 ||
      owner.platform !== this.platform || owner.registrationTarget !== this.registrationTarget ||
      owner.manifestPath !== canonicalManifest) return null
    const identity = createHash('sha256').update(JSON.stringify({
      platform: this.platform,
      registrationTarget: this.registrationTarget,
      canonicalManifest,
      owner,
      manifest: current,
    })).digest('hex')
    return { evidence: { identity, dataDirHash: dataDirectoryHash(oldDataRoot) }, ownershipPath, canonicalManifest }
  }
}

export class PosixNativeRegistration extends OwnedNativeRegistration {
  constructor(options: {
    platform: 'darwin' | 'linux'
    dataRoot: string
    registrationDirectory: string
    trustVerifier?: ExecutableTrustVerifier
  }) {
    const dataPaths = resolveExternalChromeDataPaths(options.dataRoot, options.platform)
    super(
      options.platform,
      {
        canonicalManifest: path.join(dataPaths.nativeHostManifests, `${EXTERNAL_CHROME_NATIVE_HOST_NAME}.json`),
        ownership: path.join(dataPaths.state, 'registration.json'),
        transfer: path.join(dataPaths.state, 'registration-transfer.json'),
        executable: dataPaths.nativeHostExecutable,
      },
      path.join(options.registrationDirectory, `${EXTERNAL_CHROME_NATIVE_HOST_NAME}.json`),
      options.trustVerifier ?? new PlatformExecutableTrustVerifier(options.platform),
    )
  }

  protected readCurrent(): Promise<NativeHostManifest | null> {
    return readJson<NativeHostManifest>(this.registrationTarget)
  }

  protected async currentExists(): Promise<boolean> {
    try {
      await fs.lstat(this.registrationTarget)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  protected async writeCurrent(manifest: NativeHostManifest): Promise<void> {
    await writeJsonAtomic(this.registrationTarget, manifest)
  }

  protected async removeCurrent(): Promise<void> {
    await fs.rm(this.registrationTarget, { force: true })
  }
}

export interface RegistryFacade {
  readDefault(key: string): Promise<string | null>
  writeDefault(key: string, value: string): Promise<void>
  removeKey(key: string): Promise<void>
}

export class WindowsRegistryFacade implements RegistryFacade {
  constructor(private readonly processFacade: NativeProcessFacade = new NodeNativeProcessFacade()) {}

  async readDefault(key: string): Promise<string | null> {
    const result = await this.processFacade.run('reg.exe', ['query', key, '/ve'])
    if (result.exitCode !== 0) return null
    const match = result.stdout.match(/REG_SZ\s+(.+)$/mu)
    return match?.[1]?.trim() ?? null
  }

  async writeDefault(key: string, value: string): Promise<void> {
    const result = await this.processFacade.run('reg.exe', ['add', key, '/ve', '/t', 'REG_SZ', '/d', value, '/f'])
    if (result.exitCode !== 0) throw new Error('Windows native messaging registry write failed')
  }

  async removeKey(key: string): Promise<void> {
    const result = await this.processFacade.run('reg.exe', ['delete', key, '/f'])
    if (result.exitCode !== 0 && !/unable to find|not find/iu.test(`${result.stdout}\n${result.stderr}`)) {
      throw new Error('Windows native messaging registry removal failed')
    }
  }
}

export class WindowsNativeRegistration extends OwnedNativeRegistration {
  constructor(options: {
    dataRoot: string
    registry?: RegistryFacade
    trustVerifier?: ExecutableTrustVerifier
  }) {
    const dataPaths = resolveExternalChromeDataPaths(options.dataRoot, 'win32')
    const registryKey = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${EXTERNAL_CHROME_NATIVE_HOST_NAME}`
    super(
      'win32',
      {
        canonicalManifest: path.join(dataPaths.nativeHostManifests, `${EXTERNAL_CHROME_NATIVE_HOST_NAME}.json`),
        ownership: path.join(dataPaths.state, 'registration.json'),
        transfer: path.join(dataPaths.state, 'registration-transfer.json'),
        executable: dataPaths.nativeHostExecutable,
      },
      registryKey,
      options.trustVerifier ?? new PlatformExecutableTrustVerifier('win32'),
    )
    this.registry = options.registry ?? new WindowsRegistryFacade()
  }

  private readonly registry: RegistryFacade

  protected async currentExists(): Promise<boolean> {
    return (await this.registry.readDefault(this.registrationTarget)) !== null
  }

  protected async readCurrent(): Promise<NativeHostManifest | null> {
    const manifestPath = await this.registry.readDefault(this.registrationTarget)
    if (!manifestPath) return null
    return readJson<NativeHostManifest>(manifestPath)
  }

  protected async writeCurrent(_manifest: NativeHostManifest): Promise<void> {
    await this.registry.writeDefault(this.registrationTarget, this.paths.canonicalManifest)
  }

  protected removeCurrent(): Promise<void> {
    return this.registry.removeKey(this.registrationTarget)
  }
}

export function createExternalChromeNativeRegistration(options: {
  dataRoot: string
  platform?: NodeJS.Platform
  homeDirectory?: string
}): ExternalChromeNativeRegistration {
  const platform = options.platform ?? process.platform
  const homeDirectory = options.homeDirectory ?? os.homedir()
  if (platform === 'darwin') {
    return new PosixNativeRegistration({
      platform,
      dataRoot: options.dataRoot,
      registrationDirectory: path.join(homeDirectory, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts'),
    })
  }
  if (platform === 'linux') {
    return new PosixNativeRegistration({
      platform,
      dataRoot: options.dataRoot,
      registrationDirectory: path.join(homeDirectory, '.config', 'google-chrome', 'NativeMessagingHosts'),
    })
  }
  if (platform === 'win32') return new WindowsNativeRegistration({ dataRoot: options.dataRoot })
  return new UnsupportedNativeRegistration()
}

class UnsupportedNativeRegistration implements ExternalChromeNativeRegistration {
  inspect(): Promise<NativeRegistrationInspection> {
    return Promise.resolve({ registration: 'not-registered', trust: 'unsupported', detail: 'Platform is unsupported' })
  }
  repair(): Promise<NativeRegistrationInspection> {
    return Promise.reject(new Error('External Chrome native registration is unsupported on this platform'))
  }
  transferForgeOwnedConflict(): Promise<NativeRegistrationInspection> {
    return Promise.reject(new Error('External Chrome native registration transfer is unsupported on this platform'))
  }
  remove(): Promise<NativeRegistrationInspection> {
    return this.inspect()
  }
}

function transferEvidence(transaction: RegistrationTransferTransaction): ForgeRegistrationConflictEvidence {
  return { identity: transaction.identity, dataDirHash: transaction.dataDirHash }
}

function evidenceEquals(
  left: ForgeRegistrationConflictEvidence | undefined,
  right: ForgeRegistrationConflictEvidence,
): boolean {
  return left?.identity === right.identity && left.dataDirHash === right.dataDirHash
}

function manifestEquals(value: NativeHostManifest, expected: NativeHostManifest): boolean {
  return value?.name === expected.name
    && value.description === expected.description
    && value.path === expected.path
    && value.type === 'stdio'
    && Array.isArray(value.allowed_origins)
    && value.allowed_origins.length === 1
    && value.allowed_origins[0] === EXTERNAL_CHROME_EXTENSION_ORIGIN
    && Object.keys(value).length === 5
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return null
    throw error
  }
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.new-${process.pid}-${Date.now()}`
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  try {
    await fs.rename(temporary, file)
  } catch (error) {
    await fs.rm(temporary, { force: true })
    throw error
  }
}
