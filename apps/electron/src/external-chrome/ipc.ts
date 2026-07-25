import { randomUUID } from 'node:crypto'
import {
  parseExternalChromeCoordinatorRequest,
  type ExternalChromeCandidateWindow,
  type ExternalChromeChildPolicy,
  type ExternalChromeCoordinatorRequest,
  type ExternalChromeCoordinatorStatus,
  type ExternalChromeSelectedTab,
} from '@forge/protocol'
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, IpcRenderer } from 'electron'
import type { ExternalChromeHostCoordinator } from './coordinator.js'
import type { ExternalChromeRuntimeInventory } from './relay-runtime.js'

export const EXTERNAL_CHROME_CONTROL_CHANNEL = 'forge:external-chrome-control'
export const EXTERNAL_CHROME_ATTACH_CHANNEL = 'forge:external-chrome-attach'

export type ExternalChromeControlResult =
  | { ok: true; status: ExternalChromeCoordinatorStatus }
  | { ok: false; error: 'invalid-request' | 'operation-failed' }

export type ExternalChromeLocalError =
  | 'invalid-request' | 'setup-required' | 'attachment-required' | 'lease-conflict' | 'restricted-target'
  | 'debugger-unavailable' | 'chrome-policy-blocked' | 'stale-or-lost' | 'extension-update-required' | 'operation-failed'

export interface ExternalChromeLocalAttachment {
  sessionAgentId: string
  profileId: string
  extensionInstanceId: string
  profileAlias: string
  groupId: number | null
  childPolicy: ExternalChromeChildPolicy
  tabs: Array<Pick<ExternalChromeSelectedTab, 'windowId' | 'tabId' | 'groupId' | 'title' | 'origin' | 'active'>>
  state: 'attached' | 'recovering' | 'lost'
  attachedAt: string
}

export interface ExternalChromeLocalStatus {
  coordinator: ExternalChromeCoordinatorStatus
  instances: ExternalChromeRuntimeInventory[]
  attachment: ExternalChromeLocalAttachment | null
}

export type ExternalChromeAttachResult =
  | { ok: true; status: ExternalChromeLocalStatus; windows?: ExternalChromeCandidateWindow[] }
  | { ok: false; error: ExternalChromeLocalError }

export interface TrustedExternalChromeBridge {
  status(): Promise<ExternalChromeControlResult>
  enable(): Promise<ExternalChromeControlResult>
  disable(): Promise<ExternalChromeControlResult>
  repair(): Promise<ExternalChromeControlResult>
  rollback(): Promise<ExternalChromeControlResult>
  remove(): Promise<ExternalChromeControlResult>
  takeover(): Promise<ExternalChromeControlResult>
  revealExtensionFolder(): Promise<ExternalChromeControlResult>
  localStatus(sessionAgentId: string, profileId: string): Promise<ExternalChromeAttachResult>
  listCandidates(sessionAgentId: string, profileId: string, extensionInstanceId: string): Promise<ExternalChromeAttachResult>
  attach(input: ExternalChromeAttachInput): Promise<ExternalChromeAttachResult>
  detach(sessionAgentId: string, profileId: string): Promise<ExternalChromeAttachResult>
  releaseForLifecycle(input: ExternalChromeLifecycleReleaseInput): Promise<ExternalChromeAttachResult>
}

export interface ExternalChromeLifecycleReleaseInput {
  requestId: string
  hostId: string
  hostGeneration: number
  sessionAgentId: string
  profileId: string
  tabId: string
  reason: 'stop' | 'archive' | 'delete' | 'detach' | 'host-replaced'
}

export interface ExternalChromeAttachInput {
  sessionAgentId: string
  profileId: string
  extensionInstanceId: string
  tabIds: number[]
  groupId?: number
  childPolicy: ExternalChromeChildPolicy
  confirmed: true
}

interface LocalLease extends ExternalChromeLocalAttachment {
  leaseId: string
  leaseEpoch: number
  expiresAt: number
}

