import { describe, expect, it, vi } from 'vitest'
import { BrowserHostError } from '../browser-errors.js'
import { BROWSER_IPC } from '../browser-bridge-contract.js'
import { installBrowserIpc } from '../browser-ipc.js'

describe('main-owned browser IPC role and lifecycle', () => {
  it('restricts reconciliation/automation to main and disposes the view host once', async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>()
    const ipcMain = { handle: vi.fn((channel, handler) => handlers.set(channel, handler)), removeHandler: vi.fn((channel) => handlers.delete(channel)) }
    const manager = {
      prepareRecording: vi.fn(async () => { throw new BrowserHostError('recording-requires-visible-tab', 'physical bounds missing', true) }),
      humanNavigate: vi.fn(), humanHistory: vi.fn(), humanReload: vi.fn(), humanSetZoom: vi.fn(), execute: vi.fn(),
      stopRecordingCapture: vi.fn(), saveRecording: vi.fn(), cancelRecording: vi.fn(), setRecordingMimeType: vi.fn(),
    }
    const viewHost = {
      reconcile: vi.fn(async () => ({ applied: true, tabCount: 1 })), ensureProvisional: vi.fn(), commitProvisional: vi.fn(), abortProvisional: vi.fn(),
      setPresentationTarget: vi.fn(), present: vi.fn(), captureScreenshot: vi.fn(), destroy: vi.fn(async () => undefined),
    }
    const mainWindow = { isDestroyed: () => false, webContents: { id: 10 } }
    const dispose = installBrowserIpc({ ipcMain: ipcMain as never, mainWindow: mainWindow as never, manager: manager as never, viewHost: viewHost as never })

    await expect(handlers.get(BROWSER_IPC.reconcile)!({ sender: { id: 10 } }, { updateSequence: 1 })).resolves.toMatchObject({ ok: true, value: { applied: true } })
    await expect(handlers.get(BROWSER_IPC.reconcile)!({ sender: { id: 11 } }, {})).resolves.toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    await expect(handlers.get(BROWSER_IPC.prepareRecording)!({ sender: { id: 10 } }, {})).resolves.toMatchObject({ ok: false, error: { code: 'recording-requires-visible-tab' } })

    dispose(); dispose(); await Promise.resolve()
    expect(viewHost.destroy).toHaveBeenCalledOnce()
    expect(ipcMain.removeHandler).toHaveBeenCalledTimes(16)
  })
})
