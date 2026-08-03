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
  const webContents = options.window.webContents
  let disposed = false
  let recoveryAttempts = 0
  let readyTimer: NodeJS.Timeout | null = null
  let recoveryTimer: NodeJS.Timeout | null = null
  let recoveryInFlight = false

  const canRecover = (): boolean =>
    !disposed && !options.isClosing() && !options.window.isDestroyed() && !webContents.isDestroyed()

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

  const onDidStartNavigation = (
    event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
  ): void => {
    // `did-start-loading` follows the tab spinner and also fires for Vite's
    // module activity. Fast Refresh preserves the mounted React tree, so that
    // activity does not produce a new readiness IPC and must not arm recovery.
    if (event.isMainFrame && !event.isSameDocument) {
      armReadyTimer()
    }
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

  webContents.on('did-start-navigation', onDidStartNavigation)
  webContents.on('render-process-gone', onRenderProcessGone)
  webContents.on('did-fail-load', onDidFailLoad)

  return {
    markReady(sender) {
      // Require a readiness watchdog armed by a top-level navigation. This prevents
      // a queued signal from the renderer that just exited from cancelling the
      // recovery scheduled for its replacement.
      if (!canRecover() || !readyTimer || sender !== webContents) return false
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
      if (options.window.isDestroyed() || webContents.isDestroyed()) return
      webContents.off('did-start-navigation', onDidStartNavigation)
      webContents.off('render-process-gone', onRenderProcessGone)
      webContents.off('did-fail-load', onDidFailLoad)
    },
  }
}
