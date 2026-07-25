import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  EXTERNAL_CHROME_EXTENSION_ID,
  EXTERNAL_CHROME_PROTOCOL_MAX_VERSION,
  EXTERNAL_CHROME_PROTOCOL_MIN_VERSION,
  type ExternalChromeBuildInventory,
  type ExternalChromeCoordinatorStatus,
  type ExternalChromeSetupStatus,
} from '@forge/protocol'
import {
  createCurrentUserAccessController,
  createDesktopInstanceId,
  createRendezvousEpoch,
  externalChromeUserScope,
  ExternalChromeAuthStore,
  ExternalChromeAuthorityStore,
  type CurrentUserAccessController,
} from './auth-rendezvous.js'
import {
  NodeExternalChromeEndpointAuthority,
  type ExternalChromeEndpointAuthority,
  type ExternalChromeEndpointHandle,
} from './endpoint.js'
import { resolveExternalChromeDataPaths, type ExternalChromeDataPaths } from './data-paths.js'
import {
  readExternalChromePackageManifest,
  type ExternalChromePackageManifest,
} from './package-manifest.js'
import type {
  ExternalChromeDeploymentVerifier,
  ExternalChromeInstallRecord,
} from './deployer.js'
import {
  createExternalChromeNativeRegistration,
  type ExternalChromeNativeRegistration,
} from './registration.js'
import { ExternalChromeRelayRuntime } from './relay-runtime.js'

const DEFAULT_RENDEZVOUS_TTL_MS = 15_000
const DEFAULT_REFRESH_INTERVAL_MS = 5_000

export interface ExternalChromeRollbackController {
  canRollback(): Promise<boolean>
  rollback(): Promise<unknown>
}

export interface ExternalChromeHostCoordinatorOptions {
  dataRoot: string
  desktopVersion?: string
  packagedManifestPath?: string
  rollbackController?: ExternalChromeRollbackController
  repairDeployment?: () => Promise<unknown>
  deploymentVerifier?: ExternalChromeDeploymentVerifier
  platform?: NodeJS.Platform
  pid?: number
  username?: string
  uid?: number
  instanceId?: string
  access?: CurrentUserAccessController
  authority?: ExternalChromeAuthorityStore
  endpoints?: ExternalChromeEndpointAuthority
  registration?: ExternalChromeNativeRegistration
  isProcessAlive?: (pid: number) => boolean
  now?: () => number
  rendezvousTtlMs?: number
  refreshIntervalMs?: number
  setInterval?: typeof setInterval
  clearInterval?: typeof clearInterval
}

export class ExternalChromeHostCoordinator {
  private readonly platform: NodeJS.Platform
  private readonly pid: number
  private readonly instanceId: string
  private readonly userScope: string
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly refreshIntervalMs: number
  private readonly access: CurrentUserAccessController
  private readonly auth: ExternalChromeAuthStore
  private readonly authority: ExternalChromeAuthorityStore
  private readonly endpoints: ExternalChromeEndpointAuthority
  private readonly registration: ExternalChromeNativeRegistration
  private readonly relay: ExternalChromeRelayRuntime
  private readonly paths: ExternalChromeDataPaths
  private readonly desktopVersion?: string
  private readonly packagedManifestPath?: string
  private readonly rollbackController?: ExternalChromeRollbackController
  private readonly repairDeployment?: () => Promise<unknown>
  private readonly deploymentVerifier?: ExternalChromeDeploymentVerifier
  private readonly enabledStatePath: string
  private readonly runDirectory: string
  private readonly schedule: typeof setInterval
  private readonly unschedule: typeof clearInterval
  private endpoint: ExternalChromeEndpointHandle | null = null
  private epoch: string | null = null
  private keyId: string | null = null
  private refreshTimer: ReturnType<typeof setInterval> | null = null
  private quiesced = false
  private transitionTail: Promise<void> = Promise.resolve()

