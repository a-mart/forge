import type { SleepBlockerStatus } from './sleep-blocker.js'

const SLEEP_BLOCKER_STATUS_CHANNEL = 'sleep-blocker-status'
const DISPOSED_WEB_FRAME_MAIN_ERROR = 'Render frame was disposed before WebFrameMain could be accessed'

export type SleepBlockerStatusFrame = {
  readonly detached: boolean
  isDestroyed(): boolean
  send(channel: string, ...args: unknown[]): void
}

export type SleepBlockerStatusWebContents = {
  readonly mainFrame: SleepBlockerStatusFrame
  isDestroyed(): boolean
  isLoadingMainFrame(): boolean
}

export type SleepBlockerStatusWindow = {
  readonly webContents: SleepBlockerStatusWebContents
  isDestroyed(): boolean
}

export function isDisposedWebFrameMainSendError(error: unknown): boolean {
  return error instanceof Error && error.message.includes(DISPOSED_WEB_FRAME_MAIN_ERROR)
}

export function sendSleepBlockerStatusToWindow(
  window: SleepBlockerStatusWindow | null | undefined,
  status: SleepBlockerStatus,
): boolean {
  if (!window || window.isDestroyed()) {
    return false
  }

  const webContents = window.webContents
  if (webContents.isDestroyed() || webContents.isLoadingMainFrame()) {
    return false
  }

  try {
    const frame = webContents.mainFrame
    if (frame.isDestroyed() || frame.detached) {
      return false
    }

    frame.send(SLEEP_BLOCKER_STATUS_CHANNEL, status)
    return true
  } catch (error) {
    if (isDisposedWebFrameMainSendError(error)) {
      return false
    }

    throw error
  }
}
