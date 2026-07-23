import { pathToFileURL } from 'node:url'
import type { BrowserAutomationRequest } from '@forge/protocol'
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import { webContents } from 'electron'
import {
  BrowserAutomationManager,
  type BrowserWebContentsLike,
  type BrowserWebviewRegistration,
} from './browser-automation-manager.js'
import { BrowserHostError, asBrowserHostError } from './browser-errors.js'
import { BrowserSessionRegistry } from './browser-session.js'
import { BROWSER_IPC, type BrowserBridgeConfig, type BrowserPresentationRequest } from './browser-bridge-contract.js'

export function installBrowserIpc(options: {
  ipcMain: IpcMain
  mainWindow: BrowserWindow
  manager: BrowserAutomationManager
  sessions: BrowserSessionRegistry
  guestPreloadPath: string
}): () => void {
  const { ipcMain, mainWindow, manager, sessions, guestPreloadPath } = options
  const trusted = (event: IpcMainInvokeEvent): void => {
    if (event.sender.id !== mainWindow.webContents.id) throw new BrowserHostError('invalid-input', 'Browser IPC is restricted to the trusted Forge renderer')
  }
  const handles: Array<[string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown]> = []
  const handle = (channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void => {
    const wrapped = async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      try {
        return { __forgeBrowserIpcResult: true, ok: true, value: await listener(event, ...args) }
      } catch (error) {
        return { __forgeBrowserIpcResult: true, ok: false, error: asBrowserHostError(error, `Browser IPC ${channel} failed`).toFailure() }
      }
    }
    ipcMain.handle(channel, wrapped as unknown as Parameters<IpcMain['handle']>[1])
    handles.push([channel, listener])
  }

  handle(BROWSER_IPC.config, (event, profileId) => {
    trusted(event)
    const id = String(profileId)
    sessions.getSession(id)
    return {
      partition: sessions.getPartition(id),
      preloadUrl: pathToFileURL(guestPreloadPath).toString(),
      webPreferences: 'contextIsolation=true,sandbox=true,nodeIntegration=false',
    } satisfies BrowserBridgeConfig
  })
  handle(BROWSER_IPC.register, (event, registration) => {
    trusted(event)
    const value = registration as BrowserWebviewRegistration
    const guest = webContents.fromId(value.webContentsId)
    if (!isTrustedGuest(guest, mainWindow.webContents)) throw new BrowserHostError('tab-not-found', 'Webview registration did not identify a hosted Forge guest')
    if (guest.session !== sessions.getSession(value.tab.profileId)) throw new BrowserHostError('tab-session-mismatch', 'Hosted webview partition does not match its Forge profile')
    return manager.registerWebview(value, guest as unknown as BrowserWebContentsLike)
  })
  handle(BROWSER_IPC.unregister, (event, input) => {
    trusted(event)
    const value = input as { tabId: string; webContentsId?: number }
    manager.unregisterWebview(value.tabId, value.webContentsId)
  })
  handle(BROWSER_IPC.presentation, (event, input) => {
    trusted(event)
    return manager.setTabPresentation(input as BrowserPresentationRequest)
  })
  handle(BROWSER_IPC.humanNavigate, (event, input) => {
    trusted(event)
    const value = input as { tabId: string; url: string }
    return manager.humanNavigate(value.tabId, value.url)
  })
  handle(BROWSER_IPC.humanHistory, (event, input) => {
    trusted(event)
    const value = input as { tabId: string; direction: 'back' | 'forward' }
    return manager.humanHistory(value.tabId, value.direction)
  })
  handle(BROWSER_IPC.humanReload, (event, input) => {
    trusted(event)
    const value = input as { tabId: string; hard?: boolean }
    return manager.humanReload(value.tabId, value.hard === true)
  })
  handle(BROWSER_IPC.humanZoom, (event, input) => {
    trusted(event)
    const value = input as { tabId: string; factor: number }
    return manager.humanSetZoom(value.tabId, value.factor)
  })
  handle(BROWSER_IPC.execute, async (event, request) => {
    trusted(event)
    const value = request as BrowserAutomationRequest & { recordingMimeType?: string }
    if (value.operation === 'recordingStart' && typeof value.recordingMimeType === 'string') {
      manager.setRecordingMimeType(value, value.recordingMimeType)
    }
    return manager.execute(value)
  })
  handle(BROWSER_IPC.prepareRecording, async (event, request) => {
    trusted(event)
    return manager.prepareRecording(request as BrowserAutomationRequest & { operation: 'recordingStart' })
  })
  handle(BROWSER_IPC.stopRecordingCapture, async (event, request) => {
    trusted(event)
    return manager.stopRecordingCapture(request as BrowserAutomationRequest & { operation: 'recordingStop' })
  })
  handle(BROWSER_IPC.saveRecording, async (event, input) => {
    trusted(event)
    const value = input as { request: BrowserAutomationRequest & { operation: 'recordingStop' }; mimeType: string; bytes: Uint8Array }
    return manager.saveRecording(value.request, value.mimeType, value.bytes)
  })
  handle(BROWSER_IPC.cancelRecording, (event, recordingId) => {
    trusted(event)
    manager.cancelRecording(typeof recordingId === 'string' ? recordingId : undefined)
  })

  return () => {
    for (const [channel] of handles) ipcMain.removeHandler(channel)
    void manager.destroy()
  }
}

export function isTrustedGuest(candidate: WebContents | undefined, host: WebContents): candidate is WebContents {
  return Boolean(candidate && !candidate.isDestroyed() && candidate.getType() === 'webview' && candidate.hostWebContents?.id === host.id)
}
