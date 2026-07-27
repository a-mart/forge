import { describe, expect, it, vi } from 'vitest'
import { BROWSER_WORKSPACE_IPC } from '../browser-bridge-contract.js'
import { installBrowserWorkspaceIpc } from '../browser-workspace-ipc.js'

function windowWithId(id: number, send = vi.fn()) {
  return {
    isDestroyed: () => false,
    webContents: {
      id,
      isDestroyed: () => false,
      isLoadingMainFrame: () => false,
      mainFrame: { detached: false, isDestroyed: () => false, send },
      send,
      on: vi.fn(),
    },
  }
}
const projection = {
  workspaceEpoch: 7, sessionAgentId: 'local-session', profileId: 'local-profile',
  snapshot: { schemaVersion: 1, sessionAgentId: 'local-session', profileId: 'local-profile', hostingState: 'hosted', tabs: [], activeTabId: null, defaultTabId: null, panelVisible: false, recentActions: [], revision: 1, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() },
  host: { connected: true, hostId: 'host', hostGeneration: 1, focused: true, capabilities: null, connectedAt: new Date(0).toISOString() },
  mode: 'docked' as const, popoutAvailable: true, connected: true, publishedAt: new Date(0).toISOString(),
}

describe('browser workspace role-scoped IPC', () => {
  it('allows bounded projection commands only from the current popout and replies through main authority', async () => {
    const handlers = new Map<string, (event: { sender: { id: number } }, ...args: unknown[]) => unknown>()
    const main = windowWithId(10); const popout = windowWithId(20)
    const ipcMain = { handle: vi.fn((channel, handler) => handlers.set(channel, handler)), removeHandler: vi.fn() }
    const installed = installBrowserWorkspaceIpc({
      ipcMain: ipcMain as never, getMainWindow: () => main as never, getPopoutWindow: () => popout as never,
      viewHost: { setPresentationTarget: vi.fn() } as never, getMode: () => 'docked',
      popOut: vi.fn(async () => 'popped-out'), dock: vi.fn(async () => 'docked'), bringToFront: vi.fn(),
    })
    await handlers.get(BROWSER_WORKSPACE_IPC.publish)!({ sender: { id: 10 } }, projection)
    expect(popout.webContents.send).toHaveBeenCalledWith(BROWSER_WORKSPACE_IPC.projection, expect.objectContaining({ sessionAgentId: 'local-session' }))
    expect(() => handlers.get(BROWSER_WORKSPACE_IPC.publish)!({ sender: { id: 20 } }, projection)).toThrow('restricted to the main Forge renderer')

    const request = { requestId: 'request-123', workspaceEpoch: 7, sessionAgentId: 'local-session', profileId: 'local-profile', deadlineAt: new Date(Date.now() + 5_000).toISOString(), command: { type: 'open' } }
    const result = handlers.get(BROWSER_WORKSPACE_IPC.command)!({ sender: { id: 20 } }, request)
    expect(main.webContents.send).toHaveBeenCalledWith(BROWSER_WORKSPACE_IPC.commandForward, request)
    await handlers.get(BROWSER_WORKSPACE_IPC.commandReply)!({ sender: { id: 10 } }, { requestId: 'request-123', ok: true, value: 'accepted' })
    await expect(result).resolves.toBe('accepted')
    await expect(handlers.get(BROWSER_WORKSPACE_IPC.command)!({ sender: { id: 99 } }, request)).rejects.toThrow('restricted to the current Managed Browser pop-out')
    installed.dispose()
  })

  it('rejects remote/null and stale workspace identities before forwarding', async () => {
    const handlers = new Map<string, (...args: never[]) => unknown>()
    const main = windowWithId(10); const popout = windowWithId(20)
    installBrowserWorkspaceIpc({ ipcMain: { handle: (channel: string, handler: never) => handlers.set(channel, handler), removeHandler: vi.fn() } as never, getMainWindow: () => main as never, getPopoutWindow: () => popout as never, viewHost: {} as never, getMode: () => 'docked', popOut: vi.fn(), dock: vi.fn(), bringToFront: vi.fn() })
    await (handlers.get(BROWSER_WORKSPACE_IPC.publish) as never as Function)({ sender: { id: 10 } }, { ...projection, workspaceEpoch: 8, sessionAgentId: null, profileId: null, snapshot: null })
    await expect((handlers.get(BROWSER_WORKSPACE_IPC.command) as never as Function)({ sender: { id: 20 } }, { requestId: 'request-456', workspaceEpoch: 7, sessionAgentId: 'remote', profileId: 'remote', deadlineAt: new Date(Date.now() + 1000).toISOString(), command: { type: 'open' } })).rejects.toMatchObject({ code: 'unavailable-host' })
    expect(main.webContents.send).not.toHaveBeenCalledWith(BROWSER_WORKSPACE_IPC.commandForward, expect.anything())
  })

  it('drops focus delivery when Electron disposes the authoritative main frame', () => {
    const disposedSend = vi.fn(() => {
      throw new Error('Error sending from webFrameMain: Render frame was disposed before WebFrameMain could be accessed')
    })
    const main = windowWithId(10, disposedSend)
    const installed = installBrowserWorkspaceIpc({
      ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } as never,
      getMainWindow: () => main as never,
      getPopoutWindow: () => null,
      viewHost: {} as never,
      getMode: () => 'docked',
      popOut: vi.fn(),
      dock: vi.fn(),
      bringToFront: vi.fn(),
    })

    expect(() => installed.publishFocus(true)).not.toThrow()
    expect(disposedSend).toHaveBeenCalledWith(BROWSER_WORKSPACE_IPC.focus, true)
    installed.dispose()
  })
})
