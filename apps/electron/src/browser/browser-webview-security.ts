/* Hosted webview security posture follows T3 Code DesktopWindow.ts at 9a0a0716 (MIT). */
import path from 'node:path'
import type { Event, WebPreferences } from 'electron'
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
  if (typeof params.src === 'string' && params.src !== 'about:blank') {
    try {
      const protocol = new URL(params.src).protocol
      if (protocol !== 'http:' && protocol !== 'https:') {
        event.preventDefault()
        return false
      }
    } catch {
      event.preventDefault()
      return false
    }
  }
  secureBrowserWebPreferences(webPreferences, guestPreloadPath)
  return true
}