  constructor(options: ExternalChromeHostCoordinatorOptions) {
    this.platform = options.platform ?? process.platform
    this.pid = options.pid ?? process.pid
    this.instanceId = options.instanceId ?? createDesktopInstanceId()
    const username = options.username ?? os.userInfo().username
    this.userScope = externalChromeUserScope(this.platform, username, options.uid ?? process.getuid?.())
    this.now = options.now ?? Date.now
    this.ttlMs = options.rendezvousTtlMs ?? DEFAULT_RENDEZVOUS_TTL_MS
    this.refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS
    this.schedule = options.setInterval ?? setInterval
    this.unschedule = options.clearInterval ?? clearInterval
    this.access = options.access ?? createCurrentUserAccessController(this.platform, username)
    this.auth = new ExternalChromeAuthStore(options.dataRoot, this.platform, this.access)
    this.authority = options.authority ?? new ExternalChromeAuthorityStore(
      options.dataRoot,
      this.platform,
      this.instanceId,
      this.pid,
      this.access,
      options.isProcessAlive,
      this.now,
    )
    this.paths = resolveExternalChromeDataPaths(options.dataRoot, this.platform)
    this.relay = new ExternalChromeRelayRuntime(path.join(this.paths.state, 'leases.json'), this.now)
    this.endpoints = options.endpoints ?? new NodeExternalChromeEndpointAuthority(this.access, this.relay)
    this.registration = options.registration ?? createExternalChromeNativeRegistration({
      dataRoot: options.dataRoot,
      platform: this.platform,
    })
    this.desktopVersion = options.desktopVersion
    this.packagedManifestPath = options.packagedManifestPath
    this.rollbackController = options.rollbackController
    this.repairDeployment = options.repairDeployment
    this.deploymentVerifier = options.deploymentVerifier
    this.enabledStatePath = path.join(this.paths.state, 'enabled.json')
    this.runDirectory = this.paths.run
  }

  status(): Promise<ExternalChromeCoordinatorStatus> {
    return this.statusUnlocked()
  }

  /** Real authenticated relay transport used by the External Chrome target adapter. */
  transport(): ExternalChromeRelayRuntime {
    return this.relay
  }

  resumeIfEnabled(): Promise<void> {
    return this.serialize(async () => {
      if (await this.readDesiredEnabled()) await this.enableUnlocked(true)
    })
  }

  enable(): Promise<ExternalChromeCoordinatorStatus> {
    return this.serialize(() => this.enableUnlocked(false))
  }

  takeover(): Promise<ExternalChromeCoordinatorStatus> {
    return this.serialize(async () => {
      if ((await this.authority.inspect()).state !== 'stale') {
        throw new Error('External Chrome takeover is available only for stale ownership')
      }
      return this.enableUnlocked(true)
    })
  }

  disable(): Promise<ExternalChromeCoordinatorStatus> {
    return this.serialize(async () => {
      await this.stopRuntime(false)
      await this.writeDesiredEnabled(false)
      this.quiesced = false
      return this.statusUnlocked()
    })
  }

  repair(): Promise<ExternalChromeCoordinatorStatus> {
    return this.serialize(async () => {
      const authorityBefore = await this.authority.inspect()
      const authStatus = await this.auth.status()
      const wasEnabled = await this.readDesiredEnabled()
      if (this.repairDeployment) {
        await this.stopRuntime(false)
        await this.repairDeployment()
      }
      if (authStatus !== 'secure' || authorityBefore.state === 'stale') {
        await this.stopRuntime(false)
        const rotated = await this.auth.rotate()
        rotated.key.fill(0)
      }
      await this.registration.repair()
      if (wasEnabled) return this.enableUnlocked(true)
      return this.statusUnlocked()
    })
  }

  rollback(): Promise<ExternalChromeCoordinatorStatus> {
    return this.serialize(async () => {
      if (!this.rollbackController || !(await this.rollbackController.canRollback())) {
        throw new Error('No validated External Chrome rollback is available')
      }
      const wasEnabled = await this.readDesiredEnabled()
      await this.stopRuntime(false)
      await this.rollbackController.rollback()
      if (wasEnabled) return this.enableUnlocked(true)
      return this.statusUnlocked()
    })
  }

  async validatedLoadUnpackedPath(): Promise<string | null> {
    const setup = await this.inspectSetup()
    return setup.pathState === 'ready' ? setup.loadUnpackedPath ?? null : null
  }

  remove(): Promise<ExternalChromeCoordinatorStatus> {
    return this.serialize(async () => {
      await this.stopRuntime(false)
      await this.writeDesiredEnabled(false)
      await this.registration.remove()
      await this.auth.remove()
      await fs.rm(this.enabledStatePath, { force: true })
      this.quiesced = false
      return this.statusUnlocked()
    })
  }

  rotateAuthKey(): Promise<ExternalChromeCoordinatorStatus> {
    return this.serialize(async () => {
      const wasEnabled = await this.readDesiredEnabled()
      await this.stopRuntime(false)
      const rotated = await this.auth.rotate()
      rotated.key.fill(0)
      if (wasEnabled) return this.enableUnlocked(true)
      return this.statusUnlocked()
    })
  }

  async quiesce(_reason: 'desktop-update' | 'desktop-quit' = 'desktop-quit'): Promise<void> {
    await this.serialize(async () => {
      await this.stopRuntime(true)
      this.quiesced = true
    })
  }