export function installExternalChromeIpc(options: {
  ipcMain: IpcMain
  mainWindow: BrowserWindow
  coordinator: ExternalChromeHostCoordinator
  revealExtensionFolder?: (validatedPath: string) => Promise<void>
  onError?: (error: unknown) => void
}): () => void {
  const authorized = (event: IpcMainInvokeEvent): boolean =>
    !options.mainWindow.isDestroyed() && event.sender.id === options.mainWindow.webContents.id

  const controlHandler = async (event: IpcMainInvokeEvent, input: unknown): Promise<ExternalChromeControlResult> => {
    if (!authorized(event)) return { ok: false, error: 'invalid-request' }
    let request: ExternalChromeCoordinatorRequest
    try { request = parseExternalChromeCoordinatorRequest(input) } catch { return { ok: false, error: 'invalid-request' } }
    try {
      if (request.operation === 'status') return { ok: true, status: await options.coordinator.status() }
      const before = await options.coordinator.status()
      switch (request.operation) {
        case 'enable':
          if (!before.canEnable) return { ok: false, error: 'operation-failed' }
          return { ok: true, status: await options.coordinator.enable() }
        case 'disable':
          if (!before.canDisable) return { ok: false, error: 'operation-failed' }
          return { ok: true, status: await options.coordinator.disable() }
        case 'repair':
          if (!before.canRepair) return { ok: false, error: 'operation-failed' }
          return { ok: true, status: await options.coordinator.repair() }
        case 'rollback':
          if (!before.canRollback) return { ok: false, error: 'operation-failed' }
          return { ok: true, status: await options.coordinator.rollback() }
        case 'remove':
          if (!before.canRemove) return { ok: false, error: 'operation-failed' }
          return { ok: true, status: await options.coordinator.remove() }
        case 'takeover':
          if (!before.canTakeover) return { ok: false, error: 'operation-failed' }
          return { ok: true, status: await options.coordinator.takeover() }
        case 'reveal-extension-folder': {
          if (!before.canReveal || !options.revealExtensionFolder) return { ok: false, error: 'operation-failed' }
          const validatedPath = await options.coordinator.validatedLoadUnpackedPath()
          if (!validatedPath) return { ok: false, error: 'operation-failed' }
          await options.revealExtensionFolder(validatedPath)
          return { ok: true, status: await options.coordinator.status() }
        }
      }
    } catch (error) {
      options.onError?.(error)
      return { ok: false, error: 'operation-failed' }
    }
  }

  // Candidate titles/origins are intentionally confined to this authenticated main-renderer IPC.
  // They are never passed through the backend transport or written to logs.
  const leases = new Map<string, LocalLease>()
  const leaseEpochs = new Map<string, number>()
  const key = (sessionAgentId: string, profileId: string): string => `${sessionAgentId}\u0000${profileId}`
  const transportForRecovery = options.coordinator.transport()
  let reconciliation: Promise<void> = Promise.resolve()
  const reconcileLeases = (): Promise<void> => {
    const run = reconciliation.then(async () => {
      if (typeof transportForRecovery.leaseCheckpoints !== 'function') return
      const checkpoints = await transportForRecovery.leaseCheckpoints()
      const durableKeys = new Set<string>()
      for (const checkpoint of checkpoints) {
        leaseEpochs.set(checkpoint.extensionInstanceId, Math.max(leaseEpochs.get(checkpoint.extensionInstanceId) ?? 0, checkpoint.leaseEpoch))
        if (checkpoint.sessionAgentId === '__local_pending__' || checkpoint.profileId === '__local_pending__') continue
        const attachmentKey = key(checkpoint.sessionAgentId, checkpoint.profileId)
        durableKeys.add(attachmentKey)
        const cached = leases.get(attachmentKey)
        const sameAuthority = cached?.extensionInstanceId === checkpoint.extensionInstanceId &&
          cached.leaseId === checkpoint.leaseId && cached.leaseEpoch === checkpoint.leaseEpoch
        const attachedAt = sameAuthority ? cached.attachedAt : new Date(Math.max(0, checkpoint.expiresAt - 15 * 60_000)).toISOString()
        const cachedTabs = sameAuthority ? new Map(cached.tabs.map((tab) => [tab.tabId, tab])) : new Map()
        leases.set(attachmentKey, {
          sessionAgentId: checkpoint.sessionAgentId, profileId: checkpoint.profileId,
          extensionInstanceId: checkpoint.extensionInstanceId,
          // Alias/title/origin are local-only presentation metadata. They may decorate
          // matching durable authority, but can never create or retain that authority.
          profileAlias: sameAuthority ? cached.profileAlias : 'Chrome profile',
          groupId: checkpoint.groupId, childPolicy: checkpoint.childPolicy,
          tabs: checkpoint.tabIds.map((tabId) => cachedTabs.get(tabId) ?? ({ windowId: 0, tabId, groupId: checkpoint.groupId, title: '', origin: '', active: false })),
          state: 'recovering', attachedAt, leaseId: checkpoint.leaseId, leaseEpoch: checkpoint.leaseEpoch,
          expiresAt: checkpoint.expiresAt,
        })
      }
      for (const attachmentKey of leases.keys()) if (!durableKeys.has(attachmentKey)) leases.delete(attachmentKey)
    })
    reconciliation = run.catch(() => undefined)
    return run
  }
  const recoveryReady = reconcileLeases()
  const status = async (sessionAgentId: string, profileId: string): Promise<ExternalChromeLocalStatus> => {
    await recoveryReady
    await reconcileLeases()
    const coordinator = await options.coordinator.status()
    const transport = options.coordinator.transport()
    const instances = transport.inventory()
    const stored = leases.get(key(sessionAgentId, profileId))
    let attachment: ExternalChromeLocalAttachment | null = null
    if (stored) {
      const connected = instances.some((instance) => instance.extensionInstanceId === stored.extensionInstanceId)
      attachment = publicAttachment({ ...stored, state: connected && stored.expiresAt > Date.now() ? 'attached' : coordinator.state === 'online' ? 'recovering' : 'lost' })
    }
    return { coordinator, instances, attachment }
  }
  const attachHandler = async (event: IpcMainInvokeEvent, input: unknown): Promise<ExternalChromeAttachResult> => {
    if (!authorized(event)) return { ok: false, error: 'invalid-request' }
    const request = parseAttachRequest(input)
    if (!request) return { ok: false, error: 'invalid-request' }
    try {
      await recoveryReady
      // Relay checkpoints are the lifecycle authority. Refresh before every
      // authority-sensitive operation so relay-created/adopted leases that appear
      // after IPC installation remain visible and releasable.
      await reconcileLeases()
      if (request.operation === 'status') return { ok: true, status: await status(request.sessionAgentId, request.profileId) }
      const coordinator = await options.coordinator.status()
      if (coordinator.state !== 'online' || coordinator.setup.pathState !== 'ready') return { ok: false, error: 'setup-required' }
      const transport = options.coordinator.transport()
      if (request.operation === 'candidates') {
        const result = await transport.listCandidates(request.extensionInstanceId, request.sessionAgentId)
        if (result.extensionInstanceId !== request.extensionInstanceId) return { ok: false, error: 'stale-or-lost' }
        return { ok: true, status: await status(request.sessionAgentId, request.profileId), windows: result.windows }
      }
      const attachmentKey = key(request.sessionAgentId, request.profileId)
      if (request.operation === 'detach' || request.operation === 'lifecycle-release') {
        const existing = leases.get(attachmentKey)
        if (!existing) return request.operation === 'detach'
          ? { ok: true, status: await status(request.sessionAgentId, request.profileId) }
          : { ok: false, error: 'stale-or-lost' }
        if (request.operation === 'lifecycle-release') {
          const tab = decodeOpaqueExternalTabId(request.tabId)
          if (!tab || tab.extensionInstanceId !== existing.extensionInstanceId || !existing.tabs.some((candidate) => candidate.tabId === tab.tabId)) {
            return { ok: false, error: 'stale-or-lost' }
          }
        }
        await boundedRelease(
          transport.release(existing.extensionInstanceId, existing.leaseId, existing.leaseEpoch,
            request.operation === 'detach' ? 'detached-from-forge' : `lifecycle-${request.reason}`),
        )
        leases.delete(attachmentKey)
        return { ok: true, status: await status(request.sessionAgentId, request.profileId) }
      }
      const existing = leases.get(attachmentKey)
      if (existing) return { ok: false, error: 'lease-conflict' }
      const epochKey = request.extensionInstanceId
      const leaseEpoch = (leaseEpochs.get(epochKey) ?? 0) + 1
      leaseEpochs.set(epochKey, leaseEpoch)
      const leaseId = `forge-ui-${randomUUID()}`
      const claimed = await transport.claim({
        extensionInstanceId: request.extensionInstanceId,
        sessionAgentId: request.sessionAgentId,
        profileId: request.profileId,
        leaseId,
        leaseEpoch,
        tabIds: request.tabIds,
        ...(request.groupId === undefined ? {} : { groupId: request.groupId }),
        childPolicy: request.childPolicy,
      })
      const inventory = transport.inventory().find((entry) => entry.extensionInstanceId === request.extensionInstanceId)
      const local: LocalLease = {
        sessionAgentId: request.sessionAgentId,
        profileId: request.profileId,
        extensionInstanceId: request.extensionInstanceId,
        profileAlias: inventory?.profileAlias ?? 'Chrome profile',
        groupId: claimed.groupId,
        childPolicy: claimed.childPolicy,
        tabs: claimed.tabs.map(({ windowId, tabId, groupId, title, origin, active }) => ({ windowId, tabId, groupId, title, origin, active })),
        state: 'attached',
        attachedAt: new Date().toISOString(),
        leaseId,
        leaseEpoch,
        expiresAt: Date.now() + 15 * 60_000,
      }
      leases.set(attachmentKey, local)
      return { ok: true, status: await status(request.sessionAgentId, request.profileId) }
    } catch (error) {
      return { ok: false, error: localError(error) }
    }
  }

  options.ipcMain.handle(EXTERNAL_CHROME_CONTROL_CHANNEL, controlHandler)
  options.ipcMain.handle(EXTERNAL_CHROME_ATTACH_CHANNEL, attachHandler)
  return () => {
    options.ipcMain.removeHandler(EXTERNAL_CHROME_CONTROL_CHANNEL)
    options.ipcMain.removeHandler(EXTERNAL_CHROME_ATTACH_CHANNEL)
  }
}

