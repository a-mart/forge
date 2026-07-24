import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import { installExternalChromeIpc } from '../ipc.js'
import type { ExternalChromeHostCoordinator } from '../coordinator.js'

const status = {
  state: 'disabled' as const,
  authority: 'none' as const,
  auth: 'missing' as const,
  registration: 'not-registered' as const,
  trust: 'missing' as const,
  platform: 'darwin' as const,
  canEnable: false,
  canRepair: true,
}

describe('trusted External Chrome IPC', () => {
  it('accepts only exact validated requests from the authoritative renderer and exposes no secret fields', async () => {
    let handler: ((event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>) | null = null
    const ipcMain = {
      handle: vi.fn((_channel: string, value: typeof handler) => { handler = value }),
      removeHandler: vi.fn(),
    } as unknown as IpcMain
    const mainWindow = {
      isDestroyed: () => false,
      webContents: { id: 42 },
    } as unknown as BrowserWindow
    const coordinator = {
      status: vi.fn(async () => status),
      enable: vi.fn(async () => ({ ...status, state: 'online' as const })),
      disable: vi.fn(async () => status),
      repair: vi.fn(async () => status),
      remove: vi.fn(async () => status),
    } as unknown as ExternalChromeHostCoordinator
    const dispose = installExternalChromeIpc({ ipcMain, mainWindow, coordinator })
    if (!handler) throw new Error('IPC handler was not installed')
    const invoke = handler as (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>

    await expect(invoke({ sender: { id: 7 } } as unknown as IpcMainInvokeEvent, { operation: 'status' }))
      .resolves.toEqual({ ok: false, error: 'invalid-request' })
    await expect(invoke({ sender: { id: 42 } } as unknown as IpcMainInvokeEvent, { operation: 'status', key: 'leak' }))
      .resolves.toEqual({ ok: false, error: 'invalid-request' })
    const result = await invoke({ sender: { id: 42 } } as unknown as IpcMainInvokeEvent, { operation: 'status' })
    expect(result).toEqual({ ok: true, status })
    expect(JSON.stringify(result)).not.toMatch(/endpoint|path|pid|secret|keyId/iu)
    dispose()
    expect(ipcMain.removeHandler).toHaveBeenCalledTimes(1)
  })
})
