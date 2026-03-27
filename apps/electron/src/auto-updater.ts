import { app, BrowserWindow, dialog, Notification } from 'electron'
import {
  autoUpdater,
  type ProgressInfo,
  type UpdateDownloadedEvent,
  type UpdateInfo,
} from 'electron-updater'

/** Delay before first update check after app launch. */
const UPDATE_STARTUP_DELAY_MS = 10_000

/**
 * Interval between periodic update checks: 2 hours.
 * The first check runs after UPDATE_STARTUP_DELAY_MS, then repeats at this interval.
 * If a downloaded update is pending, the periodic tick re-prompts the user instead of checking again.
 */
const UPDATE_CHECK_INTERVAL_MS = 2 * 60 * 60 * 1_000
const GITHUB_FEED = {
  provider: 'github' as const,
  owner: 'a-mart',
  repo: 'forge',
}

type BackendHealthResponse = {
  ok?: boolean
  swarm?: {
    activeSessions?: number
    activeWorkers?: number
    hasActiveSessions?: boolean
    hasActiveWorkers?: boolean
  }
}

export type UpdateStatusType =
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'

export type UpdateStatus =
  | { type: 'checking' }
  | { type: 'available'; version: string }
  | { type: 'not-available'; version: string }
  | { type: 'downloading'; percent: number }
  | { type: 'downloaded'; version: string }
  | { type: 'error'; message: string }

let manualUpdateCheck = false
let triggerUpdateCheck: ((isManual: boolean) => Promise<void>) | null = null
let triggerDownloadUpdate: (() => Promise<void>) | null = null
let triggerInstallUpdate: (() => void) | null = null

