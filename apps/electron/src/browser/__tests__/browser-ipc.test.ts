import { describe, expect, it, vi } from 'vitest'
import { BrowserHostError } from '../browser-errors.js'
import { BROWSER_IPC } from '../browser-bridge-contract.js'

vi.mock('electron', () => ({
  webContents: { fromId: vi.fn() },
}))

import { installBrowserIpc } from '../browser-ipc.js'

describe('browser IPC lifecycle envelopes', () => {
  it('makes repeated renderer unregister harmless and preserves typed host failures', async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>()
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (event: unknown, ...args: unknown[]) => Promise<unknown>) => handlers.set(channel, handler)),
      removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
    }
    const unregisterWebview = vi.fn()
    const destroy = vi.fn(async () => undefined)
    const manager = {
      unregisterWebview,
      destroy,
      prepareRecording: vi.fn(async () => {
        throw new BrowserHostError('recording-requires-visible-tab', 'physical bounds missing', true, { generation: 7 })
      }),
    }
    const dispose = installBrowserIpc({
      ipcMain: ipcMain as never,
      mainWindow: { webContents: { id: 10 } } as never,
      manager: manager as never,
      sessions: {} as never,
      guestPreloadPath: '/tmp/guest-preload.js',
    })
    const event = { sender: { id: 10 } }

    await expect(handlers.get(BROWSER_IPC.unregister)!(event, { tabId: 'tab-1', webContentsId: 22 })).resolves.toEqual({
      __forgeBrowserIpcResult: true,
      ok: true,
      value: undefined,
    })
    await expect(handlers.get(BROWSER_IPC.unregister)!(event, { tabId: 'tab-1', webContentsId: 22 })).resolves.toMatchObject({ ok: true })
    expect(unregisterWebview).toHaveBeenCalledTimes(2)

    await expect(handlers.get(BROWSER_IPC.prepareRecording)!(event, {})).resolves.toEqual({
      __forgeBrowserIpcResult: true,
      ok: false,
      error: {
        code: 'recording-requires-visible-tab',
        message: 'physical bounds missing',
        retryable: true,
        details: { generation: 7 },
      },
    })

    expect(() => dispose()).not.toThrow()
    await Promise.resolve()
    expect(destroy).toHaveBeenCalledOnce()
  })
})
