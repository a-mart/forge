/* Managed browser security posture follows T3 Code DesktopWindow.ts at 9a0a0716 (MIT). */
import path from 'node:path'
import type { Event, Session, WebContents, WebPreferences } from 'electron'
import { isBrowserPartition } from './browser-session.js'

export interface WebviewAttachParams {
  partition?: string
  preload?: string
  src?: string
  [key: string]: unknown
}

export function secureBrowserWebPreferences(webPreferences: WebPreferences, guestPreloadPath: string): void {
  webPreferences.preload = path.resolve(guestPreloadPath)
  webPreferences.sandbox = true
  webPreferences.contextIsolation = true
  webPreferences.nodeIntegration = false
  webPreferences.nodeIntegrationInSubFrames = false
  webPreferences.webSecurity = true
  webPreferences.allowRunningInsecureContent = false
  delete webPreferences.additionalArguments
  delete webPreferences.enableBlinkFeatures
  delete webPreferences.disableBlinkFeatures
}

export function managedBrowserWebPreferences(browserSession: Session, guestPreloadPath: string): WebPreferences {
  const preferences: WebPreferences = {
    session: browserSession,
    preload: path.resolve(guestPreloadPath),
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    spellcheck: true,
  }
  secureBrowserWebPreferences(preferences, guestPreloadPath)
  return preferences
}

export function isAllowedManagedBrowserUrl(url: string, allowInitialBlank = true): boolean {
  if (allowInitialBlank && url === 'about:blank') return true
  try {
    const protocol = new URL(url).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/** Apply navigation and new-window policy before the first managed navigation. */
export function secureManagedBrowserWebContents(contents: WebContents): () => void {
  const willNavigate = (event: Event, url: string): void => {
    if (!isAllowedManagedBrowserUrl(url, false)) event.preventDefault()
  }
  contents.on('will-navigate', willNavigate)
  contents.setWindowOpenHandler(({ url }) => {
    if (isAllowedManagedBrowserUrl(url, false) && !contents.isDestroyed()) {
      void contents.loadURL(url).catch(() => undefined)
    }
    return { action: 'deny' }
  })
  return () => {
    if (!contents.isDestroyed()) contents.off('will-navigate', willNavigate)
  }
}

/** @deprecated Renderer webviews are retained only by the historical fixture. */
export function enforceBrowserWebviewAttachment(
  event: Pick<Event, 'preventDefault'>,
  webPreferences: WebPreferences,
  params: WebviewAttachParams,
  guestPreloadPath: string,
): boolean {
  if (typeof params.partition !== 'string' || !isBrowserPartition(params.partition)) {
    event.preventDefault()
    return false
  }
  if (typeof params.src === 'string' && !isAllowedManagedBrowserUrl(params.src)) {
    event.preventDefault()
    return false
  }
  secureBrowserWebPreferences(webPreferences, guestPreloadPath)
  return true
}
