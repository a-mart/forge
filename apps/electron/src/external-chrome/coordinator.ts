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
  dataDirectoryHash,
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
  type ForgeRegistrationConflictEvidence,
} from './registration.js'
import { ExternalChromeRelayRuntime } from './relay-runtime.js'

const DEFAULT_RENDEZVOUS_TTL_MS = 15_000
const DEFAULT_REFRESH_INTERVAL_MS = 5_000
const TAKEOVER_AUTHORIZATION_TTL_MS = 15 * 60_000

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
  /** Test-only fault seam at the durable transfer/authorization cleanup boundary. */
  afterTakeoverTransfer?: () => void | Promise<void>
}

export class ExternalChromeHostCoordinator {
  private readonly platform: NodeJS.Platform
  private readonly pid: number
  private readonly instanceId: string
  private readonly userScope: string
  private readonly dataDirHash: string
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
  private readonly recoveryMarkerPath: string
  private readonly takeoverAuthorizationPath: string
  private readonly schedule: typeof setInterval
  private readonly unschedule: typeof clearInterval
  private readonly afterTakeoverTransfer?: () => void | Promise<void>
  private endpoint: ExternalChromeEndpointHandle | null = null
  private epoch: string | null = null
  private keyId: string | null = null
  private refreshTimer: ReturnType<typeof setInterval> | null = null
  private quiesced = false
  private recoveryOverride: ExternalChromeCoordinatorStatus['recovery'] | null = null
  private transitionTail: Promise<void> = Promise.resolve()

