import type { BrowserAutomationRequest, BrowserHostLifecycleRequest } from '@forge/protocol'
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import { BrowserAutomationManager } from './browser-automation-manager.js'
import { BrowserHostError, asBrowserHostError } from './browser-errors.js'
import { BROWSER_IPC, type BrowserPresentationRequest } from './browser-bridge-contract.js'
import type { BrowserViewportMetrics, ManagedBrowserReconcileInput, ManagedBrowserViewHost } from './managed-browser-view-host.js'

export function installBrowserIpc(options: {
  ipcMain: IpcMain
  mainWindow: BrowserWindow
  manager: BrowserAutomationManager
  viewHost: ManagedBrowserViewHost
}): () => void {
  const { ipcMain, mainWindow, manager, viewHost } = options
  const trustedMain = (event: IpcMainInvokeEvent): void => {
    if (mainWindow.isDestroyed() || event.sender.id !== mainWindow.webContents.id) {
      throw new BrowserHostError('invalid-input', 'Privileged browser IPC is restricted to the authoritative Forge renderer')
    }
  }
  const channels: string[] = []
  const handle = (channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void => {
    const wrapped = async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      try {
        return { __forgeBrowserIpcResult: true, ok: true, value: await listener(event, ...args) }
      } catch (error) {
        return { __forgeBrowserIpcResult: true, ok: false, error: asBrowserHostError(error, `Browser IPC ${channel} failed`).toFailure() }
      }
    }
    ipcMain.handle(channel, wrapped as unknown as Parameters<IpcMain['handle']>[1])
    channels.push(channel)
  }

  handle(BROWSER_IPC.reconcile, (event, input) => {
    trustedMain(event)
    return viewHost.reconcile(input as ManagedBrowserReconcileInput)
  })
  handle(BROWSER_IPC.ensureProvisional, (event, input) => {
    trustedMain(event)
    const value = input as { tab: Parameters<ManagedBrowserViewHost['ensureProvisional']>[0]; workspaceEpoch: number }
    return viewHost.ensureProvisional(value.tab, value.workspaceEpoch)
  })
  handle(BROWSER_IPC.commitProvisional, (event, input) => {
    trustedMain(event)
    const value = input as { tabId: string; workspaceEpoch: number }
    return viewHost.commitProvisional(value.tabId, value.workspaceEpoch)
  })
  handle(BROWSER_IPC.abortProvisional, (event, tabId) => {
    trustedMain(event)
    return viewHost.abortProvisional(String(tabId))
  })
  handle(BROWSER_IPC.viewport, (event, input) => {
    trustedMain(event)
    viewHost.setPresentationTarget('docked', mainWindow, input as BrowserViewportMetrics)
  })
  handle(BROWSER_IPC.presentation, (event, input) => {
    trustedMain(event)
    return viewHost.present(input as BrowserPresentationRequest & { workspaceEpoch: number })
  })
  handle(BROWSER_IPC.capture, (event, tabId) => {
    trustedMain(event)
    return viewHost.captureScreenshot(String(tabId))
  })
  handle(BROWSER_IPC.humanNavigate, (event, input) => {
    trustedMain(event)
    const value = input as { tabId: string; url: string }
    return manager.humanNavigate(value.tabId, value.url)
  })
  handle(BROWSER_IPC.humanHistory, (event, input) => {
    trustedMain(event)
    const value = input as { tabId: string; direction: 'back' | 'forward' }
    return manager.humanHistory(value.tabId, value.direction)
  })
  handle(BROWSER_IPC.humanReload, (event, input) => {
    trustedMain(event)
    const value = input as { tabId: string; hard?: boolean }
    return manager.humanReload(value.tabId, value.hard === true)
  })
  handle(BROWSER_IPC.humanZoom, (event, input) => {
    trustedMain(event)
    const value = input as { tabId: string; factor: number }
    return manager.humanSetZoom(value.tabId, value.factor)
  })
  handle(BROWSER_IPC.execute, async (event, request) => {
    trustedMain(event)
    const value = request as BrowserAutomationRequest & { recordingMimeType?: string }
    if (value.operation === 'recordingStart' && typeof value.recordingMimeType === 'string') {
      manager.setRecordingMimeType(value, value.recordingMimeType)
    }
    return manager.execute(value)
  })
  handle(BROWSER_IPC.lifecycle, async (event, request) => {
    trustedMain(event)
    return manager.handleLifecycle(request as BrowserHostLifecycleRequest)
  })
  handle(BROWSER_IPC.reveal, async (event, input) => {
    trustedMain(event)
    const value = input as { sessionAgentId: string; profileId: string; tabId: string }
    return manager.revealTarget({ sessionAgentId: value.sessionAgentId, profileId: value.profileId }, value.tabId)
  })
  handle(BROWSER_IPC.takeControl, async (event, input) => {
    trustedMain(event)
    const value = parseTakeControlInput(input)
    return manager.takeControl({ sessionAgentId: value.sessionAgentId, profileId: value.profileId }, value.tabId)
  })
  handle(BROWSER_IPC.prepareRecording, async (event, request) => {
    trustedMain(event)
    return manager.prepareRecording(request as BrowserAutomationRequest & { operation: 'recordingStart' })
  })
  handle(BROWSER_IPC.stopRecordingCapture, async (event, request) => {
    trustedMain(event)
    return manager.stopRecordingCapture(request as BrowserAutomationRequest & { operation: 'recordingStop' })
  })
  handle(BROWSER_IPC.saveRecording, async (event, input) => {
    trustedMain(event)
    const value = input as { request: BrowserAutomationRequest & { operation: 'recordingStop' }; mimeType: string; bytes: Uint8Array }
    return manager.saveRecording(value.request, value.mimeType, value.bytes)
  })
  handle(BROWSER_IPC.cancelRecording, (event, recordingId) => {
    trustedMain(event)
    manager.cancelRecording(typeof recordingId === 'string' ? recordingId : undefined)
  })

  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    for (const channel of channels) ipcMain.removeHandler(channel)
    void viewHost.destroy()
  }
}

function parseTakeControlInput(value: unknown): { sessionAgentId: string; profileId: string; tabId: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BrowserHostError('invalid-input', 'Take Control input must be an object')
  }
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join(',') !== 'profileId,sessionAgentId,tabId') {
    throw new BrowserHostError('invalid-input', 'Take Control input has unexpected fields')
  }
  const bounded = (field: 'sessionAgentId' | 'profileId', maximum: number): string => {
    const candidate = record[field]
    if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > maximum || candidate.includes('\0')) {
      throw new BrowserHostError('invalid-input', `Take Control ${field} is invalid`)
    }
    return candidate
  }
  const tabId = record.tabId
  if (typeof tabId !== 'string') {
    throw new BrowserHostError('invalid-input', 'Take Control tabId is not a canonical External Chrome tab')
  }
  const tabMatch = /^ext\.[A-Za-z0-9_-]{1,128}\.([0-9]{1,16})$/u.exec(tabId)
  if (tabMatch === null || !Number.isSafeInteger(Number(tabMatch[1]))) {
    throw new BrowserHostError('invalid-input', 'Take Control tabId is not a canonical External Chrome tab')
  }
  return { sessionAgentId: bounded('sessionAgentId', 128), profileId: bounded('profileId', 128), tabId }
}
