import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import { BrowserHostError } from './browser-errors.js'
import {
  BROWSER_WORKSPACE_IPC,
  type BrowserWorkspaceCommandRequest,
  type ManagedBrowserWorkspaceMode,
  type ManagedBrowserWorkspaceProjection,
} from './browser-bridge-contract.js'
import type { BrowserViewportMetrics, ManagedBrowserViewHost } from './managed-browser-view-host.js'

interface PendingCommand {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

export function installBrowserWorkspaceIpc(options: {
  ipcMain: IpcMain
  getMainWindow(): BrowserWindow | null
  getPopoutWindow(): BrowserWindow | null
  viewHost: ManagedBrowserViewHost
  getMode(): ManagedBrowserWorkspaceMode
  popOut(epoch: number): Promise<ManagedBrowserWorkspaceMode>
  dock(epoch: number): Promise<ManagedBrowserWorkspaceMode>
  bringToFront(): void
}): {
  dispose(): void
  publishMode(mode: ManagedBrowserWorkspaceMode): void
  publishFocus(focused: boolean): void
  getProjection(): ManagedBrowserWorkspaceProjection | null
} {
  const pending = new Map<string, PendingCommand>()
  let projection: ManagedBrowserWorkspaceProjection | null = null
  let disposed = false
  const handled: string[] = []

  const mainWindow = (): BrowserWindow => {
    const value = options.getMainWindow()
    if (!value || value.isDestroyed()) throw new BrowserHostError('host-disconnected', 'Authoritative Forge renderer is unavailable')
    return value
  }
  const popoutWindow = (): BrowserWindow => {
    const value = options.getPopoutWindow()
    if (!value || value.isDestroyed()) throw new BrowserHostError('host-disconnected', 'Managed Browser pop-out renderer is unavailable')
    return value
  }
  const requireMain = (event: IpcMainInvokeEvent): void => {
    if (event.sender.id !== mainWindow().webContents.id) throw new BrowserHostError('invalid-input', 'Workspace authority is restricted to the main Forge renderer')
  }
  const requirePopout = (event: IpcMainInvokeEvent): void => {
    if (event.sender.id !== popoutWindow().webContents.id) throw new BrowserHostError('invalid-input', 'This command is restricted to the current Managed Browser pop-out')
  }
  const handle = (channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void => {
    options.ipcMain.handle(channel, listener as Parameters<IpcMain['handle']>[1])
    handled.push(channel)
  }

  handle(BROWSER_WORKSPACE_IPC.publish, (event, value) => {
    requireMain(event)
    const next = validateProjection(value)
    if (projection && next.workspaceEpoch < projection.workspaceEpoch) return
    projection = { ...next, mode: options.getMode() }
    send(options.getPopoutWindow(), BROWSER_WORKSPACE_IPC.projection, projection)
  })
  handle(BROWSER_WORKSPACE_IPC.snapshot, (event) => {
    requirePopout(event)
    return projection ? { ...projection, mode: options.getMode() } : null
  })
  handle(BROWSER_WORKSPACE_IPC.command, async (event, value) => {
    requirePopout(event)
    const request = validateCommand(value, projection)
    const authoritative = mainWindow()
    if (pending.has(request.requestId)) throw new BrowserHostError('invalid-input', 'Duplicate browser workspace command request')
    const deadline = Date.parse(request.deadlineAt)
    if (!Number.isFinite(deadline) || deadline <= Date.now() || deadline - Date.now() > 15_000) {
      throw new BrowserHostError('invalid-input', 'Browser workspace command deadline is invalid')
    }
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(request.requestId)
        reject(new BrowserHostError('timeout', 'Browser workspace command timed out', true))
      }, Math.max(1, deadline - Date.now()))
      pending.set(request.requestId, { resolve, reject, timer })
      authoritative.webContents.send(BROWSER_WORKSPACE_IPC.commandForward, request)
    })
  })
  handle(BROWSER_WORKSPACE_IPC.commandReply, (event, value) => {
    requireMain(event)
    const reply = value as { requestId?: unknown; ok?: unknown; value?: unknown; error?: unknown }
    if (typeof reply.requestId !== 'string') return
    const waiting = pending.get(reply.requestId)
    if (!waiting) return
    pending.delete(reply.requestId)
    clearTimeout(waiting.timer)
    if (reply.ok === true) waiting.resolve(reply.value)
    else waiting.reject(new BrowserHostError('execution-failed', typeof reply.error === 'string' ? reply.error : 'Browser workspace command failed'))
  })
  handle(BROWSER_WORKSPACE_IPC.popOut, (event, epoch) => {
    requireMain(event)
    return options.popOut(requireCurrentEpoch(epoch, projection))
  })
  handle(BROWSER_WORKSPACE_IPC.dock, (event, epoch) => {
    // Both the toolbar in the authoritative renderer and the current projection
    // renderer may dock, but no other Forge window is trusted.
    const senderId = event.sender.id
    const isMain = senderId === mainWindow().webContents.id
    const popout = options.getPopoutWindow()
    const isPopout = Boolean(popout && !popout.isDestroyed() && senderId === popout.webContents.id)
    if (!isMain && !isPopout) throw new BrowserHostError('invalid-input', 'Dock is restricted to a current browser workspace renderer')
    return options.dock(requireCurrentEpoch(epoch, projection))
  })
  handle(BROWSER_WORKSPACE_IPC.bringToFront, (event) => {
    requireMain(event)
    options.bringToFront()
  })
  handle(BROWSER_WORKSPACE_IPC.viewport, (event, value) => {
    requirePopout(event)
    const metrics = value as BrowserViewportMetrics
    if (!projection || metrics.workspaceEpoch !== projection.workspaceEpoch) {
      throw new BrowserHostError('stale-host-generation', 'Pop-out viewport belongs to a stale workspace epoch', true)
    }
    options.viewHost.setPresentationTarget('popout', popoutWindow(), metrics)
  })

  const rejectPending = (message: string): void => {
    for (const waiting of pending.values()) {
      clearTimeout(waiting.timer)
      waiting.reject(new BrowserHostError('host-disconnected', message, true))
    }
    pending.clear()
  }
  options.getMainWindow()?.webContents.on('render-process-gone', () => rejectPending('Authoritative renderer exited'))

  return {
    dispose() {
      if (disposed) return
      disposed = true
      for (const channel of handled) options.ipcMain.removeHandler(channel)
      rejectPending('Browser workspace IPC disposed')
      projection = null
    },
    publishMode(mode) {
      if (projection) projection = { ...projection, mode }
      send(options.getMainWindow(), BROWSER_WORKSPACE_IPC.mode, mode)
      send(options.getPopoutWindow(), BROWSER_WORKSPACE_IPC.mode, mode)
      send(options.getPopoutWindow(), BROWSER_WORKSPACE_IPC.projection, projection)
    },
    publishFocus(focused) {
      send(options.getMainWindow(), BROWSER_WORKSPACE_IPC.focus, focused)
    },
    getProjection: () => projection,
  }
}