export function createTrustedExternalChromeBridge(ipcRenderer: IpcRenderer): TrustedExternalChromeBridge {
  const invoke = (operation: ExternalChromeCoordinatorRequest['operation']): Promise<ExternalChromeControlResult> =>
    ipcRenderer.invoke(EXTERNAL_CHROME_CONTROL_CHANNEL, { operation }) as Promise<ExternalChromeControlResult>
  const attachInvoke = (value: unknown): Promise<ExternalChromeAttachResult> =>
    ipcRenderer.invoke(EXTERNAL_CHROME_ATTACH_CHANNEL, value) as Promise<ExternalChromeAttachResult>
  return {
    status: () => invoke('status'), enable: () => invoke('enable'), disable: () => invoke('disable'),
    repair: () => invoke('repair'), rollback: () => invoke('rollback'), remove: () => invoke('remove'),
    takeover: () => invoke('takeover'), revealExtensionFolder: () => invoke('reveal-extension-folder'),
    localStatus: (sessionAgentId, profileId) => attachInvoke({ operation: 'status', sessionAgentId, profileId }),
    listCandidates: (sessionAgentId, profileId, extensionInstanceId) => attachInvoke({ operation: 'candidates', sessionAgentId, profileId, extensionInstanceId }),
    attach: (input) => attachInvoke({ operation: 'attach', ...input }),
    detach: (sessionAgentId, profileId) => attachInvoke({ operation: 'detach', sessionAgentId, profileId }),
    releaseForLifecycle: (input) => attachInvoke({ operation: 'lifecycle-release', ...input }),
  }
}

