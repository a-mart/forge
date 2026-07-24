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
  remove(): Promise<ExternalChromeControlResult>
}

export function installExternalChromeIpc(options: {
  ipcMain: IpcMain
  mainWindow: BrowserWindow
  coordinator: ExternalChromeHostCoordinator
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
      switch (request.operation) {
        case 'status': return { ok: true, status: await options.coordinator.status() }
        case 'enable': return { ok: true, status: await options.coordinator.enable() }
        case 'disable': return { ok: true, status: await options.coordinator.disable() }
        case 'repair': return { ok: true, status: await options.coordinator.repair() }
        case 'remove': return { ok: true, status: await options.coordinator.remove() }
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
    remove: () => invoke('remove'),
  }
}