  private async enableUnlocked(allowTakeover: boolean): Promise<ExternalChromeCoordinatorStatus> {
    if (this.endpoint) {
      this.quiesced = false
      await this.writeDesiredEnabled(true)
      return this.statusUnlocked()
    }
    const before = await this.authority.inspect()
    if (before.state === 'other-live' || (before.state === 'stale' && !allowTakeover)) return this.statusUnlocked()
    if ((await this.inspectSetup()).pathState !== 'ready') {
      throw new Error('External Chrome unpacked extension deployment is missing or invalid')
    }

    const expiresAt = this.expiry()
    const claim = await this.authority.claim(expiresAt)
    if (claim.state === 'other-live') return this.statusUnlocked()

    let keyRecord = before.state === 'stale' || claim.tookOver ? await this.auth.rotate() : await this.auth.ensure()
    try {
      const inspection = await this.registration.inspect()
      if (inspection.trust === 'missing' || inspection.trust === 'untrusted') {
        throw new Error('External Chrome native host is missing or is not trusted by this platform')
      }
      await this.registration.repair()
      const epoch = createRendezvousEpoch()
      this.relay.activate({ epoch, desktopInstanceId: this.instanceId, keyId: keyRecord.keyId, secret: keyRecord.key })
      const endpoint = await this.endpoints.listen({
        runDirectory: this.runDirectory,
        platform: this.platform,
        userScope: this.userScope,
        epoch,
      })
      this.endpoint = endpoint
      this.epoch = epoch
      this.keyId = keyRecord.keyId
      await this.publish(expiresAt)
      await this.writeDesiredEnabled(true)
      this.quiesced = false
      this.startRefreshTimer()
      return await this.statusUnlocked()
    } catch (error) {
      await this.stopRuntime(false)
      throw error
    } finally {
      keyRecord.key.fill(0)
      keyRecord = { ...keyRecord, key: new Uint8Array() }
    }
  }

  private async statusUnlocked(): Promise<ExternalChromeCoordinatorStatus> {
    const [authority, auth, registration, desiredEnabled, setup, canRollback] = await Promise.all([
      this.authority.inspect(),
      this.auth.status(),
      this.registration.inspect(),
      this.readDesiredEnabled(),
      this.inspectSetup(),
      this.rollbackController?.canRollback().catch(() => false) ?? false,
    ])
    let state: ExternalChromeCoordinatorStatus['state']
    if (this.endpoint && authority.state === 'owned') state = this.quiesced ? 'quiesced' : 'online'
    else if (authority.state === 'other-live') state = 'other-instance'
    else if (this.quiesced) state = 'quiesced'
    else state = desiredEnabled ? 'offline' : 'disabled'

    const platform = this.platform === 'darwin' || this.platform === 'linux' || this.platform === 'win32'
      ? this.platform
      : 'unsupported'
    const trustAllowsEnable = registration.trust === 'trusted' || registration.trust === 'unsupported'
    const authorityAvailable = authority.state !== 'other-live' && authority.state !== 'stale'
    const hasInstalledState = auth !== 'missing' || registration.registration !== 'not-registered' || state !== 'disabled'
    return {
      state,
      authority: authority.state,
      auth,
      registration: registration.registration,
      trust: registration.trust,
      platform,
      canEnable: platform !== 'unsupported' && authorityAvailable && setup.pathState === 'ready' && registration.registration !== 'conflict' && trustAllowsEnable && state !== 'online',
      canDisable: authority.state !== 'other-live' && (state === 'online' || state === 'offline' || state === 'quiesced'),
      canRepair: platform !== 'unsupported' && authorityAvailable && registration.registration !== 'conflict' && (trustAllowsEnable || this.repairDeployment !== undefined),
      canRollback: authorityAvailable && canRollback,
      canRemove: authority.state !== 'other-live' && hasInstalledState,
      canTakeover: platform !== 'unsupported' && authority.state === 'stale' && setup.pathState === 'ready' && registration.registration !== 'conflict' && trustAllowsEnable,
      canReveal: setup.pathState === 'ready',
      setup,
      ...(registration.detail ? { detail: registration.detail.slice(0, 256) } : {}),
    }
  }

  private async inspectSetup(): Promise<ExternalChromeSetupStatus> {
    const [verification, packaged] = await Promise.all([
      this.deploymentVerifier?.verifyDeployment().catch(() => ({ state: 'mismatch' as const }))
        ?? Promise.resolve({ state: 'missing' as const }),
      this.readPackagedInventory(),
    ])
    const pathState: ExternalChromeSetupStatus['pathState'] = verification.state
    return {
      extensionId: EXTERNAL_CHROME_EXTENSION_ID,
      pathState,
      ...(pathState === 'ready' ? { loadUnpackedPath: this.paths.extension } : {}),
      ...(packaged ? { packaged } : {}),
      ...(verification.state === 'ready' ? { deployed: inventoryFromInstall(verification.install, this.desktopVersion) } : {}),
    }
  }