type ParsedAttachRequest =
  | { operation: 'status'; sessionAgentId: string; profileId: string }
  | { operation: 'detach'; sessionAgentId: string; profileId: string }
  | { operation: 'candidates'; sessionAgentId: string; profileId: string; extensionInstanceId: string }
  | ({ operation: 'attach' } & ExternalChromeAttachInput)
  | ({ operation: 'lifecycle-release' } & ExternalChromeLifecycleReleaseInput)

function parseAttachRequest(value: unknown): ParsedAttachRequest | null {
  if (!record(value) || !identifier(value.operation)) return null
  const baseKeys = ['operation', 'sessionAgentId', 'profileId']
  if (!identifier(value.sessionAgentId) || !identifier(value.profileId)) return null
  if (value.operation === 'status' || value.operation === 'detach') {
    return exactKeys(value, baseKeys) ? { operation: value.operation, sessionAgentId: value.sessionAgentId, profileId: value.profileId } : null
  }
  if (value.operation === 'candidates') {
    return exactKeys(value, [...baseKeys, 'extensionInstanceId']) && identifier(value.extensionInstanceId)
      ? { operation: 'candidates', sessionAgentId: value.sessionAgentId, profileId: value.profileId, extensionInstanceId: value.extensionInstanceId }
      : null
  }
  if (value.operation === 'lifecycle-release') {
    const keys = [...baseKeys, 'requestId', 'hostId', 'hostGeneration', 'tabId', 'reason']
    const reason = value.reason
    if (!exactKeys(value, keys) || !identifier(value.requestId) || !identifier(value.hostId) ||
      !Number.isSafeInteger(value.hostGeneration) || (value.hostGeneration as number) < 1 ||
      typeof value.tabId !== 'string' || decodeOpaqueExternalTabId(value.tabId) === null ||
      (reason !== 'stop' && reason !== 'archive' && reason !== 'delete' && reason !== 'detach' && reason !== 'host-replaced') ||
      !value.requestId.startsWith(`external-chrome-release:${reason}:`)) return null
    return { operation: 'lifecycle-release', requestId: value.requestId, hostId: value.hostId, hostGeneration: value.hostGeneration as number, sessionAgentId: value.sessionAgentId, profileId: value.profileId, tabId: value.tabId, reason }
  }
  if (value.operation !== 'attach' || !exactKeys(value, [...baseKeys, 'extensionInstanceId', 'tabIds', 'childPolicy', 'confirmed'], ['groupId'])) return null
  if (!identifier(value.extensionInstanceId) || value.confirmed !== true ||
    (value.childPolicy !== 'manual' && value.childPolicy !== 'include-opened-by-leased-tabs') ||
    !Array.isArray(value.tabIds) || value.tabIds.length === 0 || value.tabIds.length > 128 ||
    value.tabIds.some((id) => !Number.isSafeInteger(id) || id < 0) || new Set(value.tabIds).size !== value.tabIds.length ||
    (value.groupId !== undefined && (!Number.isSafeInteger(value.groupId) || (value.groupId as number) < 0))) return null
  return {
    operation: 'attach', sessionAgentId: value.sessionAgentId, profileId: value.profileId,
    extensionInstanceId: value.extensionInstanceId, tabIds: value.tabIds,
    ...(value.groupId === undefined ? {} : { groupId: value.groupId as number }),
    childPolicy: value.childPolicy, confirmed: true,
  }
}

