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
  const handler = async (event: IpcMainInvokeEvent, input: unknown): Promise<ExternalChromeControlResult> => {
    if (options.mainWindow.isDestroyed() || event.sender.id !== options.mainWindow.webContents.id) {
      return { ok: false, error: 'invalid-request' }
    }
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
  options.ipcMain.handle(EXTERNAL_CHROME_CONTROL_CHANNEL, handler)
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