function validateProjection(value: unknown): ManagedBrowserWorkspaceProjection {
  if (!value || typeof value !== 'object') throw new BrowserHostError('invalid-input', 'Browser workspace projection is invalid')
  const projection = value as ManagedBrowserWorkspaceProjection
  if (!Number.isSafeInteger(projection.workspaceEpoch) || projection.workspaceEpoch < 0) throw new BrowserHostError('invalid-input', 'Browser workspace epoch is invalid')
  if (projection.sessionAgentId !== null && (typeof projection.sessionAgentId !== 'string' || projection.sessionAgentId.length === 0)) throw new BrowserHostError('invalid-input', 'Browser workspace session is invalid')
  if (projection.profileId !== null && (typeof projection.profileId !== 'string' || projection.profileId.length === 0)) throw new BrowserHostError('invalid-input', 'Browser workspace profile is invalid')
  if ((projection.sessionAgentId === null) !== (projection.profileId === null)) throw new BrowserHostError('invalid-input', 'Browser workspace identity is incomplete')
  if (projection.snapshot && (projection.snapshot.sessionAgentId !== projection.sessionAgentId || projection.snapshot.profileId !== projection.profileId)) throw new BrowserHostError('tab-session-mismatch', 'Browser workspace snapshot identity is inconsistent')
  return projection
}

function validateCommand(value: unknown, projection: ManagedBrowserWorkspaceProjection | null): BrowserWorkspaceCommandRequest {
  if (!projection || !projection.sessionAgentId || !projection.profileId || !projection.connected) {
    throw new BrowserHostError('unavailable-host', 'No selected local Managed Browser workspace is available')
  }
  if (!value || typeof value !== 'object') throw new BrowserHostError('invalid-input', 'Browser workspace command is invalid')
  const request = value as BrowserWorkspaceCommandRequest
  if (request.workspaceEpoch !== projection.workspaceEpoch || request.sessionAgentId !== projection.sessionAgentId || request.profileId !== projection.profileId) {
    throw new BrowserHostError('stale-host-generation', 'Browser workspace command targets stale authority', true)
  }
  if (typeof request.requestId !== 'string' || request.requestId.length < 8 || !request.command || typeof request.command.type !== 'string') {
    throw new BrowserHostError('invalid-input', 'Browser workspace command correlation is invalid')
  }
  if (request.command.type === 'open' && request.command.autoOpenAttemptKey !== undefined
    && (typeof request.command.autoOpenAttemptKey !== 'string' || request.command.autoOpenAttemptKey.length === 0 || request.command.autoOpenAttemptKey.length > 512)) {
    throw new BrowserHostError('invalid-input', 'Browser workspace automatic-open key is invalid')
  }
  if (request.command.type !== 'open') {
    const tabId = 'tabId' in request.command ? request.command.tabId : null
    if (!tabId || !projection.snapshot?.tabs.some((tab) => tab.tabId === tabId && tab.lifecycle !== 'closed')) {
      throw new BrowserHostError('tab-not-found', 'Browser workspace command tab is not canonical')
    }
  }
  return request
}

function requireCurrentEpoch(value: unknown, projection: ManagedBrowserWorkspaceProjection | null): number {
  const epoch = Number(value)
  if (!projection || !Number.isSafeInteger(epoch) || epoch !== projection.workspaceEpoch || !projection.sessionAgentId) {
    throw new BrowserHostError('stale-host-generation', 'Browser workspace transition targets stale authority', true)
  }
  return epoch
}

function send(window: BrowserWindow | null, channel: string, payload: unknown): void {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return
  window.webContents.send(channel, payload)
}
