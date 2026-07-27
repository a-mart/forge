import type { BrowserWindow, WebContents } from 'electron'

export const MAIN_RENDERER_READY_CHANNEL = 'forge:main-renderer-ready'

const DEFAULT_READY_TIMEOUT_MS = 30_000
const DEFAULT_RECOVERY_DELAY_MS = 250
const DEFAULT_MAX_RECOVERY_ATTEMPTS = 3
const ERR_ABORTED = -3

export type MainRendererRecoveryReason =
  | 'render-process-gone'
  | 'main-frame-load-failed'
  | 'renderer-ready-timeout'
  | 'renderer-load-rejected'

export type MainRendererRecoveryEvent =
  | { type: 'ready'; recovered: boolean }
  | { type: 'scheduled'; reason: MainRendererRecoveryReason }
  | { type: 'attempt'; reason: MainRendererRecoveryReason; attempt: number }
  | { type: 'exhausted'; reason: MainRendererRecoveryReason; attempts: number }

export type MainRendererRecoveryController = {
  markReady(sender: WebContents): boolean
  dispose(): void
}

/**
 * Recovers the main renderer without touching the backend supervisor.
 *
 * A successful renderer mount must explicitly call markReady. Crashes, failed
 * main-frame loads, and loads that never mount are retried with a small delay
 * and a hard attempt cap so a broken build cannot enter an infinite reload loop.
 */
export function installMainRendererRecovery(options: {
  window: BrowserWindow
  loadRenderer(): Promise<void>
  isClosing(): boolean
  readyTimeoutMs?: number
  recoveryDelayMs?: number
  maxRecoveryAttempts?: number
  onEvent?(event: MainRendererRecoveryEvent): void
}): MainRendererRecoveryController {
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
  const recoveryDelayMs = options.recoveryDelayMs ?? DEFAULT_RECOVERY_DELAY_MS
  const maxRecoveryAttempts = options.maxRecoveryAttempts ?? DEFAULT_MAX_RECOVERY_ATTEMPTS
  let disposed = false
  let recoveryAttempts = 0
  let readyTimer: NodeJS.Timeout | null = null
  let recoveryTimer: NodeJS.Timeout | null = null
  let recoveryInFlight = false

  const canRecover = (): boolean =>
    !disposed && !options.isClosing() && !options.window.isDestroyed() && !options.window.webContents.isDestroyed()

  const clearReadyTimer = (): void => {
    if (!readyTimer) return
    clearTimeout(readyTimer)
    readyTimer = null
  }

  const clearRecoveryTimer = (): void => {
    if (!recoveryTimer) return
    clearTimeout(recoveryTimer)
    recoveryTimer = null
  }

  const scheduleRecovery = (reason: MainRendererRecoveryReason): void => {
    clearReadyTimer()
    if (!canRecover() || recoveryTimer || recoveryInFlight) return
    if (recoveryAttempts >= maxRecoveryAttempts) {
      options.onEvent?.({ type: 'exhausted', reason, attempts: recoveryAttempts })
      return
    }

    options.onEvent?.({ type: 'scheduled', reason })
    recoveryTimer = setTimeout(() => {
      recoveryTimer = null
      if (!canRecover()) return
      recoveryAttempts += 1
      recoveryInFlight = true
      options.onEvent?.({ type: 'attempt', reason, attempt: recoveryAttempts })
      void options.loadRenderer().then(() => {
        recoveryInFlight = false
      }).catch(() => {
        recoveryInFlight = false
        scheduleRecovery('renderer-load-rejected')
      })
    }, recoveryDelayMs)
  }

  const armReadyTimer = (): void => {
    clearReadyTimer()
    if (!canRecover()) return
    readyTimer = setTimeout(() => {
      readyTimer = null
      scheduleRecovery('renderer-ready-timeout')
    }, readyTimeoutMs)
  }

  const onDidStartLoading = (): void => {
    armReadyTimer()
  }
  const onRenderProcessGone = (): void => {
    scheduleRecovery('render-process-gone')
  }
  const onDidFailLoad = (
    _event: Electron.Event,
    errorCode: number,
    _errorDescription: string,
    _validatedUrl: string,
    isMainFrame: boolean,
  ): void => {
    if (isMainFrame && errorCode !== ERR_ABORTED) {
      scheduleRecovery('main-frame-load-failed')
    }
  }

  options.window.webContents.on('did-start-loading', onDidStartLoading)
  options.window.webContents.on('render-process-gone', onRenderProcessGone)
  options.window.webContents.on('did-fail-load', onDidFailLoad)

  return {
    markReady(sender) {
      // Require a readiness watchdog armed by did-start-loading. This prevents
      // a queued signal from the renderer that just exited from cancelling the
      // recovery scheduled for its replacement.
      if (!canRecover() || !readyTimer || sender !== options.window.webContents) return false
      const recovered = recoveryAttempts > 0
      recoveryAttempts = 0
      clearReadyTimer()
      clearRecoveryTimer()
      options.onEvent?.({ type: 'ready', recovered })
      return true
    },
    dispose() {
      if (disposed) return
      disposed = true
      clearReadyTimer()
      clearRecoveryTimer()
      options.window.webContents.off('did-start-loading', onDidStartLoading)
      options.window.webContents.off('render-process-gone', onRenderProcessGone)
      options.window.webContents.off('did-fail-load', onDidFailLoad)
    },
  }
}
