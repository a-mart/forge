import { describe, expect, it, vi } from 'vitest'
import {
  sendToRendererWindow,
  type RendererIpcFrame,
  type RendererIpcWebContents,
  type RendererIpcWindow,
} from '../renderer-ipc.js'

function createWindow(options: {
  windowDestroyed?: boolean
  webContentsDestroyed?: boolean
  loading?: boolean
  frameDestroyed?: boolean
  detached?: boolean
  send?: RendererIpcFrame['send']
} = {}): { frame: RendererIpcFrame; window: RendererIpcWindow } {
  const frame: RendererIpcFrame = {
    detached: options.detached ?? false,
    isDestroyed: vi.fn(() => options.frameDestroyed ?? false),
    send: options.send ?? vi.fn(),
  }
  const webContents: RendererIpcWebContents = {
    mainFrame: frame,
    isDestroyed: vi.fn(() => options.webContentsDestroyed ?? false),
    isLoadingMainFrame: vi.fn(() => options.loading ?? false),
  }
  return {
    frame,
    window: {
      webContents,
      isDestroyed: vi.fn(() => options.windowDestroyed ?? false),
    },
  }
}

describe('sendToRendererWindow', () => {
  it('sends through the current main frame', () => {
    const send = vi.fn()
    const { window } = createWindow({ send })

    expect(sendToRendererWindow(window, 'forge:event', { ok: true }, 2)).toBe(true)
    expect(send).toHaveBeenCalledWith('forge:event', { ok: true }, 2)
  })

  it.each([
    ['destroyed window', { windowDestroyed: true }],
    ['destroyed web contents', { webContentsDestroyed: true }],
    ['loading main frame', { loading: true }],
    ['destroyed main frame', { frameDestroyed: true }],
    ['detached main frame', { detached: true }],
  ])('drops delivery for a %s', (_label, options) => {
    const send = vi.fn()
    const { window } = createWindow({ ...options, send })

    expect(sendToRendererWindow(window, 'forge:event')).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('drops the known disposed WebFrameMain race', () => {
    const send = vi.fn(() => {
      throw new Error('Error sending from webFrameMain: Render frame was disposed before WebFrameMain could be accessed')
    })
    const { window } = createWindow({ send })

    expect(sendToRendererWindow(window, 'forge:event')).toBe(false)
  })

  it('rethrows unrelated IPC failures', () => {
    const failure = new Error('An object could not be cloned.')
    const { window } = createWindow({ send: () => { throw failure } })

    expect(() => sendToRendererWindow(window, 'forge:event')).toThrow(failure)
  })
})
