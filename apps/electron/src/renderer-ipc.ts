const DISPOSED_WEB_FRAME_MAIN_ERROR = 'Render frame was disposed before WebFrameMain could be accessed'

export type RendererIpcFrame = {
  readonly detached: boolean
  isDestroyed(): boolean
  send(channel: string, ...args: unknown[]): void
}

export type RendererIpcWebContents = {
  readonly mainFrame: RendererIpcFrame
  isDestroyed(): boolean
  isLoadingMainFrame(): boolean
}

export type RendererIpcWindow = {
  readonly webContents: RendererIpcWebContents
  isDestroyed(): boolean
}

export function isDisposedWebFrameMainSendError(error: unknown): boolean {
  return error instanceof Error && error.message.includes(DISPOSED_WEB_FRAME_MAIN_ERROR)
}

/**
 * Safely deliver an event to a BrowserWindow's current main frame.
 *
 * Electron can dispose and replace WebFrameMain between a BrowserWindow/WebContents
 * liveness check and `send()`. That navigation/crash race is expected and should be
 * treated as a dropped transient event, while unrelated IPC errors still surface.
 */
export function sendToRendererWindow(
  window: RendererIpcWindow | null | undefined,
  channel: string,
  ...args: unknown[]
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

    frame.send(channel, ...args)
    return true
  } catch (error) {
    if (isDisposedWebFrameMainSendError(error)) {
      return false
    }

    throw error
  }
}
