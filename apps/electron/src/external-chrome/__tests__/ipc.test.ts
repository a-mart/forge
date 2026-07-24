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
  canEnable: true,
  canDisable: true,
  canRepair: true,
  canRollback: true,
  canRemove: true,
  canTakeover: true,
  canReveal: true,
  setup: {
    extensionId: 'fcchfcnadajoejfbiclihglkmbcfhajd' as const,
    pathState: 'ready' as const,
    loadUnpackedPath: '/forge-owned/external-chrome/extension',
  },
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
      rollback: vi.fn(async () => status),
      remove: vi.fn(async () => status),
      takeover: vi.fn(async () => status),
      validatedLoadUnpackedPath: vi.fn(async () => status.setup.loadUnpackedPath),
    } as unknown as ExternalChromeHostCoordinator
    const revealExtensionFolder = vi.fn(async () => undefined)
    const dispose = installExternalChromeIpc({ ipcMain, mainWindow, coordinator, revealExtensionFolder })
    if (!handler) throw new Error('IPC handler was not installed')
    const invoke = handler as (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>

    await expect(invoke({ sender: { id: 7 } } as unknown as IpcMainInvokeEvent, { operation: 'status' }))
      .resolves.toEqual({ ok: false, error: 'invalid-request' })
    await expect(invoke({ sender: { id: 42 } } as unknown as IpcMainInvokeEvent, { operation: 'status', key: 'leak' }))
      .resolves.toEqual({ ok: false, error: 'invalid-request' })
    const result = await invoke({ sender: { id: 42 } } as unknown as IpcMainInvokeEvent, { operation: 'status' })
    expect(result).toEqual({ ok: true, status })
    expect(JSON.stringify(result)).not.toMatch(/endpoint|pid|secret|keyId/iu)

    await expect(invoke({ sender: { id: 42 } } as unknown as IpcMainInvokeEvent, {
      operation: 'reveal-extension-folder', path: '/attacker-controlled',
    })).resolves.toEqual({ ok: false, error: 'invalid-request' })
    await expect(invoke({ sender: { id: 42 } } as unknown as IpcMainInvokeEvent, {
      operation: 'reveal-extension-folder',
    })).resolves.toEqual({ ok: true, status })
    expect(revealExtensionFolder).toHaveBeenCalledWith('/forge-owned/external-chrome/extension')

    for (const operation of ['enable', 'disable', 'repair', 'rollback', 'remove', 'takeover'] as const) {
      await expect(invoke({ sender: { id: 42 } } as unknown as IpcMainInvokeEvent, { operation }))
        .resolves.toEqual({ ok: true, status: operation === 'enable' ? { ...status, state: 'online' } : status })
    }
    expect(coordinator.rollback).toHaveBeenCalledTimes(1)
    expect(coordinator.takeover).toHaveBeenCalledTimes(1)
    dispose()
    expect(ipcMain.removeHandler).toHaveBeenCalledTimes(1)
  })
})
