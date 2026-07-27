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
/** Deprecated renderer channel retained only as a non-authoritative compatibility response. */
export const EXTERNAL_CHROME_ATTACH_CHANNEL = 'forge:external-chrome-attach'

export type ExternalChromeControlResult =
  | { ok: true; status: ExternalChromeCoordinatorStatus }
  | { ok: false; error: 'invalid-request' | 'operation-failed' }
export type ExternalChromeLocalError = 'invalid-request' | 'attachment-required' | 'operation-failed'

export interface ExternalChromeLocalAttachment {
  sessionAgentId: string; profileId: string; extensionInstanceId: string; profileAlias: string
  groupId: number | null; childPolicy: ExternalChromeChildPolicy
  tabs: Array<Pick<ExternalChromeSelectedTab, 'windowId' | 'tabId' | 'groupId' | 'title' | 'origin' | 'active'>>
  state: 'attached' | 'recovering' | 'lost'; attachedAt: string
}
export interface ExternalChromeLocalStatus {
  coordinator: ExternalChromeCoordinatorStatus
  instances: ExternalChromeRuntimeInventory[]
  attachment: ExternalChromeLocalAttachment | null
}
export type ExternalChromeAttachResult =
  | { ok: true; status: ExternalChromeLocalStatus; windows?: ExternalChromeCandidateWindow[] }
  | { ok: false; error: ExternalChromeLocalError }

export interface ExternalChromeAttachInput {
  sessionAgentId: string; profileId: string; extensionInstanceId: string; tabIds: number[]
  groupId?: number; childPolicy: ExternalChromeChildPolicy; confirmed: true
}
export interface ExternalChromeTurnEndedInput {
  requestId: string; hostId: string; hostGeneration: number; sessionAgentId: string; profileId: string
  tabId: string; turnId: string; disposition: 'handoff'
}
export interface ExternalChromeLifecycleReleaseInput {
  requestId: string; hostId: string; hostGeneration: number; sessionAgentId: string; profileId: string
  tabId: string; phase: 'prepare' | 'finalize'; releaseId: string
  reason: 'stop' | 'archive' | 'delete' | 'detach' | 'host-replaced'; originalHostId: string; originalHostGeneration: number
}

export interface TrustedExternalChromeBridge {
  status(): Promise<ExternalChromeControlResult>; enable(): Promise<ExternalChromeControlResult>; disable(): Promise<ExternalChromeControlResult>
  repair(): Promise<ExternalChromeControlResult>; rollback(): Promise<ExternalChromeControlResult>; remove(): Promise<ExternalChromeControlResult>
  takeover(): Promise<ExternalChromeControlResult>; revealExtensionFolder(): Promise<ExternalChromeControlResult>
  localStatus(sessionAgentId: string, profileId: string): Promise<ExternalChromeAttachResult>
  listCandidates(sessionAgentId: string, profileId: string, extensionInstanceId: string): Promise<ExternalChromeAttachResult>
  attach(input: ExternalChromeAttachInput): Promise<ExternalChromeAttachResult>
  detach(sessionAgentId: string, profileId: string): Promise<ExternalChromeAttachResult>
  releaseForLifecycle(input: ExternalChromeLifecycleReleaseInput): Promise<ExternalChromeAttachResult>
  turnEnded(input: ExternalChromeTurnEndedInput): Promise<ExternalChromeAttachResult>
}

