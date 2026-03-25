import { app, BrowserWindow, dialog, Notification } from 'electron'
import {
  autoUpdater,
  type ProgressInfo,
  type UpdateDownloadedEvent,
  type UpdateInfo,
} from 'electron-updater'

const UPDATE_STARTUP_DELAY_MS = 10_000
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1_000
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

  const checkForUpdates = async (): Promise<void> => {
    if (isCheckingForUpdates || isDownloadingUpdate || restartPromptOpen) {
      return
    }

    isCheckingForUpdates = true
    try {
      await autoUpdater.checkForUpdates()
    } catch (error) {
      console.warn('[auto-update] Update check failed', formatError(error))
    } finally {
      isCheckingForUpdates = false
    }
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
    showDesktopNotification('Forge update available', `Version ${info.version} is ready to download.`)
    void promptToDownloadUpdate(info)
  })

  autoUpdater.on('download-progress', (progress: ProgressInfo) => {
    setWindowProgress(options.mainWindow, progress.percent / 100)
  })

  autoUpdater.on('update-downloaded', (event) => {
    isDownloadingUpdate = false
    setWindowProgress(options.mainWindow, -1)
    pendingDownloadedUpdate = event
    showDesktopNotification('Forge update downloaded', `Version ${event.version} is ready to install.`)
    void promptToInstallDownloadedUpdate(event)
  })

  autoUpdater.on('error', (error) => {
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