export function initAutoUpdater(options: {
  mainWindow: BrowserWindow
  getBackendBaseUrl: () => string | null
  prepareQuitForUpdate: () => Promise<void>
}): void {
  if (!app.isPackaged) {
    return
  }

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.setFeedURL(GITHUB_FEED)

  let isCheckingForUpdates = false
  let isDownloadingUpdate = false
  let restartPromptOpen = false
  let pendingDownloadedUpdate: UpdateDownloadedEvent | null = null

  const sendStatus = (status: UpdateStatus): void => {
    if (!options.mainWindow.isDestroyed()) {
      options.mainWindow.webContents.send('update-status', status)
    }
  }

  const checkForUpdates = async (isManual = false): Promise<void> => {
    if (isCheckingForUpdates || isDownloadingUpdate || restartPromptOpen) {
      return
    }

    isCheckingForUpdates = true
    manualUpdateCheck = isManual
    sendStatus({ type: 'checking' })
    try {
      await autoUpdater.checkForUpdates()
    } catch (error) {
      console.warn('[auto-update] Update check failed', formatError(error))
      sendStatus({ type: 'error', message: formatError(error) })
    } finally {
      isCheckingForUpdates = false
      if (isManual) {
        manualUpdateCheck = false
      }
    }
  }

  triggerUpdateCheck = checkForUpdates

  triggerDownloadUpdate = async (): Promise<void> => {
    if (isDownloadingUpdate) {
      return
    }

    isDownloadingUpdate = true
    setWindowProgress(options.mainWindow, 0)
    sendStatus({ type: 'downloading', percent: 0 })

    try {
      await autoUpdater.downloadUpdate()
    } catch (error) {
      isDownloadingUpdate = false
      setWindowProgress(options.mainWindow, -1)
      console.warn('[auto-update] Update download failed', formatError(error))
      sendStatus({ type: 'error', message: formatError(error) })
    }
  }

  triggerInstallUpdate = (): void => {
    void (async () => {
      try {
        await options.prepareQuitForUpdate()
        autoUpdater.quitAndInstall()
      } catch (error) {
        console.warn('[auto-update] Failed to prepare update install', formatError(error))
        sendStatus({ type: 'error', message: formatError(error) })
      }
    })()
  }

  const startUpdateTimers = (): void => {
    const startupTimer = setTimeout(() => {
      void checkForUpdates()
    }, UPDATE_STARTUP_DELAY_MS)
    startupTimer.unref?.()

    const periodicTimer = setInterval(() => {
      if (pendingDownloadedUpdate) {
        void promptToInstallDownloadedUpdate(pendingDownloadedUpdate)
        return
      }

      if (!isWithinUpdateWindow()) {
        return
      }

      void checkForUpdates()
    }, UPDATE_CHECK_INTERVAL_MS)
    periodicTimer.unref?.()
  }

  const promptToDownloadUpdate = async (info: UpdateInfo): Promise<void> => {
    if (isDownloadingUpdate || restartPromptOpen) {
      return
    }

    const response = await showMessageBox(options.mainWindow, {
      type: 'info',
      buttons: ['Download Update', 'Later'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      title: 'Update available',
      message: `Forge ${info.version} is available.`,
      detail: 'Download the update now? Forge will wait for your confirmation before downloading and restarting.',
    })

    if (response.response !== 0) {
      return
    }

    isDownloadingUpdate = true
    setWindowProgress(options.mainWindow, 0)

    try {
      await autoUpdater.downloadUpdate()
    } catch (error) {
      isDownloadingUpdate = false
      setWindowProgress(options.mainWindow, -1)
      console.warn('[auto-update] Update download failed', formatError(error))
      await showMessageBox(options.mainWindow, {
        type: 'error',
        buttons: ['OK'],
        defaultId: 0,
        noLink: true,
        title: 'Update download failed',
        message: 'Forge could not download the latest update.',
        detail: formatError(error),
      })
    }
  }

  const promptToInstallDownloadedUpdate = async (event: UpdateDownloadedEvent): Promise<void> => {
    if (restartPromptOpen) {
      return
    }

    restartPromptOpen = true

    try {
      const backendHasActiveSessions = await hasActiveSessions(options.getBackendBaseUrl)
      if (backendHasActiveSessions) {
        pendingDownloadedUpdate = event
        showDesktopNotification('Forge update ready', 'An update has been downloaded. Finish active agent runs, then restart Forge to install it.')
        return
      }

      pendingDownloadedUpdate = null
      const response = await showMessageBox(options.mainWindow, {
        type: 'info',
        buttons: ['Restart and Install', 'Later'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
        title: 'Update ready to install',
        message: `Forge ${event.version} has been downloaded.`,
        detail: 'Restart Forge now to install the update, or choose Later to keep working and install it on a future restart.',
      })

      if (response.response !== 0) {
        pendingDownloadedUpdate = event
        return
      }

      try {
        await options.prepareQuitForUpdate()
        autoUpdater.quitAndInstall()
      } catch (error) {
        pendingDownloadedUpdate = event
        console.warn('[auto-update] Failed to prepare update install', formatError(error))
        await showMessageBox(options.mainWindow, {
          type: 'error',
          buttons: ['OK'],
          defaultId: 0,
          noLink: true,
          title: 'Update install blocked',
          message: 'Forge could not prepare the update install.',
          detail: formatError(error),
        })
      }
    } finally {
      restartPromptOpen = false
    }
  }

  autoUpdater.on('update-available', (info) => {
    sendStatus({ type: 'available', version: info.version })
    showDesktopNotification('Forge update available', `Version ${info.version} is ready to download.`)
    void promptToDownloadUpdate(info)
  })

  autoUpdater.on('update-not-available', () => {
    sendStatus({ type: 'not-available', version: app.getVersion() })

    if (!manualUpdateCheck) {
      return
    }

    void showMessageBox(options.mainWindow, {
      type: 'info',
      buttons: ['OK'],
      defaultId: 0,
      noLink: true,
      title: 'No update available',
      message: `You're up to date. Forge v${app.getVersion()} is the latest version.`,
    })
  })

  autoUpdater.on('download-progress', (progress: ProgressInfo) => {
    setWindowProgress(options.mainWindow, progress.percent / 100)
    sendStatus({ type: 'downloading', percent: Math.round(progress.percent) })
  })

  autoUpdater.on('update-downloaded', (event) => {
    isDownloadingUpdate = false
    setWindowProgress(options.mainWindow, -1)
    pendingDownloadedUpdate = event
    sendStatus({ type: 'downloaded', version: event.version })
    showDesktopNotification('Forge update downloaded', `Version ${event.version} is ready to install.`)
    void promptToInstallDownloadedUpdate(event)
  })

  autoUpdater.on('error', (error) => {
    sendStatus({ type: 'error', message: formatError(error) })

    if (!isDownloadingUpdate) {
      console.warn('[auto-update] Non-fatal updater error', formatError(error))
      return
    }

    isDownloadingUpdate = false
    setWindowProgress(options.mainWindow, -1)
    console.warn('[auto-update] Updater error during download', formatError(error))
  })

  startUpdateTimers()
}

export function checkForUpdatesManually(): Promise<void> {
  if (!triggerUpdateCheck || !app.isPackaged) {
    return Promise.resolve()
  }

  return triggerUpdateCheck(true)
}

export function downloadUpdateManually(): Promise<void> {
  if (!triggerDownloadUpdate || !app.isPackaged) {
    return Promise.resolve()
  }

  return triggerDownloadUpdate()
}

export function installUpdateManually(): void {
  if (!triggerInstallUpdate || !app.isPackaged) {
    return
  }

  triggerInstallUpdate()
}

function isWithinUpdateWindow(): boolean {
  const now = new Date()
  const centralHour = parseInt(now.toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    hour: 'numeric',
    hour12: false,
  }))
  return centralHour >= 7 && centralHour < 20
}

async function showMessageBox(
  mainWindow: BrowserWindow,
  options: Electron.MessageBoxOptions,
): Promise<Electron.MessageBoxReturnValue> {
  if (mainWindow.isDestroyed()) {
    return dialog.showMessageBox(options)
  }

  return dialog.showMessageBox(mainWindow, options)
}

function setWindowProgress(mainWindow: BrowserWindow, value: number): void {
  if (!mainWindow.isDestroyed()) {
    mainWindow.setProgressBar(value)
  }
}

async function hasActiveSessions(getBackendBaseUrl: () => string | null): Promise<boolean> {
  const backendBaseUrl = getBackendBaseUrl()
  if (!backendBaseUrl) {
    return false
  }

  try {
    const response = await fetch(new URL('/api/health', backendBaseUrl), {
      signal: AbortSignal.timeout(5_000),
    })

    if (!response.ok) {
      return false
    }

    const payload = (await response.json()) as BackendHealthResponse
    const activeSessions = payload.swarm?.activeSessions ?? 0
    const activeWorkers = payload.swarm?.activeWorkers ?? 0
    return Boolean(payload.swarm?.hasActiveSessions) || Boolean(payload.swarm?.hasActiveWorkers) || activeSessions > 0 || activeWorkers > 0
  } catch (error) {
    console.warn('[auto-update] Backend activity probe failed', formatError(error))
    return false
  }
}

function showDesktopNotification(title: string, body: string): void {
  if (!Notification.isSupported()) {
    return
  }

  new Notification({
    title,
    body,
    silent: true,
  }).show()
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
