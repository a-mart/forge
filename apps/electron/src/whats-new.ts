import { app, BrowserWindow, dialog, shell } from 'electron'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

const LAST_SEEN_VERSION_FILE = 'last-seen-version.json'
const GITHUB_RELEASE_URL_BASE = 'https://github.com/a-mart/forge/releases/tag'

type LastSeenVersionData = {
  version: string
}

function getLastSeenVersionPath(): string {
  return path.join(app.getPath('userData'), LAST_SEEN_VERSION_FILE)
}

async function readLastSeenVersion(): Promise<string | null> {
  try {
    const raw = await readFile(getLastSeenVersionPath(), 'utf-8')
    const data = JSON.parse(raw) as LastSeenVersionData
    return data.version ?? null
  } catch {
    return null
  }
}

async function writeLastSeenVersion(version: string): Promise<void> {
  const filePath = getLastSeenVersionPath()
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify({ version } satisfies LastSeenVersionData, null, 2), 'utf-8')
}

/**
 * Show a "What's New" dialog if the app version differs from the last-seen version.
 * This detects post-update first launches and informs the user about the new version.
 *
 * Call after the main window is created and the backend is ready.
 */
export async function showWhatsNewIfUpdated(mainWindow: BrowserWindow): Promise<void> {
  const currentVersion = app.getVersion()
  const lastSeenVersion = await readLastSeenVersion()

  // Always update on first run or matching version — nothing to show
  if (lastSeenVersion === currentVersion) {
    return
  }

  // Update the stored version before showing the dialog so it only shows once,
  // even if the user dismisses it or the app crashes.
  await writeLastSeenVersion(currentVersion)

  // Skip on very first launch (no previous version recorded)
  if (lastSeenVersion === null) {
    return
  }

  const releaseUrl = `${GITHUB_RELEASE_URL_BASE}/v${currentVersion}`

  const result = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    buttons: ['View Release Notes', 'OK'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title: "What's New",
    message: `Forge has been updated to v${currentVersion}`,
    detail:
      `Previously: v${lastSeenVersion}\n\n` +
      'Click "View Release Notes" to see what changed in this release.',
  })

  if (result.response === 0) {
    await shell.openExternal(releaseUrl)
  }
}