  private async readPackagedInventory(): Promise<ExternalChromeBuildInventory | null> {
    if (!this.packagedManifestPath) return null
    try {
      return inventoryFromManifest(await readExternalChromePackageManifest(this.packagedManifestPath), this.desktopVersion)
    } catch {
      return null
    }
  }

  private async publish(expiresAt: string): Promise<void> {
    if (!this.endpoint || !this.epoch || !this.keyId) throw new Error('External Chrome endpoint is not ready')
    await this.authority.refresh(expiresAt)
    await this.authority.publish({
      schemaVersion: 1,
      endpoint: this.endpoint.endpoint,
      epoch: this.epoch,
      expiresAt,
      keyId: this.keyId,
      userScope: this.userScope,
      desktopInstanceId: this.instanceId,
      desktopPid: this.pid,
      protocolMin: EXTERNAL_CHROME_PROTOCOL_MIN_VERSION,
      protocolMax: EXTERNAL_CHROME_PROTOCOL_MAX_VERSION,
    })
  }

  private startRefreshTimer(): void {
    this.stopRefreshTimer()
    const epoch = this.epoch
    this.refreshTimer = this.schedule(() => {
      void this.serialize(async () => {
        if (!epoch || this.epoch !== epoch) return
        try {
          await this.publish(this.expiry())
        } catch {
          await this.stopRuntime(false)
        }
      })
    }, this.refreshIntervalMs)
    this.refreshTimer.unref?.()
  }

  private stopRefreshTimer(): void {
    if (!this.refreshTimer) return
    this.unschedule(this.refreshTimer)
    this.refreshTimer = null
  }

  private async stopRuntime(markQuiesced: boolean): Promise<void> {
    this.stopRefreshTimer()
    const endpoint = this.endpoint
    this.endpoint = null
    this.epoch = null
    this.keyId = null
    if (endpoint) await endpoint.close()
    this.relay.deactivate()
    await this.authority.withdraw()
    this.quiesced = markQuiesced
  }

  private serialize<Result>(operation: () => Promise<Result>): Promise<Result> {
    const transition = this.transitionTail.then(operation, operation)
    this.transitionTail = transition.then(() => undefined, () => undefined)
    return transition
  }

  private expiry(): string {
    return new Date(this.now() + this.ttlMs).toISOString()
  }

  private async readDesiredEnabled(): Promise<boolean> {
    try {
      const value = JSON.parse(await fs.readFile(this.enabledStatePath, 'utf8')) as { enabled?: unknown }
      return value.enabled === true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return false
      throw error
    }
  }

  private async writeDesiredEnabled(enabled: boolean): Promise<void> {
    await this.access.preparePrivateDirectory(path.dirname(this.enabledStatePath))
    const temporary = `${this.enabledStatePath}.new-${process.pid}-${Date.now()}`
    await fs.writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, enabled })}\n`, { mode: 0o600, flag: 'wx' })
    try {
      await fs.rename(temporary, this.enabledStatePath)
      await this.access.securePrivateFile(this.enabledStatePath)
    } catch (error) {
      await fs.rm(temporary, { force: true })
      throw error
    }
  }
}

function inventoryFromManifest(
  manifest: ExternalChromePackageManifest,
  desktopVersion?: string,
): ExternalChromeBuildInventory {
  return {
    ...(desktopVersion ? { desktopVersion } : {}),
    packageVersion: manifest.packageVersion,
    shell: { abi: manifest.extension.shellAbi, sha256: manifest.extension.shellSha256 },
    payload: { version: manifest.extension.payloadVersion, sha256: manifest.extension.payloadSha256 },
    nativeHost: { version: manifest.nativeHost.version, sha256: manifest.nativeHost.sha256 },
  }
}

function inventoryFromInstall(
  install: ExternalChromeInstallRecord,
  desktopVersion?: string,
): ExternalChromeBuildInventory {
  return {
    ...(desktopVersion ? { desktopVersion } : {}),
    packageVersion: install.packageVersion,
    shell: { abi: install.shellAbi, sha256: install.shellSha256 },
    payload: { version: install.payloadVersion, sha256: install.payloadSha256 },
    nativeHost: { version: install.nativeVersion, sha256: install.nativeSha256 },
  }
}