function publicAttachment(lease: LocalLease): ExternalChromeLocalAttachment {
  const { leaseId: _leaseId, leaseEpoch: _leaseEpoch, expiresAt: _expiresAt, ...attachment } = lease
  void _leaseId; void _leaseEpoch; void _expiresAt
  return structuredClone(attachment)
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function identifier(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9._:@/-]+$/u.test(value) }
function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const allowed = new Set([...required, ...optional])
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) && Object.keys(value).every((key) => allowed.has(key))
}
function decodeOpaqueExternalTabId(value: string): { extensionInstanceId: string; tabId: number } | null {
  const match = /^ext\.([A-Za-z0-9_-]{1,128})\.([0-9]+)$/u.exec(value)
  if (!match) return null
  const tabId = Number(match[2])
  return Number.isSafeInteger(tabId) ? { extensionInstanceId: match[1]!, tabId } : null
}
function boundedRelease(operation: Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('External Chrome lifecycle release timed out')), 4_000)
    timer.unref?.()
    operation.then((value) => { clearTimeout(timer); resolve(value) }, (error) => { clearTimeout(timer); reject(error) })
  })
}
function localError(error: unknown): ExternalChromeLocalError {
  const message = error instanceof Error ? error.message : String(error)
  if (/attachment-required/u.test(message)) return 'attachment-required'
  if (/lease-conflict/u.test(message)) return 'lease-conflict'
  if (/restricted-target/u.test(message)) return 'restricted-target'
  if (/debugger-unavailable/u.test(message)) return 'debugger-unavailable'
  if (/chrome-policy-blocked/u.test(message)) return 'chrome-policy-blocked'
  if (/extension-update-required/u.test(message)) return 'extension-update-required'
  if (/disconnect|stale|lease-lost/u.test(message)) return 'stale-or-lost'
  return 'operation-failed'
}
