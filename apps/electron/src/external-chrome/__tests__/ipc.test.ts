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
    expect(ipcMain.removeHandler).toHaveBeenCalledTimes(2)
  })

  it('makes the legacy attach channel non-authoritative and never enumerates candidates', async () => {
    const { handlers, ipcMain, mainWindow, coordinator } = fixture()
    installExternalChromeIpc({ ipcMain, mainWindow, coordinator })
    const attach = handlers.get('forge:external-chrome-attach')!
    const event = { sender: { id: 42 } } as unknown as IpcMainInvokeEvent
    await expect(attach(event, { operation: 'status', sessionAgentId: 'session', profileId: 'profile' })).resolves.toEqual({
      ok: true, status: { coordinator: status, instances: [], attachment: null },
    })
    for (const operation of ['candidates', 'attach', 'detach', 'lifecycle-release', 'turn-ended']) {
      await expect(attach(event, { operation, sessionAgentId: 'session', profileId: 'profile' })).resolves.toEqual({ ok: false, error: 'attachment-required' })
    }
    expect(coordinator.transport().inventory()).toEqual([])
  })
})
