import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import { installExternalChromeIpc } from '../ipc.js'
import type { ExternalChromeHostCoordinator } from '../coordinator.js'

const status = {
  state: 'disabled' as const, authority: 'none' as const, auth: 'missing' as const,
  registration: 'not-registered' as const, trust: 'missing' as const, platform: 'darwin' as const,
  canEnable: true, canDisable: true, canRepair: true, canRollback: true, canRemove: true, canTakeover: true, canReveal: true,
  recovery: 'ready', setup: { extensionId: 'fcchfcnadajoejfbiclihglkmbcfhajd' as const, pathState: 'ready' as const, loadUnpackedPath: '/forge/extension' },
}

function fixture() {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>>()
  const ipcMain = { handle: vi.fn((channel: string, handler: (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>) => handlers.set(channel, handler)), removeHandler: vi.fn() } as unknown as IpcMain
  const mainWindow = { isDestroyed: () => false, webContents: { id: 42 } } as unknown as BrowserWindow
  const coordinator = {
    status: vi.fn(async () => status), enable: vi.fn(async () => status), disable: vi.fn(async () => status), repair: vi.fn(async () => status),
    rollback: vi.fn(async () => status), remove: vi.fn(async () => status), takeover: vi.fn(async () => status),
    validatedLoadUnpackedPath: vi.fn(async () => status.setup.loadUnpackedPath), transport: vi.fn(() => ({ inventory: () => [] })),
  } as unknown as ExternalChromeHostCoordinator
  return { handlers, ipcMain, mainWindow, coordinator }
}

describe('trusted External Chrome IPC', () => {
  it('keeps coordinator controls authorized and bounded', async () => {
    const { handlers, ipcMain, mainWindow, coordinator } = fixture()
    const dispose = installExternalChromeIpc({ ipcMain, mainWindow, coordinator })
    const control = handlers.get('forge:external-chrome-control')!
    await expect(control({ sender: { id: 7 } } as unknown as IpcMainInvokeEvent, { operation: 'status' })).resolves.toEqual({ ok: false, error: 'invalid-request' })
    await expect(control({ sender: { id: 42 } } as unknown as IpcMainInvokeEvent, { operation: 'status' })).resolves.toEqual({ ok: true, status })
    dispose()
    expect(ipcMain.removeHandler).toHaveBeenCalledTimes(1)
    expect(handlers.has('forge:external-chrome-control')).toBe(true)
  })

  it('dispatches each capability-gated operation, reveal, and failures', async () => {
    const { handlers, ipcMain, mainWindow, coordinator } = fixture()
    const revealed = vi.fn(async () => undefined)
    const errors: unknown[] = []
    installExternalChromeIpc({ ipcMain, mainWindow, coordinator, revealExtensionFolder: revealed, onError: (error) => errors.push(error) })
    const control = handlers.get('forge:external-chrome-control')!
    for (const operation of ['enable', 'disable', 'repair', 'rollback', 'remove', 'takeover'] as const) {
      await expect(control({ sender: { id: 42 } } as unknown as IpcMainInvokeEvent, { operation })).resolves.toEqual({ ok: true, status })
      expect(coordinator[operation]).toHaveBeenCalledOnce()
    }
    await expect(control({ sender: { id: 42 } } as unknown as IpcMainInvokeEvent, { operation: 'reveal-extension-folder' })).resolves.toEqual({ ok: true, status })
    expect(coordinator.validatedLoadUnpackedPath).toHaveBeenCalledOnce()
    expect(revealed).toHaveBeenCalledWith(status.setup.loadUnpackedPath)

    status.canEnable = false
    await expect(control({ sender: { id: 42 } } as unknown as IpcMainInvokeEvent, { operation: 'enable' })).resolves.toEqual({ ok: false, error: 'operation-failed' })
    coordinator.repair.mockRejectedValueOnce(new Error('repair failed'))
    await expect(control({ sender: { id: 42 } } as unknown as IpcMainInvokeEvent, { operation: 'repair' })).resolves.toEqual({ ok: false, error: 'operation-failed' })
    expect(errors).toHaveLength(1)
    await expect(control({ sender: { id: 42 } } as unknown as IpcMainInvokeEvent, { operation: 'unknown' })).resolves.toEqual({ ok: false, error: 'invalid-request' })
  })
})
