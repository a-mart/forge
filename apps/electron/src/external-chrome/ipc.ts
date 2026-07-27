import {
  parseExternalChromeCoordinatorRequest,
  type ExternalChromeCoordinatorRequest,
  type ExternalChromeCoordinatorStatus,
} from '@forge/protocol'
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, IpcRenderer } from 'electron'
import type { ExternalChromeHostCoordinator } from './coordinator.js'

export const EXTERNAL_CHROME_CONTROL_CHANNEL = 'forge:external-chrome-control'

export type ExternalChromeControlResult =
  | { ok: true; status: ExternalChromeCoordinatorStatus }
  | { ok: false; error: 'invalid-request' | 'operation-failed' }

export interface TrustedExternalChromeBridge {
  status(): Promise<ExternalChromeControlResult>
  enable(): Promise<ExternalChromeControlResult>
  disable(): Promise<ExternalChromeControlResult>
  repair(): Promise<ExternalChromeControlResult>
  rollback(): Promise<ExternalChromeControlResult>
  remove(): Promise<ExternalChromeControlResult>
  takeover(): Promise<ExternalChromeControlResult>
  revealExtensionFolder(): Promise<ExternalChromeControlResult>
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
  const control = async (event: IpcMainInvokeEvent, input: unknown): Promise<ExternalChromeControlResult> => {
    if (!authorized(event)) return { ok: false, error: 'invalid-request' }
    let request: ExternalChromeCoordinatorRequest
    try {
      request = parseExternalChromeCoordinatorRequest(input)
    } catch {
      return { ok: false, error: 'invalid-request' }
    }
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
    } catch (error) {
      options.onError?.(error)
    }
    return { ok: false, error: 'operation-failed' }
  }
  options.ipcMain.handle(EXTERNAL_CHROME_CONTROL_CHANNEL, control)
  return () => options.ipcMain.removeHandler(EXTERNAL_CHROME_CONTROL_CHANNEL)
}

export function createTrustedExternalChromeBridge(ipcRenderer: IpcRenderer): TrustedExternalChromeBridge {
  const invoke = (operation: ExternalChromeCoordinatorRequest['operation']): Promise<ExternalChromeControlResult> =>
    ipcRenderer.invoke(EXTERNAL_CHROME_CONTROL_CHANNEL, { operation }) as Promise<ExternalChromeControlResult>
  return {
    status: () => invoke('status'),
    enable: () => invoke('enable'),
    disable: () => invoke('disable'),
    repair: () => invoke('repair'),
    rollback: () => invoke('rollback'),
    remove: () => invoke('remove'),
    takeover: () => invoke('takeover'),
    revealExtensionFolder: () => invoke('reveal-extension-folder'),
  }
}
