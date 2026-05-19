import { describe, expect, it, vi } from 'vitest'
import type { SleepBlockerStatus } from '../sleep-blocker.js'
import {
  sendSleepBlockerStatusToWindow,
  type SleepBlockerStatusFrame,
  type SleepBlockerStatusWebContents,
  type SleepBlockerStatusWindow,
} from '../sleep-blocker-status-ipc.js'

const status: SleepBlockerStatus = {
  enabled: true,
  gracePeriodMinutes: 30,
  blocking: false,
  graceRemainingMs: null,
  reason: null,
}

type TestWindowOptions = {
  windowDestroyed?: boolean
  webContentsDestroyed?: boolean
  loadingMainFrame?: boolean
  frameDestroyed?: boolean
  frameDetached?: boolean
  send?: SleepBlockerStatusFrame['send']
}

function createTestWindow(options: TestWindowOptions = {}): {
  frame: SleepBlockerStatusFrame
  webContents: SleepBlockerStatusWebContents
  window: SleepBlockerStatusWindow
} {
  const frame: SleepBlockerStatusFrame = {
    detached: options.frameDetached ?? false,
    isDestroyed: vi.fn(() => options.frameDestroyed ?? false),
    send: options.send ?? vi.fn(),
  }
  const webContents: SleepBlockerStatusWebContents = {
    mainFrame: frame,
    isDestroyed: vi.fn(() => options.webContentsDestroyed ?? false),
    isLoadingMainFrame: vi.fn(() => options.loadingMainFrame ?? false),
  }
  const window: SleepBlockerStatusWindow = {
    webContents,
    isDestroyed: vi.fn(() => options.windowDestroyed ?? false),
  }

  return { frame, webContents, window }
}

describe('sendSleepBlockerStatusToWindow', () => {
  it('sends status through the main frame when the window and frame are valid', () => {
    const send = vi.fn()
    const { window } = createTestWindow({ send })

    expect(sendSleepBlockerStatusToWindow(window, status)).toBe(true)
    expect(send).toHaveBeenCalledWith('sleep-blocker-status', status)
  })

  it('skips a destroyed window', () => {
    const send = vi.fn()
    const { window } = createTestWindow({ windowDestroyed: true, send })

    expect(sendSleepBlockerStatusToWindow(window, status)).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('skips destroyed webContents', () => {
    const send = vi.fn()
    const { window } = createTestWindow({ webContentsDestroyed: true, send })

    expect(sendSleepBlockerStatusToWindow(window, status)).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('skips while the main frame is loading', () => {
    const send = vi.fn()
    const { window } = createTestWindow({ loadingMainFrame: true, send })

    expect(sendSleepBlockerStatusToWindow(window, status)).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('skips a destroyed frame', () => {
    const send = vi.fn()
    const { window } = createTestWindow({ frameDestroyed: true, send })

    expect(sendSleepBlockerStatusToWindow(window, status)).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('skips a detached frame', () => {
    const send = vi.fn()
    const { window } = createTestWindow({ frameDetached: true, send })

    expect(sendSleepBlockerStatusToWindow(window, status)).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('ignores the known disposed WebFrameMain send race', () => {
    const send = vi.fn(() => {
      throw new Error('Error sending from webFrameMain: Render frame was disposed before WebFrameMain could be accessed')
    })
    const { window } = createTestWindow({ send })

    expect(sendSleepBlockerStatusToWindow(window, status)).toBe(false)
    expect(send).toHaveBeenCalledWith('sleep-blocker-status', status)
  })

  it('rethrows unrelated send errors', () => {
    const sendError = new Error('An object could not be cloned.')
    const send = vi.fn(() => {
      throw sendError
    })
    const { window } = createTestWindow({ send })

    expect(() => sendSleepBlockerStatusToWindow(window, status)).toThrow(sendError)
  })
})
