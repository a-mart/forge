import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false }, BrowserWindow: class {}, dialog: {}, Notification: class {} }))
vi.mock('electron-updater', () => ({ autoUpdater: {} }))

import { prepareUpdateInstall } from '../auto-updater.js'

describe('prepareUpdateInstall', () => {
  it('quiesces before preserving the existing quit preparation behavior', async () => {
    const calls: string[] = []
    await prepareUpdateInstall({
      quiesceHook: { quiesce: async (reason) => { calls.push(reason) } },
      prepareQuitForUpdate: async () => { calls.push('prepare-quit') },
    })
    expect(calls).toEqual(['desktop-update', 'prepare-quit'])
  })

  it('bounds a stuck quiesce hook and does not quit partially', async () => {
    const prepare = vi.fn()
    await expect(prepareUpdateInstall({
      quiesceHook: { quiesce: () => new Promise(() => undefined) },
      quiesceTimeoutMs: 5,
      prepareQuitForUpdate: prepare,
    })).rejects.toThrow('timed out')
    expect(prepare).not.toHaveBeenCalled()
  })

  it('keeps old updater clients working when no hook is supplied', async () => {
    const prepare = vi.fn(async () => undefined)
    await prepareUpdateInstall({ prepareQuitForUpdate: prepare })
    expect(prepare).toHaveBeenCalledOnce()
  })
})