  constructor(options: ExternalChromeHostCoordinatorOptions) {
    this.platform = options.platform ?? process.platform
    this.pid = options.pid ?? process.pid
    this.instanceId = options.instanceId ?? createDesktopInstanceId()
    const username = options.username ?? os.userInfo().username
    this.userScope = externalChromeUserScope(this.platform, username, options.uid ?? process.getuid?.())
    this.dataDirHash = dataDirectoryHash(options.dataRoot)
    this.now = options.now ?? Date.now
    this.ttlMs = options.rendezvousTtlMs ?? DEFAULT_RENDEZVOUS_TTL_MS
    this.refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS
    this.schedule = options.setInterval ?? setInterval
    this.unschedule = options.clearInterval ?? clearInterval
    this.afterTakeoverTransfer = options.afterTakeoverTransfer
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
      path.join(os.tmpdir(), 'forge-external-chrome-authority', `${this.userScope}.json`),
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
    this.recoveryMarkerPath = path.join(this.paths.state, 'recovery-marker.json')
    this.takeoverAuthorizationPath = path.join(this.paths.state, 'takeover-authorization.json')
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
      if (await this.readDesiredEnabled()) await this.enableUnlocked(false)
    })
  }

  enable(): Promise<ExternalChromeCoordinatorStatus> {
    return this.serialize(() => this.enableUnlocked(false))
  }

  takeover(): Promise<ExternalChromeCoordinatorStatus> {
    return this.serialize(async () => {
      const [authority, registration, authorization] = await Promise.all([
        this.authority.inspect(), this.registration.inspect(), this.readTakeoverAuthorization(),
      ])
      if (authority.state === 'other-live' || authority.state === 'owned') {
        throw new Error('Current External Chrome authority must be quiesced before takeover')
      }
      const authorityOwner = 'owner' in authority ? authority.owner : undefined
      const transferEvidence = registration.forgeConflict ?? registration.completedForgeTransfer
      if (!authorization || !transferEvidence ||
        authorization.dataDirHash !== transferEvidence.dataDirHash ||
        authorization.registrationIdentity !== transferEvidence.identity ||
        (authority.state === 'stale' && authorityOwner?.dataDirHash !== authorization.dataDirHash)) {
        throw new Error('External Chrome takeover authorization is missing or stale')
      }
      // The durable exact authorization remains retryable until registration has
      // crossed its own idempotent transfer boundary. A restart can therefore
      // finish an exact partial transfer, while foreign/drifted records still fail.
      await this.registration.transferForgeOwnedConflict(transferEvidence)
      await this.afterTakeoverTransfer?.()
      await fs.rm(this.takeoverAuthorizationPath, { force: true })
      await this.registration.repair()
      const rotated = await this.auth.rotate()
      rotated.key.fill(0)
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
      if (this.endpoint) await this.quiesceRuntimeUnlocked('desktop-update')
      else await this.stopRuntime(false)
      try {
        await this.rollbackController.rollback()
      } catch (error) {
        this.recoveryOverride = 'manual-extension-reload'
        throw error
      }
      this.recoveryOverride = 'rolled-back'
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
      await fs.rm(this.takeoverAuthorizationPath, { force: true })
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

  async quiesce(reason: 'desktop-update' | 'desktop-quit' = 'desktop-quit'): Promise<void> {
    await this.serialize(() => this.quiesceRuntimeUnlocked(reason))
  }

  private async quiesceRuntimeUnlocked(reason: 'desktop-update' | 'desktop-quit'): Promise<void> {
    const deadlineAt = this.now() + 4_000
    let failure: unknown = null
    try {
      await this.relay.quiesce(reason, deadlineAt)
    } catch (error) {
      failure = error
    }
    // Capability stays detached even when exact release could not be proven.
    await this.stopRuntime(true)
    this.quiesced = true
    await this.writeRecoveryMarker({
      schemaVersion: 1, reason, status: failure === null ? 'quiesced' : 'release-unproven',
      at: new Date(this.now()).toISOString(),
    })
    if (failure !== null) throw failure instanceof Error ? failure : new Error(String(failure))
  }

  private async enableUnlocked(allowTakeover: boolean): Promise<ExternalChromeCoordinatorStatus> {
    if (this.endpoint) {
      this.quiesced = false
      await this.writeDesiredEnabled(true)
      return this.statusUnlocked()
    }
    const before = await this.authority.inspect()
    const beforeOwner = 'owner' in before ? before.owner : undefined
    const crossDataDirOwner = beforeOwner?.dataDirHash !== undefined && beforeOwner.dataDirHash !== this.dataDirHash
    const takeoverAuthorization = await this.readTakeoverAuthorization()
    if (before.state === 'other-live' || (!allowTakeover && (crossDataDirOwner || before.state === 'stale' || takeoverAuthorization !== null))) return this.statusUnlocked()
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
      // Durable lease authority is loaded before the endpoint can accept native hello.
      // Host registration/replacement and IPC recovery therefore cannot bypass checkpoints.
      await this.relay.ready()
      const [deployment, pendingDeployment] = await Promise.all([
        this.deploymentVerifier?.verifyDeployment(),
        this.deploymentVerifier?.pendingDeployment?.() ?? null,
      ])
      const expectedDeployment = pendingDeployment ?? (deployment?.state === 'ready' ? deployment.install : null)
      this.relay.configureExpectedRuntime(expectedDeployment ? {
        payloadVersion: expectedDeployment.payloadVersion,
        sha256: expectedDeployment.payloadSha256,
        shellAbi: expectedDeployment.shellAbi,
      } : null, pendingDeployment && this.deploymentVerifier?.activateStaged
        ? async () => { await this.deploymentVerifier!.activateStaged!() }
        : undefined)
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

    const authorityOwner = 'owner' in authority ? authority.owner : undefined
    const crossDataDirOwner = authorityOwner?.dataDirHash !== undefined && authorityOwner.dataDirHash !== this.dataDirHash
    if (crossDataDirOwner && registration.forgeConflict?.dataDirHash === authorityOwner.dataDirHash) {
      await this.writeTakeoverAuthorization(registration.forgeConflict)
    }
    const takeoverAuthorization = await this.readTakeoverAuthorization()
    const transferEvidence = registration.forgeConflict ?? registration.completedForgeTransfer
    const exactTransfer = takeoverAuthorization !== null && transferEvidence !== undefined &&
      takeoverAuthorization.dataDirHash === transferEvidence.dataDirHash &&
      takeoverAuthorization.registrationIdentity === transferEvidence.identity
    const platform = this.platform === 'darwin' || this.platform === 'linux' || this.platform === 'win32'
      ? this.platform
      : 'unsupported'
    const trustAllowsEnable = registration.trust === 'trusted' || registration.trust === 'unsupported'
    const authorityAvailable = authority.state !== 'other-live' && authority.state !== 'stale' && takeoverAuthorization === null
    const hasInstalledState = auth !== 'missing' || registration.registration !== 'not-registered' || state !== 'disabled'
    const markerRecovery = await this.readMarkerRecovery()
    const runtimeRecovery = this.relay.recoveryStatus()
    const deploymentRecovery = this.deploymentVerifier?.recoveryState?.() ?? null
    const compatibilityRecovery = setup.pathState === 'mismatch' ? 'incompatible-payload' : null
    if (state === 'online' && runtimeRecovery === 'ready') this.recoveryOverride = null
    const activeRuntimeRecovery = state === 'online' && runtimeRecovery !== 'ready' ? runtimeRecovery : null
    const activeMarkerRecovery = state !== 'online' && markerRecovery !== 'ready' ? markerRecovery : null
    const rollbackFailure = this.recoveryOverride === 'manual-extension-reload' ? this.recoveryOverride : null
    const rollbackReceipt = this.recoveryOverride === 'rolled-back' ? this.recoveryOverride : null
    const recovery = crossDataDirOwner
      ? 'authority-owned-by-other-data-dir'
      : deploymentRecovery ?? compatibilityRecovery ?? rollbackFailure ?? activeRuntimeRecovery ?? activeMarkerRecovery ??
        rollbackReceipt ?? (state === 'online' ? runtimeRecovery : markerRecovery)
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
      canTakeover: platform !== 'unsupported' && exactTransfer && authority.state !== 'owned' && authority.state !== 'other-live' && setup.pathState === 'ready' && trustAllowsEnable,
      canReveal: setup.pathState === 'ready',
      recovery,
      ...((crossDataDirOwner ? authorityOwner?.dataDirHash : takeoverAuthorization?.dataDirHash) ? {
        ownerDataDirHash: (crossDataDirOwner ? authorityOwner?.dataDirHash : takeoverAuthorization?.dataDirHash)!,
      } : {}),
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

  private async readMarkerRecovery(): Promise<ExternalChromeCoordinatorStatus['recovery']> {
    try {
      const raw = await fs.readFile(this.recoveryMarkerPath, 'utf8')
      if (Buffer.byteLength(raw) > 2_048) return 'manual-extension-reload'
      const marker = JSON.parse(raw) as { status?: unknown }
      return marker.status === 'release-unproven' ? 'manual-extension-reload' : 'reconnecting'
    } catch {
      return 'ready'
    }
  }

  private async writeRecoveryMarker(value: {
    schemaVersion: 1
    reason: 'desktop-update' | 'desktop-quit'
    status: 'quiesced' | 'release-unproven'
    at: string
  }): Promise<void> {
    await this.access.preparePrivateDirectory(path.dirname(this.recoveryMarkerPath))
    const temporary = `${this.recoveryMarkerPath}.new-${process.pid}-${Date.now()}`
    await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' })
    try {
      await fs.rename(temporary, this.recoveryMarkerPath)
      await this.access.securePrivateFile(this.recoveryMarkerPath)
    } catch (error) {
      await fs.rm(temporary, { force: true })
      throw error
    }
  }

  private async readTakeoverAuthorization(): Promise<{
    dataDirHash: string
    registrationIdentity: string
    expiresAt: number
  } | null> {
    try {
      const raw = await fs.readFile(this.takeoverAuthorizationPath, 'utf8')
      if (Buffer.byteLength(raw) > 1_024) return null
      const value = JSON.parse(raw) as Record<string, unknown>
      if (value.schemaVersion !== 1 || Object.keys(value).sort().join(',') !== 'dataDirHash,expiresAt,registrationIdentity,schemaVersion' ||
        typeof value.dataDirHash !== 'string' || !/^[a-f0-9]{16}$/u.test(value.dataDirHash) ||
        typeof value.registrationIdentity !== 'string' || !/^[a-f0-9]{64}$/u.test(value.registrationIdentity) ||
        typeof value.expiresAt !== 'number' || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= this.now()) {
        return null
      }
      return { dataDirHash: value.dataDirHash, registrationIdentity: value.registrationIdentity, expiresAt: value.expiresAt }
    } catch {
      return null
    }
  }

  private async writeTakeoverAuthorization(evidence: ForgeRegistrationConflictEvidence): Promise<void> {
    if (!/^[a-f0-9]{16}$/u.test(evidence.dataDirHash) || !/^[a-f0-9]{64}$/u.test(evidence.identity)) return
    await this.access.preparePrivateDirectory(path.dirname(this.takeoverAuthorizationPath))
    const temporary = `${this.takeoverAuthorizationPath}.new-${process.pid}-${Date.now()}`
    await fs.writeFile(temporary, `${JSON.stringify({
      schemaVersion: 1,
      dataDirHash: evidence.dataDirHash,
      registrationIdentity: evidence.identity,
      expiresAt: this.now() + TAKEOVER_AUTHORIZATION_TTL_MS,
    })}\n`, { mode: 0o600, flag: 'wx' })
    try {
      await fs.rename(temporary, this.takeoverAuthorizationPath)
      await this.access.securePrivateFile(this.takeoverAuthorizationPath)
    } catch (error) {
      await fs.rm(temporary, { force: true })
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