export function installExternalChromeIpc(options: {
  ipcMain: IpcMain; mainWindow: BrowserWindow; coordinator: ExternalChromeHostCoordinator
  revealExtensionFolder?: (validatedPath: string) => Promise<void>; onError?: (error: unknown) => void
}): () => void {
  const authorized = (event: IpcMainInvokeEvent): boolean => !options.mainWindow.isDestroyed() && event.sender.id === options.mainWindow.webContents.id
  const control = async (event: IpcMainInvokeEvent, input: unknown): Promise<ExternalChromeControlResult> => {
    if (!authorized(event)) return { ok: false, error: 'invalid-request' }
    let request: ExternalChromeCoordinatorRequest
    try { request = parseExternalChromeCoordinatorRequest(input) } catch { return { ok: false, error: 'invalid-request' } }
    try {
      if (request.operation === 'status') return { ok: true, status: await options.coordinator.status() }
      const before = await options.coordinator.status()
      switch (request.operation) {
        case 'enable': if (before.canEnable) return { ok: true, status: await options.coordinator.enable() }; break
        case 'disable': if (before.canDisable) return { ok: true, status: await options.coordinator.disable() }; break
        case 'repair': if (before.canRepair) return { ok: true, status: await options.coordinator.repair() }; break
        case 'rollback': if (before.canRollback) return { ok: true, status: await options.coordinator.rollback() }; break
        case 'remove': if (before.canRemove) return { ok: true, status: await options.coordinator.remove() }; break
        case 'takeover': if (before.canTakeover) return { ok: true, status: await options.coordinator.takeover() }; break
        case 'reveal-extension-folder': {
          if (!before.canReveal || !options.revealExtensionFolder) break
          const folder = await options.coordinator.validatedLoadUnpackedPath()
          if (!folder) break
          await options.revealExtensionFolder(folder)
          return { ok: true, status: await options.coordinator.status() }
        }
      }
    } catch (error) { options.onError?.(error) }
    return { ok: false, error: 'operation-failed' }
  }
  const compatibility = async (event: IpcMainInvokeEvent, input: unknown): Promise<ExternalChromeAttachResult> => {
    if (!authorized(event) || typeof input !== 'object' || input === null) return { ok: false, error: 'invalid-request' }
    if ((input as { operation?: unknown }).operation !== 'status') return { ok: false, error: 'attachment-required' }
    try {
      return { ok: true, status: { coordinator: await options.coordinator.status(), instances: options.coordinator.transport().inventory(), attachment: null } }
    } catch (error) { options.onError?.(error); return { ok: false, error: 'operation-failed' } }
  }
  options.ipcMain.handle(EXTERNAL_CHROME_CONTROL_CHANNEL, control)
  options.ipcMain.handle(EXTERNAL_CHROME_ATTACH_CHANNEL, compatibility)
  return () => { options.ipcMain.removeHandler(EXTERNAL_CHROME_CONTROL_CHANNEL); options.ipcMain.removeHandler(EXTERNAL_CHROME_ATTACH_CHANNEL) }
}

export function createTrustedExternalChromeBridge(ipcRenderer: IpcRenderer): TrustedExternalChromeBridge {
  const invoke = (operation: ExternalChromeCoordinatorRequest['operation']): Promise<ExternalChromeControlResult> => ipcRenderer.invoke(EXTERNAL_CHROME_CONTROL_CHANNEL, { operation }) as Promise<ExternalChromeControlResult>
  const legacy = (value: unknown): Promise<ExternalChromeAttachResult> => ipcRenderer.invoke(EXTERNAL_CHROME_ATTACH_CHANNEL, value) as Promise<ExternalChromeAttachResult>
  return {
    status: () => invoke('status'), enable: () => invoke('enable'), disable: () => invoke('disable'), repair: () => invoke('repair'),
    rollback: () => invoke('rollback'), remove: () => invoke('remove'), takeover: () => invoke('takeover'), revealExtensionFolder: () => invoke('reveal-extension-folder'),
    localStatus: (sessionAgentId, profileId) => legacy({ operation: 'status', sessionAgentId, profileId }),
    listCandidates: (sessionAgentId, profileId, extensionInstanceId) => legacy({ operation: 'candidates', sessionAgentId, profileId, extensionInstanceId }),
    attach: (input) => legacy({ operation: 'attach', ...input }), detach: (sessionAgentId, profileId) => legacy({ operation: 'detach', sessionAgentId, profileId }),
    releaseForLifecycle: (input) => legacy({ operation: 'lifecycle-release', ...input }), turnEnded: (input) => legacy({ operation: 'turn-ended', ...input }),
  }
}
